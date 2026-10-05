import { afterEach, describe, expect, it } from 'vitest';
import { installGitHubTokenPort, type GitHubRepoTokenResult } from '../src/lib/github-token-port';
import { invalidateGitHubTokensForWorkspace } from '../src/lib/github-token';
import { listLocalGitHubRepositories } from '../src/lib/local-github-repositories';

const repository = (id: number, fullName: string) => ({
  id,
  name: fullName.split('/')[1],
  full_name: fullName,
  private: id % 2 === 0,
  description: null,
});

describe('local GitHub repositories', () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  const install = (result: GitHubRepoTokenResult) => {
    uninstall = installGitHubTokenPort({
      getRepoToken: async () => result,
      getOperationToken: async () => ({ success: false, errorCode: 'x', errorMessage: 'x' }),
    });
  };

  it('lists what the credential reads, page by page, and reads again once the list is old', async () => {
    install({ success: true, token: 'lan-token', expiresAt: '2999-01-01T00:00:00.000Z' });
    const requests: string[] = [];
    const pages = [
      Array.from({ length: 100 }, (_, index) => repository(index + 1, `acme/repo-${index}`)),
      [repository(500, 'acme/last')],
    ];
    const request = (async (url: string, init?: RequestInit) => {
      requests.push(`${new Headers(init?.headers).get('authorization')} ${url}`);
      return Response.json(pages[requests.length - 1] ?? []);
    }) as typeof fetch;
    let now = 1_000;
    const list = () => listLocalGitHubRepositories('lw_repos', { request, now: () => now });

    const repositories = await list();
    expect(repositories).toHaveLength(101);
    expect(repositories.at(-1)).toEqual({
      id: 500,
      name: 'last',
      fullName: 'acme/last',
      private: true,
      description: null,
    });
    expect(requests).toHaveLength(2);
    expect(requests.every((line) => line.startsWith('Bearer lan-token '))).toBe(true);

    // Kept for a while, then read again.
    await list();
    expect(requests).toHaveLength(2);
    now += 5 * 60 * 1000;
    pages.push([repository(7, 'acme/new')]);
    expect((await list()).map((repo) => repo.fullName)).toEqual(['acme/new']);
  });

  it('lists none where the machine has no credential, without asking GitHub', async () => {
    invalidateGitHubTokensForWorkspace('lw_none');
    install({ success: false, errorCode: 'gh_not_authenticated', errorMessage: 'no login' });
    let asked = false;
    const request = (async () => {
      asked = true;
      return Response.json([]);
    }) as typeof fetch;
    expect(await listLocalGitHubRepositories('lw_none', { request })).toEqual([]);
    expect(asked).toBe(false);
  });
});
