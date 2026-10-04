import { Command } from 'commander';
import { z } from 'zod';
import type { WorkspaceId } from '@lody/shared';
import { createResourceDiscovery } from '@/lib/resource-discovery-runtime';
import type { DiscoveryResource, DiscoveryRow } from '@/lib/resource-discovery';
import type { DiscoveryQuery } from '@/lib/discovery-query';
import {
  getAuthContextOrThrow,
  resolveWorkspaceOrThrow,
  withWorkspaceManager,
  runOneShotCommand,
  printJson,
} from '@/lib/command-runtime';
import { getCliPlatformKind } from '@/lib/cli-platform';
import { renderTerminalTable } from '@/lib/terminal-table';
import {
  callTerminalSessionTool,
  resolveTerminalToolTarget,
  type TerminalToolTarget,
} from '@/lib/terminal-session-tools';

export type DiscoveryCommandOptions = {
  workspace?: string;
  machine?: string;
  query?: string;
  limit?: number;
  cursor?: string;
  kind?: 'local' | 'github';
  onlineStatus?: 'online' | 'offline' | 'unknown';
  allPages?: boolean;
  offline?: boolean;
  json?: boolean;
  debug?: boolean;
};

export function addDiscoveryOptions(command: Command): Command {
  return command
    .option('--query <text>', 'Filter by id, name, description or project path')
    .option('--limit <count>', 'Page size (1-100, default 20)', Number)
    .option('--cursor <cursor>', 'Continue the previous page with the same filters')
    .option('--all-pages', 'Read every page');
}

type DiscoveryPageResult = { items: DiscoveryRow[]; nextCursor?: string };

const LEGACY_LIST_KEYS: Record<DiscoveryResource, string> = {
  machine: 'machines',
  project: 'projects',
  agent_config: 'agentConfigs',
  agent_role: 'roles',
  mcp: 'servers',
};

function printDiscoveryPage(
  resource: DiscoveryResource,
  page: DiscoveryPageResult,
  items: DiscoveryRow[],
  json: boolean | undefined
): void {
  if (json) {
    printJson({ ...page, items, [LEGACY_LIST_KEYS[resource]]: items });
    return;
  }
  console.log(
    renderTerminalTable(
      [
        { header: 'ID' },
        { header: 'Name' },
        { header: 'Machine / Kind' },
        { header: 'Availability' },
      ],
      items.map((row) => [
        row.id,
        row.name,
        row.machineId ?? String(row.kind ?? row.transport ?? '-'),
        row.availability?.reason ?? row.availability?.state ?? '-',
      ])
    )
  );
  if (page.nextCursor) console.log(`Next page: --cursor ${page.nextCursor}`);
}

const DiscoveryPageResultSchema = z
  .object({ items: z.array(z.looseObject({ id: z.string(), name: z.string() })) })
  .loose()
  .transform((page) => page as DiscoveryPageResult & Record<string, unknown>);

/** A machine id, or the id of the one machine with that exact name. */
async function resolveTerminalMachine(
  target: TerminalToolTarget,
  selector: string
): Promise<string> {
  const machines: DiscoveryRow[] = [];
  let cursor: string | undefined;
  do {
    const page = DiscoveryPageResultSchema.parse(
      await callTerminalSessionTool(target, 'lody_machine_list', { limit: 100, cursor })
    );
    machines.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  const byId = machines.find((machine) => machine.id === selector);
  if (byId) return byId.id;
  const byName = machines.filter((machine) => machine.name === selector);
  if (byName.length === 1) return byName[0]!.id;
  throw new Error(
    byName.length > 1
      ? `Several machines are called ${selector}; pass a machine id.`
      : `Machine not found: ${selector}`
  );
}

/** The local platform reads the daemon's catalog through its terminal tools. */
async function runTerminalDiscoveryList(
  resource: DiscoveryResource,
  options: DiscoveryCommandOptions
): Promise<void> {
  const target = await resolveTerminalToolTarget(options.workspace);
  const machineId = options.machine
    ? await resolveTerminalMachine(target, options.machine)
    : undefined;
  const query = {
    query: options.query,
    limit: options.limit,
    cursor: options.cursor,
    machineId,
    kind: options.kind,
    onlineStatus: options.onlineStatus,
  };
  const read = async (cursor: string | undefined) =>
    DiscoveryPageResultSchema.parse(
      await callTerminalSessionTool(target, `lody_${resource}_list`, { ...query, cursor })
    );
  let page = await read(options.cursor);
  const items: DiscoveryRow[] = [...page.items];
  while (options.allPages && page.nextCursor) {
    page = await read(page.nextCursor);
    items.push(...page.items);
  }
  printDiscoveryPage(resource, page, items, options.json);
}

export async function runDiscoveryList(
  resource: DiscoveryResource,
  options: DiscoveryCommandOptions
): Promise<void> {
  await runOneShotCommand('discovery', options, async () => {
    if (getCliPlatformKind() === 'local') return runTerminalDiscoveryList(resource, options);
    const auth = getAuthContextOrThrow('discovery');
    const workspace = await resolveWorkspaceOrThrow(auth, options.workspace);
    await withWorkspaceManager(auth, workspace, 'discovery', async (manager) => {
      const discovery = await createResourceDiscovery({
        manager,
        auth,
        workspaceId: workspace.id as WorkspaceId,
        offline: options.offline,
      });
      const machineId = options.machine
        ? await discovery.resolveMachine(options.machine)
        : undefined;
      const query: DiscoveryQuery = {
        query: options.query,
        limit: options.limit,
        cursor: options.cursor,
        ...(machineId ? { machineId } : {}),
        ...(options.kind ? { kind: options.kind } : {}),
        ...(options.onlineStatus ? { onlineStatus: options.onlineStatus } : {}),
      };
      let page = await discovery.list(resource, query);
      const items: DiscoveryRow[] = [...page.items];
      while (options.allPages && page.nextCursor) {
        page = await discovery.list(resource, { ...query, cursor: page.nextCursor });
        items.push(...page.items);
      }
      printDiscoveryPage(resource, page, items, options.json);
    });
  });
}

export function discoveryListCommand(resource: 'agent_config' | 'agent_role' | 'mcp'): Command {
  const command = addDiscoveryOptions(
    new Command('list')
      .description(`List readable ${resource} resources`)
      .option('--workspace <selector>', 'Workspace id, slug or name')
      .option('--offline', 'Read cached catalogs; authorization still requires connectivity')
      .option('--json', 'Print JSON')
      .option('--debug', 'Enable debug output')
  );
  if (resource !== 'mcp') command.option('--machine <selector>', 'Machine id or name');
  return command.action((options: DiscoveryCommandOptions) => runDiscoveryList(resource, options));
}

export function discoveryGetCommand(resource: 'agent_config' | 'agent_role'): Command {
  return new Command('get')
    .description(`Read one ${resource} by stable id`)
    .argument('<id>')
    .option('--workspace <selector>', 'Workspace id, slug or name')
    .option('--json', 'Print JSON')
    .option('--offline', 'Read cached catalogs; authorization still requires connectivity')
    .action(async (id: string, options: DiscoveryCommandOptions) =>
      runOneShotCommand('discovery', options, async () => {
        if (getCliPlatformKind() === 'local') {
          const target = await resolveTerminalToolTarget(options.workspace);
          printJson(await callTerminalSessionTool(target, `lody_${resource}_get`, { id }));
          return;
        }
        const auth = getAuthContextOrThrow('discovery');
        const workspace = await resolveWorkspaceOrThrow(auth, options.workspace);
        await withWorkspaceManager(auth, workspace, 'discovery', async (manager) => {
          const discovery = await createResourceDiscovery({
            manager,
            auth,
            workspaceId: workspace.id as WorkspaceId,
            offline: options.offline,
          });
          printJson(await discovery.get(resource, id));
        });
      })
    );
}

export const agentRoleCommand = new Command('agent-role')
  .description('Inspect Agent Roles')
  .addCommand(discoveryListCommand('agent_role'))
  .addCommand(discoveryGetCommand('agent_role'));
