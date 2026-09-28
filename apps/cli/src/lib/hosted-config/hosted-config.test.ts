import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import {
  getWorkspaceFlockDocId,
  listWorkspaceAgentRoles,
  readWorkspaceFlockRowsFromFlock,
  writeWorkspaceAgentRoleToFlock,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type LocalProjectId,
  type LocalProjectMeta,
  type MachineId,
  type McpServerId,
  type WorkspaceId,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import {
  readMachineAgentConfigs,
  upsertMachineAgentConfig,
} from '@/lib/agent-config-machine-flock';
import { readMachineLocalProjects, upsertMachineLocalProject } from '@/lib/local-project-meta';
import { listWorkspaceMcpCatalog, upsertWorkspaceMcpCatalogEntry } from '@/lib/workspace-mcp-store';
import {
  HostedWorkspaceNotFoundError,
  importHostedConfig,
  previewHostedImport,
  type HostedImportWorkspace,
} from './hosted-config-import';
import { planHostedImport, type HostedImportTarget } from './hosted-config-plan';
import type { HostedConfigSnapshot } from './hosted-config-source';

const HOSTED_WORKSPACE = 'hosted-workspace' as WorkspaceId;
const HOSTED_MACHINE = 'hosted-machine' as MachineId;
const LOCAL_WORKSPACE = 'lw_local' as WorkspaceId;
const LOCAL_MACHINE = 'local-machine' as MachineId;
const LOCAL_USER = 'local:user';
const NOW = 1_800_000_000_000;

const agent = (overrides: Partial<AgentConfigMeta> & { id: string }): AgentConfigMeta =>
  ({
    machineId: HOSTED_MACHINE,
    name: 'Claude Code',
    cliType: 'builtin',
    agentType: 'claude',
    env: {},
    ...overrides,
  }) as AgentConfigMeta;

const role = (overrides: Partial<AgentRole> & { id: string }): AgentRole =>
  ({
    v: 1,
    ownerUserId: 'hosted-user',
    visibility: 'private',
    name: 'Reviewer',
    machineId: HOSTED_MACHINE,
    agentConfigId: 'hosted-claude' as AgentConfigId,
    runConfig: { modelId: 'sonnet' },
    revision: 3,
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  }) as AgentRole;

const mcp = (overrides: Partial<WorkspaceMcpServerMeta> & { id: string }): WorkspaceMcpServerMeta =>
  ({
    name: 'docs',
    transport: 'stdio',
    connection: { transport: 'stdio', command: 'docs-mcp', env: { DOCS_KEY: 'secret' } },
    createdAt: 10,
    updatedAt: 20,
    createdBy: 'hosted-user',
    ...overrides,
  }) as WorkspaceMcpServerMeta;

const project = (id: string, rootPath: string): LocalProjectMeta => ({
  id: id as LocalProjectId,
  name: path.basename(rootPath),
  rootPath,
  createdAtMs: 10,
});

const source = (overrides: Partial<HostedConfigSnapshot> = {}): HostedConfigSnapshot => ({
  workspaceId: HOSTED_WORKSPACE,
  name: 'Hosted',
  machineId: HOSTED_MACHINE,
  agentConfigs: [],
  mcpServers: [],
  agentRoles: [],
  localProjects: [],
  worktreeScripts: [],
  ...overrides,
});

const target = (overrides: Partial<HostedImportTarget> = {}): HostedImportTarget => ({
  machineId: LOCAL_MACHINE,
  userId: LOCAL_USER,
  agentConfigs: [],
  mcpServers: [],
  agentRoles: [],
  localProjects: [],
  worktreeScripts: [],
  ...overrides,
});

const ALL = [
  'agentConfigs',
  'mcpServers',
  'agentRoles',
  'localProjects',
  'worktreeScripts',
] as const;

const planOf = (
  hosted: HostedConfigSnapshot,
  local: HostedImportTarget,
  categories: readonly (typeof ALL)[number][] = ALL
) =>
  planHostedImport({
    source: hosted,
    target: local,
    categories,
    directoryExists: (rootPath) => !rootPath.includes('gone'),
    now: NOW,
  });

describe('planHostedImport', () => {
  it('takes a hosted builtin agent for the one the local service registered', () => {
    const plan = planOf(
      source({
        agentConfigs: [
          agent({ id: 'hosted-claude', env: { ANTHROPIC_BASE_URL: 'https://proxy.example' } }),
        ],
        agentRoles: [role({ id: 'reviewer' })],
      }),
      target({
        agentConfigs: [
          agent({ id: 'local-claude', machineId: LOCAL_MACHINE, env: { KEEP: 'mine' } }),
        ],
      })
    );

    expect(plan.writes.agentConfigs).toEqual([
      agent({
        id: 'local-claude',
        machineId: LOCAL_MACHINE,
        env: { KEEP: 'mine', ANTHROPIC_BASE_URL: 'https://proxy.example' },
      }),
    ]);
    expect(plan.writes.agentRoles).toEqual([
      role({
        id: 'reviewer',
        machineId: LOCAL_MACHINE,
        agentConfigId: 'local-claude' as AgentConfigId,
        ownerUserId: LOCAL_USER,
        updatedAt: NOW,
      }),
    ]);
    expect(plan.items.map((item) => [item.category, item.action])).toEqual([
      ['agentConfigs', 'update'],
      ['agentRoles', 'create'],
    ]);
  });

  it('leaves the hosted sign-in behind and says so', () => {
    const plan = planOf(
      source({
        agentConfigs: [
          agent({
            id: 'hosted-codex',
            name: 'Codex',
            agentType: 'codex',
            codexAuth: { mode: 'chatgpt', profileId: '7f6f0a8e-3a63-4c34-9d3f-2f4a0a6a2b11' },
            runtimeOverrides: { codexPath: '\0lody-codex-profile-v1' },
          }),
        ],
      }),
      target()
    );

    expect(plan.writes.agentConfigs).toEqual([
      agent({ id: 'hosted-codex', name: 'Codex', agentType: 'codex', machineId: LOCAL_MACHINE }),
    ]);
    expect(plan.items).toEqual([
      {
        category: 'agentConfigs',
        id: 'hosted-codex',
        name: 'Codex',
        detail: 'codex',
        action: 'create',
        needsSignIn: true,
      },
    ]);
  });

  it('skips what belongs to another machine or to nothing on this one', () => {
    const plan = planOf(
      source({
        agentRoles: [
          role({ id: 'elsewhere', machineId: 'another-machine' as MachineId }),
          role({ id: 'orphan', agentConfigId: 'deleted' as AgentConfigId }),
        ],
        localProjects: [project('p-gone', '/work/gone'), project('p-here', '/work/here')],
        worktreeScripts: [
          { localProjectId: 'p-gone' as LocalProjectId, phase: 'setup', config: { scripts: {} } },
          { localProjectId: 'p-here' as LocalProjectId, phase: 'setup', config: { scripts: {} } },
        ],
      }),
      target()
    );

    expect(plan.items.map((item) => [item.id, item.action, item.reason])).toEqual([
      ['elsewhere', 'skip', 'other_machine'],
      ['orphan', 'skip', 'missing_agent'],
      ['p-gone', 'skip', 'missing_directory'],
      ['p-here', 'create', undefined],
      ['p-gone:setup', 'skip', 'missing_project'],
      ['p-here:setup', 'create', undefined],
    ]);
    expect(plan.writes.localProjects.map((entry) => entry.id)).toEqual(['p-here']);
  });

  it('does not let a Role or a script refer to what is not imported with it', () => {
    const hosted = source({
      agentConfigs: [agent({ id: 'hosted-custom', cliType: 'custom', agentType: 'mine' })],
      agentRoles: [role({ id: 'reviewer', agentConfigId: 'hosted-custom' as AgentConfigId })],
      localProjects: [project('p-here', '/work/here')],
      worktreeScripts: [
        { localProjectId: 'p-here' as LocalProjectId, phase: 'cleanup', config: { scripts: {} } },
      ],
    });

    const plan = planOf(hosted, target(), ['agentRoles', 'worktreeScripts']);

    expect(plan.items.map((item) => [item.id, item.reason])).toEqual([
      ['reviewer', 'missing_agent'],
      ['p-here:cleanup', 'missing_project'],
    ]);
    expect(plan.writes).toEqual({
      agentConfigs: [],
      mcpServers: [],
      agentRoles: [],
      localProjects: [],
      worktreeScripts: [],
    });
  });

  it('keeps the history of hosted sessions out of an imported project', () => {
    const plan = planOf(
      source({
        localProjects: [
          { ...project('p-here', '/work/here'), history: {} as LocalProjectMeta['history'] },
        ],
      }),
      target()
    );
    expect(plan.writes.localProjects).toEqual([project('p-here', '/work/here')]);
  });
});

describe('importing from a hosted installation on disk', () => {
  let root: string;
  let hostedDir: string;
  let projectDir: string;
  let previousDataDir: string | undefined;
  const opened: Array<{ repo: LoroRepo; store: SqliteRepoStore }> = [];

  const open = async (file: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const store = new SqliteRepoStore({ path: file });
    const repo = await LoroRepo.create({ storageAdapter: store.storage, metaDebounceCommitMs: 0 });
    opened.push({ repo, store });
    return repo;
  };

  const local = (repo: LoroRepo): HostedImportWorkspace => ({
    repo,
    workspaceId: LOCAL_WORKSPACE,
    machineId: LOCAL_MACHINE,
    userId: LOCAL_USER,
    sync: { markMachineFlockDocDirty: () => {} },
  });

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-config-test-'));
    hostedDir = path.join(root, 'hosted');
    projectDir = fs.realpathSync(fs.mkdtempSync(path.join(root, 'project-')));
    previousDataDir = process.env.LODY_DATA_DIR;
    process.env.LODY_DATA_DIR = path.join(root, 'local');

    const hosted = await open(path.join(hostedDir, 'loro-repo', HOSTED_WORKSPACE, 'repo.sqlite3'));
    await upsertMachineAgentConfig(
      hosted,
      HOSTED_WORKSPACE,
      agent({
        id: 'hosted-custom',
        name: 'Mine',
        cliType: 'custom',
        agentType: 'mine',
        customAcp: { command: 'mine-acp', args: [] },
        env: { MINE_KEY: 'secret' },
      })
    );
    await upsertMachineLocalProject(
      hosted,
      HOSTED_WORKSPACE,
      HOSTED_MACHINE,
      project('p-here', projectDir)
    );
    await upsertWorkspaceMcpCatalogEntry(
      hosted,
      HOSTED_WORKSPACE,
      mcp({ id: 'docs' as McpServerId }),
      {
        sync: false,
      }
    );
    const flock = await hosted.openFlockDoc(getWorkspaceFlockDocId(HOSTED_WORKSPACE));
    writeWorkspaceAgentRoleToFlock(
      flock.flock,
      role({ id: 'reviewer' as AgentRoleId, agentConfigId: 'hosted-custom' as AgentConfigId })
    );
    await hosted.flush();

    fs.mkdirSync(path.join(hostedDir, 'local-project-setup', 'p-here'), { recursive: true });
    fs.writeFileSync(
      path.join(hostedDir, 'local-project-setup', 'p-here', 'setup.json'),
      JSON.stringify({ scripts: { bash: 'pnpm install' } })
    );
    fs.writeFileSync(
      path.join(hostedDir, 'workspace-catalog.json'),
      JSON.stringify({
        version: 1,
        identity: { userId: 'hosted-user' },
        machine: { machineId: HOSTED_MACHINE },
        workspaces: [{ workspaceId: HOSTED_WORKSPACE, name: 'Hosted', state: 'active' }],
        sessions: [],
      })
    );
  });

  afterEach(async () => {
    for (const { repo, store } of opened.splice(0)) {
      await repo.destroy().catch(() => undefined);
      store.close();
    }
    if (previousDataDir === undefined) delete process.env.LODY_DATA_DIR;
    else process.env.LODY_DATA_DIR = previousDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('brings the configuration over while the hosted replica stays open', async () => {
    const repo = await open(path.join(root, 'local', 'repo.sqlite3'));

    const preview = await previewHostedImport(local(repo), hostedDir);
    expect(preview.found).toBe(true);
    expect(preview.sources[0]?.items.map((item) => [item.category, item.action])).toEqual([
      ['agentConfigs', 'create'],
      ['mcpServers', 'create'],
      ['agentRoles', 'create'],
      ['localProjects', 'create'],
      ['worktreeScripts', 'create'],
    ]);

    await importHostedConfig(
      local(repo),
      { sourceWorkspaceId: HOSTED_WORKSPACE, categories: ALL },
      hostedDir
    );

    const configs = await readMachineAgentConfigs(repo, LOCAL_WORKSPACE, LOCAL_MACHINE);
    expect(configs['hosted-custom' as AgentConfigId]).toMatchObject({
      machineId: LOCAL_MACHINE,
      customAcp: { command: 'mine-acp', args: [] },
      env: { MINE_KEY: 'secret' },
    });
    expect(await listWorkspaceMcpCatalog(repo, LOCAL_WORKSPACE)).toMatchObject([
      { id: 'docs', name: 'docs', createdBy: LOCAL_USER },
    ]);
    const roles = listWorkspaceAgentRoles(
      readWorkspaceFlockRowsFromFlock(
        (await repo.openFlockDoc(getWorkspaceFlockDocId(LOCAL_WORKSPACE))).flock
      )
    );
    expect(roles).toMatchObject([
      { id: 'reviewer', machineId: LOCAL_MACHINE, ownerUserId: LOCAL_USER },
    ]);
    expect(
      Object.values(await readMachineLocalProjects(repo, LOCAL_WORKSPACE, LOCAL_MACHINE))
    ).toMatchObject([{ id: 'p-here', rootPath: projectDir }]);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(root, 'local', 'local-project-setup', 'p-here', 'setup.json'),
          'utf8'
        )
      )
    ).toEqual({ scripts: { bash: 'pnpm install' } });
  });

  it('changes nothing when it is run again', async () => {
    const repo = await open(path.join(root, 'local', 'repo.sqlite3'));
    const request = { sourceWorkspaceId: HOSTED_WORKSPACE, categories: ALL };
    await importHostedConfig(local(repo), request, hostedDir);

    const again = await importHostedConfig(local(repo), request, hostedDir);

    expect(again.items.map((item) => item.action)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
    ]);
  });

  it('leaves no copy of the hosted replica behind', async () => {
    const repo = await open(path.join(root, 'local', 'repo.sqlite3'));
    const before = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith('lody-hosted-config-'));
    await previewHostedImport(local(repo), hostedDir);
    const after = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith('lody-hosted-config-'));
    expect(after).toEqual(before);
  });

  it('reports a machine without a hosted installation and an unknown workspace', async () => {
    const repo = await open(path.join(root, 'local', 'repo.sqlite3'));

    expect(await previewHostedImport(local(repo), path.join(root, 'nowhere'))).toEqual({
      found: false,
      sources: [],
    });
    await expect(
      importHostedConfig(local(repo), { sourceWorkspaceId: 'other', categories: ALL }, hostedDir)
    ).rejects.toBeInstanceOf(HostedWorkspaceNotFoundError);
  });
});
