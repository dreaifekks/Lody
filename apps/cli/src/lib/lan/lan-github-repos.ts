// The local platform has no hosted repository registry: the repositories a
// LAN works with are the ones its GitHub credential can see. The credential is
// the LAN host's token, or this machine's own `gh` login when the host has none.
import { z } from 'zod';
import type { WorkspaceGitHubRepository } from '@/lib/workspace';

const REQUEST_TIMEOUT_MS = 15_000;
/** `/user/repos` pages of 100; ten cover any account a terminal lists. */
const MAX_LIST_PAGES = 10;

const GitHubRepositorySchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string(),
});

export type GitHubRepositoryInfo = WorkspaceGitHubRepository & { defaultBranch: string };

const toRepository = (raw: z.infer<typeof GitHubRepositorySchema>): GitHubRepositoryInfo => ({
  id: raw.id,
  name: raw.name,
  fullName: raw.full_name,
  private: raw.private,
  defaultBranch: raw.default_branch,
});

const requestGitHub = async (token: string, path: string, request: typeof fetch) =>
  await request(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'lody-lan',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

/** One repository as the credential sees it; `null` when it cannot see it at all. */
export async function readGitHubRepository(
  token: string,
  repoFullName: string,
  request: typeof fetch = fetch
): Promise<GitHubRepositoryInfo | null> {
  const [owner, name, ...rest] = repoFullName.split('/');
  if (!owner || !name || rest.length > 0)
    throw new Error(`Not a GitHub repository: ${repoFullName}`);
  const response = await requestGitHub(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    request
  );
  // GitHub answers 404 for a private repository the credential may not read.
  if (response.status === 404) return null;
  if (response.status === 401) throw new Error('GitHub does not accept the LAN GitHub token');
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${repoFullName}`);
  return toRepository(GitHubRepositorySchema.parse(await response.json()));
}

/** The repositories the credential can read, by full name. */
export async function listGitHubRepositories(
  token: string,
  request: typeof fetch = fetch
): Promise<GitHubRepositoryInfo[]> {
  const repositories: GitHubRepositoryInfo[] = [];
  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const response = await requestGitHub(
      token,
      `/user/repos?per_page=100&sort=full_name&page=${page}`,
      request
    );
    if (response.status === 401) throw new Error('GitHub does not accept the LAN GitHub token');
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for the repository list`);
    const items = z.array(GitHubRepositorySchema).parse(await response.json());
    repositories.push(...items.map(toRepository));
    if (items.length < 100) break;
  }
  return repositories;
}
