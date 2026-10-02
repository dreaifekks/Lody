// The GitHub credential a LAN host keeps for its members. One person's devices
// share one GitHub account, so the host holds a single token and every member
// that has no `gh` login of its own asks the host for it, behind the same
// credential gate as everything else of the LAN.
import type { LanHub } from './lan-hub';

export const LAN_GITHUB_TOKEN_PATH = '/github/token';

export type LanGitHubCredential = {
  token: string;
  /** The GitHub login the token acts as, recorded when it was saved. */
  login: string | null;
  /** The numeric GitHub user id; GitHub counts rate limits per user. */
  userId: string | null;
};

const REQUEST_TIMEOUT_MS = 8_000;

/**
 * The credential the host of `hub` keeps, or `null` when it keeps none or runs
 * a build without one. Throws when the host cannot be asked.
 */
export async function fetchLanHubGitHubCredential(
  hub: Pick<LanHub, 'url' | 'token'>,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<LanGitHubCredential | null> {
  const response = await (options.fetch ?? fetch)(`${hub.url}${LAN_GITHUB_TOKEN_PATH}`, {
    headers: { Authorization: `Bearer ${hub.token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`The LAN host answered ${response.status}`);
  const body = (await response.json()) as Partial<LanGitHubCredential>;
  if (typeof body.token !== 'string' || !body.token) {
    throw new Error('The LAN host answered without a GitHub token');
  }
  return {
    token: body.token,
    login: typeof body.login === 'string' ? body.login : null,
    userId: typeof body.userId === 'string' ? body.userId : null,
  };
}
