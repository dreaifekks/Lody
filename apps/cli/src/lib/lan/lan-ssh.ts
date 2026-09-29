// Where the SSH server of this machine answers the members of its LANs. The
// agent service opens nothing for it: an editor on another member opens a
// folder of a session here through the SSH server the machine already runs.
import os from 'node:os';
import {
  LAN_SSH_DEFAULT_PORT,
  LAN_SSH_PROTOCOL_VERSION,
  formatLanSshDestination,
  parseLanSshDestination,
  type LanSshDestination,
} from '@lody/shared/lan-ssh';
import type { LanHub } from '@lody/shared/node/lan-hub';
import { probeSshServer } from '@lody/shared/node/ssh-probe';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { probeLocalAddressToward } from './lan-terminal';

export type LanSshSetting =
  /** Says where the SSH server answers, if one does. */
  | { kind: 'probe' }
  | { kind: 'off' }
  /** Says what it was told; `user` is `null` for the one the agent service runs as. */
  | { kind: 'fixed'; user: string | null; host: string; port: number };

const SETTING_PATTERN = /^(?:([^@\s]+)@)?([^@:\s]+)(?::(\d{1,5}))?$/u;

/**
 * `LODY_LAN_SSH`: unset to say where the SSH server of this machine answers,
 * `[user@]host[:port]` to say something else, `off` to say nothing.
 */
export function resolveLanSshSetting(env: NodeJS.ProcessEnv = process.env): LanSshSetting {
  const raw = env.LODY_LAN_SSH?.trim();
  if (!raw) return { kind: 'probe' };
  if (raw.toLowerCase() === 'off') return { kind: 'off' };

  const [, user, host, port] = SETTING_PATTERN.exec(raw) ?? [];
  const destination = parseLanSshDestination({
    version: LAN_SSH_PROTOCOL_VERSION,
    // Only what the setting names is checked here; the user it leaves out is read later.
    user: user ?? 'user',
    host,
    port: port ? Number(port) : LAN_SSH_DEFAULT_PORT,
  });
  if (!destination) {
    throw new Error(`LODY_LAN_SSH must be [user@]host[:port] or "off", not "${raw}"`);
  }
  return { kind: 'fixed', user: user ?? null, host: destination.host, port: destination.port };
}

export type LanSshProbes = {
  /** The address this machine has toward a hub; `null` while the hub does not answer. */
  address: (hubUrl: string) => Promise<string | null>;
  /** Whether an SSH server answers there. */
  server: (host: string, port: number) => Promise<boolean>;
  /** The user the agent service runs as; `null` when the system does not name one. */
  user: () => string | null;
  /** What else this machine is called: its host name and the addresses it has. */
  names: () => string[];
};

function readServiceUser(): string | null {
  try {
    return os.userInfo().username || null;
  } catch {
    return null;
  }
}

function isLoopback(address: string): boolean {
  return address === '::1' || address.startsWith('127.');
}

// The networks a machine makes for what runs on it: every machine that has
// them has the same addresses there, so they tell no machine from another.
const INNER_NETWORK_PATTERN = /^(?:docker|br-|bridge|veth|virbr|cni|flannel|podman|lxc|lxd)/iu;

function readMachineNames(): string[] {
  const names = [os.hostname()];
  for (const [network, addresses] of Object.entries(os.networkInterfaces())) {
    if (INNER_NETWORK_PATTERN.test(network)) continue;
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      // An address a machine gave itself because nobody gave it one.
      if (address.address.startsWith('169.254.')) continue;
      names.push(address.address);
    }
  }
  return names;
}

/**
 * What this machine says to the members of one LAN: `null` for nothing, and
 * `undefined` while it cannot tell, which leaves what it said before.
 */
export async function describeLanSsh(options: {
  hubUrl: string;
  setting: LanSshSetting;
  probes?: Partial<LanSshProbes>;
}): Promise<LanSshDestination | null | undefined> {
  const { setting } = options;
  if (setting.kind === 'off') return null;

  const readUser = options.probes?.user ?? readServiceUser;
  if (setting.kind === 'fixed') {
    // What the machine was told is said as it was told, with nothing to find it by.
    return parseLanSshDestination({
      version: LAN_SSH_PROTOCOL_VERSION,
      user: setting.user ?? readUser(),
      host: setting.host,
      port: setting.port,
    });
  }

  const probeAddress = options.probes?.address ?? ((url: string) => probeLocalAddressToward(url));
  const address = await probeAddress(options.hubUrl);
  if (!address) return undefined;
  // A hub on this machine is reached on an address no other member reaches.
  if (isLoopback(address)) return null;
  const answers = await (options.probes?.server ?? probeSshServer)(address, LAN_SSH_DEFAULT_PORT);
  if (!answers) return null;
  return parseLanSshDestination({
    version: LAN_SSH_PROTOCOL_VERSION,
    user: readUser(),
    host: address,
    port: LAN_SSH_DEFAULT_PORT,
    names: (options.probes?.names ?? readMachineNames)(),
  });
}

/** What this machine says to the members of each of its LANs, as `LODY_LAN_SSH` has it. */
export function createLanSshDescriber(options: {
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  probes?: Partial<LanSshProbes>;
}): (hub: LanHub) => Promise<LanSshDestination | null | undefined> {
  const { logger } = options;
  let setting: LanSshSetting;
  try {
    setting = resolveLanSshSetting(options.env);
  } catch (error) {
    logger.warn(`[lan-ssh] ${formatErrorMessage(error)}`);
    setting = { kind: 'off' };
  }

  const said = new Map<string, string>();
  return async (hub) => {
    const destination = await describeLanSsh({
      hubUrl: hub.url,
      setting,
      ...(options.probes ? { probes: options.probes } : {}),
    });
    if (destination === undefined) return undefined;

    const saying = destination ? formatLanSshDestination(destination) : '';
    if (said.get(hub.id) !== saying) {
      said.set(hub.id, saying);
      logger.info(
        destination
          ? `[lan-ssh] Editors of the members of ${hub.name} open folders of this machine as ${saying}`
          : `[lan-ssh] No SSH server of this machine is named to the members of ${hub.name}`
      );
    }
    return destination;
  };
}
