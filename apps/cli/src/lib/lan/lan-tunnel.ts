// A port reached through one machine of a LAN from another: a dev server an
// agent started there, opened here, or anything that machine reaches, as with
// `ssh -L`. Each connection asks for one host and port and then carries bytes
// both ways, over the connection members open to each other.
import net from 'node:net';
import type tls from 'node:tls';
import { z } from 'zod';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import {
  connectLanMember,
  readFirstLine,
  writeLine,
  type LanMemberConnectOptions,
} from './lan-terminal';

const CONNECT_TIMEOUT_MS = 10_000;

export const LanTunnelRequestSchema = z.object({
  type: z.literal('connect'),
  port: z.number().int().min(1).max(65_535),
  /** What the machine connects to; its own loopback interface when absent. */
  host: z.string().min(1).max(253).optional(),
  /**
   * The machine whose port is meant, on the local tunnel socket of this
   * machine's agent service; a member serves only its own.
   */
  machineId: z.string().min(1).optional(),
});
export type LanTunnelRequest = z.infer<typeof LanTunnelRequestSchema>;

const LanTunnelAnswerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connected') }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);

function parseJsonLine<T>(schema: z.ZodType<T>, line: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The next line of a socket that a reader before left paused. */
function readLine(socket: net.Socket): Promise<{ line: string; rest: Buffer }> {
  const line = readFirstLine(socket);
  socket.resume();
  return line;
}

/**
 * A port this machine reaches: of its loopback interface unless another host
 * is named. `localhost` lets a server that listens on `::1` only answer as well
 * as one on `127.0.0.1`. A member reaches what its owner could reach from it
 * anyway, so a host is not restricted, as `ssh -L` restricts none.
 */
export function connectPort(port: number, host = 'localhost'): Promise<net.Socket> {
  const target = host === 'localhost' ? `port ${port}` : `${host}:${port}`;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, autoSelectFamily: true });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`nothing answered on ${target} in time`));
    }, CONNECT_TIMEOUT_MS);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.off('error', onError);
      resolve(socket);
    });
    const onError = (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new Error(
          error.code === 'ECONNREFUSED' ? `nothing listens on ${target}` : formatErrorMessage(error)
        )
      );
    };
    socket.once('error', onError);
  });
}

/**
 * Carries bytes both ways. A side that finishes sending passes its end on and
 * still receives the answer, as `ssh -L` does; a side that breaks off or
 * fails takes the other down with it.
 */
export function joinSockets(left: net.Socket, right: net.Socket): void {
  for (const socket of [left, right]) socket.allowHalfOpen = true;
  left.pipe(right);
  right.pipe(left);
  const follow = (from: net.Socket, to: net.Socket) => {
    let ended = false;
    from.once('end', () => {
      ended = true;
    });
    from.once('close', () => {
      if (!ended) to.destroy();
    });
    from.on('error', () => to.destroy());
  };
  follow(left, right);
  follow(right, left);
  left.resume();
  right.resume();
}

/**
 * Answers one connection that names a port with a connection to it. The
 * request is the first line; what follows it already belongs to the port.
 */
export async function serveTunnelRequest(
  socket: net.Socket,
  options: {
    initial?: Buffer;
    logger: Logger;
    /** Where a port is reached; what this machine reaches itself by default. */
    connect?: (request: LanTunnelRequest) => Promise<net.Socket>;
  }
): Promise<void> {
  let line: string;
  let rest: Buffer;
  try {
    if (options.initial && options.initial.length > 0) socket.unshift(options.initial);
    ({ line, rest } = await readLine(socket));
  } catch (error) {
    options.logger.debug(`[lan-tunnel] request failed: ${formatErrorMessage(error)}`);
    socket.destroy();
    return;
  }
  const request = parseJsonLine(LanTunnelRequestSchema, line);
  if (!request) {
    writeLine(socket, { type: 'error', message: 'invalid tunnel request' });
    socket.end();
    return;
  }
  let target: net.Socket;
  try {
    target = await (options.connect ?? ((wanted) => connectPort(wanted.port, wanted.host)))(
      request
    );
  } catch (error) {
    writeLine(socket, { type: 'error', message: formatErrorMessage(error) });
    socket.end();
    return;
  }
  if (socket.destroyed) {
    target.destroy();
    return;
  }
  writeLine(socket, { type: 'connected' });
  if (rest.length > 0) target.write(rest);
  joinSockets(socket, target);
}

/**
 * Asks the other end of a connection for a port and resolves once it is
 * connected; the socket then carries the port's bytes.
 */
export async function requestTunnel(
  socket: net.Socket,
  target: { port: number; host?: string; machineId?: string }
): Promise<net.Socket> {
  writeLine(socket, {
    type: 'connect',
    port: target.port,
    ...(target.host ? { host: target.host } : {}),
    ...(target.machineId ? { machineId: target.machineId } : {}),
  } satisfies LanTunnelRequest);
  const { line, rest } = await readLine(socket);
  const answer = parseJsonLine(LanTunnelAnswerSchema, line);
  if (!answer) throw new Error('the machine gave no tunnel answer');
  if (answer.type === 'error') throw new Error(answer.message);
  if (rest.length > 0) socket.unshift(rest);
  return socket;
}

/** A port a member reaches, over the connection members open to each other. */
export async function openLanTunnel(
  options: LanMemberConnectOptions & { port: number; host?: string }
): Promise<tls.TLSSocket> {
  const { socket, rest } = await connectLanMember({ ...options, service: 'tunnel' });
  if (rest.length > 0) socket.unshift(rest);
  try {
    await requestTunnel(socket, {
      port: options.port,
      ...(options.host ? { host: options.host } : {}),
    });
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
