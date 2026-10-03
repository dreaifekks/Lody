// The GitHub token port of a LAN member: in place of the hosted broker, the
// member asks the host of the workspace's LAN for the one credential it keeps.
// There is no personal identity and no per-repository scoping; whichever
// repository is asked for gets the same token, and GitHub decides what it may do.
import type {
  CloudGithubTokenManager,
  CloudGithubTokenPort,
  CloudGithubWriteTokenContext,
} from '@lody/platform';
import type { LanHub } from '@lody/shared/node/lan-hub';
import {
  fetchLanHubGitHubCredential,
  type LanGitHubCredential,
} from '@lody/shared/node/lan-github';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

/** A token saved on the host is long-lived; this bounds how late a change is seen. */
const CREDENTIAL_TTL_MS = 5 * 60_000;
/** The PR poller asks for every repository it watches; a host without a token is asked again later. */
const ABSENT_TTL_MS = 60_000;
const UNREACHABLE_TTL_MS = 15_000;

type Cached =
  | { kind: 'credential'; credential: LanGitHubCredential; until: number }
  | { kind: 'absent'; until: number };

export class LanGitHubTokenUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LanGitHubTokenUnavailableError';
  }
}

function createLanGitHubTokenManager(options: {
  workspaceId: string;
  resolveHub: (workspaceId: string) => LanHub | null;
  logger: Logger;
  fetch?: typeof fetch;
  now: () => number;
}): CloudGithubTokenManager {
  let cached: Cached | null = null;
  let pending: Promise<LanGitHubCredential> | null = null;

  const load = async (): Promise<LanGitHubCredential> => {
    const hub = options.resolveHub(options.workspaceId);
    if (!hub) throw new LanGitHubTokenUnavailableError('This workspace belongs to no LAN');
    let credential: LanGitHubCredential | null;
    try {
      credential = await fetchLanHubGitHubCredential(hub, { fetch: options.fetch });
    } catch (error) {
      // Remembered briefly, so a host that is away does not slow every request.
      cached = { kind: 'absent', until: options.now() + UNREACHABLE_TTL_MS };
      throw new LanGitHubTokenUnavailableError(
        `The host of ${hub.name} could not be asked for its GitHub token: ${formatErrorMessage(error)}`
      );
    }
    if (!credential) {
      cached = { kind: 'absent', until: options.now() + ABSENT_TTL_MS };
      throw new LanGitHubTokenUnavailableError(`The host of ${hub.name} keeps no GitHub token`);
    }
    cached = { kind: 'credential', credential, until: options.now() + CREDENTIAL_TTL_MS };
    return credential;
  };

  const getCredential = async (): Promise<LanGitHubCredential> => {
    if (cached && cached.until > options.now()) {
      if (cached.kind === 'credential') return cached.credential;
      throw new LanGitHubTokenUnavailableError('The LAN host has given no GitHub token lately');
    }
    pending ??= load().finally(() => {
      pending = null;
    });
    return await pending;
  };

  const info = async () => {
    const credential = await getCredential();
    return {
      token: credential.token,
      tokenSource: 'app' as const,
      rateLimitScope: credential.userId
        ? `github:user:${credential.userId}`
        : `github:lan:${options.workspaceId}`,
    };
  };

  const forget = (token?: string) => {
    if (!token || (cached?.kind === 'credential' && cached.credential.token === token)) {
      cached = null;
    }
  };

  return {
    getCredentialPolicy: () => Promise.resolve({ personalEnabled: false }),
    getCredentialCandidate: async (_repoFullName, _context, source) => {
      if (source === 'personal') return { available: false, reason: 'personal_auth_missing' };
      try {
        const { token } = await info();
        return { token, tokenSource: 'app' };
      } catch (error) {
        options.logger.debug(`[lan-github] ${formatErrorMessage(error)}`);
        return { available: false, reason: 'lan_host_has_no_token' };
      }
    },
    startAutoRefresh: () => {},
    getAppTokenForRepo: async () => (await info()).token,
    getWriteTokenForRepo: async (_repoFullName: string, _context: CloudGithubWriteTokenContext) =>
      (await info()).token,
    getAppTokenInfoForRepo: async () => await info(),
    getWriteTokenInfoForRepo: async () => await info(),
    retainRepoOwner: () => {},
    invalidate: (_repoFullName, context) => forget(context?.invalidatedToken),
    invalidateAll: () => forget(),
    shutdown: () => Promise.resolve(),
  };
}

const lanGitHubTokenPorts = new WeakSet<CloudGithubTokenPort>();

/**
 * Whether a cloud port's GitHub tokens are the LAN host's. That token is never
 * brokered: agents receive it only where the machine has no `gh` login.
 */
export function isLanGitHubTokenPort(port: CloudGithubTokenPort | null | undefined): boolean {
  return port ? lanGitHubTokenPorts.has(port) : false;
}

export function createLanGitHubTokenPort(options: {
  /** Read at each request, so a LAN that moved is followed. */
  resolveHub: (workspaceId: string) => LanHub | null;
  logger: Logger;
  fetch?: typeof fetch;
  now?: () => number;
}): CloudGithubTokenPort {
  const port: CloudGithubTokenPort = {
    createTokenManager: (workspaceId) =>
      createLanGitHubTokenManager({ ...options, workspaceId, now: options.now ?? Date.now }),
  };
  lanGitHubTokenPorts.add(port);
  return port;
}
