import { Command } from 'commander';
import {
  HOSTED_CONFIG_CATEGORIES,
  countHostedConfigItems,
  type HostedConfigCategory,
  type HostedConfigItem,
  type LocalProjectControlResponse,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import { Effect } from 'effect';
import { makeLocalProbeClientAuto } from '@lody/shared/node/local-ipc';
import {
  DAEMON_NOT_RUNNING_MESSAGE,
  printJson,
  runOneShotCommand,
  type CommonCommandOptions,
} from '@/lib/command-runtime';
import { makeLocalWorkspaceCatalog } from '@/lib/local-workspace-catalog';
import { sendLocalProjectControl } from '@/lib/local-project-control-client';
import { renderTerminalTable } from '@/lib/terminal-table';

type ImportOptions = Pick<CommonCommandOptions, 'json' | 'debug'> & {
  workspace?: string;
  from?: string;
  only?: string;
  dryRun?: boolean;
};

const PROBE_TIMEOUT_MS = 3_000;

type Target = { workspaceId: WorkspaceId; name: string };

const CATEGORY_LABELS: Record<HostedConfigCategory, string> = {
  agentConfigs: 'Agent',
  mcpServers: 'MCP server',
  agentRoles: 'Role',
  localProjects: 'Project',
  worktreeScripts: 'Worktree script',
};

const REASONS: Record<NonNullable<HostedConfigItem['reason']>, string> = {
  other_machine: 'belongs to another machine',
  missing_directory: 'its directory is not on this machine',
  missing_project: 'its project is not imported',
  missing_agent: 'its agent is not imported',
  invalid: 'cannot be read',
};

function fail(response: Extract<LocalProjectControlResponse, { ok: false }>): never {
  throw new Error(response.message);
}

function parseCategories(only: string | undefined): HostedConfigCategory[] {
  if (!only?.trim()) return [...HOSTED_CONFIG_CATEGORIES];
  const names = only.split(',').map((name) => name.trim());
  const unknown = names.filter(
    (name) => !HOSTED_CONFIG_CATEGORIES.includes(name as HostedConfigCategory)
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown category ${unknown.join(', ')}; use ${HOSTED_CONFIG_CATEGORIES.join(', ')}`
    );
  }
  return names as HostedConfigCategory[];
}

/** The agent service names its machine itself, so no account is involved. */
async function resolveMachineId(): Promise<MachineId> {
  try {
    const health = await Effect.runPromise(
      makeLocalProbeClientAuto().health({ timeoutMs: PROBE_TIMEOUT_MS })
    );
    return health.machineId as MachineId;
  } catch {
    throw new Error(DAEMON_NOT_RUNNING_MESSAGE);
  }
}

/** The workspaces the agent service of this installation serves. */
async function resolveTargets(selector?: string): Promise<Target[]> {
  const workspaces = await Effect.runPromise(makeLocalWorkspaceCatalog().listActiveWorkspaces());
  const targets = workspaces.map((workspace) => ({
    workspaceId: workspace.workspaceId as WorkspaceId,
    name: workspace.name,
  }));
  if (targets.length === 0) throw new Error(DAEMON_NOT_RUNNING_MESSAGE);
  if (!selector?.trim()) return targets;
  const wanted = selector.trim();
  const matches = targets.filter(
    (target) => target.workspaceId === wanted || target.name === wanted
  );
  if (matches.length === 0) {
    throw new Error(
      `No workspace ${wanted}; this machine runs ${targets.map((target) => target.name).join(', ')}`
    );
  }
  return matches;
}

function describe(item: HostedConfigItem): string {
  if (item.action === 'skip') return `skipped: ${item.reason ? REASONS[item.reason] : 'unusable'}`;
  if (item.action === 'unchanged') return 'already there';
  const verb = item.action === 'create' ? 'added' : 'updated';
  return item.needsSignIn ? `${verb}; sign in again` : verb;
}

function printItems(items: readonly HostedConfigItem[]): void {
  console.log(
    renderTerminalTable(
      [{ header: 'Kind' }, { header: 'Name' }, { header: 'Detail' }, { header: 'Result' }],
      items.map((item) => [
        CATEGORY_LABELS[item.category],
        item.name,
        item.detail ?? '',
        describe(item),
      ])
    )
  );
}

const importCommand = new Command('import')
  .description('Import the configuration of the hosted Lody installed on this machine')
  .option('--workspace <id|name>', 'Import into this workspace instead of every one')
  .option('--from <id>', 'Import this hosted workspace instead of every one')
  .option('--only <categories>', `Comma-separated: ${HOSTED_CONFIG_CATEGORIES.join(', ')}`)
  .option('--dry-run', 'Show what an import would do')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (options: ImportOptions) => {
    await runOneShotCommand('hosted', options, async () => {
      const categories = parseCategories(options.only);
      const machineId = await resolveMachineId();
      const targets = await resolveTargets(options.workspace);
      const results = [];

      for (const target of targets) {
        const preview = await sendLocalProjectControl({
          type: 'hosted-config/preview',
          machineId,
          workspaceId: target.workspaceId,
        });
        if (!preview.ok) fail(preview);
        if (preview.type !== 'hosted-config/preview') throw new Error('Unexpected response');
        if (!preview.result.found) {
          throw new Error('No hosted Lody installation was found on this machine');
        }

        const sources = preview.result.sources.filter(
          (source) => !options.from || source.workspaceId === options.from
        );
        if (sources.length === 0) throw new Error(`No hosted workspace ${options.from}`);

        for (const source of sources) {
          let items = source.items.filter((item) => categories.includes(item.category));
          if (!options.dryRun) {
            const imported = await sendLocalProjectControl({
              type: 'hosted-config/import',
              machineId,
              workspaceId: target.workspaceId,
              sourceWorkspaceId: source.workspaceId,
              categories,
            });
            if (!imported.ok) fail(imported);
            if (imported.type !== 'hosted-config/import') throw new Error('Unexpected response');
            items = imported.result.items;
          }
          results.push({ workspace: target, from: source.workspaceId, items });
          if (options.json) continue;

          console.log(
            `${options.dryRun ? 'Would import' : 'Imported'} ${source.name} into ${target.name}: ` +
              `${countHostedConfigItems(items, ['create', 'update'])} changed, ` +
              `${countHostedConfigItems(items, ['unchanged'])} already there, ` +
              `${countHostedConfigItems(items, ['skip'])} skipped.`
          );
          if (items.length > 0) printItems(items);
        }
      }

      if (options.json) printJson({ ok: true, dryRun: options.dryRun === true, results });
    });
  });

export const hostedCommand = new Command('hosted')
  .description('Move from the hosted Lody to this installation')
  .addCommand(importCommand);
