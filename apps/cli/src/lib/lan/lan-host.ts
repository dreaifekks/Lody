// `lody lan up`: turns a server into a LAN host that is also a member of its
// own LAN, and keeps both running as services.
import fs from 'node:fs';
import type os from 'node:os';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { formatLanInvite, normalizeLanHubUrl } from '@lody/shared/lan-hub';
import {
  addLanHub,
  deriveLanHubId,
  probeLanHub,
  readLanHubSettings,
  writeLanHubSettings,
  type LanHub,
  type LanHubSettingsLocation,
} from '@lody/shared/node/lan-hub';
import {
  LAN_HUB_HANDOVER_ABORT_PATH,
  LAN_HUB_HANDOVER_COMPLETE_PATH,
  LAN_HUB_HANDOVER_PATH,
  readLanHubHandover,
} from './hub-handover';
import { readLanHubToken } from './hub-server';
import {
  LAN_SERVICE_UNITS,
  renderLanServiceUnit,
  type LanServiceCommand,
  type LanServiceManager,
} from './service';

type NetworkInterfaces = ReturnType<typeof os.networkInterfaces>;

function ipv4ToNumber(address: string): number | null {
  const parts = address.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return parts.reduce((value, part) => value * 256 + part, 0);
}

function inRange(address: string, base: string, prefixLength: number): boolean {
  const value = ipv4ToNumber(address);
  const start = ipv4ToNumber(base);
  if (value === null || start === null) return false;
  const size = 2 ** (32 - prefixLength);
  return value >= start && value < start + size;
}

/** Carrier-grade NAT space, which overlay networks such as Tailscale assign from. */
const isOverlayAddress = (address: string) => inRange(address, '100.64.0.0', 10);
const isPrivateAddress = (address: string) =>
  inRange(address, '10.0.0.0', 8) ||
  inRange(address, '172.16.0.0', 12) ||
  inRange(address, '192.168.0.0', 16);

/**
 * The address a LAN host listens on when none was given: one that is only
 * reachable from a private network. An overlay network wins over the local
 * segment because it reaches the same machines from anywhere and encrypts the
 * traffic. A machine with public addresses only returns `null`; the hub speaks
 * plain HTTP by default, and exposing it has to be a decision.
 */
export function pickLanHostAddress(interfaces: NetworkInterfaces): string | null {
  const addresses = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
  return addresses.find(isOverlayAddress) ?? addresses.find(isPrivateAddress) ?? null;
}

export type HostLanOptions = {
  name?: string | null;
  host: string;
  port: number;
  dataDir: string;
  /** The address other devices use when it differs from the one listened on. */
  publicUrl?: string | null;
  /** Hosts the LAN without running agents on this machine. */
  withAgent: boolean;
  /**
   * Runs once the hub answers and before this machine joins it at its
   * address; throwing leaves the settings as they were.
   */
  beforeJoin?: (publicUrl: string) => Promise<void>;
};

export type HostLanResult = {
  hub: LanHub;
  created: boolean;
  invite: string;
  lingering: boolean;
  agent: 'started' | 'skipped' | 'failed';
  agentLog: string;
};

export type HostLanDependencies = {
  services: LanServiceManager;
  command: LanServiceCommand;
  searchPath: string;
  /** The data directory this command runs with, when it is not the default. */
  dataDir?: string | null;
  settings?: LanHubSettingsLocation;
  /** Resolves once the condition holds, or rejects when it never does. */
  waitFor: (condition: () => Promise<boolean>, description: string) => Promise<void>;
  probe?: typeof probeLanHub;
  readToken?: typeof readLanHubToken;
};

export async function hostLan(
  options: HostLanOptions,
  dependencies: HostLanDependencies
): Promise<HostLanResult> {
  const { services, command, searchPath } = dependencies;
  const probe = dependencies.probe ?? probeLanHub;
  const readToken = dependencies.readToken ?? readLanHubToken;
  const listenUrl = `http://${options.host.includes(':') ? `[${options.host}]` : options.host}:${options.port}`;
  const publicUrl = normalizeLanHubUrl(options.publicUrl?.trim() || listenUrl);
  // Read first: settings this command cannot edit have to stop it before it
  // starts a service the machine would then not belong to.
  const settings = readLanHubSettings(dependencies.settings);
  if (settings.source === 'environment') {
    throw new Error('LANs are set by the environment here; unset them to host a LAN');
  }

  await services.install(
    'hub',
    renderLanServiceUnit('hub', {
      command,
      searchPath,
      dataDir: dependencies.dataDir ?? null,
      hub: {
        host: options.host,
        port: options.port,
        dataDir: options.dataDir,
        publicUrl: options.publicUrl ?? null,
      },
    })
  );

  // Held in an object because the assignment happens inside the condition.
  const started: { token: string | null } = { token: null };
  await dependencies.waitFor(async () => {
    const credential = readToken(options.dataDir);
    if (!credential) return false;
    started.token = credential;
    // The service answers on the address it listens on; the public address
    // may only exist from the outside.
    const reachability = await probe({
      url: normalizeLanHubUrl(listenUrl),
      token: credential,
      id: deriveLanHubId(credential),
    });
    return reachability === 'reachable';
  }, `${LAN_SERVICE_UNITS.hub} to accept connections`);
  const token = started.token;
  if (!token) throw new Error('The LAN host started without a credential');
  await options.beforeJoin?.(publicUrl);

  const joined = addLanHub(settings.hubs, { url: publicUrl, token, name: options.name ?? null });
  writeLanHubSettings(
    { hubs: joined.hubs, machineName: settings.machineName },
    dependencies.settings
  );

  let agent: HostLanResult['agent'] = 'skipped';
  let agentLog = '';
  if (options.withAgent) {
    await services.install(
      'agent',
      renderLanServiceUnit('agent', {
        command,
        searchPath,
        dataDir: dependencies.dataDir ?? null,
      })
    );
    try {
      await dependencies.waitFor(
        async () => (await services.getState('agent')).active,
        `${LAN_SERVICE_UNITS.agent} to start`
      );
      agent = 'started';
    } catch {
      agent = 'failed';
      agentLog = await services.readRecentLog('agent');
    }
  }

  return {
    hub: joined.hub,
    created: joined.created,
    invite: formatLanInvite(joined.hub),
    lingering: await services.enableLinger(),
    agent,
    agentLog,
  };
}

export type TakeOverLanOptions = Omit<HostLanOptions, 'name' | 'beforeJoin' | 'withAgent'> & {
  /** The LAN, as this machine is a member of it. */
  hub: LanHub;
};

export type TakeOverLanResult = HostLanResult & { files: string[]; replaced: string | null };

/**
 * `lody lan take-over`: moves the hub of a LAN this machine is a member of
 * onto this machine. The current host stops serving and sends its data; this
 * machine starts a hub with it; the current host then points every member
 * here. Until that last step nothing is decided: whatever fails before it
 * has the current host serve the LAN again, so two hubs never serve one LAN.
 */
export async function takeOverLan(
  options: TakeOverLanOptions,
  dependencies: HostLanDependencies & { fetch?: typeof fetch }
): Promise<TakeOverLanResult> {
  const { hub, dataDir } = options;
  const { services } = dependencies;
  const request = dependencies.fetch ?? fetch;
  const readToken = dependencies.readToken ?? readLanHubToken;
  const authorization = { Authorization: `Bearer ${hub.token}` };

  const existing = readToken(dataDir);
  if (existing && existing !== hub.token) {
    throw new Error(`${dataDir} holds another LAN; choose another directory with --data-dir`);
  }
  if ((await services.getState('hub')).active) {
    throw new Error(
      'This machine already hosts a LAN; run `lody lan down --keep-agent` to stop it first'
    );
  }

  const abort = async () => {
    await request(`${hub.url}${LAN_HUB_HANDOVER_ABORT_PATH}`, {
      method: 'POST',
      headers: authorization,
      signal: AbortSignal.timeout(30_000),
    }).catch(() => undefined);
  };

  const incoming = `${dataDir}.incoming-${process.pid}`;
  fs.rmSync(incoming, { recursive: true, force: true });
  fs.mkdirSync(incoming, { recursive: true, mode: 0o700 });
  let files: string[];
  try {
    const response = await request(`${hub.url}${LAN_HUB_HANDOVER_PATH}`, {
      method: 'POST',
      headers: authorization,
    });
    if (response.status === 409) {
      throw new Error(`The host of ${hub.name} is already handing it over, or it moved`);
    }
    if (response.status === 404) {
      throw new Error(`The host of ${hub.name} runs a build that cannot hand it over; update it`);
    }
    if (!response.ok || !response.body) {
      throw new Error(`The host of ${hub.name} answered ${response.status}`);
    }
    files = await readLanHubHandover(
      Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      incoming
    );
    if (readToken(incoming) !== hub.token) {
      throw new Error(`The host of ${hub.name} sent the data of another LAN`);
    }
  } catch (error) {
    fs.rmSync(incoming, { recursive: true, force: true });
    // Only a host that started handing over is affected; one that refused is not.
    await abort();
    throw error;
  }

  let replaced: string | null = null;
  if (fs.existsSync(dataDir)) {
    replaced = `${dataDir}.replaced-${Date.now()}`;
    fs.renameSync(dataDir, replaced);
  }
  fs.renameSync(incoming, dataDir);

  let committed = false;
  try {
    const result = await hostLan(
      {
        ...options,
        name: null,
        withAgent: false,
        beforeJoin: async (publicUrl) => {
          const response = await request(`${hub.url}${LAN_HUB_HANDOVER_COMPLETE_PATH}`, {
            method: 'POST',
            headers: { ...authorization, 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: publicUrl }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) {
            throw new Error(`The host of ${hub.name} did not point its members here`);
          }
          committed = true;
        },
      },
      dependencies
    );
    return { ...result, files, replaced };
  } catch (error) {
    // Past the commit the LAN lives here, and the hub stays whatever else failed.
    if (committed) throw error;
    await services.remove('hub').catch(() => false);
    await abort();
    throw error;
  }
}
