/**
 * Where the agent service of a LAN member accepts terminal connections from
 * the other members. It is published in the machine's metadata of that LAN's
 * workspace; the address is not a secret, the credential of the LAN is what
 * opens it.
 */
export const LAN_TERMINAL_PROTOCOL_VERSION = 1;

export type LanTerminalEndpoint = {
  version: typeof LAN_TERMINAL_PROTOCOL_VERSION;
  host: string;
  port: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `null` for anything this version cannot connect to. */
export function parseLanTerminalEndpoint(value: unknown): LanTerminalEndpoint | null {
  if (!isRecord(value) || value.version !== LAN_TERMINAL_PROTOCOL_VERSION) return null;
  const { host, port } = value;
  if (typeof host !== 'string' || host.trim() === '' || host.length > 255) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }
  return { version: LAN_TERMINAL_PROTOCOL_VERSION, host, port };
}

export function sameLanTerminalEndpoint(
  left: LanTerminalEndpoint | null | undefined,
  right: LanTerminalEndpoint | null | undefined
): boolean {
  if (!left || !right) return !left && !right;
  return left.host === right.host && left.port === right.port && left.version === right.version;
}
