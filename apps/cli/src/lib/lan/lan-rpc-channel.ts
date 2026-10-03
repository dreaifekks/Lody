import type { Duplex } from 'node:stream';
import { z } from 'zod';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { ByteReader } from './lan-files';
import { connectLanMember, type LanMemberConnectOptions } from './lan-terminal';

/**
 * The machine RPC requests of a desktop, carried to the member they are for
 * over the connection terminals use instead of through the hub. A connection
 * carries one request, as the hub would have carried it, and the answers the
 * member would have written to the hub, each one line of JSON.
 *
 * The member handles the request as one read from its request stream, so it
 * checks it exactly as it checks those; the connection adds that the request
 * names the workspace of the LAN whose key opened it.
 */
const REQUEST_MAX_BYTES = 8 * 1024 * 1024;
const ANSWER_MAX_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

const AnswerSchema = z.union([
  z.object({ type: z.literal('answers'), answers: z.array(z.unknown()) }).strict(),
  z.object({ type: z.literal('error'), message: z.string() }).strict(),
]);

/** The request never left this machine; the hub may carry it. */
export class LanRpcNotSentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LanRpcNotSentError';
  }
}

function writeLine(stream: Duplex, value: unknown): void {
  if (!stream.destroyed) stream.write(`${JSON.stringify(value)}\n`);
}

export async function serveLanRpcConnection(
  stream: Duplex,
  options: {
    initial: Buffer;
    /** The workspace of the LAN whose key opened the connection. */
    workspaceId: string;
    handle: (request: unknown) => Promise<unknown[]>;
    logger: Logger;
  }
): Promise<void> {
  stream.on('error', () => {});
  const timer = setTimeout(
    () => stream.destroy(new Error('no request arrived')),
    REQUEST_TIMEOUT_MS
  );
  timer.unref?.();
  try {
    let line: string | null;
    try {
      line = await new ByteReader(stream, options.initial).readLine(REQUEST_MAX_BYTES);
    } finally {
      clearTimeout(timer);
    }
    if (line === null) return;
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      writeLine(stream, { type: 'error', message: 'The request cannot be read' });
      return;
    }
    const workspaceId = (request as { workspaceId?: unknown } | null)?.workspaceId;
    if (workspaceId !== options.workspaceId) {
      writeLine(stream, { type: 'error', message: 'This connection belongs to another LAN' });
      return;
    }
    writeLine(stream, { type: 'answers', answers: await options.handle(request) });
  } catch (error) {
    options.logger.debug(`[lan-rpc] a request was not answered: ${formatErrorMessage(error)}`);
    writeLine(stream, { type: 'error', message: formatErrorMessage(error) });
  } finally {
    stream.end();
  }
}

/**
 * Carries one request to a member and returns its answers. Throws
 * `LanRpcNotSentError` when the request never got to the member.
 */
export async function askLanMemberRpc(
  options: LanMemberConnectOptions & { request: unknown; timeoutMs: number }
): Promise<unknown[]> {
  let connection: Awaited<ReturnType<typeof connectLanMember>>;
  try {
    connection = await connectLanMember({ ...options, service: 'rpc' });
  } catch (error) {
    throw new LanRpcNotSentError(formatErrorMessage(error), { cause: error });
  }
  const { socket, rest } = connection;
  const timer = setTimeout(
    () => socket.destroy(new Error('the member did not answer in time')),
    options.timeoutMs
  );
  timer.unref?.();
  try {
    writeLine(socket, options.request);
    const line = await new ByteReader(socket, rest).readLine(ANSWER_MAX_BYTES);
    if (line === null) throw new Error('the member closed the connection');
    const answer = AnswerSchema.parse(JSON.parse(line));
    if (answer.type === 'error') throw new Error(answer.message);
    return answer.answers;
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}
