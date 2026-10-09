import {
  AGENT_ROLE_VERSION,
  getAgentRoleMentionSlug,
  isAgentRoleContentEqual,
  normalizeAgentRoleDescription,
  normalizeAgentRoleEmoji,
  normalizeAgentRoleMentionSlug,
  normalizeAgentRoleRunConfig,
  withAgentRolePlacements,
  type AgentRole,
  type AgentRolePlacement,
  type AgentRoleRunConfig,
} from './agent-role';
import type { AgentConfigId, AgentRoleId, MachineId } from './ids';

/**
 * The authoring state of one Agent Role, and the pure rules around it.
 *
 * Separated from the dialog so the parts that must not be got wrong — what a
 * Role may store, when `revision` moves, and whether a saved Role still matches
 * its agent's capabilities — are testable without rendering anything.
 */
/** One machine's row in the editor. A row with no agent chosen is not saved. */
export type AgentRoleFormPlacement = {
  machineId: MachineId;
  enabled: boolean;
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
  /** In dispatch order; see `AgentRole.placements`. */
  placements: AgentRoleFormPlacement[];
  promptPrefix: string;
  /** Off by default: a new Role is private until its owner says otherwise. */
  shareWithWorkspace: boolean;
};

export const EMPTY_AGENT_ROLE_FORM_VALUE: AgentRoleFormValue = {
  name: '',
  description: '',
  emoji: '',
  placements: [],
  promptPrefix: '',
  shareWithWorkspace: false,
};

/**
 * Seed a new Role from a run configuration the user already has in front of
 * them — the composer's current selection.
 *
 * Creating a Role out of "what I am about to run" is the whole point of
 * offering it from the composer, so the form opens on that configuration with
 * only the name left to write. The values pass through the shared normalizer,
 * so the seed refuses exactly the option keys a Role may never store.
 */
export const buildAgentRoleFormValueFromRunConfig = (input: {
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
    placements: input.machineId
      ? [
          {
            machineId: input.machineId,
            enabled: true,
            agentConfigId: input.agentConfigId ?? null,
            modeId: runConfig.modeId ?? null,
            modelId: runConfig.modelId ?? null,
            configOptionValues: { ...(runConfig.configOptionValues ?? {}) },
          },
        ]
      : [],
  };
};

const buildAgentRoleFormPlacement = (placement: AgentRolePlacement): AgentRoleFormPlacement => ({
  machineId: placement.machineId,
  enabled: placement.enabled,
  agentConfigId: placement.agentConfigId,
  modeId: placement.runConfig.modeId ?? null,
  modelId: placement.runConfig.modelId ?? null,
  configOptionValues: { ...(placement.runConfig.configOptionValues ?? {}) },
  ...(placement.runConfig.memory ? { memory: placement.runConfig.memory } : {}),
});

export const buildAgentRoleFormValue = (role: AgentRole): AgentRoleFormValue => ({
  name: role.name,
  description: role.description ?? '',
  emoji: role.emoji ?? '',
  placements: role.placements.map(buildAgentRoleFormPlacement),
  promptPrefix: role.promptPrefix ?? '',
  shareWithWorkspace: role.visibility === 'workspace',
});

export type AgentRoleFormError =
  | 'name_required'
  | 'name_taken'
  | 'machine_required'
  | 'agent_config_required';

/** A blank row for a machine the editor lists but the Role does not use yet. */
export const buildEmptyAgentRoleFormPlacement = (machineId: MachineId): AgentRoleFormPlacement => ({
  machineId,
  enabled: false,
  agentConfigId: null,
  modeId: null,
  modelId: null,
  configOptionValues: {},
});

/**
 * The name is the only authored label, so it carries both jobs: it is what the
 * list shows and what `@` completes. Uniqueness is therefore checked on the
 * DERIVED mention token — "Code Reviewer" and "Code-Reviewer" are the same
 * `@Code-Reviewer` — and only against the Roles this user can see. It is a
 * readability rule, not an identity one: the mention range always carries the
 * Role id, so another member's private Role neither can nor needs to be checked.
 */
export const validateAgentRoleForm = (
  value: AgentRoleFormValue,
  options: { accessibleRoles: readonly AgentRole[]; editingRoleId?: AgentRoleId | null }
): AgentRoleFormError[] => {
  const errors: AgentRoleFormError[] = [];
  const slug = normalizeAgentRoleMentionSlug(value.name);
  if (!slug) {
    // Covers both an empty name and one that is all punctuation the mention
    // token strips: either way there is nothing to type after `@`.
    errors.push('name_required');
  } else if (
    options.accessibleRoles.some(
      (role) => role.id !== options.editingRoleId && getAgentRoleMentionSlug(role) === slug
    )
  ) {
    errors.push('name_taken');
  }

  const enabled = value.placements.filter((placement) => placement.enabled);
  if (enabled.length === 0) errors.push('machine_required');
  else if (enabled.some((placement) => !placement.agentConfigId))
    errors.push('agent_config_required');
  return errors;
};

/**
 * The run config a form value implies.
 *
 * Runs through the shared normalizer rather than copying the fields, so the
 * authoring surface refuses exactly the option keys the reader would later
 * refuse — a Role never becomes a place a secret is stored.
 */
export const buildAgentRoleRunConfig = (value: AgentRoleFormPlacement): AgentRoleRunConfig =>
  normalizeAgentRoleRunConfig({
    memory: value.memory,
    modeId: value.modeId ?? undefined,
    modelId: value.modelId ?? undefined,
    configOptionValues: value.configOptionValues,
  });

/**
 * Turn an authored form into the row to persist. Expects a value that passed
 * `validateAgentRoleForm`: rows without an agent are dropped, so at least one
 * enabled placement remains.
 *
 * `revision` only moves when something actually changed: accepted Operations
 * and Session provenance record it, so a no-op save must not invent a new one.
 */
export const buildAgentRoleFromForm = (
  value: AgentRoleFormValue,
  options: {
    existing?: AgentRole;
    ownerUserId: string;
    now: number;
    createId: () => AgentRoleId;
  }
): AgentRole => {
  const { existing, ownerUserId, now } = options;
  const emoji = normalizeAgentRoleEmoji(value.emoji);
  const promptPrefix = value.promptPrefix.trim();
  const placements = value.placements.flatMap((placement): AgentRolePlacement[] =>
    placement.agentConfigId
      ? [
          {
            machineId: placement.machineId,
            agentConfigId: placement.agentConfigId,
            enabled: placement.enabled,
            runConfig: buildAgentRoleRunConfig(placement),
          },
        ]
      : []
  );
  const next = withAgentRolePlacements(
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
    placements
  );

  if (!existing) return next;
  if (isAgentRoleContentEqual(existing, next)) return existing;
  return { ...next, revision: existing.revision + 1, updatedAt: now };
};
