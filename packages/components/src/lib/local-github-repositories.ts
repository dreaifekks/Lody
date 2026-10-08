import { z } from 'zod';
import type { WorkspaceRepository } from '@lody/cloud-api';
import { getGitHubRepoToken } from './github-token';

/** `/user/repos` pages of 100; ten cover any account a picker lists. */
const MAX_PAGES = 10;
/** Read again after this, so a credential that gained repositories shows them. */
const LIST_LIFETIME_MS = 5 * 60 * 1000;

const GitHubRepositorySchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  description: z.string().nullable().optional(),
});

const lists = new Map<string, { readAt: number; repositories: Promise<WorkspaceRepository[]> }>();

async function readRepositories(
  workspaceId: string,
  request: typeof fetch
): Promise<WorkspaceRepository[]> {
  let token: string;
  try {
    token = await getGitHubRepoToken(workspaceId, '');
  } catch {
    // No credential on this machine and none from its LAN: no repositories.
    return [];
  }
  const repositories: WorkspaceRepository[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await request(
      `https://api.github.com/user/repos?per_page=100&sort=full_name&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } }
    );
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for the repositories`);
    const items = z.array(GitHubRepositorySchema).parse(await response.json());
    for (const item of items)
      repositories.push({
        id: item.id,
        name: item.name,
        fullName: item.full_name,
        private: item.private,
        description: item.description ?? null,
      });
    if (items.length < 100) break;
  }
  return repositories;
}

/**
 * The repositories a workspace of the local platform works with. It keeps no
 * registry of them: they are the ones the GitHub credential of this machine
 * reads, the LAN host's token or its own `gh` login, as `lody github list`
 * lists them.
 */
export function listLocalGitHubRepositories(
  workspaceId: string,
  options: { request?: typeof fetch; now?: () => number } = {}
): Promise<WorkspaceRepository[]> {
  const now = options.now ?? Date.now;
  const kept = lists.get(workspaceId);
  if (kept && now() - kept.readAt < LIST_LIFETIME_MS) return kept.repositories;
  const repositories = readRepositories(workspaceId, options.request ?? fetch);
  lists.set(workspaceId, { readAt: now(), repositories });
  // A failed read is asked again next time rather than kept.
  repositories.catch(() => lists.delete(workspaceId));
  return repositories;
}

/** Reads the list again next time, for a credential that just changed. */
export function forgetLocalGitHubRepositories(workspaceId: string): void {
  lists.delete(workspaceId);
}
