import { sha256Hex } from './sha256';
import type { RepoId, SessionId } from '.';

const SAFE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LOCAL_REPO_ID_PREFIX = 'local---';

function assertSafeSessionId(sessionId: SessionId): void {
  if (!SAFE_SESSION_ID_RE.test(sessionId)) {
    throw new Error(
      `Invalid sessionId ${JSON.stringify(sessionId)}: expected /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/`
    );
  }
}

// ── GitHub repo parsing (extracted from apps/cli/src/utils/github.ts) ──

const GITHUB_REPO_PART_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const GITHUB_REPO_OWNER_MAX_LEN = 39;
const GITHUB_REPO_NAME_MAX_LEN = 100;

type GitHubRepoParts = { owner: string; repo: string };

function parseOwnerRepoFromPathSegment(pathStr: string, raw: string): GitHubRepoParts {
  const cleaned = pathStr
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  const parts = cleaned.split('/').filter(Boolean);

  if (parts.length !== 2) {
    throw new Error(`Invalid GitHub repo: expected owner/repo, got ${JSON.stringify(raw)}`);
  }

  const owner = parts[0] ?? '';
  const repo = parts[1] ?? '';

  if (
    !owner ||
    !repo ||
    owner.length > GITHUB_REPO_OWNER_MAX_LEN ||
    repo.length > GITHUB_REPO_NAME_MAX_LEN ||
    !GITHUB_REPO_PART_RE.test(owner) ||
    !GITHUB_REPO_PART_RE.test(repo)
  ) {
    throw new Error(`Invalid GitHub repo: expected owner/repo, got ${JSON.stringify(raw)}`);
  }

  return { owner, repo };
}

function stripWrappingQuotes(value?: string): string | undefined {
  if (!value) return value;
  return value.replace(/^['"]+|['"]+$/g, '');
}

export function parseGitHubRepo(raw: string): GitHubRepoParts {
  const value = stripWrappingQuotes(raw?.trim()) ?? raw?.trim();
  if (!value) {
    throw new Error('Invalid GitHub repo: empty value');
  }

  if (/^git@github\.com:/i.test(value)) {
    return parseOwnerRepoFromPathSegment(value.replace(/^git@github\.com:/i, ''), raw);
  }

  if (/^https?:\/\//i.test(value) || /^ssh:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
      throw new Error(`Invalid GitHub repo: expected github.com host, got ${JSON.stringify(raw)}`);
    }
    return parseOwnerRepoFromPathSegment(url.pathname, raw);
  }

  if (/^github\.com\//i.test(value) || /^www\.github\.com\//i.test(value)) {
    const url = new URL(`https://${value}`);
    return parseOwnerRepoFromPathSegment(url.pathname, raw);
  }

  return parseOwnerRepoFromPathSegment(value, raw);
}

// ── Public API ──

/**
 * Derives a stable repo id from a GitHub repo reference.
 *
 * Accepted formats:
 * - `owner/repo`
 * - `https://github.com/owner/repo` (optional `.git`)
 * - `git@github.com:owner/repo` (optional `.git`)
 *
 * The derived id is intended for local caching paths (e.g. bare repo and worktrees). It is
 * readable and maps 1:1 to the source repository.
 */
export function deriveRepoIdFromGitHubRepo(repo: string): RepoId {
  const { owner, repo: repoName } = parseGitHubRepo(repo);
  return `github---${owner.toLowerCase()}---${repoName.toLowerCase()}` as RepoId;
}

/**
 * Normalize a filesystem path to use forward slashes, so the segment joining below
 * has a single separator to reason about. Callers that hand the result back to a
 * host (`fs`, `spawn`, an error message, a launcher argv) restore the host's own
 * separator with `toHostSeparators`; URI builders normalize to `/` themselves.
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

const WINDOWS_ROOTED_PATH_RE = /^[A-Za-z]:[\\/]/;

/**
 * Whether a stored host path was produced on Windows.
 *
 * The shape of the value decides, never `process.platform`: these builders run in the
 * renderer against a `dotlodyPath` that the Flock carries from whichever machine owns
 * the session, so a Windows desktop routinely builds paths for a Linux machine and a
 * Linux browser builds paths for a Windows one.
 */
function isWindowsStyleHostPath(hostPath: string): boolean {
  return WINDOWS_ROOTED_PATH_RE.test(hostPath) || hostPath.includes('\\');
}

/**
 * Re-apply `hostPath`'s separator to a `/`-joined path derived from it.
 *
 * Without this a Windows machine's worktree and chat paths surface as
 * `C:/Users/x/.lody/...` while every path the CLI builds with `path.join` (local
 * project roots, the chat workdir the daemon actually creates) is `C:\Users\x\...`.
 * The two spellings name one directory but never compare equal, and the mixed form
 * is what the user sees in the workspace path, path launchers and workdir errors.
 */
function toHostSeparators(joined: string, hostPath: string): string {
  return isWindowsStyleHostPath(hostPath) ? joined.replace(/\//g, '\\') : joined;
}

function normalizeLocalProjectPathForRepoId(p: string): string {
  const normalized = normalizePath(p.trim());
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+$/g, '');
}

/**
 * Base directory for all Lody repositories on the host.
 * Returns `<homeDir>/.lody/repos`, in the separator style of `homeDir` itself.
 *
 * Carries the same caveat as `getLodyDotlodyPath`: the literal `.lody` is a fallback
 * for a machine with no published `dotlodyPath` row, not the installation's real data
 * root. Node callers have `getLodyDataDir()` and must use it.
 *
 * @param homeDir - The user's home directory (e.g. from `os.homedir()`).
 *   Required because this module is browser-compatible and cannot access Node.js `os`.
 */
export function getLodyReposBaseDir(homeDir: string): string {
  return getLodyReposBaseDirFromDotlodyPath(getLodyDotlodyPath(homeDir));
}

/**
 * Host path for the machine-wide Lody data directory.
 * Returns `<homeDir>/.lody`, in the separator style of `homeDir` itself.
 *
 * Only a fallback for a machine that has not published its `dotlodyPath` row yet:
 * being browser-safe, it cannot see `LODY_DATA_DIR` or the OSS `.lody-oss` profile,
 * both of which the published row honors. Prefer the published row when present.
 */
export function getLodyDotlodyPath(homeDir: string): string {
  return toHostSeparators(`${normalizePath(homeDir)}/.lody`, homeDir);
}

function normalizeDotlodyPath(dotlodyPath: string): string {
  const normalized = normalizePath(dotlodyPath.trim());
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+$/g, '');
}

/**
 * Base directory for all Lody repositories from a stored machine `.lody` path.
 * Returns `<dotlodyPath>/repos`, in the separator style of `dotlodyPath` itself.
 */
export function getLodyReposBaseDirFromDotlodyPath(dotlodyPath: string): string {
  return toHostSeparators(`${normalizeDotlodyPath(dotlodyPath)}/repos`, dotlodyPath);
}

/**
 * Relative path segment from repos base to a session worktree.
 * Returns `<repoId>/worktrees/<sessionId>`.
 */
export function getWorktreeRelativePath(repoId: RepoId, sessionId: SessionId): string {
  assertSafeSessionId(sessionId);
  return `${repoId}/worktrees/${sessionId}`;
}

/**
 * Host path for a session worktree: `<homeDir>/.lody/repos/<repoId>/worktrees/<sessionId>`.
 *
 * @param homeDir - The user's home directory (e.g. from `os.homedir()`).
 */
export function getWorktreeHostPath(
  repoId: RepoId,
  sessionId: SessionId,
  homeDir?: string
): string {
  assertSafeSessionId(sessionId);
  if (homeDir) {
    return getWorktreeHostPathFromDotlodyPath(repoId, sessionId, getLodyDotlodyPath(homeDir));
  }
  // Fallback: use ~ as placeholder (useful for display / protocol URIs)
  return `~/.lody/repos/${repoId}/worktrees/${sessionId}`;
}

/**
 * Host path for a session worktree from a stored machine `.lody` path.
 */
export function getWorktreeHostPathFromDotlodyPath(
  repoId: RepoId,
  sessionId: SessionId,
  dotlodyPath: string
): string {
  assertSafeSessionId(sessionId);
  return toHostSeparators(
    `${normalizeDotlodyPath(dotlodyPath)}/repos/${repoId}/worktrees/${sessionId}`,
    dotlodyPath
  );
}

/**
 * Host path for a chat-only session workspace from a stored machine `.lody` path.
 */
export function getDefaultSessionWorkdirFromDotlodyPath(
  dotlodyPath: string,
  sessionId: SessionId
): string {
  assertSafeSessionId(sessionId);
  return toHostSeparators(`${normalizeDotlodyPath(dotlodyPath)}/chats/${sessionId}`, dotlodyPath);
}

/** Derive a stable repoId for a local project by hashing its absolute root path. */
export function deriveRepoIdFromLocalProjectPath(absolutePath: string): RepoId {
  const normalized = normalizeLocalProjectPathForRepoId(absolutePath);
  if (!normalized) {
    throw new Error('Invalid local project path: empty value');
  }
  return `${LOCAL_REPO_ID_PREFIX}${sha256Hex(normalized).slice(0, 12)}` as RepoId;
}

export function isLocalRepoId(repoId: RepoId): boolean {
  return repoId.startsWith(LOCAL_REPO_ID_PREFIX);
}
