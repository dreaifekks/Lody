import {
  CODEX_PROFILE_LEGACY_LAUNCH_GUARD,
  withAgentRolePlacements,
  type AgentConfigId,
  type AgentConfigMeta,
  type CatalogAgentRole,
  type HostedConfigCategory,
  type HostedConfigItem,
  type LocalProjectMeta,
  type MachineId,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import type { HostedConfigSnapshot, HostedWorktreeScript } from './hosted-config-source';

export type HostedImportTarget = {
  machineId: MachineId;
  userId: string;
  agentConfigs: readonly AgentConfigMeta[];
  mcpServers: readonly WorkspaceMcpServerMeta[];
  agentRoles: readonly CatalogAgentRole[];
  localProjects: readonly LocalProjectMeta[];
  worktreeScripts: readonly HostedWorktreeScript[];
};

export type HostedImportWrites = {
  agentConfigs: AgentConfigMeta[];
  mcpServers: WorkspaceMcpServerMeta[];
  agentRoles: CatalogAgentRole[];
  localProjects: LocalProjectMeta[];
  worktreeScripts: HostedWorktreeScript[];
};

export type HostedImportPlan = {
  items: HostedConfigItem[];
  writes: HostedImportWrites;
};

export type HostedImportPlanInput = {
  source: HostedConfigSnapshot;
  target: HostedImportTarget;
  /** What the import writes. A preview names all of them. */
  categories: readonly HostedConfigCategory[];
  directoryExists: (rootPath: string) => boolean;
  now: number;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)])
    );
  }
  return value;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/**
 * A hosted sign-in is a reference to a credential kept for the hosted
 * workspace, machine and agent. It opens nothing here, so it stays behind.
 */
function withoutHostedSignIn(config: AgentConfigMeta): AgentConfigMeta {
  const { codexAuth: _codexAuth, runtimeOverrides, ...rest } = config;
  if (!runtimeOverrides) return rest;
  const { codexPath, ...overrides } = runtimeOverrides;
  const kept = {
    ...overrides,
    ...(codexPath && codexPath !== CODEX_PROFILE_LEGACY_LAUNCH_GUARD ? { codexPath } : {}),
  };
  return Object.keys(kept).length > 0 ? { ...rest, runtimeOverrides: kept } : rest;
}

function planAgentConfigs(input: HostedImportPlanInput): {
  items: HostedConfigItem[];
  writes: AgentConfigMeta[];
  /** Hosted agent id to the id the agent has in the workspace after the import. */
  imported: Map<AgentConfigId, AgentConfigId>;
} {
  const { source, target } = input;
  const selected = input.categories.includes('agentConfigs');
  const items: HostedConfigItem[] = [];
  const writes: AgentConfigMeta[] = [];
  const imported = new Map<AgentConfigId, AgentConfigId>();
  const claimed = new Set<AgentConfigId>();

  for (const hosted of source.agentConfigs) {
    const sameType = target.agentConfigs.filter(
      (config) => config.cliType === hosted.cliType && config.agentType === hosted.agentType
    );
    // The local agent service registers the builtin agents itself, under ids
    // of its own. A hosted builtin agent is that agent, not a second one.
    const counterpart =
      target.agentConfigs.find((config) => config.id === hosted.id) ??
      (hosted.cliType === 'builtin' && sameType.length === 1 && !claimed.has(sameType[0]!.id)
        ? sameType[0]
        : undefined);
    const cleaned = withoutHostedSignIn(hosted);
    const needsSignIn = hosted.codexAuth !== undefined && counterpart?.codexAuth === undefined;

    const next: AgentConfigMeta = counterpart
      ? {
          ...counterpart,
          ...cleaned,
          id: counterpart.id,
          machineId: target.machineId,
          env: { ...counterpart.env, ...cleaned.env },
          ...(counterpart.runtimeOverrides || cleaned.runtimeOverrides
            ? { runtimeOverrides: { ...counterpart.runtimeOverrides, ...cleaned.runtimeOverrides } }
            : {}),
        }
      : { ...cleaned, machineId: target.machineId };
    const action = !counterpart ? 'create' : same(next, counterpart) ? 'unchanged' : 'update';

    if (counterpart) claimed.add(counterpart.id);
    if (selected || action !== 'create') imported.set(hosted.id, next.id);
    if (action !== 'unchanged') writes.push(next);
    items.push({
      category: 'agentConfigs',
      id: hosted.id,
      name: hosted.name,
      detail: hosted.agentType,
      action,
      ...(needsSignIn ? { needsSignIn } : {}),
    });
  }
  return { items, writes, imported };
}

function planMcpServers(input: HostedImportPlanInput): {
  items: HostedConfigItem[];
  writes: WorkspaceMcpServerMeta[];
} {
  const items: HostedConfigItem[] = [];
  const writes: WorkspaceMcpServerMeta[] = [];
  for (const hosted of input.source.mcpServers) {
    // A workspace knows a server by its name: agents are given that name.
    const counterpart =
      input.target.mcpServers.find((server) => server.id === hosted.id) ??
      input.target.mcpServers.find((server) => server.name === hosted.name);
    const { createdBy: _createdBy, ...values } = hosted;
    const next: WorkspaceMcpServerMeta = {
      ...values,
      id: counterpart?.id ?? hosted.id,
      createdAt: counterpart?.createdAt ?? hosted.createdAt,
      updatedAt: counterpart?.updatedAt ?? hosted.updatedAt,
      createdBy: counterpart?.createdBy ?? input.target.userId,
    };
    const action = !counterpart ? 'create' : same(next, counterpart) ? 'unchanged' : 'update';
    if (action !== 'unchanged') writes.push({ ...next, updatedAt: input.now });
    items.push({
      category: 'mcpServers',
      id: hosted.id,
      name: hosted.name,
      detail: hosted.transport,
      action,
    });
  }
  return { items, writes };
}

function planAgentRoles(
  input: HostedImportPlanInput,
  imported: ReadonlyMap<AgentConfigId, AgentConfigId>
): { items: HostedConfigItem[]; writes: CatalogAgentRole[] } {
  const items: HostedConfigItem[] = [];
  const writes: CatalogAgentRole[] = [];
  for (const hosted of input.source.agentRoles) {
    const item = { category: 'agentRoles' as const, id: hosted.id, name: hosted.name };
    // A Role names one agent of one machine and never falls back to another.
    if (hosted.machineId !== input.source.machineId) {
      items.push({ ...item, action: 'skip', reason: 'other_machine' });
      continue;
    }
    const agentConfigId = imported.get(hosted.agentConfigId);
    if (!agentConfigId) {
      items.push({ ...item, action: 'skip', reason: 'missing_agent' });
      continue;
    }
    const counterpart = input.target.agentRoles.find((role) => role.id === hosted.id);
    // A hosted Role is a single-machine one; it becomes one placement here.
    const next = withAgentRolePlacements(
      {
        ...hosted,
        ownerUserId: input.target.userId,
        revision: counterpart?.revision ?? hosted.revision,
        createdAt: counterpart?.createdAt ?? hosted.createdAt,
        updatedAt: counterpart?.updatedAt ?? hosted.updatedAt,
      },
      [
        {
          machineId: input.target.machineId,
          agentConfigId,
          enabled: true,
          runConfig: hosted.runConfig,
        },
      ]
    );
    const action = !counterpart ? 'create' : same(next, counterpart) ? 'unchanged' : 'update';
    if (action !== 'unchanged') {
      writes.push({
        ...next,
        revision: counterpart ? counterpart.revision + 1 : next.revision,
        updatedAt: input.now,
      });
    }
    items.push({ ...item, action });
  }
  return { items, writes };
}

function planLocalProjects(input: HostedImportPlanInput): {
  items: HostedConfigItem[];
  writes: LocalProjectMeta[];
  /** Projects the workspace holds after the import. */
  present: Set<string>;
} {
  const selected = input.categories.includes('localProjects');
  const items: HostedConfigItem[] = [];
  const writes: LocalProjectMeta[] = [];
  const present = new Set<string>(input.target.localProjects.map((project) => project.id));
  for (const hosted of input.source.localProjects) {
    const item = {
      category: 'localProjects' as const,
      id: hosted.id,
      name: hosted.name,
      detail: hosted.rootPath,
    };
    if (present.has(hosted.id)) {
      items.push({ ...item, action: 'unchanged' });
      continue;
    }
    if (!input.directoryExists(hosted.rootPath)) {
      items.push({ ...item, action: 'skip', reason: 'missing_directory' });
      continue;
    }
    // The history of a project lists sessions of hosted agents.
    const { history: _history, ...project } = hosted;
    writes.push(project);
    if (selected) present.add(hosted.id);
    items.push({ ...item, action: 'create' });
  }
  return { items, writes, present };
}

function planWorktreeScripts(
  input: HostedImportPlanInput,
  present: ReadonlySet<string>
): { items: HostedConfigItem[]; writes: HostedWorktreeScript[] } {
  const items: HostedConfigItem[] = [];
  const writes: HostedWorktreeScript[] = [];
  const names = new Map(input.source.localProjects.map((project) => [project.id, project.name]));
  for (const hosted of input.source.worktreeScripts) {
    const item = {
      category: 'worktreeScripts' as const,
      id: `${hosted.localProjectId}:${hosted.phase}`,
      name: names.get(hosted.localProjectId) ?? hosted.localProjectId,
      detail: hosted.phase,
    };
    if (!present.has(hosted.localProjectId)) {
      items.push({ ...item, action: 'skip', reason: 'missing_project' });
      continue;
    }
    const counterpart = input.target.worktreeScripts.find(
      (script) => script.localProjectId === hosted.localProjectId && script.phase === hosted.phase
    );
    const action = !counterpart
      ? 'create'
      : same(counterpart.config, hosted.config)
        ? 'unchanged'
        : 'update';
    if (action !== 'unchanged') writes.push(hosted);
    items.push({ ...item, action });
  }
  return { items, writes };
}

/**
 * Decides what importing a hosted workspace does to a workspace, without doing
 * it. Only the selected categories are returned, but an unselected one still
 * decides what a selected one may refer to: a Role needs its agent and a
 * script its project, imported now or present already.
 */
export function planHostedImport(input: HostedImportPlanInput): HostedImportPlan {
  const agentConfigs = planAgentConfigs(input);
  const mcpServers = planMcpServers(input);
  const agentRoles = planAgentRoles(input, agentConfigs.imported);
  const localProjects = planLocalProjects(input);
  const worktreeScripts = planWorktreeScripts(input, localProjects.present);

  const planned = { agentConfigs, mcpServers, agentRoles, localProjects, worktreeScripts };
  const selected = (category: HostedConfigCategory) => input.categories.includes(category);
  return {
    items: Object.values(planned)
      .flatMap((plan) => plan.items)
      .filter((item) => selected(item.category)),
    writes: {
      agentConfigs: selected('agentConfigs') ? agentConfigs.writes : [],
      mcpServers: selected('mcpServers') ? mcpServers.writes : [],
      agentRoles: selected('agentRoles') ? agentRoles.writes : [],
      localProjects: selected('localProjects') ? localProjects.writes : [],
      worktreeScripts: selected('worktreeScripts') ? worktreeScripts.writes : [],
    },
  };
}
