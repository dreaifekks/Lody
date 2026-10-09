import { useCallback, useEffect, useMemo } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { usePostHog } from '@posthog/react';
import type {
  AgentConfigId,
  AgentRoleId,
  AgentRoleInstanceId,
  MachineId,
  SessionId,
} from '@lody/shared';

import { getAllAgentConfigAtom } from '@/atoms/agents';
import {
  sessionAgentRoleDurableSnapshotAtomFamily,
  sessionAgentRoleSelectionAtomFamily,
} from '@/atoms/session-agent-roles';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';
import { filterAcpSessionConfigOptionValues } from '@/lib/acp-session-config-selection';
import { captureAgentRoleApplied } from '@/lib/agent-role-analytics';
import {
  buildAgentRoleTurnSelection,
  canFixedComposerUseAgentRoleEntry,
  findComposerAgentRoleItem,
  findRecordedComposerAgentRoleItem,
  isAgentRoleRunConfigApplied,
  mapComposerAgentRoleEntries,
  selectSessionAgentRoles,
  type ComposerAgentRoleItem,
  type SessionTurnAgentRoleSelection,
} from '@/lib/composer-agent-roles';
import {
  useAgentRoleAvailability,
  useComposerAgentRoleNames,
  useWorkspaceAgentRoles,
} from '@/hooks/use-workspace-agent-roles';

export type SessionAgentRoleControl = {
  items: ComposerAgentRoleItem[];
  /** The instance this session's run config still IS, not merely the last picked. */
  selectedInstanceId: AgentRoleInstanceId | null;
  /** Three-state Turn metadata: undefined=legacy/unknown, null=explicit None. */
  turnSelection?: SessionTurnAgentRoleSelection;
  onSelect: (instanceId: AgentRoleInstanceId | null) => void;
};

/**
 * The Role row for an EXISTING session's composer.
 *
 * A live session's agent is fixed, so this is deliberately not the landing's
 * feature. It offers only Role instances on the Session's machine with its
 * exact Agent Config (its model provider), and applies only their RUN CONFIG — model,
 * reasoning, permission, and whatever else that agent publishes — because
 * those are exactly the values a session can still change per turn. The Role's
 * machine, config, and instruction are not applied and are not claimed to be.
 *
 * Applied by calling the composer's own change callbacks rather than through a
 * preference channel: this surface has no reconcile pass to seed, and a value
 * the agent does not support is skipped rather than forced in. An unsent picked
 * Role lives in session-keyed app state because navigation unmounts this
 * composer; accepted choices live in synchronized Turn inputConfig.
 */
export function useSessionAgentRole({
  sessionId,
  provenanceRoleId,
  provenanceRoleRevision,
  provenanceInstanceId,
  durableRoleId,
  durableRoleRevision,
  durableInstanceId,
  durableSourceTurnKey,
  durableKnownSourceTurnKeys = [],
  durableRoleReady = true,
  machineId,
  agentConfigId,
  modelOptions,
  selectedModelId,
  onModelChange,
  modeOptions,
  selectedModeId,
  onModeChange,
  configOptionSelectors,
  configOptionValues,
  runConfigHasUserEdits = false,
  onConfigOptionChange,
}: {
  sessionId: SessionId;
  /** Role that created this session; seeds only the composer's display name. */
  provenanceRoleId?: AgentRoleId;
  provenanceRoleRevision?: number;
  provenanceInstanceId?: AgentRoleInstanceId;
  /** Latest accepted/queued Turn selection. Null is explicit None. */
  durableRoleId?: AgentRoleId | null;
  durableRoleRevision?: number;
  /** The instance that Turn recorded, when it recorded one. */
  durableInstanceId?: AgentRoleInstanceId;
  /** Stable logical Turn identity used to fence local unsent choices. */
  durableSourceTurnKey?: string;
  /** Logical Turns visible when the latest durable snapshot was resolved. */
  durableKnownSourceTurnKeys?: readonly string[];
  /** False while the Session document is hydrating after a remount. */
  durableRoleReady?: boolean;
  machineId: MachineId | null | undefined;
  agentConfigId: AgentConfigId | null | undefined;
  modelOptions: ReadonlyArray<AcpSessionSelectOption>;
  selectedModelId: string | null;
  onModelChange?: (value: string) => void;
  modeOptions: ReadonlyArray<AcpSessionSelectOption>;
  selectedModeId: string | null;
  onModeChange?: (value: string) => void;
  configOptionSelectors: ReadonlyArray<AcpConfigOptionSelector>;
  configOptionValues: Record<string, AcpConfigOptionValue | undefined> | undefined;
  /** Tracks manual drift even while the selected Role row is unavailable. */
  runConfigHasUserEdits?: boolean;
  onConfigOptionChange?: (configId: string, value: AcpConfigOptionValue) => void;
}): SessionAgentRoleControl {
  const postHog = usePostHog();
  const { roles, synced: agentRolesSynced } = useWorkspaceAgentRoles();
  const { resolveInstance } = useAgentRoleAvailability(roles);
  const agentConfigs = useAtomValue(getAllAgentConfigAtom);
  const names = useComposerAgentRoleNames();
  const resolvedItems = useMemo(
    () =>
      selectSessionAgentRoles({
        roles,
        machineId,
        agentConfigId,
        agentConfigs,
        resolveAvailability: resolveInstance,
        names,
      }),
    [agentConfigId, agentConfigs, machineId, names, resolveInstance, roles]
  );
  const items = useMemo(
    () =>
      durableRoleReady
        ? resolvedItems
        : mapComposerAgentRoleEntries(resolvedItems, (entry) => ({
            ...entry,
            availability: { kind: 'unknown' },
          })),
    [durableRoleReady, resolvedItems]
  );

  /* Which Role was picked, as a NAME. A newly created session starts with its
     provenance Role, while an explicit choice (including None) overrides that
     seed in session-keyed app state. Whether the Role still describes the run
     config is derived below, so a knob moved by hand takes the name away on its
     own. */
  const [selectionOverride, setSelectionOverride] = useAtom(
    sessionAgentRoleSelectionAtomFamily(sessionId)
  );
  const [durableSnapshot, setDurableSnapshot] = useAtom(
    sessionAgentRoleDurableSnapshotAtomFamily(sessionId)
  );
  const hydratedTurnKey = durableSourceTurnKey ?? null;
  const hydratedKnownTurnKeys = useMemo(
    () =>
      durableKnownSourceTurnKeys.length > 0
        ? durableKnownSourceTurnKeys
        : hydratedTurnKey
          ? [hydratedTurnKey]
          : [],
    [durableKnownSourceTurnKeys, hydratedTurnKey]
  );
  const effectiveKnownTurnKeys = durableRoleReady
    ? hydratedKnownTurnKeys
    : (durableSnapshot?.knownTurnKeys ??
      selectionOverride?.basedOnTurnKeys ??
      hydratedKnownTurnKeys);
  const effectiveDurableRoleId =
    !durableRoleReady && durableSnapshot ? durableSnapshot.roleId : durableRoleId;
  const effectiveDurableRoleRevision =
    !durableRoleReady && durableSnapshot ? durableSnapshot.roleRevision : durableRoleRevision;
  const effectiveDurableInstanceId =
    !durableRoleReady && durableSnapshot ? durableSnapshot.instanceId : durableInstanceId;
  useEffect(() => {
    if (!durableRoleReady) return;
    setDurableSnapshot((current) => {
      if (
        current &&
        current.roleId === durableRoleId &&
        current.roleRevision === durableRoleRevision &&
        current.instanceId === durableInstanceId &&
        current.currentTurnKey === hydratedTurnKey &&
        current.knownTurnKeys.length === hydratedKnownTurnKeys.length &&
        current.knownTurnKeys.every((key, index) => key === hydratedKnownTurnKeys[index])
      ) {
        return current;
      }
      return {
        roleId: durableRoleId,
        roleRevision: durableRoleRevision,
        instanceId: durableInstanceId,
        currentTurnKey: hydratedTurnKey,
        knownTurnKeys: hydratedKnownTurnKeys,
      };
    });
  }, [
    durableRoleId,
    durableRoleReady,
    durableRoleRevision,
    durableInstanceId,
    hydratedKnownTurnKeys,
    hydratedTurnKey,
    setDurableSnapshot,
  ]);
  const selectionOverrideIsCurrent =
    !selectionOverride ||
    !hydratedTurnKey ||
    selectionOverride.basedOnTurnKeys.includes(hydratedTurnKey);
  const useOverride =
    Boolean(selectionOverride) && (!durableRoleReady || selectionOverrideIsCurrent);
  const pickedRoleId =
    useOverride && selectionOverride
      ? selectionOverride.roleId
      : effectiveDurableRoleId !== undefined
        ? effectiveDurableRoleId
        : (provenanceRoleId ?? null);
  const pickedInstanceId =
    useOverride && selectionOverride
      ? selectionOverride.instanceId
      : effectiveDurableRoleId !== undefined
        ? effectiveDurableInstanceId
        : provenanceInstanceId;
  useEffect(() => {
    if (!durableRoleReady || !selectionOverride || selectionOverrideIsCurrent) {
      return;
    }
    // A newer durable Turn permanently consumes this draft. Otherwise deleting
    // a queued Turn could return the resolver to an older source and resurrect
    // a choice that was already sent or superseded.
    setSelectionOverride(undefined);
  }, [durableRoleReady, selectionOverride, selectionOverrideIsCurrent, setSelectionOverride]);
  const selection = useMemo(
    () => ({
      modeId: selectedModeId,
      modelId: selectedModelId,
      configOptionValues: configOptionValues ?? {},
    }),
    [configOptionValues, selectedModeId, selectedModelId]
  );
  /* The picked instance, while it still exists on this Session's machine: a
     deleted or moved instance ends the selection rather than handing it to
     another. A record made before instances names only its Role, which then
     means what a bare pick of that Role runs here. */
  const recordedItem = pickedRoleId
    ? findRecordedComposerAgentRoleItem(items, pickedRoleId, pickedInstanceId)
    : undefined;
  const pickedItem =
    recordedItem && canFixedComposerUseAgentRoleEntry(recordedItem) ? recordedItem : undefined;
  const selectedInstanceId = useMemo(() => {
    if (!pickedItem || pickedItem.role.id !== pickedRoleId) return null;
    return !durableRoleReady ||
      isAgentRoleRunConfigApplied(pickedItem.instance.runConfig, selection)
      ? pickedItem.instance.id
      : null;
  }, [durableRoleReady, pickedItem, pickedRoleId, selection]);
  const storedPickedRevision =
    effectiveDurableRoleId === pickedRoleId
      ? effectiveDurableRoleRevision
      : provenanceRoleId === pickedRoleId
        ? provenanceRoleRevision
        : undefined;
  const turnSelection: SessionTurnAgentRoleSelection =
    selectedInstanceId && pickedItem
      ? buildAgentRoleTurnSelection(pickedItem)
      : pickedRoleId === null
        ? null
        : pickedItem
          ? // A manual run-config change means this is no longer that Role.
            null
          : !agentRolesSynced
            ? runConfigHasUserEdits
              ? null
              : typeof storedPickedRevision === 'number'
                ? { agentRoleId: pickedRoleId, agentRoleRevision: storedPickedRevision }
                : undefined
            : pickedInstanceId
              ? // Its instance is gone from this Session's machine: no stand-in.
                null
              : roles.some((role) => role.id === pickedRoleId)
                ? typeof storedPickedRevision === 'number'
                  ? { agentRoleId: pickedRoleId, agentRoleRevision: storedPickedRevision }
                  : undefined
                : // The synchronized catalog authoritatively no longer contains it.
                  null;

  const onSelect = useCallback(
    (instanceId: AgentRoleInstanceId | null) => {
      if (instanceId === null) {
        // Clears the NAME, not the configuration: the values are the user's own
        // now, and rolling them back would undo choices they never asked to undo.
        if (!durableRoleReady) return;
        setSelectionOverride({ roleId: null, basedOnTurnKeys: effectiveKnownTurnKeys });
        return;
      }
      const item = findComposerAgentRoleItem(items, instanceId);
      if (!item || item.availability.kind !== 'available') return;
      const { role, instance } = item;
      setSelectionOverride({
        roleId: role.id,
        instanceId: instance.id,
        basedOnTurnKeys: effectiveKnownTurnKeys,
      });

      const { modelId, modeId, configOptionValues: pinned } = instance.runConfig;
      const appliedModelId =
        modelId && modelOptions.some((option) => option.value === modelId) ? modelId : undefined;
      if (appliedModelId) {
        onModelChange?.(appliedModelId);
      }
      if (modeId && modeOptions.some((option) => option.value === modeId)) {
        onModeChange?.(modeId);
      }
      // An option this agent dropped, or whose value it no longer offers, is
      // skipped rather than forced back in — through the same filter every
      // other surface applies to remembered values. A Role that also pins a
      // different model is the exception: the selectors describe the outgoing
      // model, whose ladder must not decide the pinned effort.
      for (const [configId, value] of Object.entries(
        filterAcpSessionConfigOptionValues(pinned, configOptionSelectors, {
          switchesModel: appliedModelId !== undefined && appliedModelId !== selectedModelId,
        })
      )) {
        onConfigOptionChange?.(configId, value);
      }
      // Offered instances run on this Session's own machine and Agent Config.
      captureAgentRoleApplied(postHog, role, { source: 'existing_session', crossMachine: false });
    },
    [
      configOptionSelectors,
      durableRoleReady,
      effectiveKnownTurnKeys,
      items,
      modeOptions,
      modelOptions,
      onConfigOptionChange,
      onModeChange,
      onModelChange,
      postHog,
      selectedModelId,
      setSelectionOverride,
    ]
  );

  return { items, selectedInstanceId, turnSelection, onSelect };
}
