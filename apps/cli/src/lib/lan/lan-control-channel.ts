import type { Duplex } from 'node:stream';
import {
  LanMemberControlRequestSchema,
  LanMemberControlResponseSchema,
  type LanMemberControlRequest,
  type LanMemberControlResponse,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { ByteReader } from './lan-files';
import { connectLanMember, type LanMemberConnectOptions } from './lan-terminal';

/**
 * What the members of a LAN ask of each other's machines, sent from machine to
 * machine over the connection terminals use. A connection carries one request
 * and its answer, each one line of JSON, and ends.
 *
 * The hub carried these requests first, and still carries one for a member
 * this machine cannot connect to; but a request in the hub waits there until
 * the member reads it, and stays there afterwards.
 */
const REQUEST_MAX_BYTES = 256 * 1024;
const ANSWER_MAX_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

/** The request never left this machine, so asking another way asks once. */
export class LanMemberUnreachableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LanMemberUnreachableError';
  }
}

function writeLine(stream: Duplex, value: unknown): void {
  if (!stream.destroyed) stream.write(`${JSON.stringify(value)}\n`);
}

/**
 * Answers the one request a member sends over a connection. The connection is
 * keyed to one LAN, so a request about the workspace of another LAN of this
 * machine is refused: its members are another user.
 */
export async function serveLanControlConnection(
  stream: Duplex,
  options: {
    initial: Buffer;
    /** The workspace of the LAN whose key opened the connection. */
    workspaceId: string;
    answer: (request: LanMemberControlRequest) => Promise<LanMemberControlResponse>;
    logger: Logger;
    requestTimeoutMs?: number;
  }
): Promise<void> {
  stream.on('error', () => {});
  const timer = setTimeout(
    () => stream.destroy(new Error('no request arrived')),
    options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
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
    let request: LanMemberControlRequest;
    try {
      request = LanMemberControlRequestSchema.parse(JSON.parse(line)) as LanMemberControlRequest;
    } catch {
      writeLine(stream, {
        type: 'error',
        code: 'invalid_request',
        message: 'The request cannot be read',
      });
      return;
    }
    if (request.workspaceId !== options.workspaceId) {
      writeLine(stream, {
        ok: false,
        type: request.type,
        error: 'workspace_not_found',
        message: 'This connection belongs to another LAN',
      } satisfies LanMemberControlResponse);
      return;
    }
    let response: LanMemberControlResponse;
    try {
      response = await options.answer(request);
    } catch (error) {
      response = {
        ok: false,
        type: request.type,
        error: 'execution_failed',
        message: formatErrorMessage(error),
      };
    }
    writeLine(stream, response);
  } catch (error) {
    options.logger.debug(`[lan-control] a request was not answered: ${formatErrorMessage(error)}`);
  } finally {
    stream.end();
  }
}

/**
 * Puts a request to a member over a connection it already answered and reads
 * its answer. Whatever goes wrong from here on may have happened after the
 * member acted, so it is not `LanMemberUnreachableError`.
 */
export async function askOverLanControlConnection(
  stream: Duplex,
  options: { initial: Buffer; request: LanMemberControlRequest; timeoutMs: number }
): Promise<LanMemberControlResponse> {
  let failure: Error | null = null;
  stream.on('error', (error) => {
    failure ??= error;
  });
  const timer = setTimeout(
    () => stream.destroy(new Error('the member did not answer in time')),
    options.timeoutMs
  );
  timer.unref?.();
  try {
    writeLine(stream, options.request);
    let line: string | null;
    try {
      line = await new ByteReader(stream, options.initial).readLine(ANSWER_MAX_BYTES);
    } catch (error) {
      throw failure ?? error;
    }
    if (line === null) throw failure ?? new Error('the member closed the connection');
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error('the member answered with something else');
    }
    const parsed = LanMemberControlResponseSchema.safeParse(value);
    if (parsed.success) return parsed.data as LanMemberControlResponse;
    const refusal = value as { type?: unknown; message?: unknown } | null;
    if (refusal?.type === 'error' && typeof refusal.message === 'string') {
      throw new Error(refusal.message);
    }
    throw new Error('the member answered with something else');
  } finally {
    clearTimeout(timer);
    stream.end();
  }
}

/** Puts a request to the member of a LAN at the endpoint it publishes. */
export async function askLanMemberDirectly(
  options: LanMemberConnectOptions & { request: LanMemberControlRequest; timeoutMs: number }
): Promise<LanMemberControlResponse> {
  let connection: Awaited<ReturnType<typeof connectLanMember>>;
  try {
    connection = await connectLanMember({ ...options, service: 'control' });
  } catch (error) {
    throw new LanMemberUnreachableError(formatErrorMessage(error), { cause: error });
  }
  const { socket, rest } = connection;
  try {
    return await askOverLanControlConnection(socket, {
      initial: rest,
      request: options.request,
      timeoutMs: options.timeoutMs,
    });
  } finally {
    socket.destroy();
  }
}
