import { Command } from 'commander';
import {
  HOSTED_CONFIG_CATEGORIES,
  countHostedConfigItems,
  type HostedConfigCategory,
  type HostedConfigItem,
  type LanMachine,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import { Effect } from 'effect';
import {
  DAEMON_NOT_RUNNING_MESSAGE,
  printJson,
  runOneShotCommand,
  type CommonCommandOptions,
} from '@/lib/command-runtime';
import {
  askLanMachine,
  findLanMachine,
  listLanMachinesOfThisMachine,
  resolveControlWorkspace,
  resolveLocalMachineId,
} from '@/lib/lan/lan-control-client';
import { makeLocalWorkspaceCatalog } from '@/lib/local-workspace-catalog';
import { renderTerminalTable } from '@/lib/terminal-table';

type ImportOptions = Pick<CommonCommandOptions, 'json' | 'debug'> & {
  machine?: string;
  workspace?: string;
  from?: string;
  only?: string;
  dryRun?: boolean;
};

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

/** The workspaces an import on this machine writes into: one that was named, or every one. */
async function resolveOwnTargets(selector?: string): Promise<Target[]> {
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

/** Another member is asked in one LAN both are in: the one that was named, or the first. */
async function resolveMemberTargets(machine: LanMachine, selector?: string): Promise<Target[]> {
  const workspaceId = await resolveControlWorkspace(machine, selector);
  const lan = machine.lans.find((entry) => entry.workspaceId === workspaceId);
  return [{ workspaceId, name: lan?.name ?? workspaceId }];
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
  .description('Import the configuration of the hosted Lody installed on a machine')
  .option('--machine <name>', 'A member of a LAN to import on; this machine when left out')
  .option('--workspace <id|name>', 'Import into this workspace or LAN')
  .option('--from <id>', 'Import this hosted workspace instead of every one')
  .option('--only <categories>', `Comma-separated: ${HOSTED_CONFIG_CATEGORIES.join(', ')}`)
  .option('--dry-run', 'Show what an import would do')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (options: ImportOptions) => {
    await runOneShotCommand('hosted', options, async () => {
      const categories = parseCategories(options.only);
      const localMachineId = await resolveLocalMachineId();
      const member = options.machine?.trim()
        ? findLanMachine(
            (await listLanMachinesOfThisMachine(localMachineId)).machines,
            options.machine
          )
        : null;
      const machineId = (member?.machineId ?? localMachineId) as MachineId;
      const where = member && !member.self ? ` on ${member.name}` : '';
      const targets =
        member && !member.self
          ? await resolveMemberTargets(member, options.workspace)
          : await resolveOwnTargets(options.workspace);
      const results = [];

      for (const target of targets) {
        const preview = await askLanMachine(localMachineId, {
          type: 'hosted-config/preview',
          machineId,
          workspaceId: target.workspaceId,
        });
        if (!preview.ok) throw new Error(preview.message);
        if (preview.type !== 'hosted-config/preview') throw new Error('Unexpected response');
        if (!preview.result.found) {
          throw new Error(`No hosted Lody installation was found${where || ' on this machine'}`);
        }

        const sources = preview.result.sources.filter(
          (source) => !options.from || source.workspaceId === options.from
        );
        if (sources.length === 0) throw new Error(`No hosted workspace ${options.from}`);

        for (const source of sources) {
          let items = source.items.filter((item) => categories.includes(item.category));
          if (!options.dryRun) {
            const imported = await askLanMachine(localMachineId, {
              type: 'hosted-config/import',
              machineId,
              workspaceId: target.workspaceId,
              sourceWorkspaceId: source.workspaceId,
              categories,
            });
            if (!imported.ok) throw new Error(imported.message);
            if (imported.type !== 'hosted-config/import') throw new Error('Unexpected response');
            items = imported.result.items;
          }
          results.push({ workspace: target, from: source.workspaceId, items });
          if (options.json) continue;

          console.log(
            `${options.dryRun ? 'Would import' : 'Imported'} ${source.name} into ${target.name}${where}: ` +
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
