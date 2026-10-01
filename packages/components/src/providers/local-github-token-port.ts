import type { GitHubTokenErrorResult, GitHubTokenPort } from '@/lib/github-token-port';

/**
 * The local desktop's GitHub token source: the `gh` login of the machine this
 * window runs on, read by the Electron main process. There is no hosted broker,
 * so there is no per-repository scoping and no personal/App distinction; the
 * token is whatever `gh` holds, and GitHub itself decides what it may do.
 */
export type LocalGitHubCliTokenResult =
  | { ok: true; token: string }
  | { ok: false; code: string; message: string };

export type ReadLocalGitHubCliToken = () => Promise<LocalGitHubCliTokenResult | null | undefined>;

/**
 * `gh` tokens do not expire on a schedule. The renderer cache refreshes 10
 * minutes before this, so a re-login is picked up within about half an hour,
 * or at once when GitHub answers 401.
 */
const LOCAL_TOKEN_LIFETIME_MS = 40 * 60 * 1000;

const UNAVAILABLE: GitHubTokenErrorResult = {
  success: false,
  errorCode: 'gh_unavailable',
  errorMessage: 'This window cannot read the GitHub CLI login of its machine.',
};

export function createLocalGitHubTokenPort(
  read: ReadLocalGitHubCliToken,
  now: () => number = Date.now
): GitHubTokenPort {
  const readToken = async () => {
    let result: LocalGitHubCliTokenResult | null | undefined;
    try {
      result = await read();
    } catch {
      return UNAVAILABLE;
    }
    if (!result) return UNAVAILABLE;
    if (!result.ok) {
      return {
        success: false as const,
        errorCode: result.code === 'gh-missing' ? 'gh_missing' : 'gh_not_authenticated',
        errorMessage: result.message,
      };
    }
    return {
      success: true as const,
      token: result.token,
      expiresAt: new Date(now() + LOCAL_TOKEN_LIFETIME_MS).toISOString(),
    };
  };
  return {
    getRepoToken: async () => await readToken(),
    getOperationToken: async () => {
      const result = await readToken();
      // `app` keeps the hosted personal-identity advice out of a 403 message.
      return result.success ? { ...result, tokenSource: 'app' as const } : result;
    },
  };
}
