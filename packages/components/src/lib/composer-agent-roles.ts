import {
  listAgentRoleInstancesOnMachine,
  snapshotAgentRole,
  type AgentConfigMeta,
  type AgentRoleAvailability,
  type AgentRoleId,
  type AgentRoleInstance,
  type AgentRoleInstanceId,
  type AgentRoleRunConfig,
  type AgentRoleUnavailableReason,
  type CatalogAgentRole,
  type MachineId,
} from '@lody/shared';
import type { AcpConfigOptionValue } from '@/components/shared/acp-selector-options';
import type { AgentSelection } from '@/components/shared/agent-selector';

/**
 * Agent Roles as the composer's run-config menu uses them.
 *
 * A Role is a template; what the menu offers are its instances on the
 * composer's machine, each one packaged answer to "which agent, which model,
 * which run options" — the same knobs the menu's detail tab exposes one at a
 * time. That is the whole relationship between the two tabs, and it is why the
 * rules here are about identity rather than repair: picking an instance must
 * set exactly what it says, and the composer must stop naming it the moment the
 * running configuration is no longer that instance's.
 */

export type ComposerAgentRoleItem = {
  /** The whole catalog row: the template, and every instance. */
  role: CatalogAgentRole;
  /** The instance this entry runs. Selection, checks and records all use it. */
  instance: AgentRoleInstance;
  /** The Role's name, plus the instance's label when the machine holds several. */
  title: string;
  availability: AgentRoleAvailability;
  /**
   * The instance's config while it still exists; its absence is itself the
   * reason. Carries what the detail pane needs to resolve that agent's
   * capabilities, so a stored id can be shown as the label the agent publishes.
   */
  agentConfig?: Pick<
    AgentConfigMeta,
    'name' | 'cliType' | 'agentType' | 'brandId' | 'env' | 'runtimeOverrides'
  >;
};

export type SessionTurnAgentRoleSelection =
  | {
      agentRoleId: AgentRoleId;
      memory?: import('@lody/shared').MemoryBinding;
      agentRoleRevision: number;
      /** Carries the instance that ran. */
      agentRoleSnapshot?: import('@lody/shared').AgentRoleSnapshot;
    }
  | null
  | undefined;

/** The Turn record of a picked entry: the Role, the instance that runs, its memory. */
export const buildAgentRoleTurnSelection = (
  item: Pick<ComposerAgentRoleItem, 'role' | 'instance'>
): NonNullable<SessionTurnAgentRoleSelection> => ({
  agentRoleId: item.role.id,
  agentRoleRevision: item.role.revision,
  memory: item.instance.runConfig.memory,
  agentRoleSnapshot: snapshotAgentRole(item.role, item.instance),
});

/** `uiStyle`, or `uiStyle · Claude` when the machine holds more than one instance. */
export const formatAgentRoleInstanceTitle = (
  role: Pick<CatalogAgentRole, 'name' | 'instances'>,
  instance: AgentRoleInstance
): string =>
  listAgentRoleInstancesOnMachine(role, instance.machineId).length > 1
    ? `${role.name} · ${instance.label}`
    : role.name;

export const findComposerAgentRoleItem = (
  items: readonly ComposerAgentRoleItem[],
  instanceId: AgentRoleInstanceId | null | undefined
): ComposerAgentRoleItem | undefined =>
  instanceId ? items.find((item) => item.instance.id === instanceId) : undefined;

export type ComposerRunConfigOverrides = {
  modeIdOverride?: string | null;
  modelIdOverride?: string | null;
  configOptionValuesOverride?: Record<string, AcpConfigOptionValue>;
};

/**
 * Resolve the Role metadata for a programmatic Turn (retry, Goal, PR action,
 * etc.). Undefined means inherit; null remains an explicit None selection.
 */
export function resolveProgrammaticTurnAgentRole({
  requested,
  composer,
  durableRoleId,
  durableRoleRevision,
  durableMemory,
  durableSnapshot,
}: {
  requested?: SessionTurnAgentRoleSelection;
  composer?: SessionTurnAgentRoleSelection;
  durableRoleId?: AgentRoleId | null;
  durableMemory?: import('@lody/shared').MemoryBinding;
  durableRoleRevision?: number;
  /** The durable Turn's Role record, which names the instance that ran. */
  durableSnapshot?: import('@lody/shared').AgentRoleSnapshot;
}): SessionTurnAgentRoleSelection {
  if (requested !== undefined) return requested;
  if (composer !== undefined) return composer;
  if (durableRoleId === null) return null;
  return durableRoleId && typeof durableRoleRevision === 'number'
    ? {
        agentRoleId: durableRoleId,
        agentRoleRevision: durableRoleRevision,
        memory: durableMemory,
        ...(durableSnapshot?.id === durableRoleId ? { agentRoleSnapshot: durableSnapshot } : {}),
      }
    : undefined;
}

/**
 * Revalidate an inherited Role against the actual run config a programmatic
 * Turn will freeze. Execute-plan and similar actions deliberately override
 * Plan/mode values; keeping the old Role id beside those different values
 * would make the Turn claim a configuration it is not running.
 *
 * A catalog-pending Role may still be carried when the run config is untouched.
 * Once an override exists we must be able to verify the picked instance, or
 * conservatively freeze explicit None.
 */
export function resolveTurnAgentRoleForRunConfig({
  turnSelection,
  item,
  current,
  overrides,
}: {
  turnSelection: SessionTurnAgentRoleSelection;
  item: Pick<ComposerAgentRoleItem, 'role' | 'instance'> | undefined;
  current: ComposerRunConfigValues;
  overrides?: ComposerRunConfigOverrides;
}): SessionTurnAgentRoleSelection {
  if (turnSelection === null || turnSelection === undefined) return turnSelection;
  const hasOverride =
    overrides?.modeIdOverride !== undefined ||
    overrides?.modelIdOverride !== undefined ||
    overrides?.configOptionValuesOverride !== undefined;
  if (!hasOverride) return turnSelection;
  if (!item || item.role.id !== turnSelection.agentRoleId) return null;

  const effective: ComposerRunConfigValues = {
    modeId: overrides?.modeIdOverride !== undefined ? overrides.modeIdOverride : current.modeId,
    modelId: overrides?.modelIdOverride !== undefined ? overrides.modelIdOverride : current.modelId,
    configOptionValues: overrides?.configOptionValuesOverride ?? current.configOptionValues,
  };
  return isAgentRoleRunConfigApplied(item.instance.runConfig, effective) ? turnSelection : null;
}

type AgentConfigLookup = ReadonlyMap<string, AgentConfigMeta>;

const itemFor = (
  role: CatalogAgentRole,
  instance: AgentRoleInstance,
  configById: AgentConfigLookup,
  resolveAvailability: (instance: AgentRoleInstance) => AgentRoleAvailability
): ComposerAgentRoleItem => ({
  role,
  instance,
  title: formatAgentRoleInstanceTitle(role, instance),
  availability: resolveAvailability(instance),
  agentConfig: configById.get(instance.agentConfigId),
});

/** Role name, then the Role's own instance order. */
const sortItems = (items: ComposerAgentRoleItem[]): ComposerAgentRoleItem[] =>
  items.sort(
    (left, right) =>
      left.role.name.localeCompare(right.role.name) ||
      left.role.id.localeCompare(right.role.id) ||
      left.role.instances.indexOf(left.instance) - right.role.instances.indexOf(right.instance)
  );

/**
 * The Role instances the composer offers for the machine the chat will start
 * on: one flat list, one entry per instance on that machine.
 *
 * Scoped to that one machine because the composer has already decided it: an
 * instance elsewhere could only move the chat off the selected machine.
 *
 * Unavailable instances stay listed. Seeing that one exists and why it cannot
 * run is what lets someone fix it; dropping the row makes it look deleted.
 */
export function buildComposerAgentRoleItems({
  roles,
  machineId,
  agentConfigs,
  resolveAvailability,
}: {
  roles: readonly CatalogAgentRole[];
  machineId: MachineId | null | undefined;
  agentConfigs: readonly AgentConfigMeta[];
  resolveAvailability: (instance: AgentRoleInstance) => AgentRoleAvailability;
}): ComposerAgentRoleItem[] {
  if (!machineId) return [];
  const configById = new Map(agentConfigs.map((config) => [config.id as string, config]));
  return sortItems(
    roles.flatMap((role) =>
      listAgentRoleInstancesOnMachine(role, machineId).map((instance) =>
        itemFor(role, instance, configById, resolveAvailability)
      )
    )
  );
}

/**
 * Whether this run config pins the permission mode.
 *
 * Permission IS part of an instance — the Role editor writes it as
 * `runConfig.modeId` for legacy ACP modes, or as the agent's own `_permission`
 * option — so while an instance is what will run, permission is not a separate
 * thing left to choose. Asked rather than assumed, because an agent that
 * publishes no permission control leaves an instance with nothing to pin, and
 * hiding the composer's permission button then would take away a knob the
 * instance never owned.
 */
export function doesAgentRolePinPermissionMode(
  runConfig: AgentRoleRunConfig,
  source: { kind: 'configOption'; configId: string } | { kind: 'modeId' } | null
): boolean {
  if (!source) return false;
  return source.kind === 'modeId'
    ? Boolean(runConfig.modeId)
    : runConfig.configOptionValues?.[source.configId] !== undefined;
}

/**
 * What to do about a Role the composer just asked to select but has not seen
 * yet — the one it created a moment ago.
 *
 * A create resolves on the DURABLE local write, while the catalog snapshot the
 * composer reads from arrives on its own tick, so "not in the list" right after
 * saving means "not yet". It can also mean "not here at all": the editor lets a
 * Role run on other machines only, and the composer must not follow one onto a
 * machine it is not starting this chat on. So the answers are wait, select
 * (the Role's default instance here), and give up — never "select something
 * else".
 */
export type PendingAgentRoleSelection =
  | { kind: 'wait' }
  | { kind: 'select'; instanceId: AgentRoleInstanceId }
  | { kind: 'give-up' };

export function resolvePendingAgentRoleSelection({
  roleId,
  items,
  isInCatalog,
}: {
  roleId: AgentRoleId;
  /** The instances the composer offers, i.e. those on its own machine. */
  items: readonly ComposerAgentRoleItem[];
  /** Whether the catalog knows this Role at all, on any machine. */
  isInCatalog: boolean;
}): PendingAgentRoleSelection {
  // The first instance listed for the Role is its default on this machine.
  const item = items.find((entry) => entry.role.id === roleId);
  if (!item) {
    // Known to the catalog but not offered here: it runs elsewhere, and
    // following it would move the chat off the selected machine.
    return isInCatalog ? { kind: 'give-up' } : { kind: 'wait' };
  }
  if (item.availability.kind === 'unknown') return { kind: 'wait' };
  return item.availability.kind === 'available'
    ? { kind: 'select', instanceId: item.instance.id }
    : { kind: 'give-up' };
}

/**
 * Why a Role cannot run, as translation keys.
 *
 * One mapping, because every surface that lists Roles has to say the same thing
 * for the same reason — a second copy is one that drifts into describing a
 * `machine_offline` Role as a missing config.
 */
export const AGENT_ROLE_UNAVAILABLE_REASON_KEYS = {
  memory_unsupported: 'settings.memory.unsupported',
  machine_unknown: 'settings.agentRoles.unavailable.machineUnknown',
  machine_offline: 'settings.agentRoles.unavailable.machineOffline',
  agent_config_missing: 'settings.agentRoles.unavailable.agentConfigMissing',
  agent_config_machine_mismatch: 'settings.agentRoles.unavailable.agentConfigMismatch',
} as const satisfies Record<AgentRoleUnavailableReason, string>;

export type ComposerRunConfigValues = {
  modeId: string | null;
  modelId: string | null;
  configOptionValues: Record<string, AcpConfigOptionValue | undefined>;
};

export type ComposerRunConfigSelection = ComposerRunConfigValues & {
  agentSelection: AgentSelection | null;
};

/**
 * Whether every value an instance PINS is what the composer is set to.
 *
 * Only the pinned values are compared: an instance deliberately leaves the
 * rest on the agent's default, so an unpinned option is not a difference.
 *
 * This is the half that does NOT involve the agent, because the two surfaces
 * disagree about the agent on purpose — see `isComposerAgentRoleApplied`.
 */
export function isAgentRoleRunConfigApplied(
  runConfig: AgentRoleRunConfig,
  selection: ComposerRunConfigValues
): boolean {
  const { modeId, modelId, configOptionValues } = runConfig;
  if (modeId && selection.modeId !== modeId) return false;
  if (modelId && selection.modelId !== modelId) return false;
  for (const [configId, value] of Object.entries(configOptionValues ?? {})) {
    if (selection.configOptionValues[configId] !== value) return false;
  }
  return true;
}

/**
 * Whether the composer is currently configured as this instance says — values
 * AND the agent and machine it runs on.
 *
 * This is the NEW-CHAT rule. The chat landing can still move the agent, so
 * picking an instance there authorizes the whole instance, and the footer names
 * it only while that holds. Three things end it, and all three are cases where
 * the instance's own promise was already broken: the user moved a knob, the
 * agent changed, or the agent no longer supports a value the instance pins so
 * the selection state fell back to the agent's own.
 */
export function isComposerAgentRoleApplied(
  instance: AgentRoleInstance,
  selection: ComposerRunConfigSelection
): boolean {
  const { agentSelection } = selection;
  if (!agentSelection) return false;
  if (agentSelection.agentId !== instance.agentConfigId) return false;
  if (agentSelection.machineId !== instance.machineId) return false;
  return isAgentRoleRunConfigApplied(instance.runConfig, selection);
}

/**
 * The Role instances an EXISTING session may reuse: those on its exact machine
 * with its exact Agent Config (the model-provider binding shown in the
 * composer).
 *
 * A live session's agent is fixed — its machine, its config, its whole
 * runtime — so an instance cannot be executed there the way the landing
 * executes one. What DOES transfer is the run configuration: model, reasoning,
 * and permission options. Keeping the offer on the exact binding avoids
 * presenting an instance whose provider credentials, capability set, or machine
 * availability do not describe the running Session. Unavailable instances
 * remain visible and disabled with their real reason, just like the new-chat
 * menu.
 *
 * The Role's instruction is NOT part of it. A Role's prompt prefix belongs to
 * the FIRST turn of a session it creates; replaying it into an ongoing
 * conversation would be a different feature.
 */
export function selectSessionAgentRoles({
  roles,
  machineId,
  agentConfigId,
  agentConfigs,
  resolveAvailability,
}: {
  roles: readonly CatalogAgentRole[];
  /** Existing Sessions stay on this exact machine and provider binding. */
  machineId: MachineId | null | undefined;
  agentConfigId: AgentConfigMeta['id'] | null | undefined;
  agentConfigs: readonly AgentConfigMeta[];
  resolveAvailability: (instance: AgentRoleInstance) => AgentRoleAvailability;
}): ComposerAgentRoleItem[] {
  if (!machineId || !agentConfigId) return [];
  return buildComposerAgentRoleItems({
    roles,
    machineId,
    agentConfigs,
    resolveAvailability,
  }).filter((item) => item.instance.agentConfigId === agentConfigId);
}
