import type net from 'node:net';
import {
  createUtf8StreamDecoder,
  TerminalClientMessageSchema,
  type TerminalClientMessage,
  type TerminalOpenParams,
  type TerminalOpenResult,
  type TerminalServerEvent,
  type TerminalSnapshot,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

const MAX_BUFFER_BYTES = 1024 * 1024;

export type TerminalReplay = {
  title: string;
  scrollback: string;
};

/**
 * What a terminal connection is served from: the terminals of this machine,
 * or, for a desktop of this machine, also the terminals of other LAN members.
 * Operations on a terminal a connection never listed, opened or attached may
 * be refused, so they stay synchronous.
 */
export interface TerminalService {
  list(sessionId: string): Promise<TerminalSnapshot[]>;
  open(params: TerminalOpenParams): Promise<TerminalOpenResult>;
  attach(terminalId: string, cols: number, rows: number): Promise<TerminalReplay>;
  input(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  close(terminalId: string): void;
  closeSession(sessionId: string): void;
  onEvent(handler: (event: TerminalServerEvent) => void): () => void;
}

type TerminalSocketState = {
  subscribedTerminalIds: Set<string>;
  replayingTerminalIds: Set<string>;
  replayBuffers: Map<string, TerminalServerEvent[]>;
  /** Opens with `attach` under way: their terminals are not known yet. */
  attachingOpens: number;
  /** Events of terminals nobody here attached, kept while such an open is under way. */
  openBuffer: TerminalServerEvent[];
};

// Outbound events are built by trusted internal code (each `send()` call site is
// typed against TerminalServerEvent), so we skip a per-chunk schema re-validation
// here — it would run a full discriminated-union parse on every PTY output chunk
// on the CPU-sensitive CLI main thread. Inbound client messages are still
// validated at the trust boundary in the socket 'data' handler below.
function encodeEvent(event: TerminalServerEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function send(socket: net.Socket, event: TerminalServerEvent): void {
  if (socket.destroyed) return;
  socket.write(encodeEvent(event));
}

function getEventTerminalId(event: TerminalServerEvent): string | null {
  return 'terminalId' in event && typeof event.terminalId === 'string' ? event.terminalId : null;
}

function publishTerminalEvent(
  socket: net.Socket,
  state: TerminalSocketState,
  event: TerminalServerEvent
): void {
  const terminalId = getEventTerminalId(event);
  if (!terminalId) {
    send(socket, event);
    return;
  }
  if (!state.subscribedTerminalIds.has(terminalId)) {
    // It may be the terminal an open with `attach` is creating.
    if (state.attachingOpens > 0) state.openBuffer.push(event);
    return;
  }
  if (state.replayingTerminalIds.has(terminalId)) {
    const buffer = state.replayBuffers.get(terminalId) ?? [];
    buffer.push(event);
    state.replayBuffers.set(terminalId, buffer);
    return;
  }
  send(socket, event);
  if (event.type === 'exit') {
    state.subscribedTerminalIds.delete(terminalId);
  }
}

function startTerminalReplay(state: TerminalSocketState, terminalId: string): void {
  state.subscribedTerminalIds.add(terminalId);
  state.replayingTerminalIds.add(terminalId);
  state.replayBuffers.set(terminalId, []);
}

function finishTerminalReplay(
  socket: net.Socket,
  state: TerminalSocketState,
  terminalId: string
): void {
  state.replayingTerminalIds.delete(terminalId);
  const bufferedEvents = state.replayBuffers.get(terminalId) ?? [];
  state.replayBuffers.delete(terminalId);
  for (const event of bufferedEvents) {
    send(socket, event);
    if (event.type === 'exit') {
      state.subscribedTerminalIds.delete(terminalId);
    }
  }
}

function cancelTerminalReplay(state: TerminalSocketState, terminalId: string): void {
  state.replayingTerminalIds.delete(terminalId);
  state.replayBuffers.delete(terminalId);
  state.subscribedTerminalIds.delete(terminalId);
}

const ERROR_CODES = [
  'session_not_found',
  'session_archived',
  'session_deleted',
  'session_machine_mismatch',
  'session_parent_cycle',
  'session_ambiguous',
  'terminal_not_found',
  'terminal_limit_exceeded',
  'remote_unreachable',
] as const;

function classifyTerminalError(error: unknown): { code: string; message: string } {
  const message = formatErrorMessage(error);
  const code = ERROR_CODES.find((candidate) => message.startsWith(`${candidate}:`));
  if (code) {
    return { code, message };
  }
  if (message.includes('workdir') || message.includes('directory') || message.includes('ENOENT')) {
    return { code: 'workdir_unavailable', message };
  }
  return { code: 'terminal_error', message };
}

async function handleMessage(
  service: TerminalService,
  socket: net.Socket,
  state: TerminalSocketState,
  message: TerminalClientMessage
): Promise<void> {
  try {
    switch (message.type) {
      case 'list': {
        send(socket, {
          type: 'terminals',
          requestId: message.requestId,
          sessionId: message.sessionId,
          terminals: await service.list(message.sessionId),
        });
        return;
      }
      case 'open': {
        if (!message.attach) {
          const result = await service.open(message);
          send(socket, {
            type: 'opened',
            requestId: message.requestId,
            terminalId: result.terminalId,
            ...(result.cwd ? { cwd: result.cwd } : {}),
          });
          return;
        }
        state.attachingOpens += 1;
        let result: TerminalOpenResult;
        try {
          result = await service.open(message);
        } finally {
          state.attachingOpens -= 1;
        }
        const { terminalId } = result;
        const early = state.openBuffer.filter((event) => getEventTerminalId(event) === terminalId);
        state.openBuffer =
          state.attachingOpens > 0
            ? state.openBuffer.filter((event) => getEventTerminalId(event) !== terminalId)
            : [];
        // A service that cannot say its events reach here leaves it to `attach`.
        if (result.attached) state.subscribedTerminalIds.add(terminalId);
        send(socket, {
          type: 'opened',
          requestId: message.requestId,
          terminalId,
          ...(result.cwd ? { cwd: result.cwd } : {}),
          ...(result.attached ? { attached: true } : {}),
        });
        if (result.attached) {
          for (const event of early) publishTerminalEvent(socket, state, event);
        }
        return;
      }
      case 'attach': {
        startTerminalReplay(state, message.terminalId);
        try {
          const replay = await service.attach(message.terminalId, message.cols, message.rows);
          // The title closes a replay: a client that asked with a request id
          // knows the scrollback before it is complete.
          if (replay.scrollback) {
            send(socket, {
              type: 'data',
              requestId: message.requestId,
              terminalId: message.terminalId,
              data: replay.scrollback,
              replay: true,
            });
          }
          send(socket, {
            type: 'title',
            requestId: message.requestId,
            terminalId: message.terminalId,
            title: replay.title,
          });
          finishTerminalReplay(socket, state, message.terminalId);
        } catch (error) {
          cancelTerminalReplay(state, message.terminalId);
          throw error;
        }
        return;
      }
      case 'input': {
        service.input(message.terminalId, message.data);
        return;
      }
      case 'resize': {
        service.resize(message.terminalId, message.cols, message.rows);
        return;
      }
      case 'close': {
        service.close(message.terminalId);
        return;
      }
      case 'close_session': {
        service.closeSession(message.sessionId);
        return;
      }
      default: {
        throw new Error(`unsupported_terminal_message:${JSON.stringify(message)}`);
      }
    }
  } catch (error) {
    const terminalError = classifyTerminalError(error);
    send(socket, {
      type: 'error',
      requestId: message.requestId,
      ...('terminalId' in message ? { terminalId: message.terminalId } : {}),
      code: terminalError.code,
      message: terminalError.message,
    });
  }
}

/**
 * Serves the terminal protocol on one connection: newline-delimited client
 * messages in, server events out, with each terminal's events delivered only
 * after the connection attached it. `initial` is what arrived before the
 * connection was handed over.
 */
export function serveTerminalConnection(
  socket: net.Socket,
  options: { service: TerminalService; logger: Logger; initial?: Buffer }
): void {
  const { service, logger } = options;
  let buffer = '';
  // One decoder per connection: a pasted multi-byte character can land on a
  // socket chunk boundary, and per-chunk `toString('utf8')` would turn it into
  // U+FFFD on both sides of the split.
  const decodeChunk = createUtf8StreamDecoder();
  const state: TerminalSocketState = {
    subscribedTerminalIds: new Set<string>(),
    replayingTerminalIds: new Set<string>(),
    replayBuffers: new Map<string, TerminalServerEvent[]>(),
    attachingOpens: 0,
    openBuffer: [],
  };
  const unsubscribe = service.onEvent((event) => {
    publishTerminalEvent(socket, state, event);
  });

  const receive = (chunk: Buffer) => {
    buffer += decodeChunk(chunk);
    // Compare char length (O(1)) rather than re-scanning the whole buffer with
    // Buffer.byteLength on every chunk (O(n²) across a large multi-chunk paste).
    // This is a safety cap against an unbounded line, so an approximate bound is fine.
    if (buffer.length > MAX_BUFFER_BYTES) {
      send(socket, {
        type: 'error',
        code: 'payload_too_large',
        message: 'Terminal socket payload exceeded buffer limit',
      });
      socket.destroy();
      return;
    }

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch (error) {
          send(socket, {
            type: 'error',
            code: 'invalid_json',
            message: formatErrorMessage(error),
          });
          newlineIndex = buffer.indexOf('\n');
          continue;
        }

        const parsed = TerminalClientMessageSchema.safeParse(raw);
        if (!parsed.success) {
          send(socket, {
            type: 'error',
            code: 'invalid_request',
            message: parsed.error.message,
          });
          newlineIndex = buffer.indexOf('\n');
          continue;
        }

        void handleMessage(service, socket, state, parsed.data);
      }
      newlineIndex = buffer.indexOf('\n');
    }
  };

  socket.on('data', receive);
  socket.on('close', () => {
    unsubscribe();
  });
  socket.on('error', (error) => {
    logger.debug(`[terminal] socket error: ${error.message}`);
  });
  if (options.initial && options.initial.length > 0) {
    receive(options.initial);
  }
}
