import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore, type WorkspaceSummary } from '@lody/platform';
import type {
  TerminalOpenParams,
  TerminalOpenResult,
  TerminalServerEvent,
  TerminalSnapshot,
} from '@lody/shared';
import { getLanHubWorkspaceId } from '@lody/shared/lan-hub';
import type { LanTerminalEndpoint } from '@lody/shared/lan-terminal';
import { addLanHub, type LanHub } from '@lody/shared/node/lan-hub';
import { serveTerminalConnection, type TerminalReplay } from '@/lib/terminal-connection';
import type { TerminalPtyServiceApi } from '@/lib/terminal-pty-service';
import { ScopedTerminalService, TerminalRouter } from '@/lib/terminal-services';
import type { Logger } from '@/utils/logger';
import { connectLanTerminal, deriveLanTerminalKey } from './lan-terminal';
import { LanTerminalHost, resolveLanTerminalPort } from './lan-terminal-host';

const silentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  setDebug: () => {},
  child: () => silentLogger(),
  close: async () => {},
});

/** Terminals kept in memory: input comes back as output, as a shell's echo would. */
class FakePty implements TerminalPtyServiceApi {
  readonly inputs: Array<[string, string]> = [];
  readonly opened: string[] = [];
  private readonly terminals = new Map<string, { sessionId: string; scrollback: string }>();
  private readonly handlers = new Set<(event: TerminalServerEvent) => void>();
  private sequence = 0;

  constructor(private readonly name: string) {}

  list(sessionId: string): TerminalSnapshot[] {
    return [...this.terminals]
      .filter(([, terminal]) => terminal.sessionId === sessionId)
      .map(([terminalId]) => ({ terminalId, title: this.name }));
  }

  async open(params: TerminalOpenParams): Promise<TerminalOpenResult> {
    const terminalId = `${this.name}-${++this.sequence}`;
    this.terminals.set(terminalId, { sessionId: params.sessionId, scrollback: '$ ' });
    this.opened.push(params.sessionId);
    return { terminalId, cwd: `/${this.name}` };
  }

  attach(terminalId: string): TerminalReplay {
    return { title: this.name, scrollback: this.require(terminalId).scrollback };
  }

  input(terminalId: string, data: string): void {
    const terminal = this.require(terminalId);
    this.inputs.push([terminalId, data]);
    terminal.scrollback += data;
    this.emit({ type: 'data', terminalId, data });
  }

  resize(terminalId: string): void {
    this.require(terminalId);
  }

  close(terminalId: string): void {
    this.require(terminalId);
    this.terminals.delete(terminalId);
    this.emit({ type: 'exit', terminalId, exitCode: 0 });
  }

  closeSession(sessionId: string): void {
    for (const [terminalId, terminal] of [...this.terminals]) {
      if (terminal.sessionId === sessionId) this.close(terminalId);
    }
  }

  closeAll(): void {}

  sessionOf(terminalId: string): string | null {
    return this.terminals.get(terminalId)?.sessionId ?? null;
  }

  onEvent(handler: (event: TerminalServerEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private require(terminalId: string) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`terminal_not_found:${terminalId}`);
    return terminal;
  }

  private emit(event: TerminalServerEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}

const lanHub = (name: string, token: string): LanHub =>
  addLanHub([], { name, url: 'http://127.0.0.1:8788', token }).hub;

const home = lanHub('Home', 'home-credential');
const office = lanHub('Office', 'office-credential');
const HOME = getLanHubWorkspaceId(home.id);

const SERVER = 'server-machine';
const CLIENT = 'client-machine';

/** Sessions of the server machine in the Home LAN; anything else is refused. */
async function verifyHomeSession(sessionId: string): Promise<void> {
  if (sessionId === 'home-session') return;
  if (sessionId === 'client-session') {
    throw new Error(`session_machine_mismatch:${sessionId}:${CLIENT}`);
  }
  throw new Error(`session_not_found:${sessionId}`);
}

function nextEvent(
  router: TerminalRouter,
  matches: (event: TerminalServerEvent) => boolean
): Promise<TerminalServerEvent> {
  return new Promise((resolve) => {
    const off = router.onEvent((event) => {
      if (!matches(event)) return;
      off();
      resolve(event);
    });
  });
}

describe('terminals between LAN members', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function startServer(options: { port?: number } = {}) {
    const pty = new FakePty('server');
    const published = new Map<string, LanTerminalEndpoint | undefined>();
    const host = new LanTerminalHost({
      machineId: SERVER,
      logger: silentLogger(),
      lans: {
        hubs: [home],
        workspaces: createStore<readonly WorkspaceSummary[]>([]),
      },
      port: options.port ?? 0,
      probeAddress: async () => '127.0.0.1',
      serviceFor: (workspaceId) =>
        workspaceId === HOME ? new ScopedTerminalService(pty, verifyHomeSession) : null,
      publish: async (workspaceId, endpoint) => {
        published.set(workspaceId, endpoint);
      },
    });
    cleanups.push(() => host.close());
    await host.refresh();
    return { pty, host, published };
  }

  function startClient(
    endpoint: LanTerminalEndpoint,
    options: { hub?: LanHub; token?: string; expectMachine?: string } = {}
  ) {
    const local = new FakePty('client');
    const hub = options.hub ?? home;
    const router = new TerminalRouter({
      local,
      machineId: CLIENT,
      locate: async (sessionId) =>
        sessionId === 'local-session'
          ? { workspaceId: HOME, machineId: CLIENT }
          : { workspaceId: HOME, machineId: SERVER },
      connect: async () =>
        await connectLanTerminal({
          endpoint,
          lanId: hub.id,
          key: deriveLanTerminalKey(options.token ?? hub.token),
          machineId: options.expectMachine ?? SERVER,
        }),
    });
    cleanups.push(() => router.dispose());
    return { local, router };
  }

  it('publishes where it accepts terminals and serves a member end to end', async () => {
    const { pty, published } = await startServer();
    const endpoint = published.get(HOME);
    expect(endpoint).toMatchObject({ version: 1, host: '127.0.0.1' });

    const { router, local } = startClient(endpoint!);
    const { terminalId } = await router.open({ sessionId: 'home-session', cols: 80, rows: 24 });
    expect(pty.opened).toEqual(['home-session']);
    expect(local.opened).toEqual([]);

    expect(await router.attach(terminalId, 80, 24)).toEqual({ title: 'server', scrollback: '$ ' });
    const echoed = nextEvent(router, (event) => event.type === 'data');
    router.input(terminalId, 'ls\r');
    expect(await echoed).toEqual({ type: 'data', terminalId, data: 'ls\r' });
    expect(pty.inputs).toEqual([[terminalId, 'ls\r']]);

    expect(await router.list('home-session')).toEqual([{ terminalId, title: 'server' }]);
    const exited = nextEvent(router, (event) => event.type === 'exit');
    router.close(terminalId);
    expect(await exited).toEqual({ type: 'exit', terminalId, exitCode: 0 });
  });

  it('serves a desktop through the local terminal socket', async () => {
    const { published, pty } = await startServer();
    const { router } = startClient(published.get(HOME)!);
    // The local socket of this machine, as the desktop's relay reaches it.
    const localSocket = net.createServer((socket) =>
      serveTerminalConnection(socket, { service: router, logger: silentLogger() })
    );
    await new Promise<void>((resolve) => localSocket.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => localSocket.close(() => resolve())));
    const desktop = net.connect((localSocket.address() as net.AddressInfo).port, '127.0.0.1');
    cleanups.push(() => desktop.destroy());
    const received: Array<Record<string, unknown>> = [];
    const waiters: Array<() => void> = [];
    let buffer = '';
    desktop.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        received.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
        buffer = buffer.slice(newline + 1);
      }
      for (const wake of waiters.splice(0)) wake();
    });
    const request = (message: Record<string, unknown>) =>
      desktop.write(`${JSON.stringify(message)}\n`);
    const answer = async (matches: (event: Record<string, unknown>) => boolean) => {
      for (;;) {
        const found = received.find(matches);
        if (found) return found;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    };

    // The desktop's messages carry request ids of their own.
    request({
      type: 'open',
      requestId: 'desktop-1',
      sessionId: 'home-session',
      cols: 80,
      rows: 24,
    });
    const opened = await answer((event) => event.requestId === 'desktop-1');
    expect(opened).toMatchObject({ type: 'opened', terminalId: 'server-1' });
    request({ type: 'attach', requestId: 'desktop-2', terminalId: 'server-1', cols: 80, rows: 24 });
    // The replay arrives before the title that closes it.
    const title = await answer((event) => event.type === 'title');
    const replay = received.find((event) => event.type === 'data');
    expect(received.indexOf(replay!)).toBeLessThan(received.indexOf(title));
    expect(replay).toMatchObject({ data: '$ ', replay: true, terminalId: 'server-1' });
    request({ type: 'input', terminalId: 'server-1', data: 'pwd\r' });
    expect(await answer((event) => event.data === 'pwd\r')).toMatchObject({ type: 'data' });
    expect(pty.inputs).toEqual([['server-1', 'pwd\r']]);
  });

  it('keeps a session of this machine on this machine', async () => {
    const { published, pty } = await startServer();
    const { router, local } = startClient(published.get(HOME)!);

    await router.open({ sessionId: 'local-session', cols: 80, rows: 24 });

    expect(local.opened).toEqual(['local-session']);
    expect(pty.opened).toEqual([]);
  });

  it('gives the replay of a terminal only to whoever attached it', async () => {
    const { published } = await startServer();
    const { router } = startClient(published.get(HOME)!);
    const { terminalId } = await router.open({ sessionId: 'home-session', cols: 80, rows: 24 });
    const seen: TerminalServerEvent[] = [];
    router.onEvent((event) => seen.push(event));

    await router.attach(terminalId, 80, 24);
    await router.attach(terminalId, 100, 30);

    expect(seen).toEqual([]);
  });

  it('refuses a machine that does not hold the credential of the LAN', async () => {
    const { published, pty } = await startServer();
    const { router } = startClient(published.get(HOME)!, { token: 'guessed-credential' });

    await expect(router.open({ sessionId: 'home-session', cols: 80, rows: 24 })).rejects.toThrow(
      /^remote_unreachable:/
    );
    expect(pty.opened).toEqual([]);
  });

  it('refuses a LAN the machine is not a member of', async () => {
    const { published, pty } = await startServer();
    const { router } = startClient(published.get(HOME)!, { hub: office });

    await expect(router.open({ sessionId: 'home-session', cols: 80, rows: 24 })).rejects.toThrow(
      /^remote_unreachable:/
    );
    expect(pty.opened).toEqual([]);
  });

  it('refuses sessions outside the LAN and terminals it never handed out', async () => {
    const { published } = await startServer();
    const { router } = startClient(published.get(HOME)!);

    await expect(router.open({ sessionId: 'client-session', cols: 80, rows: 24 })).rejects.toThrow(
      /^session_machine_mismatch:/
    );
    await expect(router.list('unknown-session')).rejects.toThrow(/^session_not_found:/);
  });

  it('refuses terminals of other sessions even to a member that names them', async () => {
    const { published, pty } = await startServer();
    const hidden = await pty.open({ sessionId: 'elsewhere', cols: 80, rows: 24 });
    const link = await connectLanTerminal({
      endpoint: published.get(HOME)!,
      lanId: home.id,
      key: deriveLanTerminalKey(home.token),
      machineId: SERVER,
    });
    cleanups.push(() => link.close());
    const refused = new Promise<TerminalServerEvent>((resolve) => link.onEvent(resolve));

    await expect(link.attach(hidden.terminalId, 80, 24)).rejects.toThrow(/^session_not_found:/);
    link.send({ type: 'input', terminalId: hidden.terminalId, data: 'rm -rf ~\r' });

    expect(await refused).toMatchObject({ type: 'error', code: 'terminal_not_found' });
    expect(pty.inputs).toEqual([]);
  });

  it('does not talk to another machine that answers at the address', async () => {
    const { published, pty } = await startServer();
    const { router } = startClient(published.get(HOME)!, { expectMachine: 'another-machine' });

    await expect(router.open({ sessionId: 'home-session', cols: 80, rows: 24 })).rejects.toThrow(
      /another machine/i
    );
    expect(pty.opened).toEqual([]);
  });

  it('ends the terminals of a machine that goes away and reaches it again later', async () => {
    const { published, host } = await startServer();
    const endpoint = published.get(HOME)!;
    const { router } = startClient(endpoint);
    const { terminalId } = await router.open({ sessionId: 'home-session', cols: 80, rows: 24 });

    const ended = nextEvent(router, (event) => event.type === 'exit');
    await host.close();
    expect(await ended).toEqual({ type: 'exit', terminalId, exitCode: -1, signal: 'disconnected' });
    await expect(router.list('home-session')).rejects.toThrow(/^remote_unreachable:/);
  });

  it('takes another port when the preferred one is in use', async () => {
    const occupant = net.createServer();
    await new Promise<void>((resolve) => occupant.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => occupant.close(() => resolve())));
    const taken = (occupant.address() as net.AddressInfo).port;

    const { published } = await startServer({ port: taken });

    const endpoint = published.get(HOME);
    expect(endpoint?.port).toBeGreaterThan(0);
    expect(endpoint?.port).not.toBe(taken);
  });
});

describe('resolveLanTerminalPort', () => {
  it('reads the port from the environment', () => {
    expect(resolveLanTerminalPort({})).toBe(8789);
    expect(resolveLanTerminalPort({ LODY_LAN_TERMINAL_PORT: '9000' })).toBe(9000);
    expect(resolveLanTerminalPort({ LODY_LAN_TERMINAL_PORT: 'off' })).toBeNull();
    expect(() => resolveLanTerminalPort({ LODY_LAN_TERMINAL_PORT: 'many' })).toThrow();
  });
});
