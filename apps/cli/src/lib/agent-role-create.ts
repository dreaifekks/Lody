import {
  bindAgentRoleTarget,
  getAgentRoleTargets,
  getWorkspaceFlockDocId,
  listWorkspaceAgentRoles,
  readWorkspaceFlockRowsFromFlock,
  snapshotAgentRole,
  selectAgentRoleInstance,
  type AgentRoleTarget,
  type MachineId,
  type SessionId,
  type AgentRole,
  type WorkspaceId,
} from '@lody/shared';
import { createResourceDiscovery } from './resource-discovery-runtime';
import type { AgentRoleDiscoveryTarget } from './resource-discovery';
import {
  resolveCreateCurrentSessionId,
  resolveSessionMetaOrThrow,
  selectLocalProjectsBySelector,
} from '@/commands/session';
import { type AuthContext, normalizeCliValue } from '@/lib/command-runtime';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { CreateOptions, ResolvedTurnDispatchConfig } from '@/commands/session';

/**
 * CLI `session create --agent-role` uses the same instance selector as MCP.
 * The selected instance owns the machine, agent and run config; the Role owns
 * the Prompt prefix. Machine pins select an instance; manual agent/run-config
 * overrides are ignored.
 */

export const composeAgentRolePrompt = (
  promptPrefix: string | undefined,
  prompt: string
): string => {
  const prefix = promptPrefix?.trim();
  return prefix ? `${prefix}\n\n${prompt}` : prompt;
};

export const loadWorkspaceAgentRoleCatalog = async (
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId
): Promise<ReadonlyMap<string, AgentRole>> => {
  const docId = getWorkspaceFlockDocId(workspaceId);
  await manager.syncFlockDocOrThrow(docId, {
    timeoutMs: 10_000,
    reason: 'agent-role-catalog-read',
  });
  const handle = await manager.repo.openFlockDoc(docId);
  return new Map(
    listWorkspaceAgentRoles(readWorkspaceFlockRowsFromFlock(handle.flock)).map((role) => [
      role.id,
      role,
    ])
  );
};

const formatAgentRoleCandidates = (roles: readonly AgentRole[]): string =>
  roles
    .map((role) => `${role.name} (${role.id})`)
    .sort((left, right) => left.localeCompare(right))
    .join(', ');

export const selectUniqueAgentRoleByIdOrName = (
  roles: readonly AgentRole[],
  selector: string
): AgentRole => {
  const normalizedSelector = normalizeCliValue(selector);
  if (!normalizedSelector) {
    throw new Error('Missing Agent Role selector.');
  }

  const idMatch = roles.find((role) => role.id === normalizedSelector);
  if (idMatch) {
    return idMatch;
  }

  const nameMatches = roles.filter((role) => normalizeCliValue(role.name) === normalizedSelector);
  const [onlyNameMatch] = nameMatches;
  if (nameMatches.length === 1 && onlyNameMatch) {
    const aliases = roles.flatMap((role) =>
      getAgentRoleTargets(role)
        .filter((target) => target.alias && normalizeCliValue(target.alias) === normalizedSelector)
        .map((target) => ({ role, target }))
    );
    if (
      aliases.some(
        ({ role }) => role.id !== onlyNameMatch.id || getAgentRoleTargets(role).length > 1
      )
    ) {
      throw new Error(
        `Agent Role selector is ambiguous: ${normalizedSelector} names a Role and target aliases. Use a Role or target id. Candidates: ${formatAgentRoleCandidates(roles)}`
      );
    }
    return onlyNameMatch;
  }
  if (nameMatches.length > 1) {
    throw new Error(
      `Agent Role selector is ambiguous: ${normalizedSelector}. Use an id instead. Candidates: ${formatAgentRoleCandidates(roles)}`
    );
  }

  throw new Error(
    `Agent Role not found: ${normalizedSelector}. Candidates: ${formatAgentRoleCandidates(roles)}`
  );
};

const formatAgentRoleTargets = (role: AgentRole): string =>
  getAgentRoleTargets(role)
    .map((target) => `${target.id} (${target.machineId}${target.alias ? `, ${target.alias}` : ''})`)
    .join(', ');

/**
 * The Role bound to the machine that will run it.
 *
 * A selector may be a Role id, its unique name, or one target's alias, which
 * names the machine by itself. A Role on several machines otherwise needs
 * `machineId`: nothing picks one of its targets on the caller's behalf. For a
 * single-target Role any supplied machine must still match.
 */
export const selectAgentRoleTarget = (
  roles: readonly AgentRole[],
  selector: string,
  machine?: { machineId?: string }
): AgentRole => {
  const normalizedSelector = normalizeCliValue(selector);
  const machineId = normalizeCliValue(machine?.machineId);
  const targetIds = roles.flatMap((role) =>
    getAgentRoleTargets(role)
      .filter((target) => target.id === normalizedSelector)
      .map((target) => ({ role, target }))
  );
  if (!roles.some((role) => role.id === normalizedSelector) && targetIds.length) {
    if (targetIds.length !== 1) throw new Error(`Agent Role target id is ambiguous: ${selector}.`);
    const { role, target } = targetIds[0]!;
    if (machineId && machineId !== target.machineId)
      throw new Error(`Target ${target.id} does not run on machine ${machineId}.`);
    return bindAgentRoleTarget(role, target.machineId, target.id)!;
  }
  const aliasMatches = roles.flatMap((role) =>
    getAgentRoleTargets(role)
      .filter(
        (target) =>
          target.id === normalizedSelector ||
          (target.alias && normalizeCliValue(target.alias) === normalizedSelector)
      )
      .map((target) => ({ role, target }))
  );
  const isIdOrName = roles.some(
    (role) => role.id === normalizedSelector || normalizeCliValue(role.name) === normalizedSelector
  );
  if (!isIdOrName && aliasMatches.length) {
    if (aliasMatches.length !== 1)
      throw new Error(
        `Agent Role alias is ambiguous: ${selector}. Targets: ${aliasMatches.map(({ role, target }) => `${role.name}/${target.id} (${target.machineId})`).join(', ')}`
      );
    const { role, target } = aliasMatches[0]!;
    if (machineId && machineId !== target.machineId)
      throw new Error(`Target ${target.id} does not run on machine ${machineId}.`);
    return bindAgentRoleTarget(role, target.machineId, target.id)!;
  }
  const role = selectUniqueAgentRoleByIdOrName(roles, selector);
  const choice = selectAgentRoleInstance(
    role,
    { machineId: machineId as MachineId | undefined },
    () => true
  );
  if (choice.kind === 'rejected')
    throw new Error(
      `Agent Role ${role.name}: ${choice.reason}. Targets: ${formatAgentRoleTargets(role)}`
    );
  return bindAgentRoleTarget(role, choice.instance.machineId, choice.instance.id)!;
};

/** Manual create flags that an explicit Role replaces; their values are ignored. */
export type AgentRoleCreateOverrides = {
  machine?: string;
  agent?: string;
  agentConfig?: string;
  mode?: string;
  model?: string;
  configOption?: string[];
};

export const listIgnoredAgentRoleOverrides = (options: AgentRoleCreateOverrides): string[] => {
  const ignored: string[] = [];
  if (normalizeCliValue(options.agent)) {
    ignored.push('--agent');
  }
  if (normalizeCliValue(options.agentConfig)) {
    ignored.push('--agent-config');
  }
  if (normalizeCliValue(options.mode)) {
    ignored.push('--mode');
  }
  if (normalizeCliValue(options.model)) {
    ignored.push('--model');
  }
  if (options.configOption && options.configOption.length > 0) {
    ignored.push('--config-option');
  }
  return ignored;
};

export type ResolvedAgentRoleCreate = {
  role: AgentRole;
  instance: AgentRoleTarget;
  machineId: AgentRole['machineId'];
  agentConfigId: AgentRole['agentConfigId'];
  prompt: string;
  dispatchConfig: ResolvedTurnDispatchConfig;
  /** CLI flags whose values the Role overrides, in help-flag form (e.g. --model). */
  ignoredOverrides: string[];
};

export const resolveAgentRoleCreate = (args: {
  role: AgentRole;
  prompt: string;
  overrides?: AgentRoleCreateOverrides;
  request?: Parameters<typeof selectAgentRoleInstance>[1];
  instances?: readonly AgentRoleDiscoveryTarget[];
}): ResolvedAgentRoleCreate => {
  const reportOf = (instance: AgentRoleTarget) =>
    args.instances?.find((entry) => entry.id === instance.id);
  const choice = selectAgentRoleInstance(
    args.role,
    args.request ?? {},
    (instance) => reportOf(instance)?.availability.state !== 'unavailable',
    (instance) => reportOf(instance)?.group.key ?? `config:${instance.agentConfigId}`
  );
  if (choice.kind === 'rejected') {
    throw new Error(
      `Agent Role "${args.role.name}": ${choice.reason}. Usable instances: ${choice.usableInstances.map((instance) => `${instance.id} (${instance.machineId})`).join(', ') || 'none'}.`
    );
  }
  return {
    role: args.role,
    instance: choice.instance,
    machineId: choice.instance.machineId,
    agentConfigId: choice.instance.agentConfigId,
    prompt: composeAgentRolePrompt(args.role.promptPrefix, args.prompt),
    dispatchConfig: { ...choice.instance.runConfig, inheritSessionDefaults: false },
    ignoredOverrides: listIgnoredAgentRoleOverrides(args.overrides ?? {}),
  };
};

/** Resolve the CLI `--agent-role` selector (fixed id or unique name) against the workspace catalog. */
export const resolveAgentRoleCreateFromCatalog = async (args: {
  manager: LoroDocumentManager;
  auth: AuthContext;
  workspaceId: WorkspaceId;
  selector: string;
  prompt: string;
  overrides?: CreateOptions;
}): Promise<ResolvedAgentRoleCreate> => {
  const catalog = await loadWorkspaceAgentRoleCatalog(args.manager, args.workspaceId);
  const roles = [...catalog.values()];
  const namedRole = roles.find(
    (role) =>
      role.id === normalizeCliValue(args.selector) ||
      normalizeCliValue(role.name) === normalizeCliValue(args.selector)
  );
  const targetIdMatch = roles.some((role) =>
    getAgentRoleTargets(role).some((target) => target.id === normalizeCliValue(args.selector))
  );
  const role =
    namedRole && (!targetIdMatch || namedRole.id === normalizeCliValue(args.selector))
      ? selectUniqueAgentRoleByIdOrName(roles, args.selector)
      : selectAgentRoleTarget(roles, args.selector);
  const discovery = await createResourceDiscovery(args);
  const options = args.overrides ?? {};
  const machine = normalizeCliValue(options.machine);
  const machineId = machine ? ((await discovery.resolveMachine(machine)) as MachineId) : undefined;
  const parentId =
    normalizeCliValue(options.parent) ??
    (options.useCurrentSessionAsParent ? resolveCreateCurrentSessionId(options) : undefined);
  const projectId = normalizeCliValue(options.localProject);
  const workContextMachineId = parentId
    ? (await resolveSessionMetaOrThrow(args.manager, parentId as SessionId)).machineId
    : projectId
      ? await discovery.localProjectMachineId(
          projectId,
          machineId
            ? [machineId]
            : [...new Set(getAgentRoleTargets(role).map((instance) => instance.machineId))],
          (project) => selectLocalProjectsBySelector([project], projectId).length > 0
        )
      : undefined;
  if (projectId && !workContextMachineId) {
    throw new Error(
      `Local project ${projectId} is not on a machine where Agent Role "${role.name}" has an instance.`
    );
  }
  return resolveAgentRoleCreate({
    role,
    prompt: args.prompt,
    overrides: options,
    instances: await discovery.agentRoleTargets(role.id),
    request: {
      machineId,
      workContextMachineId,
      callerMachineId: args.auth.machineId as MachineId,
    },
  });
};

export const bindAgentRoleCreateOptions = (
  options: CreateOptions,
  resolved: ResolvedAgentRoleCreate | undefined
): void => {
  if (!resolved) return;
  options.agentRoleId = resolved.role.id;
  options.agentRoleRevision = resolved.role.revision;
  options.agentRoleSnapshot = snapshotAgentRole(resolved.role, resolved.instance);
};

/**
 * Make the Role the sole create target: manual machine/agent/run-config flags
 * are cleared so nothing downstream can observe the overridden values, and the
 * Role provenance is frozen onto the create options.
 */
export const applyAgentRoleCreateTarget = (
  options: CreateOptions,
  resolved: ResolvedAgentRoleCreate
): void => {
  options.machine = resolved.machineId;
  options.agentConfig = resolved.agentConfigId;
  delete options.agent;
  delete options.mode;
  delete options.model;
  options.configOption = [];
  bindAgentRoleCreateOptions(options, resolved);
};
