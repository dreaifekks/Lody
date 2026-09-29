/**
 * Where the SSH server of a LAN member answers, which is how an editor on
 * another member opens a folder of it. It is published in the machine's
 * metadata of that LAN's workspace. It names a door and opens none: the SSH
 * server decides who gets in.
 */
export const LAN_SSH_PROTOCOL_VERSION = 1;
export const LAN_SSH_DEFAULT_PORT = 22;
export const LAN_SSH_NAMES_MAX = 16;

export type LanSshDestination = {
  version: typeof LAN_SSH_PROTOCOL_VERSION;
  user: string;
  host: string;
  port: number;
  /**
   * What else the machine is called: its host name and its other addresses.
   * Nothing connects to them. A member finds by them the entry of its own SSH
   * configuration that reaches the machine, whichever of them the entry uses.
   */
  names?: string[];
};

// All of them end up in the arguments of an editor on the machine that reads
// them, so none can begin an option or carry the syntax of an address.
const USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/u;
// A host name or an IPv4 address. An IPv6 address has no spelling every editor reads.
const HOST_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const HOST_PATTERN = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})*$`, 'u');
const HOST_MAX = 253;
// The name of an entry of an SSH configuration is whatever its owner chose,
// a colon among it. An address has no place for one in the name of a host.
const URL_HOST_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,252}$/u;
const CONFIGURED_HOST_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._:+-]{0,252}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isHost = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= HOST_MAX && HOST_PATTERN.test(value);

const isPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535;

/** The names among `values` a machine may be called, each once, without `host`. */
export function normalizeLanSshNames(values: readonly unknown[], host: string): string[] {
  const names: string[] = [];
  for (const value of values) {
    if (!isHost(value) || value === host || names.includes(value)) continue;
    names.push(value);
    if (names.length === LAN_SSH_NAMES_MAX) break;
  }
  return names;
}

/** `null` for anything this version cannot hand to an editor. */
export function parseLanSshDestination(value: unknown): LanSshDestination | null {
  if (!isRecord(value) || value.version !== LAN_SSH_PROTOCOL_VERSION) return null;
  const { user, host, port } = value;
  if (typeof user !== 'string' || !USER_PATTERN.test(user)) return null;
  if (!isHost(host) || !isPort(port)) return null;
  // A name that cannot be read is left out; the machine is reached without it.
  const names = Array.isArray(value.names) ? normalizeLanSshNames(value.names, host) : [];
  return {
    version: LAN_SSH_PROTOCOL_VERSION,
    user,
    host,
    port,
    ...(names.length > 0 ? { names } : {}),
  };
}

export function sameLanSshDestination(
  left: LanSshDestination | null | undefined,
  right: LanSshDestination | null | undefined
): boolean {
  if (!left || !right) return !left && !right;
  const names = (destination: LanSshDestination) => [...(destination.names ?? [])].sort().join();
  return (
    left.user === right.user &&
    left.host === right.host &&
    left.port === right.port &&
    left.version === right.version &&
    names(left) === names(right)
  );
}

/** `user@host`, with the port only when it is not the one SSH assumes. */
export function formatLanSshDestination(destination: LanSshDestination): string {
  const port = destination.port === LAN_SSH_DEFAULT_PORT ? '' : `:${destination.port}`;
  return `${destination.user}@${destination.host}${port}`;
}

/**
 * What an editor is handed to reach a machine. It is kept in its parts: the
 * name of an entry may hold a colon, which written out would read as a port.
 */
export type SshDestination = {
  /** A host name, an address, or an entry of the SSH configuration of the machine that connects. */
  host: string;
  /** Absent where the entry says who connects. */
  user?: string;
  /** Absent where the entry says it, or where it is the one SSH assumes. */
  port?: number;
};

/** Whether an entry of an SSH configuration has a name an editor can be handed. */
export function isSshConfiguredHost(value: unknown): value is string {
  return typeof value === 'string' && CONFIGURED_HOST_PATTERN.test(value);
}

/** Whether a host has a name that an address can carry as it is. */
export function isSshUrlHost(value: unknown): value is string {
  return typeof value === 'string' && URL_HOST_PATTERN.test(value);
}

/** `null` for anything an editor could read as something else. */
export function parseSshDestination(value: unknown): SshDestination | null {
  if (!isRecord(value) || !isSshConfiguredHost(value.host)) return null;
  const { host, user, port } = value;
  if (user !== undefined && (typeof user !== 'string' || !USER_PATTERN.test(user))) return null;
  if (port !== undefined && !isPort(port)) return null;
  return { host, ...(user === undefined ? {} : { user }), ...(port === undefined ? {} : { port }) };
}

/** What a machine says about itself, as an editor is handed it. */
export function toSshDestination(machine: LanSshDestination): SshDestination {
  return {
    host: machine.host,
    user: machine.user,
    ...(machine.port === LAN_SSH_DEFAULT_PORT ? {} : { port: machine.port }),
  };
}

/** `[user@]host[:port]`, for someone to read. */
export function formatSshDestination(destination: SshDestination): string {
  const user = destination.user === undefined ? '' : `${destination.user}@`;
  const port = destination.port === undefined ? '' : `:${destination.port}`;
  return `${user}${destination.host}${port}`;
}
