// Platform-neutral contract for self-hosted Streams hubs ("LANs"). Node-only
// file access and id derivation live in `node/lan-hub.ts`; everything here is
// safe in a renderer.
import { LAN_HUB_SCHEME, LOCAL_USER_ID_PREFIX, LOCAL_WORKSPACE_ID_PREFIX } from './platform-kind';
import { isReservedWorkspaceSlug } from './workspace-slugs';

export const LAN_HUB_DEFAULT_NAME = 'Lody LAN';
export const LAN_HUB_DEFAULT_SLUG = 'lan';
export const LAN_HUB_NAME_MAX_LENGTH = 40;
export const LAN_HUB_ID_PATTERN = /^[a-f0-9]{32}$/;
export const LAN_INVITE_SCHEME = 'lody-lan';
export const LAN_INVITE_TLS_SCHEME = 'lody-lans';

/**
 * The one owner of every LAN workspace. A LAN is a trust domain: whoever holds
 * its credential may control every machine in it, so its devices act as one
 * user, exactly like one account signed in on several devices. The id is the
 * same for every LAN because a process has a single identity while it may
 * belong to several LANs at once.
 */
export const LAN_SHARED_USER_ID = `${LOCAL_USER_ID_PREFIX}be8b1a352fc7a753365e852b5b5998e8`;

/** What a renderer may know about a LAN: everything except its credential. */
export type LanHubSummary = {
  /** Stable on every device that joined this LAN. */
  id: string;
  /** Chosen on this device; other devices may call the same LAN differently. */
  name: string;
  /** Origin of the hub, e.g. `http://100.64.0.1:8788`. */
  url: string;
  slug: string;
  workspaceId: string;
};

export type LanInvite = {
  url: string;
  token: string;
  name: string | null;
};

export class LanHubInputError extends Error {
  constructor(
    readonly code:
      | 'invalid_url'
      | 'invalid_token'
      | 'invalid_name'
      | 'invalid_invite'
      | 'duplicate_name'
      | 'duplicate_hub'
      | 'unknown_hub',
    message: string
  ) {
    super(message);
    this.name = 'LanHubInputError';
  }
}

export function getLanHubWorkspaceId(hubId: string): string {
  return `${LOCAL_WORKSPACE_ID_PREFIX}${hubId}`;
}

/**
 * How a desktop renderer addresses one hub. The shell forwards this origin to
 * the hub's real address and supplies the credential itself.
 */
export function getLanHubRendererOrigin(hubId: string): string {
  if (!LAN_HUB_ID_PATTERN.test(hubId)) {
    throw new LanHubInputError('unknown_hub', `Invalid LAN id ${JSON.stringify(hubId)}`);
  }
  return `${LAN_HUB_SCHEME}://${hubId}`;
}

/** Accepts `host:port` as well, because that is what people copy from a terminal. */
export function normalizeLanHubUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new LanHubInputError('invalid_url', 'LAN address is required');
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  const authority = (scheme ? trimmed.slice(scheme[0].length) : trimmed).replace(/\/+$/g, '');
  const candidate = `${scheme ? scheme[1] : 'http'}://${authority}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new LanHubInputError(
      'invalid_url',
      `LAN address is not a valid URL: ${JSON.stringify(input)}`
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new LanHubInputError('invalid_url', 'LAN address must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new LanHubInputError('invalid_url', 'LAN address must not contain credentials');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new LanHubInputError('invalid_url', 'LAN address must not contain a path or query');
  }
  return parsed.origin;
}

export function normalizeLanHubToken(input: string): string {
  const token = input.trim();
  if (!token) throw new LanHubInputError('invalid_token', 'LAN token is required');
  // The token travels in an HTTP header and in an invite link.
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(token)) {
    throw new LanHubInputError('invalid_token', 'LAN token contains unsupported characters');
  }
  return token;
}

export function normalizeLanHubName(input: string): string {
  const name = input.replace(/\s+/g, ' ').trim();
  if (!name) throw new LanHubInputError('invalid_name', 'LAN name is required');
  if (name.length > LAN_HUB_NAME_MAX_LENGTH) {
    throw new LanHubInputError(
      'invalid_name',
      `LAN name must be at most ${LAN_HUB_NAME_MAX_LENGTH} characters`
    );
  }
  return name;
}

function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

/**
 * Route slug of a LAN on this device. It follows the name while staying a
 * valid, unreserved and unique workspace slug; `taken` holds the slugs of the
 * other LANs.
 */
export function resolveLanHubSlug(
  hub: { id: string; name: string },
  taken: ReadonlySet<string> = new Set()
): string {
  const base = hub.name === LAN_HUB_DEFAULT_NAME ? LAN_HUB_DEFAULT_SLUG : slugify(hub.name);
  const candidates = [
    base,
    base ? `${LAN_HUB_DEFAULT_SLUG}-${base}` : '',
    `${LAN_HUB_DEFAULT_SLUG}-${hub.id.slice(0, 8)}`,
  ];
  for (const candidate of candidates) {
    if (candidate && !isReservedWorkspaceSlug(candidate) && !taken.has(candidate)) {
      return candidate;
    }
  }
  return `${LAN_HUB_DEFAULT_SLUG}-${hub.id}`;
}

/**
 * One string that carries everything a device needs to join a LAN. The token
 * sits in the user-info position and the name in the path, so the link needs
 * no quoting in a shell.
 */
export function formatLanInvite(hub: { url: string; token: string; name?: string | null }): string {
  const url = new URL(normalizeLanHubUrl(hub.url));
  const scheme = url.protocol === 'https:' ? LAN_INVITE_TLS_SCHEME : LAN_INVITE_SCHEME;
  const token = encodeURIComponent(normalizeLanHubToken(hub.token));
  const name = hub.name?.trim() ? `/${encodeURIComponent(normalizeLanHubName(hub.name))}` : '';
  return `${scheme}://${token}@${url.host}${name}`;
}

export function parseLanInvite(input: string): LanInvite {
  const match = /^(lody-lans?):\/\/(.+)$/i.exec(input.trim());
  if (!match) {
    throw new LanHubInputError(
      'invalid_invite',
      `A LAN invite starts with ${LAN_INVITE_SCHEME}:// or ${LAN_INVITE_TLS_SCHEME}://`
    );
  }
  const secure = match[1]!.toLowerCase() === LAN_INVITE_TLS_SCHEME;
  let parsed: URL;
  try {
    // Parsed as a web address so every runtime reads the authority the same way.
    parsed = new URL(`${secure ? 'https' : 'http'}://${match[2]!}`);
  } catch {
    throw new LanHubInputError('invalid_invite', 'The LAN invite is not a valid link');
  }
  if (!parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new LanHubInputError('invalid_invite', 'The LAN invite is not a valid link');
  }
  let token: string;
  let name: string | null;
  try {
    token = normalizeLanHubToken(decodeURIComponent(parsed.username));
    const rawName = decodeURIComponent(parsed.pathname.replace(/^\/+|\/+$/g, ''));
    name = rawName ? normalizeLanHubName(rawName) : null;
  } catch (error) {
    if (error instanceof LanHubInputError) throw error;
    throw new LanHubInputError('invalid_invite', 'The LAN invite is not a valid link');
  }
  return { url: parsed.origin, token, name };
}

/**
 * The name a machine is known by. A host name reported by the operating system
 * can carry the domain of whichever network the machine is on right now, so
 * only its first label identifies the machine itself.
 */
export function normalizeMachineName(hostname: string): string {
  const trimmed = hostname.trim().replace(/\.+$/g, '');
  if (!trimmed) return trimmed;
  // An address has no labels to drop.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(trimmed) || trimmed.includes(':')) return trimmed;
  const [label] = trimmed.split('.');
  return label || trimmed;
}
