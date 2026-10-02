import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import {
  createUtf8StreamDecoder,
  TerminalServerEventSchema,
  type TerminalClientMessage,
  type TerminalOpenParams,
  type TerminalOpenResult,
  type TerminalServerEvent,
  type TerminalSnapshot,
} from '@lody/shared';
import { LAN_TERMINAL_PROTOCOL_VERSION, type LanTerminalEndpoint } from '@lody/shared/lan-terminal';
import { z } from 'zod';
import type { TerminalReplay } from '@/lib/terminal-connection';
import type { RemoteTerminalCommand, RemoteTerminalLink } from '@/lib/terminal-services';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

/**
 * What members of a LAN send each other directly runs over TLS with a key
 * derived from the credential of the LAN (TLS-PSK): only a member completes
 * the handshake, in either direction, and nothing on the wire is readable
 * without the credential. No certificate is involved. ECDHE keeps past
 * sessions private should a credential leak later. TLS 1.3 has no external-PSK
 * support in Node, so both sides pin TLS 1.2 and the one suite OpenSSL and
 * BoringSSL (Electron) share.
 */
const TLS_OPTIONS = {
  ciphers: 'ECDHE-PSK-CHACHA20-POLY1305',
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.2',
} as const;

export const LAN_TERMINAL_DEFAULT_PORT = 8789;

const HANDSHAKE_TIMEOUT_MS = 10_000;
const HELLO_MAX_BYTES = 4096;
const REQUEST_TIMEOUT_MS = 9_000;
const KEEPALIVE_MS = 30_000;

export function deriveLanTerminalKey(token: string): Buffer {
  return crypto.createHash('sha256').update(`lody-lan-hub:terminal:${token}`).digest();
}

/**
 * What a connection between members carries. A connection serves one of them,
 * named in its hello; one that names none is a terminal connection, as every
 * connection was before there was anything else.
 */
export const LAN_MEMBER_SERVICES = ['terminal', 'files', 'control'] as const;
export type LanMemberService = (typeof LAN_MEMBER_SERVICES)[number];

/**
 * After the TLS handshake the client names the machine it meant to reach and
 * the server names itself: an address that now belongs to another member of
 * the same LAN must not receive the input meant for the first. The server
 * repeats the service it is about to serve, so a client learns from the
 * answer of a build that knows terminals only that it got a terminal.
 */
const HelloSchema = z.object({
  type: z.literal('hello'),
  version: z.number().int(),
  machineId: z.string().min(1),
  service: z.string().optional(),
});
const HelloRefusalSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
});

function writeLine(socket: net.Socket, value: unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

/**
 * The first line of a connection, and whatever followed it in the same chunk.
 * The socket is paused afterwards so nothing is lost before the next reader.
 */
function readFirstLine(socket: net.Socket): Promise<{ line: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('hello timed out')), HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();
    const finish = (error: Error | null, result?: { line: string; rest: Buffer }) => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onError);
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(0x0a);
      if (newline < 0) {
        if (received.length > HELLO_MAX_BYTES) finish(new Error('hello too large'));
        return;
      }
      socket.pause();
      finish(null, {
        line: received.subarray(0, newline).toString('utf8'),
        rest: received.subarray(newline + 1),
      });
    };
    const onClose = () => finish(new Error('connection closed during hello'));
    const onError = (error: Error) => finish(error);
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

function parseLine<T>(schema: z.ZodType<T>, line: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type LanTerminalConnection = {
  socket: tls.TLSSocket;
  /** The LAN whose key the client proved it holds. */
  lanId: string;
  /** What the client asked this connection to carry. */
  service: LanMemberService;
  /** What the client sent after its hello; the socket is paused. */
  initial: Buffer;
};

function isLanMemberService(value: string): value is LanMemberService {
  return (LAN_MEMBER_SERVICES as readonly string[]).includes(value);
}

/**
 * Accepts terminal connections from members of the LANs `keyFor` knows. A
 * connection reaches `onConnection` only after the TLS handshake with the
 * LAN's key and the hello both succeeded.
 */
export function createLanTerminalServer(options: {
  machineId: string;
  /** What this machine serves; a connection that asks for anything else is refused. */
  services: readonly LanMemberService[];
  keyFor: (lanId: string) => Buffer | null;
  onConnection: (connection: LanTerminalConnection) => void;
  logger: Logger;
}): tls.Server {
  const identities = new WeakMap<tls.TLSSocket, string>();
  const server = tls.createServer(
    {
      ...TLS_OPTIONS,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      pskCallback: (socket, identity) => {
        const key = options.keyFor(identity);
        if (key) identities.set(socket, identity);
        return key;
      },
    },
    (socket) => {
      const lanId = identities.get(socket);
      if (!lanId) {
        socket.destroy();
        return;
      }
      void (async () => {
        try {
          const { line, rest } = await readFirstLine(socket);
          const hello = parseLine(HelloSchema, line);
          if (!hello || hello.version !== LAN_TERMINAL_PROTOCOL_VERSION) {
            writeLine(socket, {
              type: 'error',
              code: 'unsupported_version',
              message: `This machine speaks terminal protocol ${LAN_TERMINAL_PROTOCOL_VERSION}`,
            });
            socket.end();
            return;
          }
          if (hello.machineId !== options.machineId) {
            writeLine(socket, {
              type: 'error',
              code: 'machine_mismatch',
              message: 'Another machine of this LAN answers at this address',
            });
            socket.end();
            return;
          }
          const service = hello.service ?? 'terminal';
          if (!isLanMemberService(service) || !options.services.includes(service)) {
            writeLine(socket, {
              type: 'error',
              code: 'unsupported_service',
              message: `This machine serves no ${service} to the members of its LANs`,
            });
            socket.end();
            return;
          }
          writeLine(socket, {
            type: 'hello',
            version: LAN_TERMINAL_PROTOCOL_VERSION,
            machineId: options.machineId,
            service,
          });
          socket.setKeepAlive(true, KEEPALIVE_MS);
          options.onConnection({ socket, lanId, service, initial: rest });
        } catch (error) {
          options.logger.debug(`[lan-terminal] hello failed: ${formatErrorMessage(error)}`);
          socket.destroy();
        }
      })();
    }
  );
  server.on('tlsClientError', (error) => {
    // A peer without the key of any LAN of this machine ends here.
    options.logger.debug(`[lan-terminal] rejected a connection: ${error.message}`);
  });
  return server;
}

type Pending =
  | {
      kind: 'list';
      resolve: (terminals: TerminalSnapshot[]) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  | {
      kind: 'open';
      resolve: (result: TerminalOpenResult) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  | {
      kind: 'attach';
      scrollback: string;
      resolve: (replay: TerminalReplay) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    };

type PendingEntry = Pending extends infer Entry
  ? Entry extends Pending
    ? Omit<Entry, 'timer'>
    : never
  : never;

class LanTerminalLink implements RemoteTerminalLink {
  closed = false;
  private sequence = 0;
  private buffer = '';
  private readonly decode = createUtf8StreamDecoder();
  private readonly pending = new Map<string, Pending>();
  private readonly handlers = new Set<(event: TerminalServerEvent) => void>();
  private readonly closeHandlers = new Set<(reason: string) => void>();
  private closeReason = 'connection closed';

  constructor(
    private readonly socket: tls.TLSSocket,
    initial: Buffer
  ) {
    socket.setKeepAlive(true, KEEPALIVE_MS);
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('error', (error) => {
      this.closeReason = error.message;
    });
    socket.on('close', () => this.onClosed());
    if (initial.length > 0) this.receive(initial);
    socket.resume();
  }

  list(sessionId: string): Promise<TerminalSnapshot[]> {
    return new Promise((resolve, reject) => {
      const requestId = this.register({ kind: 'list', resolve, reject });
      this.write({ type: 'list', requestId, sessionId });
    });
  }

  open(params: TerminalOpenParams): Promise<TerminalOpenResult> {
    return new Promise((resolve, reject) => {
      const requestId = this.register({ kind: 'open', resolve, reject });
      // Only the fields of an open: the caller's message may carry its own request id.
      const { sessionId, cols, rows } = params;
      this.write({ type: 'open', requestId, sessionId, cols, rows });
    });
  }

  attach(terminalId: string, cols: number, rows: number): Promise<TerminalReplay> {
    return new Promise((resolve, reject) => {
      const requestId = this.register({ kind: 'attach', scrollback: '', resolve, reject });
      this.write({ type: 'attach', requestId, terminalId, cols, rows });
    });
  }

  send(command: RemoteTerminalCommand): void {
    this.write(command);
  }

  onEvent(handler: (event: TerminalServerEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onClose(handler: (reason: string) => void): () => void {
    if (this.closed) {
      handler(this.closeReason);
      return () => {};
    }
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  close(): void {
    this.closeReason = 'closed by this machine';
    this.socket.destroy();
  }

  private register(entry: PendingEntry): string {
    const requestId = String(++this.sequence);
    if (this.closed) {
      entry.reject(new Error(`remote_unreachable:${this.closeReason}`));
      return requestId;
    }
    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      entry.reject(new Error('remote_unreachable:the machine did not answer in time'));
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    this.pending.set(requestId, { ...entry, timer } as Pending);
    return requestId;
  }

  private write(message: TerminalClientMessage): void {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: Buffer): void {
    this.buffer += this.decode(chunk);
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        const event = parseLine(TerminalServerEventSchema, line);
        if (!event) {
          this.closeReason = 'the machine sent an invalid terminal event';
          this.socket.destroy();
          return;
        }
        this.handle(event);
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private handle(event: TerminalServerEvent): void {
    const pending = event.requestId ? this.pending.get(event.requestId) : undefined;
    if (!pending || !event.requestId) {
      for (const handler of this.handlers) handler(event);
      return;
    }
    if (event.type === 'error') {
      this.settle(event.requestId, pending);
      const prefix = `${event.code}:`;
      pending.reject(
        new Error(event.message.startsWith(prefix) ? event.message : `${prefix}${event.message}`)
      );
      return;
    }
    if (pending.kind === 'attach') {
      // The replay goes to whoever attached, not to every viewer of the terminal.
      if (event.type === 'data') {
        pending.scrollback += event.data;
      } else if (event.type === 'title') {
        this.settle(event.requestId, pending);
        pending.resolve({ title: event.title, scrollback: pending.scrollback });
      }
      return;
    }
    if (pending.kind === 'list' && event.type === 'terminals') {
      this.settle(event.requestId, pending);
      pending.resolve(event.terminals);
    } else if (pending.kind === 'open' && event.type === 'opened') {
      this.settle(event.requestId, pending);
      pending.resolve({ terminalId: event.terminalId, ...(event.cwd ? { cwd: event.cwd } : {}) });
    }
  }

  private settle(requestId: string, pending: Pending): void {
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
  }

  private onClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [requestId, pending] of this.pending) {
      this.settle(requestId, pending);
      pending.reject(new Error(`remote_unreachable:${this.closeReason}`));
    }
    for (const handler of this.closeHandlers) handler(this.closeReason);
    this.closeHandlers.clear();
  }
}

export type LanMemberConnectOptions = {
  endpoint: LanTerminalEndpoint;
  lanId: string;
  key: Buffer;
  /** The machine expected at the endpoint. */
  machineId: string;
};

/**
 * Connects to one member of a LAN for one service. The socket is paused and
 * `rest` is what the member sent after its hello.
 */
export async function connectLanMember(
  options: LanMemberConnectOptions & { service: LanMemberService }
): Promise<{ socket: tls.TLSSocket; rest: Buffer }> {
  const socket = tls.connect({
    ...TLS_OPTIONS,
    host: options.endpoint.host,
    port: options.endpoint.port,
    pskCallback: () => ({ psk: options.key, identity: options.lanId }),
    // There is no certificate: the key authenticates the server.
    checkServerIdentity: () => undefined,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    writeLine(socket, {
      type: 'hello',
      version: LAN_TERMINAL_PROTOCOL_VERSION,
      machineId: options.machineId,
      service: options.service,
    });
    const { line, rest } = await readFirstLine(socket);
    const refusal = parseLine(HelloRefusalSchema, line);
    if (refusal) throw new Error(refusal.message);
    const hello = parseLine(HelloSchema, line);
    if (!hello || hello.machineId !== options.machineId) {
      throw new Error('another machine answered');
    }
    // A build from before services answers every hello as a terminal.
    if ((hello.service ?? 'terminal') !== options.service) {
      throw new Error(`the machine serves no ${options.service}; update it`);
    }
    return { socket, rest };
  } catch (error) {
    socket.destroy();
    throw new Error(
      `remote_unreachable:${options.endpoint.host}:${options.endpoint.port}: ${formatErrorMessage(error)}`,
      { cause: error }
    );
  }
}

/** Connects to the terminals of one member of a LAN. */
export async function connectLanTerminal(
  options: LanMemberConnectOptions
): Promise<RemoteTerminalLink> {
  const { socket, rest } = await connectLanMember({ ...options, service: 'terminal' });
  return new LanTerminalLink(socket, rest);
}

/**
 * The address of this machine on the way to a hub, which is the address the
 * other members of that LAN, who reach the same hub, are most likely to reach.
 */
export function probeLocalAddressToward(hubUrl: string, timeoutMs = 5_000): Promise<string | null> {
  let target: URL;
  try {
    target = new URL(hubUrl);
  } catch {
    return Promise.resolve(null);
  }
  const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (address: string | null) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(address);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => {
      const address = socket.localAddress;
      finish(address ? address.replace(/^::ffff:/, '') : null);
    });
    socket.once('error', () => finish(null));
  });
}
