import {
  AGENT_ROLE_VERSION,
  getAgentRoleMentionSlug,
  isAgentRoleContentEqual,
  normalizeAgentRoleDescription,
  normalizeAgentRoleEmoji,
  normalizeAgentRoleInstanceLabel,
  normalizeAgentRoleMentionSlug,
  normalizeAgentRoleRunConfig,
  withAgentRoleInstances,
  type AgentRole,
  type AgentRoleInstance,
  type AgentRoleRunConfig,
  type CatalogAgentRole,
} from './agent-role';
import type { AgentConfigId, AgentRoleId, AgentRoleInstanceId, MachineId } from './ids';

/**
 * The authoring state of one Agent Role, and the pure rules around it.
 *
 * Separated from the dialog so the parts that must not be got wrong — what a
 * Role may store, when `revision` moves, and whether a saved Role still matches
 * its agent's capabilities — are testable without rendering anything.
 */

/** One instance in the editor. A machine and an agent are chosen before it can be saved. */
export type AgentRoleFormInstance = {
  id: AgentRoleInstanceId;
  label: string;
  machineId: MachineId | null;
  agentConfigId: AgentConfigId | null;
  modeId: string | null;
  modelId: string | null;
  configOptionValues: Record<string, string | boolean>;
  memory?: AgentRoleRunConfig['memory'];
};

export type AgentRoleFormValue = {
  name: string;
  description: string;
  emoji: string;
  /** In dispatch order; see `AgentRole.instances`. */
  instances: AgentRoleFormInstance[];
  promptPrefix: string;
  /** Off by default: a new Role is private until its owner says otherwise. */
  shareWithWorkspace: boolean;
};

export const EMPTY_AGENT_ROLE_FORM_VALUE: AgentRoleFormValue = {
  name: '',
  description: '',
  emoji: '',
  instances: [],
  promptPrefix: '',
  shareWithWorkspace: false,
};

/** A new instance, before its machine and agent are chosen. */
export const buildEmptyAgentRoleFormInstance = (
  id: AgentRoleInstanceId,
  machineId: MachineId | null = null
): AgentRoleFormInstance => ({
  id,
  label: '',
  machineId,
  agentConfigId: null,
  modeId: null,
  modelId: null,
  configOptionValues: {},
});

/**
 * Seed a new Role from a run configuration the user already has in front of
 * them — the composer's current selection — as its one instance.
 *
 * Creating a Role out of "what I am about to run" is the whole point of
 * offering it from the composer, so the form opens on that configuration with
 * only the name left to write. The values pass through the shared normalizer,
 * so the seed refuses exactly the option keys a Role may never store.
 */
export const buildAgentRoleFormValueFromRunConfig = (input: {
  instanceId: AgentRoleInstanceId;
  /** The agent's name, the instance's default label. */
  label: string;
  machineId: MachineId | null | undefined;
  agentConfigId: AgentConfigId | null | undefined;
  modeId?: string | null;
  modelId?: string | null;
  configOptionValues?: Record<string, string | boolean | undefined>;
}): AgentRoleFormValue => {
  const runConfig = normalizeAgentRoleRunConfig({
    modeId: input.modeId ?? undefined,
    modelId: input.modelId ?? undefined,
    configOptionValues: input.configOptionValues,
  });
  return {
    ...EMPTY_AGENT_ROLE_FORM_VALUE,
    instances: input.machineId
      ? [
          {
            id: input.instanceId,
            label: input.label,
            machineId: input.machineId,
            agentConfigId: input.agentConfigId ?? null,
            modeId: runConfig.modeId ?? null,
            modelId: runConfig.modelId ?? null,
            configOptionValues: { ...(runConfig.configOptionValues ?? {}) },
          },
        ]
      : [],
  };
};

export const buildAgentRoleFormInstance = (instance: AgentRoleInstance): AgentRoleFormInstance => ({
  id: instance.id,
  label: instance.label,
  machineId: instance.machineId,
  agentConfigId: instance.agentConfigId,
  modeId: instance.runConfig.modeId ?? null,
  modelId: instance.runConfig.modelId ?? null,
  configOptionValues: { ...(instance.runConfig.configOptionValues ?? {}) },
  ...(instance.runConfig.memory ? { memory: instance.runConfig.memory } : {}),
});

export const buildAgentRoleFormValue = (role: CatalogAgentRole): AgentRoleFormValue => ({
  name: role.name,
  description: role.description ?? '',
  emoji: role.emoji ?? '',
  instances: role.instances.map(buildAgentRoleFormInstance),
  promptPrefix: role.promptPrefix ?? '',
  shareWithWorkspace: role.visibility === 'workspace',
});

export type AgentRoleFormError =
  | 'name_required'
  | 'name_taken'
  | 'instance_required'
  | 'machine_required'
  | 'agent_config_required'
  | 'label_required'
  | 'label_taken';

/** What is wrong with one instance, if anything; also used to mark its row. */
export const validateAgentRoleFormInstance = (
  instance: AgentRoleFormInstance,
  instances: readonly AgentRoleFormInstance[]
): AgentRoleFormError[] => {
  const errors: AgentRoleFormError[] = [];
  const label = normalizeAgentRoleInstanceLabel(instance.label).toLowerCase();
  if (!instance.machineId) errors.push('machine_required');
  if (!instance.agentConfigId) errors.push('agent_config_required');
  if (!label) errors.push('label_required');
  else if (
    instances.some(
      (other) =>
        other.id !== instance.id &&
        normalizeAgentRoleInstanceLabel(other.label).toLowerCase() === label
    )
  )
    errors.push('label_taken');
  return errors;
};

/**
 * The name is the Role's only authored label, so it carries both jobs: it is
 * what the list shows and what `@` completes. Uniqueness is therefore checked on
 * the DERIVED mention token — "Code Reviewer" and "Code-Reviewer" are the same
 * `@Code-Reviewer` — and only against the Roles this user can see. It is a
 * readability rule, not an identity one: the mention range always carries the
 * Role id, so another member's private Role neither can nor needs to be checked.
 */
export const validateAgentRoleForm = (
  value: AgentRoleFormValue,
  options: { accessibleRoles: readonly AgentRole[]; editingRoleId?: AgentRoleId | null }
): AgentRoleFormError[] => {
  const errors = new Set<AgentRoleFormError>();
  const slug = normalizeAgentRoleMentionSlug(value.name);
  if (!slug) {
    // Covers both an empty name and one that is all punctuation the mention
    // token strips: either way there is nothing to type after `@`.
    errors.add('name_required');
  } else if (
    options.accessibleRoles.some(
      (role) => role.id !== options.editingRoleId && getAgentRoleMentionSlug(role) === slug
    )
  ) {
    errors.add('name_taken');
  }

  if (value.instances.length === 0) errors.add('instance_required');
  for (const instance of value.instances)
    for (const error of validateAgentRoleFormInstance(instance, value.instances)) errors.add(error);
  return [...errors];
};

/**
 * The run config a form instance implies.
 *
 * Runs through the shared normalizer rather than copying the fields, so the
 * authoring surface refuses exactly the option keys the reader would later
 * refuse — a Role never becomes a place a secret is stored.
 */
export const buildAgentRoleRunConfig = (value: AgentRoleFormInstance): AgentRoleRunConfig =>
  normalizeAgentRoleRunConfig({
    memory: value.memory,
    modeId: value.modeId ?? undefined,
    modelId: value.modelId ?? undefined,
    configOptionValues: value.configOptionValues,
  });

/**
 * Turn an authored form into the row to persist. Expects a value that passed
 * `validateAgentRoleForm`: every instance has a machine and an agent.
 *
 * `revision` only moves when something actually changed: accepted Operations
 * and Session provenance record it, so a no-op save must not invent a new one.
 */
export const buildAgentRoleFromForm = (
  value: AgentRoleFormValue,
  options: {
    /** The catalog row being edited. */
    existing?: CatalogAgentRole;
    ownerUserId: string;
    now: number;
    createId: () => AgentRoleId;
  }
): CatalogAgentRole => {
  const { existing, ownerUserId, now } = options;
  const emoji = normalizeAgentRoleEmoji(value.emoji);
  const promptPrefix = value.promptPrefix.trim();
  const instances = value.instances.map((instance): AgentRoleInstance => ({
    id: instance.id,
    label: normalizeAgentRoleInstanceLabel(instance.label),
    machineId: instance.machineId as MachineId,
    agentConfigId: instance.agentConfigId as AgentConfigId,
    runConfig: buildAgentRoleRunConfig(instance),
  }));
  const next = withAgentRoleInstances(
    {
      v: AGENT_ROLE_VERSION,
      id: existing?.id ?? options.createId(),
      ownerUserId: existing?.ownerUserId ?? ownerUserId,
      visibility: value.shareWithWorkspace ? 'workspace' : 'private',
      name: value.name.trim(),
      description: normalizeAgentRoleDescription(value.description),
      ...(emoji ? { emoji } : {}),
      ...(promptPrefix ? { promptPrefix } : {}),
      revision: existing?.revision ?? 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: existing?.updatedAt ?? now,
    },
    instances
  );

  if (!existing) return next;
  if (isAgentRoleContentEqual(existing, next)) return existing;
  return { ...next, revision: existing.revision + 1, updatedAt: now };
};
