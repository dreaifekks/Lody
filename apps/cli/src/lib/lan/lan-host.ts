// `lody lan up`: turns a server into a LAN host that is also a member of its
// own LAN, and keeps both running as services.
import type os from 'node:os';
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
