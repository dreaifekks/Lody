import {
  getAgentRoleAgentFamily,
  getAgentRoleTargets,
  LODY_PLAN_MODE_CONFIG_ID,
  ACP_COLLABORATION_MODE_CONFIG_ID,
  ACP_COLLABORATION_MODE_PLAN_VALUE,
  ACP_COLLABORATION_MODE_DEFAULT_VALUE,
  snapshotAgentRole,
  type AgentConfigMeta,
  type AgentRoleAvailability,
  type AgentRoleId,
  type AgentRoleTarget,
  type AgentRoleInstanceId,
  type AgentRoleRunConfig,
  type AgentRoleUnavailableReason,
  type AgentRole,
  type MachineId,
} from '@lody/shared';
import {
  isFastModeOffWithoutToggle,
  type AcpConfigOptionSelector,
  type AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import type { AgentSelection } from '@/components/shared/agent-selector';

/** Each menu entry names one stable target and its complete run configuration. */
export type ComposerAgentRoleItem = {
  /** Complete catalog row, retained for editing and provenance. */
  role: AgentRole;
  /** The instance this entry runs. Selection, checks and records all use it. */
  instance: AgentRoleTarget;
  /**
   * The Role, target alias or Agent family, and machine name.
   */
  title: string;
  /** Target alias, else the Agent family's display name. */
  groupName: string;
  /** Whether the Role has several separately selectable targets. */
  hasSiblingGroups: boolean;
  /** Whether the instance is on the composer's machine. */
  local: boolean;
  /**
   * The instance's machine as the app names it (`names.machine`): the title's
   * suffix and the detail pane read this one name.
   */
  machineName: string;
  targetIndex: number;
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
  item: Pick<ComposerAgentRoleItem, 'role' | 'instance' | 'groupName'>
): NonNullable<SessionTurnAgentRoleSelection> => ({
  agentRoleId: item.role.id,
  agentRoleRevision: item.role.revision,
  memory: item.instance.runConfig.memory,
  agentRoleSnapshot: snapshotAgentRole(item.role, {
    id: item.instance.id,
    label: item.groupName,
  }),
});

/**
 * The entry for an instance: a listed one, or another member of a listed
 * group, read as an entry of its own (its machine, its agent, its title).
 */
export const findComposerAgentRoleItem = (
  items: readonly ComposerAgentRoleItem[],
  instanceId: AgentRoleInstanceId | null | undefined
): ComposerAgentRoleItem | undefined => {
  if (!instanceId) return undefined;
  return items.find((item) => item.instance.id === instanceId);
};

/**
 * The entry a stored record names. A record with an instance names exactly
 * that one: once it is deleted the record resolves to nothing, never to a
 * stand-in that would bring another instance's memory along. Only a record
 * made before instances, which names just its Role, means what a bare pick
 * of that Role runs.
 */
export const findRecordedComposerAgentRoleItem = (
  items: readonly ComposerAgentRoleItem[],
  roleId: string,
  instanceId: AgentRoleInstanceId | null | undefined
): ComposerAgentRoleItem | undefined =>
  instanceId
    ? findComposerAgentRoleItem(
        items.filter((item) => item.role.id === roleId),
        instanceId
      )
    : findDefaultComposerAgentRoleItem(items, roleId);

/**
 * Whether an entry's title already names its agent: an unaliased group of a
 * Role with several groups is titled by its agent family, so a second mention
 * of the agent beside it says one thing twice.
 */
export const doesAgentRoleTitleNameAgent = (
  item: Pick<ComposerAgentRoleItem, 'instance' | 'hasSiblingGroups'>
): boolean => !item.instance.alias;

/** Bare legacy selections resolve only when exactly one target remains. */
export const findDefaultComposerAgentRoleItem = (
  items: readonly ComposerAgentRoleItem[],
  roleId: string
): ComposerAgentRoleItem | undefined => {
  const entries = items.filter((item) => item.role.id === roleId);
  return entries.length === 1 ? entries[0] : undefined;
};

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
 * Turn will freeze. Independent Plan toggles preserve the Role; changes to
 * pinned model, permission, or other options still detach it.
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

  const modelId =
    overrides?.modelIdOverride !== undefined ? overrides.modelIdOverride : current.modelId;
  const effective: ComposerRunConfigValues = {
    modeId: overrides?.modeIdOverride !== undefined ? overrides.modeIdOverride : current.modeId,
    modelId,
    configOptionValues: overrides?.configOptionValuesOverride ?? current.configOptionValues,
    // The selectors describe the composer's model; another model's are not known here.
    configOptionSelectors: modelId === current.modelId ? current.configOptionSelectors : undefined,
  };
  return isAgentRoleRunConfigApplied(item.instance.runConfig, effective) ? turnSelection : null;
}

export const describeComposerAgentRoleInstance = (
  role: AgentRole,
  instance: AgentRoleTarget,
  agentConfigs: readonly AgentConfigMeta[],
  unknownAgent: string
): Pick<ComposerAgentRoleItem, 'title' | 'groupName' | 'hasSiblingGroups'> => {
  const config = agentConfigs.find((entry) => entry.id === instance.agentConfigId);
  const groupName =
    instance.alias || (config ? getAgentRoleAgentFamily(config).name : unknownAgent);
  const hasSiblingGroups = getAgentRoleTargets(role).length > 1;
  return { title: `${role.name} · ${groupName}`, groupName, hasSiblingGroups };
};

/** Names the builder cannot know: machines, and an agent whose config is unknown. */
export type ComposerAgentRoleNames = {
  machine: (machineId: MachineId) => string | undefined;
  unknownAgent: string;
};

/** Every target remains visible; ordering never chooses a target on the caller's behalf. */
export function buildComposerAgentRoleItems({
  roles,
  machineId,
  agentConfigs,
  resolveAvailability,
  names,
}: {
  roles: readonly AgentRole[];
  /** The composer's machine: preferred, never required. */
  machineId: MachineId | null | undefined;
  agentConfigs: readonly AgentConfigMeta[];
  resolveAvailability: (instance: AgentRoleTarget) => AgentRoleAvailability;
  names: ComposerAgentRoleNames;
}): ComposerAgentRoleItem[] {
  const configById = new Map(agentConfigs.map((config) => [config.id, config]));
  return roles
    .flatMap((role) =>
      getAgentRoleTargets(role).map((instance, targetIndex) => {
        const local = instance.machineId === machineId;
        const machineName = names.machine(instance.machineId) ?? instance.machineId;
        const description = describeComposerAgentRoleInstance(
          role,
          instance,
          agentConfigs,
          names.unknownAgent
        );
        const item: ComposerAgentRoleItem = {
          role,
          instance,
          ...description,
          title: `${description.title} · ${machineName}`,
          local,
          machineName,
          targetIndex,
          availability: resolveAvailability(instance),
          agentConfig: configById.get(instance.agentConfigId),
        };
        return item;
      })
    )
    .sort(
      (left, right) =>
        Number(right.local) - Number(left.local) ||
        left.role.name.localeCompare(right.role.name) ||
        left.targetIndex - right.targetIndex
    );
}

/**
 * What picking an entry does on the new-chat page, where nothing has started
 * yet: select its agent, and move the chat to its machine when it runs
 * elsewhere.
 */
export const planNewChatAgentRolePick = (
  item: Pick<ComposerAgentRoleItem, 'instance'>,
  machineId: MachineId | null | undefined
): { agentSelection: AgentSelection; moveToMachineId?: MachineId } => ({
  agentSelection: { agentId: item.instance.agentConfigId, machineId: item.instance.machineId },
  ...(item.instance.machineId !== machineId ? { moveToMachineId: item.instance.machineId } : {}),
});

/**
 * The entries of a composer whose machine is fixed — an existing Session, or a
 * Tab drafted inside one — where an entry elsewhere is listed but cannot be
 * picked: it would have to move the conversation.
 */
export const pinComposerAgentRoleItemsToMachine = (
  items: readonly ComposerAgentRoleItem[]
): ComposerAgentRoleItem[] =>
  mapComposerAgentRoleEntries(items, (entry) =>
    canFixedComposerUseAgentRoleEntry(entry)
      ? entry
      : { ...entry, availability: { kind: 'unavailable', reason: 'other_machine' } }
  );

/**
 * Whether a composer whose machine is fixed can use an entry at all. The menu
 * disables what fails this, and a recorded selection that fails it ends: the
 * two must not disagree about the same entry.
 */
export const canFixedComposerUseAgentRoleEntry = (
  entry: Pick<ComposerAgentRoleItem, 'local'>
): boolean => entry.local;

/** Apply availability changes independently to every target. */
export const mapComposerAgentRoleEntries = (
  items: readonly ComposerAgentRoleItem[],
  map: (entry: ComposerAgentRoleItem) => ComposerAgentRoleItem
): ComposerAgentRoleItem[] => items.map(map);

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
  /** The entries the composer offers. */
  items: readonly ComposerAgentRoleItem[];
  /** Whether the catalog knows this Role at all. */
  isInCatalog: boolean;
}): PendingAgentRoleSelection {
  const item = findDefaultComposerAgentRoleItem(items, roleId);
  if (!item) return isInCatalog ? { kind: 'give-up' } : { kind: 'wait' };
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
  other_machine: 'settings.agentRoles.unavailable.otherMachine',
} as const satisfies Record<AgentRoleUnavailableReason, string>;

export type ComposerRunConfigValues = {
  modeId: string | null;
  modelId: string | null;
  configOptionValues: Record<string, AcpConfigOptionValue | undefined>;
  /**
   * The option selectors resolved for `modelId`: which controls that model
   * has. `undefined` when they are not known for it.
   */
  configOptionSelectors: readonly Pick<AcpConfigOptionSelector, 'configId'>[] | undefined;
};

export type ComposerRunConfigSelection = ComposerRunConfigValues & {
  agentSelection: AgentSelection | null;
};

/**
 * Whether every value an instance PINS is what the composer is set to.
 *
 * Only the pinned values are compared: an instance deliberately leaves the
 * rest on the agent's default, so an unpinned option is not a difference. One
 * pin holds without its value being in the selection: Fast pinned off, on a
 * model whose selectors show it has no Fast toggle (`isFastModeOffWithoutToggle`).
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
    const selected = selection.configOptionValues[configId];
    if (
      configId === LODY_PLAN_MODE_CONFIG_ID &&
      typeof value === 'boolean' &&
      typeof selected === 'boolean'
    )
      continue;
    if (
      configId === ACP_COLLABORATION_MODE_CONFIG_ID &&
      [ACP_COLLABORATION_MODE_PLAN_VALUE, ACP_COLLABORATION_MODE_DEFAULT_VALUE].includes(
        value as string
      ) &&
      [ACP_COLLABORATION_MODE_PLAN_VALUE, ACP_COLLABORATION_MODE_DEFAULT_VALUE].includes(
        selected as string
      )
    )
      continue;
    if (selected === value) continue;
    if (
      selected === undefined &&
      isFastModeOffWithoutToggle(configId, value, selection.configOptionSelectors)
    ) {
      continue;
    }
    return false;
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
  instance: AgentRoleTarget,
  selection: ComposerRunConfigSelection
): boolean {
  const { agentSelection } = selection;
  if (!agentSelection) return false;
  if (agentSelection.agentId !== instance.agentConfigId) return false;
  if (agentSelection.machineId !== instance.machineId) return false;
  return isAgentRoleRunConfigApplied(instance.runConfig, selection);
}

/**
 * The Role entries an EXISTING session offers: those on its exact machine with
 * its exact Agent Config (the model-provider binding shown in the composer)
 * can be picked; entries on other machines are listed but disabled, since the
 * session cannot move.
 *
 * A live session's agent is fixed — its machine, its config, its whole
 * runtime — so an instance cannot be executed there the way the landing
 * executes one. What DOES transfer is the run configuration: model, reasoning,
 * and permission options. Keeping the offer on the exact binding avoids
 * presenting an instance whose provider credentials, capability set, or machine
 * availability do not describe the running Session; an instance here on
 * another agent is left out. Unavailable entries remain visible and disabled
 * with their real reason, just like the new-chat menu.
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
  names,
}: {
  roles: readonly AgentRole[];
  /** Existing Sessions stay on this exact machine and provider binding. */
  machineId: MachineId | null | undefined;
  agentConfigId: AgentConfigMeta['id'] | null | undefined;
  agentConfigs: readonly AgentConfigMeta[];
  resolveAvailability: (instance: AgentRoleTarget) => AgentRoleAvailability;
  names: ComposerAgentRoleNames;
}): ComposerAgentRoleItem[] {
  if (!machineId || !agentConfigId) return [];
  return pinComposerAgentRoleItemsToMachine(
    buildComposerAgentRoleItems({
      roles,
      machineId,
      agentConfigs,
      resolveAvailability,
      names,
    }).filter((item) => !item.local || item.instance.agentConfigId === agentConfigId)
  );
}
