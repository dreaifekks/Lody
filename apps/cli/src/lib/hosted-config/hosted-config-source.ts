import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { LoroRepo } from 'loro-repo';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import {
  getWorkspaceFlockDocId,
  listWorkspaceAgentRoles,
  listWorkspaceMcpServers,
  readWorkspaceFlockRowsFromFlock,
  type AgentConfigMeta,
  type AgentRole,
  type LocalProjectId,
  type LocalProjectMeta,
  type MachineId,
  type WorkspaceId,
  type WorkspaceMcpServerMeta,
  type WorktreeScriptPhase,
  type WorktreeSetupScriptConfig,
} from '@lody/shared';
import { getInstallationProfile } from '@lody/shared/node/installation-profile';
import { z } from 'zod';
import { listMergedAgentConfigs } from '@/lib/agent-config-machine-flock';
import { readMachineLocalProjects } from '@/lib/local-project-meta';

export type HostedWorkspace = {
  workspaceId: WorkspaceId;
  name: string;
  machineId: MachineId;
};

export type HostedWorktreeScript = {
  localProjectId: LocalProjectId;
  phase: WorktreeScriptPhase;
  config: WorktreeSetupScriptConfig;
};

export type HostedConfigSnapshot = HostedWorkspace & {
  agentConfigs: AgentConfigMeta[];
  mcpServers: WorkspaceMcpServerMeta[];
  agentRoles: AgentRole[];
  localProjects: LocalProjectMeta[];
  worktreeScripts: HostedWorktreeScript[];
};

const WORKTREE_SCRIPT_PHASES: readonly WorktreeScriptPhase[] = ['setup', 'cleanup'];

const CatalogMachineSchema = z.object({ machineId: z.string().min(1) }).nullish();

// Only what an import needs. The hosted installation owns this file and may
// have written fields a later version added.
const HostedCatalogSchema = z.object({
  machine: CatalogMachineSchema,
  workspaces: z.array(
    z.object({
      workspaceId: z.string().min(1),
      name: z.string().optional(),
      state: z.string().optional(),
      machine: CatalogMachineSchema,
    })
  ),
});

const WorktreeScriptSchema = z.object({
  scripts: z.object({ bash: z.string().optional(), powershell: z.string().optional() }),
  timeoutMs: z.number().int().positive().optional(),
});

/**
 * The data directory of the hosted installation of this user. It is named by
 * the hosted profile and not by `getLodyDataDir`, which answers with the data
 * directory of the running process whenever `LODY_DATA_DIR` is set.
 */
export function resolveHostedDataDir(): string {
  const override = process.env.LODY_HOSTED_DATA_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), getInstallationProfile('cloud').dataDirectoryName);
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function replicaPath(dataDir: string, workspaceId: string): string {
  return path.join(dataDir, 'loro-repo', workspaceId, 'repo.sqlite3');
}

/** The hosted workspaces this machine holds a replica of. */
export async function listHostedWorkspaces(dataDir: string): Promise<HostedWorkspace[]> {
  const catalog = HostedCatalogSchema.safeParse(
    await readJson(path.join(dataDir, 'workspace-catalog.json'))
  );
  if (!catalog.success) return [];

  const workspaces: HostedWorkspace[] = [];
  for (const workspace of catalog.data.workspaces) {
    const machineId = workspace.machine?.machineId ?? catalog.data.machine?.machineId;
    if (!machineId || (workspace.state && workspace.state !== 'active')) continue;
    if (!(await exists(replicaPath(dataDir, workspace.workspaceId)))) continue;
    workspaces.push({
      workspaceId: workspace.workspaceId as WorkspaceId,
      name: workspace.name?.trim() || workspace.workspaceId,
      machineId: machineId as MachineId,
    });
  }
  return workspaces;
}

async function readWorktreeScripts(
  dataDir: string,
  projects: readonly LocalProjectMeta[]
): Promise<HostedWorktreeScript[]> {
  const scripts: HostedWorktreeScript[] = [];
  for (const project of projects) {
    for (const phase of WORKTREE_SCRIPT_PHASES) {
      const parsed = WorktreeScriptSchema.safeParse(
        await readJson(path.join(dataDir, 'local-project-setup', project.id, `${phase}.json`))
      );
      if (parsed.success) {
        scripts.push({ localProjectId: project.id, phase, config: parsed.data });
      }
    }
  }
  return scripts;
}

/**
 * Reads what a hosted workspace configured for this machine.
 *
 * The replica is copied first and only the copy is opened: the hosted agent
 * service may be running and owns the file, and opening a replica migrates it.
 * The copy holds the credentials agents were configured with, so it lives in a
 * directory only this user can read and is removed before returning.
 */
export async function readHostedConfig(
  dataDir: string,
  workspace: HostedWorkspace
): Promise<HostedConfigSnapshot> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-hosted-config-'));
  try {
    const copy = path.join(scratch, 'repo.sqlite3');
    const source = new Database(replicaPath(dataDir, workspace.workspaceId), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      await source.backup(copy);
    } finally {
      source.close();
    }

    const store = new SqliteRepoStore({ path: copy });
    const repo = await LoroRepo.create({ storageAdapter: store.storage });
    try {
      const { workspaceId, machineId } = workspace;
      const [agentConfigs, localProjects, workspaceFlock] = await Promise.all([
        listMergedAgentConfigs(repo, workspaceId, [machineId]),
        readMachineLocalProjects(repo, workspaceId, machineId),
        repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId)),
      ]);
      const workspaceRows = readWorkspaceFlockRowsFromFlock(workspaceFlock.flock);
      const projects = Object.values(localProjects);
      return {
        ...workspace,
        agentConfigs: agentConfigs.filter((config) => config.machineId === machineId),
        mcpServers: listWorkspaceMcpServers(workspaceRows),
        agentRoles: listWorkspaceAgentRoles(workspaceRows),
        localProjects: projects,
        worktreeScripts: await readWorktreeScripts(dataDir, projects),
      };
    } finally {
      await repo.destroy().catch(() => undefined);
      store.close();
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
