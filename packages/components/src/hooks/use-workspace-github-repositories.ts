import { useEffect, useState } from 'react';
import type { WorkspaceRepository } from '@lody/cloud-api';
import { useCloudQuery } from '@lody/platform/react';
import { useAppCapability } from '@/lib/app-platform';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { listLocalGitHubRepositories } from '@/lib/local-github-repositories';

/**
 * The GitHub repositories of a workspace: the hosted registry's, or where
 * there is none, the ones the GitHub credential of this machine reads.
 * `undefined` while they load, as the hosted query is.
 */
export function useWorkspaceGitHubRepositories(
  workspaceId: string | null | undefined
): WorkspaceRepository[] | null | undefined {
  const registry = useAppCapability('githubIntegration');
  const hosted = useCloudQuery(
    cloudOperations.github.getWorkspaceRepositories,
    registry && workspaceId ? { workspaceId } : 'skip'
  );
  const [local, setLocal] = useState<{
    workspaceId: string;
    repositories: WorkspaceRepository[];
  } | null>(null);
  useEffect(() => {
    if (registry || !workspaceId) return undefined;
    let current = true;
    listLocalGitHubRepositories(workspaceId).then(
      (repositories) => {
        if (current) setLocal({ workspaceId, repositories });
      },
      () => {
        if (current) setLocal({ workspaceId, repositories: [] });
      }
    );
    return () => {
      current = false;
    };
  }, [registry, workspaceId]);
  if (registry) return hosted;
  return local && local.workspaceId === workspaceId ? local.repositories : undefined;
}
