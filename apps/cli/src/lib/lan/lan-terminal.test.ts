import net from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore, type WorkspaceSummary } from '@lody/platform';
import {
  machineShellScope,
  type LanMemberControlRequest,
  type LanMemberControlResponse,
  type MachineId,
  type TerminalOpenParams,
  type TerminalOpenResult,
  type TerminalServerEvent,
  type TerminalSnapshot,
} from '@lody/shared';
import { getLanHubWorkspaceId } from '@lody/shared/lan-hub';
import type { LanTerminalEndpoint } from '@lody/shared/lan-terminal';
import { addLanHub, type LanHub } from '@lody/shared/node/lan-hub';
import { serveTerminalConnection, type TerminalReplay } from '@/lib/terminal-connection';
import type { TerminalPtyServiceApi } from '@/lib/terminal-pty-service';
import { ScopedTerminalService, TerminalRouter } from '@/lib/terminal-services';
import type { Logger } from '@/utils/logger';
import { askLanMemberDirectly, LanMemberUnreachableError } from './lan-control-channel';
import { askLanHubPeer, type LanHubPeerHandler } from './lan-hub-peers';
import { askLanMemberRpc, LanRpcNotSentError } from './lan-rpc-channel';
import { createDetachFilter, runMachineShell, type ShellIo } from './lan-shell';
import { connectLanTerminal, createTerminalLink, deriveLanTerminalKey } from './lan-terminal';
import { joinSockets, openLanTunnel } from './lan-tunnel';
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
  readonly openParams: TerminalOpenParams[] = [];
  private readonly terminals = new Map<string, { sessionId: string; scrollback: string }>();
  private readonly handlers = new Set<(event: TerminalServerEvent) => void>();
  private sequence = 0;

  constructor(
    private readonly name: string,
    private readonly behavior: {
      /** Says, as the real service does, that its events reach every listener from the start. */
      attachedOnOpen?: boolean;
      /** A command that writes this and ends at once, before anyone could attach it. */
      quick?: { output: string; exitCode: number };
    } = {}
  ) {}

  list(sessionId: string): TerminalSnapshot[] {
    return [...this.terminals]
      .filter(([, terminal]) => terminal.sessionId === sessionId)
      .map(([terminalId]) => ({ terminalId, title: this.name }));
  }

  async open(params: TerminalOpenParams): Promise<TerminalOpenResult> {
    const terminalId = `${this.name}-${++this.sequence}`;
    this.terminals.set(terminalId, { sessionId: params.sessionId, scrollback: '$ ' });
    this.opened.push(params.sessionId);
    this.openParams.push(params);
    const { quick } = this.behavior;
    if (quick) {
      queueMicrotask(() => {
        this.emit({ type: 'data', terminalId, data: quick.output });
        this.terminals.delete(terminalId);
        this.emit({ type: 'exit', terminalId, exitCode: quick.exitCode });
      });
    }
    return {
      terminalId,
      cwd: `/${this.name}`,
      ...(this.behavior.attachedOnOpen ? { attached: true } : {}),
    };
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

  async function startServer(
    options: {
      port?: number;
      control?: (request: LanMemberControlRequest) => Promise<LanMemberControlResponse>;
      hub?: LanHubPeerHandler;
      rpc?: (request: unknown) => Promise<unknown[]>;
      tunnels?: boolean;
      pty?: FakePty;
    } = {}
  ) {
    const pty = options.pty ?? new FakePty('server');
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
        workspaceId === HOME ? new ScopedTerminalService(pty, verifyHomeSession, SERVER) : null,
      ...(options.control
        ? {
            controlFor: (workspaceId: string) =>
              workspaceId === HOME ? (options.control ?? null) : null,
          }
        : {}),
      ...(options.rpc
        ? { rpcFor: (workspaceId: string) => (workspaceId === HOME ? (options.rpc ?? null) : null) }
        : {}),
      ...(options.hub
        ? { hubFor: (workspaceId: string) => (workspaceId === HOME ? (options.hub ?? null) : null) }
        : {}),
      ...(options.tunnels ? { tunnels: true } : {}),
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
        sessionId === 'local-session' || sessionId === machineShellScope(CLIENT)
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

  it('answers a request of a member over the connection, once, and only for its own LAN', async () => {
    const asked: LanMemberControlRequest[] = [];
    const { published } = await startServer({
      control: async (request) => {
        asked.push(request);
        return {
          ok: true,
          type: 'lan/update-machine',
          result: { outcome: 'started', version: '0.100.0-lan.5' },
        };
      },
    });
    const ask = (request: LanMemberControlRequest) =>
      askLanMemberDirectly({
        endpoint: published.get(HOME)!,
        lanId: home.id,
        key: deriveLanTerminalKey(home.token),
        machineId: SERVER,
        request,
        timeoutMs: 5_000,
      });
    const request: LanMemberControlRequest = {
      type: 'lan/update-machine',
      machineId: SERVER as MachineId,
      workspaceId: HOME,
    };

    expect(await ask(request)).toEqual({
      ok: true,
      type: 'lan/update-machine',
      result: { outcome: 'started', version: '0.100.0-lan.5' },
    });
    // The connection is keyed to Home; a request about another LAN's workspace is not answered.
    expect(
      await ask({ ...request, workspaceId: getLanHubWorkspaceId(office.id) as typeof HOME })
    ).toMatchObject({ ok: false, error: 'workspace_not_found' });
    expect(asked).toEqual([request]);
  });

  it('says a request never left when the member takes none over its connection', async () => {
    const { published } = await startServer();
    const asking = askLanMemberDirectly({
      endpoint: published.get(HOME)!,
      lanId: home.id,
      key: deriveLanTerminalKey(home.token),
      machineId: SERVER,
      request: { type: 'lan/update-machine', machineId: SERVER as MachineId, workspaceId: HOME },
      timeoutMs: 5_000,
    });

    await expect(asking).rejects.toBeInstanceOf(LanMemberUnreachableError);
  });

  it('tells a member where it follows the hub, and follows one that took over', async () => {
    const followed: unknown[] = [];
    const { published } = await startServer({
      hub: {
        where: async () => ({
          location: { url: 'http://10.0.0.1:8788', term: 2 },
          reachable: false,
        }),
        moved: async (location) => {
          followed.push(location);
          return true;
        },
      },
    });
    const ask = (request: Parameters<typeof askLanHubPeer>[0]['request']) =>
      askLanHubPeer({
        endpoint: published.get(HOME)!,
        lanId: home.id,
        key: deriveLanTerminalKey(home.token),
        machineId: SERVER,
        request,
      });

    expect(await ask({ type: 'where' })).toEqual({
      type: 'where',
      location: { url: 'http://10.0.0.1:8788', term: 2 },
      reachable: false,
    });
    expect(
      await ask({ type: 'moved', location: { url: 'http://10.0.0.2:8788', term: 3 } })
    ).toEqual({ type: 'moved', followed: true });
    expect(followed).toEqual([{ url: 'http://10.0.0.2:8788', term: 3 }]);
  });

  it('carries a machine request to a member and brings back its answers', async () => {
    const handled: unknown[] = [];
    const { published } = await startServer({
      rpc: async (request) => {
        handled.push(request);
        return [{ id: 'live-1', result: { state: 'idle' } }];
      },
    });
    const ask = (request: unknown) =>
      askLanMemberRpc({
        endpoint: published.get(HOME)!,
        lanId: home.id,
        key: deriveLanTerminalKey(home.token),
        machineId: SERVER,
        request,
        timeoutMs: 5_000,
      });

    expect(await ask({ id: 'live-1', workspaceId: HOME })).toEqual([
      { id: 'live-1', result: { state: 'idle' } },
    ]);
    // The connection is keyed to Home; a request about another LAN's workspace is not handled.
    await expect(ask({ id: 'live-2', workspaceId: 'lw_office' })).rejects.toThrow(/another LAN/);
    expect(handled).toEqual([{ id: 'live-1', workspaceId: HOME }]);
  });

  it('says a machine request never left when the member takes none directly', async () => {
    const { published } = await startServer();
    await expect(
      askLanMemberRpc({
        endpoint: published.get(HOME)!,
        lanId: home.id,
        key: deriveLanTerminalKey(home.token),
        machineId: SERVER,
        request: { id: 'live-1', workspaceId: HOME },
        timeoutMs: 5_000,
      })
    ).rejects.toBeInstanceOf(LanRpcNotSentError);
  });

  /** This machine's local terminal socket in front of the router, as `lan shell` reaches it. */
  async function serveLocally(router: TerminalRouter) {
    const localSocket = net.createServer((socket) =>
      serveTerminalConnection(socket, { service: router, logger: silentLogger() })
    );
    await new Promise<void>((resolve) => localSocket.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => localSocket.close(() => resolve())));
    const socket = net.connect((localSocket.address() as net.AddressInfo).port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.pause();
    const link = createTerminalLink(socket);
    cleanups.push(() => link.close());
    return link;
  }

  function pipedIo() {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    let output = '';
    const waiters: Array<() => void> = [];
    stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      for (const wake of waiters.splice(0)) wake();
    });
    const io: ShellIo = {
      stdin,
      stdout,
      stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    };
    /** Resolves once the terminal shows `text`. */
    const shows = async (text: string) => {
      for (;;) {
        if (output === text) return;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    };
    return { io, stdin, output: () => output, shows };
  }

  it("opens a shell of a member's machine where it is asked to start and runs a command", async () => {
    const { published, pty } = await startServer();
    const { router, local } = startClient(published.get(HOME)!);
    const link = await serveLocally(router);
    const { io, stdin, output, shows } = pipedIo();

    const outcome = runMachineShell(link, {
      machineId: SERVER,
      cwd: '~/src',
      command: 'cat',
      io,
    });
    // The replay of the new shell says it is attached.
    await shows('$ ');
    const [opened] = pty.openParams;
    expect(opened).toMatchObject({
      sessionId: machineShellScope(SERVER),
      cwd: '~/src',
      command: 'cat',
    });
    expect(local.opened).toEqual([]);
    // The member echoes input, as a shell would; the exit ends the command.
    stdin.write('hello\n');
    await shows('$ hello\n');
    pty.close('server-1');

    expect(await outcome).toEqual({ type: 'exited', exitCode: 0 });
    expect(output()).toBe('$ hello\n');
    expect(pty.inputs).toEqual([['server-1', 'hello\n']]);
  });

  it('opens a shell of this machine on this machine', async () => {
    const { published, pty } = await startServer();
    const { router, local } = startClient(published.get(HOME)!);

    await router.open({ sessionId: machineShellScope(CLIENT), cols: 80, rows: 24 });

    expect(local.opened).toEqual([machineShellScope(CLIENT)]);
    expect(pty.opened).toEqual([]);
  });

  it('gives the output and exit code of a command that ends before it could be attached', async () => {
    const { published } = await startServer({
      pty: new FakePty('server', {
        attachedOnOpen: true,
        quick: { output: 'hi\r\n', exitCode: 3 },
      }),
    });
    const { router } = startClient(published.get(HOME)!);
    const link = await serveLocally(router);
    const { io, output } = pipedIo();

    const outcome = await runMachineShell(link, {
      machineId: SERVER,
      command: 'echo hi; exit 3',
      io,
    });

    expect(outcome).toEqual({ type: 'exited', exitCode: 3 });
    expect(output()).toBe('hi\r\n');
  });

  it('lists the shells of a member and brings one back after the command left it', async () => {
    const { published, pty } = await startServer();
    const { router } = startClient(published.get(HOME)!);
    const first = await serveLocally(router);
    const { terminalId } = await first.open({
      sessionId: machineShellScope(SERVER),
      cols: 80,
      rows: 24,
    });
    first.close();

    const again = await serveLocally(router);
    expect(await again.list(machineShellScope(SERVER))).toEqual([{ terminalId, title: 'server' }]);
    const { io, shows } = pipedIo();
    const outcome = runMachineShell(again, { machineId: SERVER, attach: 'server-', io });
    await shows('$ ');
    pty.close(terminalId);
    expect(await outcome).toEqual({ type: 'exited', exitCode: 0 });
  });

  it('refuses a shell of another machine, and one of a machine that opens none', async () => {
    const { published, pty } = await startServer();
    const link = await connectLanTerminal({
      endpoint: published.get(HOME)!,
      lanId: home.id,
      key: deriveLanTerminalKey(home.token),
      machineId: SERVER,
    });
    cleanups.push(() => link.close());

    await expect(
      link.open({ sessionId: machineShellScope(CLIENT), cols: 80, rows: 24 })
    ).rejects.toThrow(/^session_machine_mismatch:/);
    expect(pty.opened).toEqual([]);

    const closed = new ScopedTerminalService(pty, verifyHomeSession);
    await expect(
      closed.open({ sessionId: machineShellScope(SERVER), cols: 80, rows: 24 })
    ).rejects.toThrow(/^session_not_found:/);
    expect(pty.opened).toEqual([]);
  });

  /** A server that answers only once its client finished sending, like `nc -N` expects. */
  async function answerAfterEnd() {
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      let received = '';
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
      });
      socket.on('end', () => socket.end(`got ${received}`));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return (server.address() as net.AddressInfo).port;
  }

  function askAndFinish(socket: net.Socket, request: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let answer = '';
      socket.on('data', (chunk: Buffer) => {
        answer += chunk.toString('utf8');
      });
      socket.once('close', () => resolve(answer));
      socket.once('error', reject);
      socket.resume();
      socket.end(request);
    });
  }

  it("brings back a member's answer after the client finished sending", async () => {
    const port = await answerAfterEnd();
    const { published } = await startServer({ tunnels: true });
    const tunnel = await openLanTunnel({
      endpoint: published.get(HOME)!,
      lanId: home.id,
      key: deriveLanTerminalKey(home.token),
      machineId: SERVER,
      port,
    });

    expect(await askAndFinish(tunnel, 'request')).toBe('got request');
  });

  it('passes the end of a forwarded connection on and keeps its answer', async () => {
    const port = await answerAfterEnd();
    // What `lan forward` listens with, joined to the port as each hop joins its two sides.
    const forward = net.createServer({ pauseOnConnect: true }, (client) => {
      const upstream = net.connect({ port, host: '127.0.0.1' });
      upstream.once('connect', () => joinSockets(client, upstream));
    });
    await new Promise<void>((resolve) => forward.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => forward.close(() => resolve())));
    const client = net.connect({
      port: (forward.address() as net.AddressInfo).port,
      host: '127.0.0.1',
      allowHalfOpen: true,
    });
    await new Promise<void>((resolve) => client.once('connect', () => resolve()));

    expect(await askAndFinish(client, 'GET / HTTP/1.0\r\n\r\n')).toBe('got GET / HTTP/1.0\r\n\r\n');
  });

  it('carries a connection to a port the member reaches both ways', async () => {
    // A dev server of the member: it answers what it receives in capitals.
    const devServer = net.createServer((socket) =>
      socket.on('data', (chunk) => socket.write(chunk.toString('utf8').toUpperCase()))
    );
    await new Promise<void>((resolve) => devServer.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => devServer.close(() => resolve())));
    const port = (devServer.address() as net.AddressInfo).port;
    const { published } = await startServer({ tunnels: true });
    const member = {
      endpoint: published.get(HOME)!,
      lanId: home.id,
      key: deriveLanTerminalKey(home.token),
      machineId: SERVER,
    };

    const tunnel = await openLanTunnel({ ...member, port });
    cleanups.push(() => tunnel.destroy());
    const answered = new Promise<string>((resolve) =>
      tunnel.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')))
    );
    tunnel.resume();
    tunnel.write('get /');
    expect(await answered).toBe('GET /');

    // A host the member reaches, as with ssh -L.
    const named = await openLanTunnel({ ...member, port, host: '127.0.0.1' });
    cleanups.push(() => named.destroy());
    const namedAnswer = new Promise<string>((resolve) =>
      named.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')))
    );
    named.resume();
    named.write('via host');
    expect(await namedAnswer).toBe('VIA HOST');

    // A port nothing listens on is refused with the reason, not left open.
    devServer.close();
    await expect(openLanTunnel({ ...member, port })).rejects.toThrow(/nothing listens/);
  });

  it('opens no port of a member that serves none', async () => {
    const { published } = await startServer();

    await expect(
      openLanTunnel({
        endpoint: published.get(HOME)!,
        lanId: home.id,
        key: deriveLanTerminalKey(home.token),
        machineId: SERVER,
        port: 1,
      })
    ).rejects.toThrow(/serves no tunnel/);
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

describe('createDetachFilter', () => {
  it('leaves on Enter ~ . and passes everything else on', () => {
    let detached = 0;
    const filter = createDetachFilter(() => {
      detached += 1;
    });

    expect(filter('ls ~/src\r')).toBe('ls ~/src\r');
    expect(filter('~~')).toBe('~');
    expect(filter('\r~x')).toBe('\r~x');
    expect(detached).toBe(0);
    expect(filter('\r~')).toBe('\r');
    expect(filter('.')).toBe('');
    expect(detached).toBe(1);
  });
});
