import { Command } from 'commander';
import {
  getAuthContextOrThrow,
  printJson,
  resolveWorkspaceOrThrow,
  runOneShotCommand,
  type CommonCommandOptions,
} from '@/lib/command-runtime';
import { renderTerminalTable } from '@/lib/terminal-table';
import {
  listWorkspaceGitHubRepositoriesForCliToken,
  WorkspaceGitHubRepositorySchema,
  type WorkspaceGitHubRepository,
} from '@/lib/workspace';
import { z } from 'zod';
import { getCliPlatformKind } from '@/lib/cli-platform';
import { resolveTerminalToolTarget, runTerminalCommand } from '@/lib/terminal-session-tools';

type GitHubListOptions = Pick<CommonCommandOptions, 'workspace' | 'json' | 'debug'>;

export function sortGitHubRepositories(
  repositories: WorkspaceGitHubRepository[]
): WorkspaceGitHubRepository[] {
  return [...repositories].sort((left, right) => {
    const fullNameCompare = left.fullName.localeCompare(right.fullName);
    if (fullNameCompare !== 0) {
      return fullNameCompare;
    }

    const nameCompare = left.name.localeCompare(right.name);
    if (nameCompare !== 0) {
      return nameCompare;
    }

    return left.id - right.id;
  });
}

function formatRepositoryVisibility(
  repository: Pick<WorkspaceGitHubRepository, 'private'>
): string {
  return repository.private ? 'private' : 'public';
}

function printHumanRepositoryList(repositories: WorkspaceGitHubRepository[]): void {
  if (repositories.length === 0) {
    console.log('No GitHub repositories found.');
    return;
  }

  console.log(
    renderTerminalTable(
      [{ header: 'ID' }, { header: 'Repository' }, { header: 'Visibility' }],
      repositories.map((repository) => [
        repository.id,
        repository.fullName,
        formatRepositoryVisibility(repository),
      ])
    )
  );
}

const LocalRepositoryListSchema = z.object({
  workspaceId: z.string(),
  repositories: z.array(WorkspaceGitHubRepositorySchema),
});

/**
 * The hosted Lody lists the repositories linked to the workspace. A local
 * daemon has no such registry and lists what its GitHub credential can read:
 * the LAN host's token, or this machine's own `gh` login.
 */
async function listRepositories(workspaceSelector: string | undefined) {
  if (getCliPlatformKind() === 'local') {
    const result = LocalRepositoryListSchema.parse(
      await runTerminalCommand(await resolveTerminalToolTarget(workspaceSelector), {
        command: 'github-list',
      })
    );
    return {
      workspace: { id: result.workspaceId },
      repositories: sortGitHubRepositories(result.repositories),
    };
  }
  const auth = getAuthContextOrThrow('github');
  const workspace = await resolveWorkspaceOrThrow(auth, workspaceSelector);
  const repositories = sortGitHubRepositories(
    await listWorkspaceGitHubRepositoriesForCliToken({
      token: auth.token,
      workspaceId: workspace.id,
    })
  );
  return { workspace, repositories };
}

export const githubCommand = new Command('github')
  .description('List the GitHub repositories a workspace can use')
  .addCommand(
    new Command('list')
      .description('List the GitHub repositories a workspace can use')
      .option('--workspace <selector>', 'Target workspace id, slug, or name')
      .option('--json', 'Print JSON output')
      .option('--debug', 'Enable debug output')
      .action(async (options: GitHubListOptions) => {
        await runOneShotCommand('github', options, async () => {
          const { workspace, repositories } = await listRepositories(options.workspace);

          if (options.json) {
            printJson({
              ok: true,
              workspaceId: workspace.id,
              repositories: repositories.map((repository) => ({
                id: repository.id,
                name: repository.name,
                fullName: repository.fullName,
                private: repository.private,
              })),
            });
            return;
          }

          printHumanRepositoryList(repositories);
        });
      })
  );
