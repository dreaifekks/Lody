import { LODY_PROTOCOLS, SESSION_LINK_SCHEMES } from './session-link-schemes.mjs';
export {
  LODY_PROTOCOLS,
  SESSION_LINK_SCHEMES,
  INSTALLATION_LINK_SCHEMES,
} from './session-link-schemes.mjs';

/** Public resource links are independent of the installed desktop channel. */
export type SessionLink = {
  sessionId: string;
  workspaceId?: string;
  /** Legacy read compatibility only; new links address this ID directly. */
  tabSessionId?: string;
  /** Fork: a turn of the conversation to scroll to (`?turn=`). */
  turnId?: string;
};

const ID = /^[A-Za-z0-9_-]+$/u;
/** Turn ids also use `:` and `.` (`assistant:inbox:completion:12`). */
const TURN_ID = /^[A-Za-z0-9_.:-]+$/u;
const SCHEMES = new Set(SESSION_LINK_SCHEMES.map((scheme) => `${scheme}:`));

export function buildSessionLink(target: SessionLink): string {
  for (const value of [target.sessionId, target.workspaceId, target.tabSessionId]) {
    if (value !== undefined && !ID.test(value)) throw new Error('Invalid session link identifier');
  }
  if (target.turnId !== undefined && !TURN_ID.test(target.turnId))
    throw new Error('Invalid session link identifier');
  const query = new URLSearchParams();
  if (target.workspaceId) query.set('workspace', target.workspaceId);
  // Written raw: URLSearchParams would encode a turn id's colons, and links carry no `%`.
  const search = [query.toString(), target.turnId ? `turn=${target.turnId}` : '']
    .filter(Boolean)
    .join('&');
  const sessionId = target.tabSessionId ?? target.sessionId;
  const url = `${LODY_PROTOCOLS.resource}://session/${sessionId}${search ? `?${search}` : ''}`;
  if (url.length > 8192) throw new Error('Session link is too long');
  return url;
}

/** Read old transcripts without ever registering the generic session scheme. */
export function parseSessionLink(raw: string): SessionLink | null {
  if (raw.length > 8192 || /[\s\\%]/u.test(raw)) return null;
  const legacy = /^session:\/\/([A-Za-z0-9_-]+)\/?$/u.exec(raw);
  if (legacy) return { sessionId: legacy[1]! };
  // Reject path normalization (e.g. /other/../id) before URL can erase it.
  if (!/^[a-zA-Z.-]+:\/\/session\/[A-Za-z0-9_-]+(?:\?[^#]*)?$/u.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    !SCHEMES.has(url.protocol) ||
    url.hostname !== 'session' ||
    url.port ||
    url.username ||
    url.password
  )
    return null;
  const sessionId = url.pathname.slice(1);
  if (!ID.test(sessionId)) return null;
  for (const key of url.searchParams.keys()) {
    if (key !== 'workspace' && key !== 'tab' && key !== 'turn') return null;
    if (
      url.searchParams.getAll(key).length !== 1 ||
      !(key === 'turn' ? TURN_ID : ID).test(url.searchParams.get(key) ?? '')
    )
      return null;
  }
  return {
    sessionId,
    ...(url.searchParams.has('workspace')
      ? { workspaceId: url.searchParams.get('workspace')! }
      : {}),
    ...(url.searchParams.has('tab') ? { tabSessionId: url.searchParams.get('tab')! } : {}),
    ...(url.searchParams.has('turn') ? { turnId: url.searchParams.get('turn')! } : {}),
  };
}

/** MCP references cannot select a different authorized workspace. */
export function resolveSessionLinkId(raw: string, workspaceId: string): string {
  const link = parseSessionLink(raw);
  if (!link) {
    if (!ID.test(raw)) throw new Error('Invalid session reference');
    return raw;
  }
  if (link.workspaceId && link.workspaceId !== workspaceId) {
    throw new Error('Session link belongs to a different workspace');
  }
  // A bare session reference is unambiguous; tab relationships require a catalog.
  if (link.tabSessionId) throw new Error('Use the child session ID directly for MCP requests');
  // A `turn` only scrolls the reader; tools address the whole conversation.
  return link.sessionId;
}
