import type { Duplex } from 'node:stream';
import { z } from 'zod';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { ByteReader } from './lan-files';
import { connectLanMember, type LanMemberConnectOptions } from './lan-terminal';

/**
 * What members tell each other about their LAN's hub, over the connection
 * terminals use: where each of them follows the hub and whether it reaches
 * it, and that a standby took over. It works while the hub is gone, which is
 * when it is needed. A connection carries one request and its answer.
 *
 * Nothing here is signed: only a member completes the handshake of the
 * connection, and a member holds the credential that would sign it.
 */
const LINE_MAX_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

export type LanHubLocation = { url: string; term: number };

const LocationSchema = z
  .object({ url: z.string().min(1).max(2048), term: z.number().int().nonnegative() })
  .strict();
const RequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('where') }).strict(),
  z.object({ type: z.literal('moved'), location: LocationSchema }).strict(),
]);
export type LanHubPeerRequest = z.infer<typeof RequestSchema>;

const AnswerSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('where'),
      location: LocationSchema,
      /** Whether this member reached the hub lately; `null` before it tried. */
      reachable: z.boolean().nullable(),
    })
    .strict(),
  z.object({ type: z.literal('moved'), followed: z.boolean() }).strict(),
  z.object({ type: z.literal('error'), message: z.string() }).strict(),
]);
export type LanHubPeerAnswer = z.infer<typeof AnswerSchema>;

/** How a member answers for one LAN. */
export type LanHubPeerHandler = {
  where: () => Promise<{ location: LanHubLocation; reachable: boolean | null }>;
  /** Follows a hub that took over; whether this member now follows it. */
  moved: (location: LanHubLocation) => Promise<boolean>;
};

function writeLine(stream: Duplex, value: unknown): void {
  if (!stream.destroyed) stream.write(`${JSON.stringify(value)}\n`);
}

export async function serveLanHubPeerConnection(
  stream: Duplex,
  options: { initial: Buffer; handler: LanHubPeerHandler; logger: Logger }
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
      line = await new ByteReader(stream, options.initial).readLine(LINE_MAX_BYTES);
    } finally {
      clearTimeout(timer);
    }
    if (line === null) return;
    let request: LanHubPeerRequest;
    try {
      request = RequestSchema.parse(JSON.parse(line));
    } catch {
      writeLine(stream, { type: 'error', message: 'The request cannot be read' });
      return;
    }
    if (request.type === 'where') {
      writeLine(stream, { type: 'where', ...(await options.handler.where()) });
      return;
    }
    writeLine(stream, { type: 'moved', followed: await options.handler.moved(request.location) });
  } catch (error) {
    options.logger.debug(`[lan-hub] a member was not answered: ${formatErrorMessage(error)}`);
    writeLine(stream, { type: 'error', message: formatErrorMessage(error) });
  } finally {
    stream.end();
  }
}

/** Puts one request about the hub to a member at the endpoint it publishes. */
export async function askLanHubPeer(
  options: LanMemberConnectOptions & { request: LanHubPeerRequest; timeoutMs?: number }
): Promise<LanHubPeerAnswer> {
  const { socket, rest } = await connectLanMember({ ...options, service: 'hub' });
  const timer = setTimeout(
    () => socket.destroy(new Error('the member did not answer in time')),
    options.timeoutMs ?? REQUEST_TIMEOUT_MS
  );
  timer.unref?.();
  try {
    writeLine(socket, options.request);
    const line = await new ByteReader(socket, rest).readLine(LINE_MAX_BYTES);
    if (line === null) throw new Error('the member closed the connection');
    return AnswerSchema.parse(JSON.parse(line));
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}
