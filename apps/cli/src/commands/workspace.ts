import { Command } from 'commander';
import {
  getAuthContextOrThrow,
  printJson,
  runOneShotCommand,
  type CommonCommandOptions,
} from '@/lib/command-runtime';
import { renderTerminalTable } from '@/lib/terminal-table';
import { listWorkspacesForToken, type WorkspaceSummary } from '@/lib/workspace';
import { Effect } from 'effect';
import { getCliPlatformKind } from '@/lib/cli-platform';
import { makeLocalWorkspaceCatalog } from '@/lib/local-workspace-catalog';

type WorkspaceListOptions = Pick<CommonCommandOptions, 'json' | 'debug'>;

export function sortWorkspaceSummaries(workspaces: WorkspaceSummary[]): WorkspaceSummary[] {
  return [...workspaces].sort((left, right) => {
    const nameCompare = left.name.localeCompare(right.name);
    if (nameCompare !== 0) {
      return nameCompare;
    }

    const leftSlug = left.slug?.trim() ?? '';
    const rightSlug = right.slug?.trim() ?? '';
    const slugCompare = leftSlug.localeCompare(rightSlug);
    if (slugCompare !== 0) {
      return slugCompare;
    }

    return left.id.localeCompare(right.id);
  });
}

/**
 * The local platform has no account to ask: its workspaces are the ones this
 * machine's catalog holds, one per LAN or the single local one.
 */
async function listAccessibleWorkspaces(): Promise<WorkspaceSummary[]> {
  if (getCliPlatformKind() !== 'local')
    return await listWorkspacesForToken(getAuthContextOrThrow('workspace').token);
  const catalog = await Effect.runPromise(makeLocalWorkspaceCatalog().read());
  return catalog.workspaces
    .filter((row) => row.state === 'active')
    .map((row) => ({ id: row.workspaceId, name: row.name, slug: row.slug, role: row.role }));
}

export const workspaceCommand = new Command('workspace')
  .description('Manage workspaces')
  .addCommand(
    new Command('list')
      .description('List accessible workspaces')
      .option('--json', 'Print JSON output')
      .option('--debug', 'Enable debug output')
      .action(async (options: WorkspaceListOptions) => {
        await runOneShotCommand('workspace', options, async () => {
          const workspaces = sortWorkspaceSummaries(await listAccessibleWorkspaces());
          if (options.json) {
            printJson({
              ok: true,
              workspaces: workspaces.map((workspace) => ({
                id: workspace.id,
                name: workspace.name,
                slug: workspace.slug,
              })),
            });
            return;
          }

          if (workspaces.length === 0) {
            console.log('No workspaces found.');
            return;
          }

          console.log(
            renderTerminalTable(
              [{ header: 'ID' }, { header: 'Name' }, { header: 'Slug' }],
              workspaces.map((workspace) => [workspace.id, workspace.name, workspace.slug])
            )
          );
        });
      })
  );
