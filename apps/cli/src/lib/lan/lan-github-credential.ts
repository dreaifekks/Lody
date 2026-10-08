// What a machine says about its GitHub credentials to the desktop's Settings >
// GitHub, and how a desktop gives the hub of a LAN its token. Neither answer
// carries a token: the desktop sends one in and sees only whose it is.
import type { LanGitHubState, LanGitHubTokenResult } from '@lody/shared/lan-control';
import {
  fetchLanHubGitHubCredential,
  type LanGitHubCredential,
} from '@lody/shared/node/lan-github';
import {
  LAN_HUB_CREDENTIALS_GITHUB_PATH,
  readLanCredentialsGitHub,
} from '@lody/shared/node/lan-credentials';
import type { LanHub } from '@lody/shared/node/lan-hub';
import { describeGitHubToken } from './hub-github';
import { readGhAuthToken } from './lan-agent-github';

/** Sets (`PUT`) or drops (`DELETE`) one credential the hub of a LAN holds. */
export async function callLanHubCredentials(
  hub: Pick<LanHub, 'name' | 'url' | 'token'>,
  method: 'PUT' | 'DELETE',
  route: string,
  body?: unknown,
  request: typeof fetch = fetch
): Promise<Record<string, unknown>> {
  const response = await request(`${hub.url}${route}`, {
    method,
    headers: { Authorization: `Bearer ${hub.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 404) {
    throw new Error(`${hub.name} runs a host that takes no credentials from members; update it`);
  }
  if (!response.ok) {
    throw new Error(
      `${hub.name} refused: ${typeof answer.error === 'string' ? answer.error : response.status}`
    );
  }
  return answer;
}

export type LanGitHubSource = {
  /** The credentials agents of this machine use for the workspace of `hub`. */
  describe(hub: LanHub | null): Promise<LanGitHubState>;
  /** Gives `hub` the token its members use; `null` takes it back. */
  save(hub: LanHub, token: string | null): Promise<LanGitHubTokenResult>;
};

export function createLanGitHubSource(
  options: {
    readOwnToken?: () => Promise<string | null>;
    readCopy?: (hubId: string) => LanGitHubCredential | null;
    fetch?: typeof fetch;
  } = {}
): LanGitHubSource {
  const request = options.fetch ?? fetch;
  const readOwnToken = options.readOwnToken ?? readGhAuthToken;
  const readCopy = options.readCopy ?? readLanCredentialsGitHub;

  const readLan = async (hub: LanHub): Promise<LanGitHubCredential | null> => {
    try {
      return await fetchLanHubGitHubCredential(hub, { fetch: request });
    } catch {
      // While the hub is away agents use this machine's copy, so the page does too.
      return readCopy(hub.id);
    }
  };

  return {
    describe: async (hub) => {
      const [own, lan] = await Promise.all([readOwnToken(), hub ? readLan(hub) : null]);
      return {
        own: own
          ? {
              login: await describeGitHubToken(own, request).then(
                (account) => account.login,
                () => null
              ),
            }
          : null,
        lan: lan ? { login: lan.login } : null,
      };
    },
    save: async (hub, token) => {
      if (token === null) {
        await callLanHubCredentials(
          hub,
          'DELETE',
          LAN_HUB_CREDENTIALS_GITHUB_PATH,
          undefined,
          request
        );
        return { login: null };
      }
      const { login, userId } = await describeGitHubToken(token, request);
      await callLanHubCredentials(
        hub,
        'PUT',
        LAN_HUB_CREDENTIALS_GITHUB_PATH,
        { token, login, userId },
        request
      );
      return { login };
    },
  };
}
