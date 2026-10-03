import type tls from 'node:tls';
import type { ReadonlyStore, WorkspaceSummary } from '@lody/platform';
import { getLanHubWorkspaceId } from '@lody/shared/lan-hub';
import {
  LAN_TERMINAL_PROTOCOL_VERSION,
  sameLanTerminalEndpoint,
  type LanTerminalEndpoint,
} from '@lody/shared/lan-terminal';
import type {
  LanMemberControlRequest,
  LanMemberControlResponse,
  SessionFilePayload,
} from '@lody/shared';
import type { LanHub } from '@lody/shared/node/lan-hub';
import { serveTerminalConnection, type TerminalService } from '@/lib/terminal-connection';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { serveLanControlConnection } from './lan-control-channel';
import { serveLanRpcConnection } from './lan-rpc-channel';
import {
  serveLanHubPeerConnection,
  type LanHubLocation,
  type LanHubPeerHandler,
} from './lan-hub-peers';
import { serveLanFileConnection, type LanFileToRead, type ReceivedLanFile } from './lan-files';
import {
  createLanTerminalServer,
  deriveLanTerminalKey,
  LAN_TERMINAL_DEFAULT_PORT,
  probeLocalAddressToward,
} from './lan-terminal';

const REFRESH_INTERVAL_MS = 60_000;
const MAX_CONNECTIONS = 64;

/** The LANs of this machine as the agent service follows them. */
export type LanTerminalMembership = {
  readonly hubs: readonly LanHub[];
  readonly workspaces: ReadonlyStore<readonly WorkspaceSummary[]>;
  /** Follows a LAN's hub to where it is now; whether the settings changed. */
  adopt?: (hubId: string, location: LanHubLocation, reason: string) => boolean;
  termOf?: (hubId: string) => number;
};

/**
 * `LODY_LAN_TERMINAL_PORT`: unset for the default port, a number for another
 * one (`0` for any free port), `off` to accept no terminal connections.
 */
export function resolveLanTerminalPort(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.LODY_LAN_TERMINAL_PORT?.trim();
  if (!raw) return LAN_TERMINAL_DEFAULT_PORT;
  if (raw.toLowerCase() === 'off') return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`LODY_LAN_TERMINAL_PORT must be a port number or "off", not "${raw}"`);
  }
  return port;
}

type Listener = { server: tls.Server; port: number };

/** Takes the files of a message for the sessions of one LAN's workspace. */
export type LanFileReceiver = {
  /** Throws the reason when this machine takes no file for the session. */
  admit: (file: { sessionId: string; sizeBytes: number }) => Promise<void>;
  store: (file: ReceivedLanFile) => Promise<SessionFilePayload>;
  /** A file this machine keeps, for a member that shows its message. */
  read: (file: { sessionId: string; fileId: string }) => Promise<LanFileToRead>;
};

/**
 * Lets the other members of each LAN open terminals on this machine, hand it
 * the files of their messages and put their requests to it. It listens on the address this machine has
 * toward each hub, not on every interface, and publishes that endpoint into
 * the LAN's workspace.
 */
export class LanTerminalHost {
  private readonly listeners = new Map<string, Listener>();
  private readonly endpoints = new Map<string, LanTerminalEndpoint>();
  private readonly sockets = new Set<tls.TLSSocket>();
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly options: {
      machineId: string;
      logger: Logger;
      lans: LanTerminalMembership;
      /** The terminals one LAN's members may reach, per connection; `null` while it does not run. */
      serviceFor: (workspaceId: string) => TerminalService | null;
      /** Absent on a machine that takes no files; `null` while the workspace does not run. */
      filesFor?: (workspaceId: string) => LanFileReceiver | null;
      /** Absent on a machine that answers no requests of members; `null` while the workspace does not run. */
      controlFor?: (
        workspaceId: string
      ) => ((request: LanMemberControlRequest) => Promise<LanMemberControlResponse>) | null;
      /** Absent on a machine that tells members nothing about the hub. */
      hubFor?: (workspaceId: string) => LanHubPeerHandler | null;
      /** Absent on a machine that takes no machine RPC requests directly. */
      rpcFor?: (workspaceId: string) => ((request: unknown) => Promise<unknown[]>) | null;
      /** Records where this machine accepts terminals; `undefined` withdraws it. */
      publish: (workspaceId: string, endpoint: LanTerminalEndpoint | undefined) => Promise<void>;
      /** The port to prefer; `0` for any. */
      port: number;
      probeAddress?: (hubUrl: string) => Promise<string | null>;
      refreshIntervalMs?: number;
    }
  ) {}

  start(): void {
    if (this.closed || this.unsubscribe) return;
    this.unsubscribe = this.options.lans.workspaces.subscribe(() => {
      void this.refresh();
    });
    // An address can change under a running service: a laptop moves between networks.
    this.timer = setInterval(
      () => void this.refresh(),
      this.options.refreshIntervalMs ?? REFRESH_INTERVAL_MS
    );
    this.timer.unref?.();
    void this.refresh();
  }

  /** What this machine publishes into a workspace; `undefined` while it accepts nothing there. */
  endpointFor(workspaceId: string): LanTerminalEndpoint | undefined {
    return this.endpoints.get(workspaceId);
  }

  /** Brings listeners and published endpoints in line with the LANs; runs one at a time. */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return await this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        await this.reconcile();
      } while (this.refreshAgain && !this.closed);
    })().finally(() => {
      this.refreshing = null;
    });
    return await this.refreshing;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const listeners = [...this.listeners.values()];
    this.listeners.clear();
    await Promise.all(
      listeners.map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve())))
    );
  }

  private async reconcile(): Promise<void> {
    if (this.closed) return;
    const probe = this.options.probeAddress ?? ((url: string) => probeLocalAddressToward(url));
    const hubs = [...this.options.lans.hubs];
    const addresses = new Map<string, string>();
    for (const hub of hubs) {
      const workspaceId = getLanHubWorkspaceId(hub.id);
      // A hub that does not answer right now keeps the address it had.
      const address = (await probe(hub.url)) ?? this.endpoints.get(workspaceId)?.host;
      if (address) addresses.set(workspaceId, address);
    }
    if (this.closed) return;

    const wanted = new Set(addresses.values());
    for (const [address, listener] of [...this.listeners]) {
      if (wanted.has(address)) continue;
      this.listeners.delete(address);
      listener.server.close();
    }
    for (const address of wanted) {
      if (this.listeners.has(address)) continue;
      const listener = await this.listen(address);
      if (this.closed) {
        listener?.server.close();
        return;
      }
      if (listener) this.listeners.set(address, listener);
    }

    for (const [workspaceId, address] of addresses) {
      const listener = this.listeners.get(address);
      await this.setEndpoint(
        workspaceId,
        listener
          ? { version: LAN_TERMINAL_PROTOCOL_VERSION, host: address, port: listener.port }
          : undefined
      );
    }
    const current = new Set(hubs.map((hub) => getLanHubWorkspaceId(hub.id)));
    for (const workspaceId of [...this.endpoints.keys()]) {
      // The workspace of a LAN this machine left stops with it; nothing to withdraw.
      if (!current.has(workspaceId)) this.endpoints.delete(workspaceId);
    }
  }

  private async setEndpoint(
    workspaceId: string,
    endpoint: LanTerminalEndpoint | undefined
  ): Promise<void> {
    if (sameLanTerminalEndpoint(this.endpoints.get(workspaceId), endpoint)) return;
    if (endpoint) this.endpoints.set(workspaceId, endpoint);
    else this.endpoints.delete(workspaceId);
    try {
      await this.options.publish(workspaceId, endpoint);
    } catch (error) {
      this.options.logger.debug(
        `[lan-terminal] could not publish the endpoint into ${workspaceId}: ${formatErrorMessage(error)}`
      );
    }
  }

  private async listen(address: string): Promise<Listener | null> {
    const { filesFor, controlFor, hubFor, rpcFor } = this.options;
    const server = createLanTerminalServer({
      machineId: this.options.machineId,
      services: [
        'terminal',
        ...(filesFor ? (['files'] as const) : []),
        ...(controlFor ? (['control'] as const) : []),
        ...(hubFor ? (['hub'] as const) : []),
        ...(rpcFor ? (['rpc'] as const) : []),
      ],
      logger: this.options.logger,
      keyFor: (lanId) => {
        const hub = this.options.lans.hubs.find((candidate) => candidate.id === lanId);
        return hub ? deriveLanTerminalKey(hub.token) : null;
      },
      onConnection: ({ socket, lanId, service, initial }) => {
        const workspaceId = getLanHubWorkspaceId(lanId);
        const terminals = service === 'terminal' ? this.options.serviceFor(workspaceId) : null;
        const files = service === 'files' ? (filesFor?.(workspaceId) ?? null) : null;
        const control = service === 'control' ? (controlFor?.(workspaceId) ?? null) : null;
        const hub = service === 'hub' ? (hubFor?.(workspaceId) ?? null) : null;
        const rpc = service === 'rpc' ? (rpcFor?.(workspaceId) ?? null) : null;
        if (!terminals && !files && !control && !hub && !rpc) {
          socket.end(
            `${JSON.stringify({
              type: 'error',
              code: 'remote_unreachable',
              message: 'remote_unreachable:this machine does not run that LAN yet',
            })}\n`
          );
          return;
        }
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
        if (rpc) {
          void serveLanRpcConnection(socket, {
            initial,
            workspaceId,
            handle: rpc,
            logger: this.options.logger,
          });
          return;
        }
        if (hub) {
          void serveLanHubPeerConnection(socket, {
            initial,
            handler: hub,
            logger: this.options.logger,
          });
          return;
        }
        if (control) {
          void serveLanControlConnection(socket, {
            initial,
            workspaceId,
            answer: control,
            logger: this.options.logger,
          });
          return;
        }
        if (files) {
          void serveLanFileConnection(socket, {
            ...files,
            initial,
            logger: this.options.logger,
          });
          return;
        }
        if (terminals) {
          serveTerminalConnection(socket, {
            service: terminals,
            logger: this.options.logger,
            initial,
          });
          socket.resume();
        }
      },
    });
    server.maxConnections = MAX_CONNECTIONS;

    const bind = (port: number) =>
      new Promise<number>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(port, address, () => {
          server.off('error', onError);
          const bound = server.address();
          resolve(typeof bound === 'object' && bound ? bound.port : port);
        });
      });

    try {
      let port: number;
      try {
        port = await bind(this.options.port);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || this.options.port === 0) {
          throw error;
        }
        port = await bind(0);
      }
      server.on('error', (error) => {
        this.options.logger.warn(`[lan-terminal] listener on ${address} failed: ${error.message}`);
      });
      this.options.logger.info(
        `[lan-terminal] accepting terminals of LAN members on ${address}:${port}`
      );
      return { server, port };
    } catch (error) {
      this.options.logger.warn(
        `[lan-terminal] cannot accept terminals on ${address}: ${formatErrorMessage(error)}`
      );
      server.close();
      return null;
    }
  }
}
