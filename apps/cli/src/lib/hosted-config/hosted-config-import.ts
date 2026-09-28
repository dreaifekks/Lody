import fs from 'node:fs';
import {
  getServerNow,
  getWorkspaceFlockDocId,
  HOSTED_CONFIG_CATEGORIES,
  listWorkspaceAgentRoles,
  readWorkspaceFlockRowsFromFlock,
  writeWorkspaceAgentRoleToFlock,
  type HostedConfigCategory,
  type HostedConfigImportResult,
  type HostedConfigPreview,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroRepo } from 'loro-repo';
import {
  listMergedAgentConfigs,
  upsertMachineAgentConfig,
  type MachineFlockSyncScheduler,
} from '@/lib/agent-config-machine-flock';
import { readMachineLocalProjects, upsertMachineLocalProject } from '@/lib/local-project-meta';
import { listWorkspaceMcpCatalog, upsertWorkspaceMcpCatalogEntry } from '@/lib/workspace-mcp-store';
import {
  readLocalProjectWorktreeCleanup,
  readLocalProjectWorktreeSetup,
  writeLocalProjectWorktreeCleanup,
  writeLocalProjectWorktreeSetup,
} from '@/session/worktree/worktree-setup-config-store';
import {
  planHostedImport,
  type HostedImportPlan,
  type HostedImportTarget,
} from './hosted-config-plan';
import {
  listHostedWorkspaces,
  readHostedConfig,
  resolveHostedDataDir,
  type HostedConfigSnapshot,
  type HostedWorktreeScript,
} from './hosted-config-source';

/** The workspace of the running agent service an import writes into. */
export type HostedImportWorkspace = {
  repo: LoroRepo;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  userId: string;
  sync: MachineFlockSyncScheduler;
};

export class HostedWorkspaceNotFoundError extends Error {
  constructor(workspaceId: string) {
    super(`This machine holds no hosted workspace ${workspaceId}`);
    this.name = 'HostedWorkspaceNotFoundError';
  }
}

function directoryExists(rootPath: string): boolean {
  try {
    return fs.statSync(rootPath).isDirectory();
  } catch {
    return false;
  }
}

async function readTargetWorktreeScripts(
  source: HostedConfigSnapshot
): Promise<HostedWorktreeScript[]> {
  const scripts: HostedWorktreeScript[] = [];
  for (const { localProjectId, phase } of source.worktreeScripts) {
    const config =
      phase === 'setup'
        ? await readLocalProjectWorktreeSetup(localProjectId)
        : await readLocalProjectWorktreeCleanup(localProjectId);
    if (config) scripts.push({ localProjectId, phase, config });
  }
  return scripts;
}

async function readTarget(
  workspace: HostedImportWorkspace,
  source: HostedConfigSnapshot
): Promise<HostedImportTarget> {
  const { repo, workspaceId, machineId, userId } = workspace;
  const [agentConfigs, mcpServers, workspaceFlock, localProjects, worktreeScripts] =
    await Promise.all([
      listMergedAgentConfigs(repo, workspaceId, [machineId]),
      listWorkspaceMcpCatalog(repo, workspaceId),
      repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId)),
      readMachineLocalProjects(repo, workspaceId, machineId),
      readTargetWorktreeScripts(source),
    ]);
  return {
    machineId,
    userId,
    agentConfigs: agentConfigs.filter((config) => config.machineId === machineId),
    mcpServers,
    agentRoles: listWorkspaceAgentRoles(readWorkspaceFlockRowsFromFlock(workspaceFlock.flock)),
    localProjects: Object.values(localProjects),
    worktreeScripts,
  };
}

async function plan(
  workspace: HostedImportWorkspace,
  source: HostedConfigSnapshot,
  categories: readonly HostedConfigCategory[]
): Promise<HostedImportPlan> {
  return planHostedImport({
    source,
    target: await readTarget(workspace, source),
    categories,
    directoryExists,
    now: getServerNow(),
  });
}

/** What importing each hosted workspace of this machine would do. */
export async function previewHostedImport(
  workspace: HostedImportWorkspace,
  dataDir = resolveHostedDataDir()
): Promise<HostedConfigPreview> {
  const hosted = await listHostedWorkspaces(dataDir);
  const sources = [];
  for (const entry of hosted) {
    const source = await readHostedConfig(dataDir, entry);
    const { items } = await plan(workspace, source, HOSTED_CONFIG_CATEGORIES);
    sources.push({ workspaceId: entry.workspaceId, name: entry.name, items });
  }
  return { found: hosted.length > 0, sources };
}

/**
 * Imports the selected categories of one hosted workspace. Importing twice
 * changes nothing the second time: an item is written only while the
 * workspace differs from it.
 */
export async function importHostedConfig(
  workspace: HostedImportWorkspace,
  request: { sourceWorkspaceId: string; categories: readonly HostedConfigCategory[] },
  dataDir = resolveHostedDataDir()
): Promise<HostedConfigImportResult> {
  const entry = (await listHostedWorkspaces(dataDir)).find(
    (candidate) => candidate.workspaceId === request.sourceWorkspaceId
  );
  if (!entry) throw new HostedWorkspaceNotFoundError(request.sourceWorkspaceId);

  const source = await readHostedConfig(dataDir, entry);
  const { items, writes } = await plan(workspace, source, request.categories);
  const { repo, workspaceId, machineId, sync } = workspace;
  const reason = 'hosted-config-import';

  // Agents before the Roles that name them, projects before their scripts.
  for (const config of writes.agentConfigs) {
    await upsertMachineAgentConfig(repo, workspaceId, config, { sync, reason });
  }
  for (const server of writes.mcpServers) {
    await upsertWorkspaceMcpCatalogEntry(repo, workspaceId, server);
  }
  if (writes.agentRoles.length > 0) {
    const handle = await repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId));
    const changed = writes.agentRoles
      .map((role) => writeWorkspaceAgentRoleToFlock(handle.flock, role))
      .some(Boolean);
    if (changed) {
      await repo.flush();
      await handle.syncOnce().catch(() => undefined);
    }
  }
  for (const project of writes.localProjects) {
    await upsertMachineLocalProject(repo, workspaceId, machineId, project, undefined, {
      sync,
      reason,
    });
  }
  for (const script of writes.worktreeScripts) {
    if (script.phase === 'setup') {
      await writeLocalProjectWorktreeSetup(script.localProjectId, script.config);
    } else {
      await writeLocalProjectWorktreeCleanup(script.localProjectId, script.config);
    }
  }

  return { workspaceId, items };
}
