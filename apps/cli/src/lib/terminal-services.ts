import {
  parseMachineShellScope,
  type TerminalOpenParams,
  type TerminalOpenResult,
  type TerminalServerEvent,
  type TerminalSnapshot,
} from '@lody/shared';
import type { TerminalReplay, TerminalService } from '@/lib/terminal-connection';
import type { TerminalPtyServiceApi } from '@/lib/terminal-pty-service';
import { formatErrorMessage } from '@/utils/format-error';

type EventHandler = (event: TerminalServerEvent) => void;

/** A message to a remote terminal that expects no answer. */
export type RemoteTerminalCommand =
  | { type: 'input'; terminalId: string; data: string }
  | { type: 'resize'; terminalId: string; cols: number; rows: number }
  | { type: 'close'; terminalId: string }
  | { type: 'close_session'; sessionId: string };

/** One connection to the terminals of another machine. */
export interface RemoteTerminalLink {
  readonly closed: boolean;
  list(sessionId: string): Promise<TerminalSnapshot[]>;
  open(params: TerminalOpenParams): Promise<TerminalOpenResult>;
  attach(terminalId: string, cols: number, rows: number): Promise<TerminalReplay>;
  send(command: RemoteTerminalCommand): void;
  /** Live events of the terminals this link attached; replays are returned by `attach`. */
  onEvent(handler: EventHandler): () => void;
  onClose(handler: (reason: string) => void): () => void;
  close(): void;
}

export type TerminalSessionLocation = { workspaceId: string; machineId: string };

/**
 * The terminals a desktop of this machine reaches: its own, and those of the
 * LAN members that own the sessions it shows. A terminal is routed by the
 * machine that owns its session, and stays with the connection that listed or
 * opened it.
 */
export class TerminalRouter implements TerminalService {
  private readonly handlers = new Set<EventHandler>();
  private readonly links = new Map<string, Promise<RemoteTerminalLink>>();
  private readonly terminals = new Map<string, RemoteTerminalLink>();
  private readonly sessions = new Map<string, RemoteTerminalLink>();
  private readonly unsubscribeLocal: () => void;

  constructor(
    private readonly options: {
      local: TerminalPtyServiceApi;
      machineId: string;
      /** The workspace and machine of a session this machine knows. */
      locate: (sessionId: string) => Promise<TerminalSessionLocation | null>;
      /** Absent where no other machine can be reached. */
      connect?: (location: TerminalSessionLocation) => Promise<RemoteTerminalLink>;
    }
  ) {
    this.unsubscribeLocal = options.local.onEvent((event) => this.emit(event));
  }

  async list(sessionId: string): Promise<TerminalSnapshot[]> {
    const link = await this.route(sessionId);
    if (!link) return this.options.local.list(sessionId);
    const terminals = await link.list(sessionId);
    this.sessions.set(sessionId, link);
    for (const terminal of terminals) this.terminals.set(terminal.terminalId, link);
    return terminals;
  }

  async open(params: TerminalOpenParams): Promise<TerminalOpenResult> {
    const link = await this.route(params.sessionId);
    if (!link) return await this.options.local.open(params);
    const result = await link.open(params);
    this.sessions.set(params.sessionId, link);
    this.terminals.set(result.terminalId, link);
    return result;
  }

  async attach(terminalId: string, cols: number, rows: number): Promise<TerminalReplay> {
    const link = this.terminals.get(terminalId);
    if (link) return await link.attach(terminalId, cols, rows);
    return this.options.local.attach(terminalId, cols, rows);
  }

  input(terminalId: string, data: string): void {
    const link = this.terminals.get(terminalId);
    if (link) link.send({ type: 'input', terminalId, data });
    else this.options.local.input(terminalId, data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const link = this.terminals.get(terminalId);
    if (link) link.send({ type: 'resize', terminalId, cols, rows });
    else this.options.local.resize(terminalId, cols, rows);
  }

  close(terminalId: string): void {
    const link = this.terminals.get(terminalId);
    if (link) link.send({ type: 'close', terminalId });
    else this.options.local.close(terminalId);
  }

  closeSession(sessionId: string): void {
    const link = this.sessions.get(sessionId);
    if (link) link.send({ type: 'close_session', sessionId });
    else this.options.local.closeSession(sessionId);
  }

  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  dispose(): void {
    this.unsubscribeLocal();
    for (const pending of this.links.values()) {
      void pending.then((link) => link.close()).catch(() => undefined);
    }
    this.links.clear();
  }

  /** `null` for a session this machine owns, or one it cannot place. */
  private async route(sessionId: string): Promise<RemoteTerminalLink | null> {
    const { connect, locate, machineId } = this.options;
    if (!connect) return null;
    const location = await locate(sessionId);
    if (!location || location.machineId === machineId) return null;
    return await this.linkFor(location, connect);
  }

  private async linkFor(
    location: TerminalSessionLocation,
    connect: (location: TerminalSessionLocation) => Promise<RemoteTerminalLink>
  ): Promise<RemoteTerminalLink> {
    const key = `${location.workspaceId}\u0000${location.machineId}`;
    const existing = this.links.get(key);
    if (existing) {
      const link = await existing.catch(() => null);
      if (link && !link.closed) return link;
      if (this.links.get(key) === existing) this.links.delete(key);
    }

    const pending = connect(location).then(
      (link) => {
        this.adopt(key, link);
        return link;
      },
      (error: unknown) => {
        const message = formatErrorMessage(error);
        throw new Error(
          message.startsWith('remote_unreachable:') ? message : `remote_unreachable:${message}`
        );
      }
    );
    this.links.set(key, pending);
    pending.catch(() => {
      if (this.links.get(key) === pending) this.links.delete(key);
    });
    return await pending;
  }

  private adopt(key: string, link: RemoteTerminalLink): void {
    link.onEvent((event) => {
      if (event.type === 'exit') this.terminals.delete(event.terminalId);
      this.emit(event);
    });
    link.onClose(() => {
      const pending = this.links.get(key);
      void pending
        ?.then((current) => {
          if (current === link && this.links.get(key) === pending) this.links.delete(key);
        })
        .catch(() => undefined);
      // The terminals may still run over there, but nothing here reaches them
      // any more; listing the session again finds them.
      for (const [terminalId, owner] of [...this.terminals]) {
        if (owner !== link) continue;
        this.terminals.delete(terminalId);
        this.emit({ type: 'exit', terminalId, exitCode: -1, signal: 'disconnected' });
      }
      for (const [sessionId, owner] of [...this.sessions]) {
        if (owner === link) this.sessions.delete(sessionId);
      }
    });
  }

  private emit(event: TerminalServerEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}

/**
 * The terminals of this machine as another member of one LAN reaches them:
 * only sessions of that LAN's workspace owned by this machine, the shells of
 * this machine, and only terminals this connection listed, opened or attached.
 */
export class ScopedTerminalService implements TerminalService {
  private readonly admittedSessions = new Set<string>();
  private readonly admittedTerminals = new Set<string>();

  constructor(
    private readonly pty: TerminalPtyServiceApi,
    /** Throws the terminal error to answer with when the session is not reachable. */
    private readonly verifySession: (sessionId: string) => Promise<void>,
    /**
     * This machine, whose shells a member may open: it holds the LAN's key and
     * could open a shell in any session of the machine already. Absent where
     * no shell of the machine is opened.
     */
    private readonly shellMachineId?: string
  ) {}

  async list(sessionId: string): Promise<TerminalSnapshot[]> {
    await this.admitSession(sessionId);
    const terminals = this.pty.list(sessionId);
    for (const terminal of terminals) this.admittedTerminals.add(terminal.terminalId);
    return terminals;
  }

  async open(params: TerminalOpenParams): Promise<TerminalOpenResult> {
    await this.admitSession(params.sessionId);
    const result = await this.pty.open(params);
    this.admittedTerminals.add(result.terminalId);
    return result;
  }

  async attach(terminalId: string, cols: number, rows: number): Promise<TerminalReplay> {
    if (!this.admittedTerminals.has(terminalId)) {
      const sessionId = this.pty.sessionOf(terminalId);
      if (!sessionId) throw new Error(`terminal_not_found:${terminalId}`);
      await this.admitSession(sessionId);
      this.admittedTerminals.add(terminalId);
    }
    return this.pty.attach(terminalId, cols, rows);
  }

  input(terminalId: string, data: string): void {
    this.pty.input(this.admitted(terminalId), data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.pty.resize(this.admitted(terminalId), cols, rows);
  }

  close(terminalId: string): void {
    this.pty.close(this.admitted(terminalId));
  }

  closeSession(sessionId: string): void {
    if (!this.admittedSessions.has(sessionId)) throw new Error(`session_not_found:${sessionId}`);
    this.pty.closeSession(sessionId);
  }

  onEvent(handler: EventHandler): () => void {
    // The connection forwards only the events of terminals it attached.
    return this.pty.onEvent(handler);
  }

  private async admitSession(sessionId: string): Promise<void> {
    if (this.admittedSessions.has(sessionId)) return;
    const shellMachineId = parseMachineShellScope(sessionId);
    if (shellMachineId !== null) {
      if (!this.shellMachineId) throw new Error(`session_not_found:${sessionId}`);
      if (shellMachineId !== this.shellMachineId) {
        throw new Error(`session_machine_mismatch:${sessionId}:${shellMachineId}`);
      }
    } else {
      await this.verifySession(sessionId);
    }
    this.admittedSessions.add(sessionId);
  }

  private admitted(terminalId: string): string {
    if (!this.admittedTerminals.has(terminalId)) {
      throw new Error(`terminal_not_found:${terminalId}`);
    }
    return terminalId;
  }
}
