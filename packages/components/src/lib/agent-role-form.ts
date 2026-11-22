import {
  ACP_CONFIG_OPTION_OFF_VALUE,
  isAcpThoughtLevelConfigOption,
  EMPTY_AGENT_ROLE_FORM_VALUE,
  buildEmptyAgentRoleFormInstance,
} from '@lody/shared';
import type { TFunction } from 'i18next';
import {
  isSensitiveAgentRoleConfigOptionKey,
  type AgentRoleFormInstance,
  type AgentRoleRunConfig,
} from '@lody/shared';
import {
  isConfigOptionValueValid,
  isFastModeOffWithoutToggle,
  type AcpConfigOptionSelector,
  type AcpSelectConfigOptionSelector,
  type AcpSelectorOptions,
} from '@/components/shared/acp-selector-options';

const findModeConfigSelector = (
  selectors: readonly AcpConfigOptionSelector[] | undefined
): AcpSelectConfigOptionSelector | undefined =>
  selectors?.find(
    (selector): selector is AcpSelectConfigOptionSelector =>
      selector.category === 'mode' &&
      selector.type === 'select' &&
      selector.configId !== 'interaction_mode'
  );

const findModelConfigSelector = (
  selectors: readonly AcpConfigOptionSelector[] | undefined
): AcpSelectConfigOptionSelector | undefined =>
  selectors?.find(
    (selector): selector is AcpSelectConfigOptionSelector =>
      selector.category === 'model' && selector.type === 'select'
  );

/**
 * Seed one instance with what its selected agent actually defaults to.
 *
 * A Role has no "inherit" state: every run-config control shows a concrete
 * value, because "Agent default" tells a user nothing about what will run and
 * pushes the decision to a later surface. So the first time a config is
 * selected the agent's own defaults are written in, and from there the user is
 * choosing, not accepting a blank.
 *
 * Only unset fields are filled: a saved Role keeps its stored selection even
 * when it differs from the agent's current default, which is what makes an
 * incompatible value visible instead of silently replaced.
 */
export const applyAgentRoleRunConfigDefaults = (
  value: AgentRoleFormInstance,
  selectorOptions: AcpSelectorOptions | null
): AgentRoleFormInstance => {
  if (!selectorOptions || selectorOptions.capabilityAuthority === 'unavailable') return value;

  const modeConfigSelector = findModeConfigSelector(selectorOptions.configOptionSelectors);
  const modelConfigSelector = findModelConfigSelector(selectorOptions.configOptionSelectors);
  const modelId =
    value.modelId ??
    (selectorOptions.modelOptions.length > 0
      ? typeof value.configOptionValues.model === 'string'
        ? value.configOptionValues.model
        : (selectorOptions.defaultModelId ?? selectorOptions.modelOptions[0]?.value ?? null)
      : null);
  const modeId =
    value.modeId ??
    (selectorOptions.modeOptions.length > 0
      ? typeof value.configOptionValues.mode === 'string'
        ? value.configOptionValues.mode
        : (selectorOptions.defaultModeId ?? selectorOptions.modeOptions[0]?.value ?? null)
      : null);

  const configOptionValues = { ...value.configOptionValues };
  for (const selector of selectAuthorableAgentRoleConfigOptions(
    selectorOptions.configOptionSelectors
  )) {
    if (configOptionValues[selector.configId] !== undefined) continue;
    if (
      selector.configId === modelConfigSelector?.configId &&
      selectorOptions.modelOptions.length === 0 &&
      value.modelId
    ) {
      configOptionValues[selector.configId] = value.modelId;
      continue;
    }
    if (
      selector.configId === modeConfigSelector?.configId &&
      selectorOptions.modeOptions.length === 0 &&
      value.modeId
    ) {
      configOptionValues[selector.configId] = value.modeId;
      continue;
    }
    configOptionValues[selector.configId] = selector.currentValue;
  }

  if (
    modelId === value.modelId &&
    modeId === value.modeId &&
    Object.keys(configOptionValues).length === Object.keys(value.configOptionValues).length
  ) {
    return value;
  }
  return { ...value, modelId, modeId, configOptionValues };
};

const isPermissionModeSelector = (selector: AcpConfigOptionSelector): boolean =>
  (selector.category === 'mode' && selector.configId !== 'interaction_mode') ||
  selector.category === '_permission';

export const carryAgentRoleOptionsToModel = (
  values: AgentRoleFormInstance['configOptionValues'],
  outgoing: readonly AcpConfigOptionSelector[],
  incoming: readonly AcpConfigOptionSelector[]
): AgentRoleFormInstance['configOptionValues'] => {
  const carried: AgentRoleFormInstance['configOptionValues'] = {};
  for (const [configId, value] of Object.entries(values)) {
    const prev = outgoing.find((selector) => selector.configId === configId);
    if (!prev) {
      carried[configId] = value;
      continue;
    }
    const next = incoming.find((selector) => selector.configId === configId);
    // Changing the model must never silently drop or rewrite a pinned permission
    // mode: carry it to the incoming permission control (even under a renamed id
    // or if unsupported on the new model) so the warning stays visible until the
    // owner explicitly picks a new permission.
    if (isPermissionModeSelector(prev)) {
      if (next) {
        carried[configId] = value;
      } else {
        const renamed = incoming.find(
          (selector) => isPermissionModeSelector(selector) && selector.category === prev.category
        );
        if (renamed) {
          if (values[renamed.configId] === undefined && carried[renamed.configId] === undefined) {
            carried[renamed.configId] = value;
          }
        } else {
          carried[configId] = value;
        }
      }
      continue;
    }
    if (next !== undefined && isConfigOptionValueValid(next, value)) {
      carried[configId] = value;
    }
  }
  return carried;
};

// ---------------------------------------------------------------------------
// Capability compatibility
// ---------------------------------------------------------------------------

export type AgentRoleRunConfigIssue =
  /** The agent's capabilities are unknown, so nothing can be judged compatible. */
  | { kind: 'capabilities_unknown' }
  | { kind: 'mode_unsupported'; value: string }
  | { kind: 'model_unsupported'; value: string }
  | { kind: 'option_unsupported'; configId: string }
  | { kind: 'option_value_unsupported'; configId: string; value: string };

/**
 * Which parts of a saved run config the selected agent no longer supports.
 *
 * Opening the editor reports rather than repairs. Explicit Save reconciles option
 * controls; a missing model or mode stays pinned until the owner selects a new one.
 */
export const findAgentRoleRunConfigIssues = (
  runConfig: AgentRoleRunConfig,
  selectorOptions: AcpSelectorOptions
): AgentRoleRunConfigIssue[] => {
  const hasSelection =
    Boolean(runConfig.modeId) ||
    Boolean(runConfig.modelId) ||
    Object.keys(runConfig.configOptionValues ?? {}).length > 0;
  if (selectorOptions.capabilityAuthority === 'unavailable') {
    return hasSelection ? [{ kind: 'capabilities_unknown' }] : [];
  }

  const modeConfigSelector = findModeConfigSelector(selectorOptions.configOptionSelectors);
  const modelConfigSelector = findModelConfigSelector(selectorOptions.configOptionSelectors);
  const isModeConfigDriven =
    selectorOptions.modeOptions.length === 0 && modeConfigSelector !== undefined;
  const isModelConfigDriven =
    selectorOptions.modelOptions.length === 0 && modelConfigSelector !== undefined;
  const modeConfigId = modeConfigSelector?.configId ?? 'mode';
  const modelConfigId = modelConfigSelector?.configId ?? 'model';
  const effectiveModeOptions =
    selectorOptions.modeOptions.length > 0
      ? selectorOptions.modeOptions
      : (modeConfigSelector?.options ?? []);
  const effectiveModelOptions =
    selectorOptions.modelOptions.length > 0
      ? selectorOptions.modelOptions
      : (modelConfigSelector?.options ?? []);

  const modeFromConfig =
    typeof runConfig.configOptionValues?.[modeConfigId] === 'string'
      ? (runConfig.configOptionValues[modeConfigId] as string)
      : undefined;
  const modelFromConfig =
    typeof runConfig.configOptionValues?.[modelConfigId] === 'string'
      ? (runConfig.configOptionValues[modelConfigId] as string)
      : undefined;
  const canonicalModeId = isModeConfigDriven
    ? (modeFromConfig ?? runConfig.modeId)
    : (runConfig.modeId ?? modeFromConfig);
  const canonicalModelId = isModelConfigDriven
    ? (modelFromConfig ?? runConfig.modelId)
    : (runConfig.modelId ?? modelFromConfig);

  const issues: AgentRoleRunConfigIssue[] = [];
  if (canonicalModeId && !effectiveModeOptions.some((option) => option.value === canonicalModeId)) {
    issues.push({ kind: 'mode_unsupported', value: canonicalModeId });
  }
  if (
    canonicalModelId &&
    !effectiveModelOptions.some((option) => option.value === canonicalModelId)
  ) {
    issues.push({ kind: 'model_unsupported', value: canonicalModelId });
  }

  for (const [configId, value] of Object.entries(runConfig.configOptionValues ?? {})) {
    if (
      configId === modeConfigId &&
      (isModeConfigDriven || selectorOptions.modeOptions.length > 0) &&
      (typeof value === 'string' || typeof canonicalModeId === 'string')
    ) {
      continue;
    }
    if (
      configId === modelConfigId &&
      (isModelConfigDriven || selectorOptions.modelOptions.length > 0) &&
      (typeof value === 'string' || typeof canonicalModelId === 'string')
    ) {
      continue;
    }
    const selector = selectorOptions.configOptionSelectors.find(
      (candidate) => candidate.configId === configId
    );
    if (!selector) {
      // Fast pinned off on a model without the toggle is what runs anyway.
      if (!isFastModeOffWithoutToggle(configId, value, selectorOptions.configOptionSelectors)) {
        issues.push({ kind: 'option_unsupported', configId });
      }
      continue;
    }
    if (!isConfigOptionValueValid(selector, value)) {
      issues.push({ kind: 'option_value_unsupported', configId, value: String(value) });
    }
  }
  return issues;
};

/** One issue as the Role editor and the composer's Role pane both word it. */
export const describeAgentRoleRunConfigIssue = (
  issue: AgentRoleRunConfigIssue,
  t: TFunction
): string => {
  switch (issue.kind) {
    case 'capabilities_unknown':
      return t('settings.agentRoles.issues.capabilitiesUnknown');
    case 'mode_unsupported':
      return t('settings.agentRoles.issues.modeUnsupported', { value: issue.value });
    case 'model_unsupported':
      return t('settings.agentRoles.issues.modelUnsupported', { value: issue.value });
    case 'option_unsupported':
      return t('settings.agentRoles.issues.optionUnsupported', { option: issue.configId });
    case 'option_value_unsupported':
      return t('settings.agentRoles.issues.optionValueUnsupported', {
        option: issue.configId,
        value: issue.value,
      });
    default: {
      const exhaustive: never = issue;
      return String(exhaustive);
    }
  }
};

/**
 * The option selectors a Role may author.
 *
 * The same refusal as the reader: an agent is free to publish an option with
 * any id, so a secret-shaped one is never offered as something to store.
 */
export const selectAuthorableAgentRoleConfigOptions = <T extends { configId: string }>(
  selectors: readonly T[]
): T[] => selectors.filter((selector) => !isSensitiveAgentRoleConfigOptionKey(selector.configId));

/** Reconcile each instance only on an explicit Save with authoritative capabilities. */
export const prepareAgentRoleInstanceForSave = (
  value: AgentRoleFormInstance,
  selectorOptions: AcpSelectorOptions | null | undefined
): AgentRoleFormInstance => {
  if (selectorOptions?.capabilityAuthority !== 'authoritative') return value;
  const modeConfigSelector = findModeConfigSelector(selectorOptions.configOptionSelectors);
  const modelConfigSelector = findModelConfigSelector(selectorOptions.configOptionSelectors);
  const configOptionValues = Object.fromEntries(
    selectAuthorableAgentRoleConfigOptions(selectorOptions.configOptionSelectors).map(
      (selector) => {
        const current = value.configOptionValues[selector.configId];
        // Keep retired mode/permission/model pins intact until the owner picks
        // a new one, matching how top-level modeId/modelId behave for built-in agents.
        if (
          (selector.configId === modeConfigSelector?.configId ||
            selector.configId === modelConfigSelector?.configId ||
            selector.category === '_permission') &&
          typeof current === 'string' &&
          current.length > 0
        ) {
          return [selector.configId, current];
        }
        return [
          selector.configId,
          isConfigOptionValueValid(selector, current) ? current : selector.currentValue,
        ];
      }
    )
  );
  // Keep top-level modeId/modelId aligned with config-option mode/model edits on
  // registry/custom agents so a stale top-level field cannot override an edit.
  const modeId =
    selectorOptions.modeOptions.length === 0 &&
    modeConfigSelector &&
    typeof configOptionValues[modeConfigSelector.configId] === 'string'
      ? (configOptionValues[modeConfigSelector.configId] as string)
      : value.modeId;
  const modelId =
    selectorOptions.modelOptions.length === 0 &&
    modelConfigSelector &&
    typeof configOptionValues[modelConfigSelector.configId] === 'string'
      ? (configOptionValues[modelConfigSelector.configId] as string)
      : value.modelId;
  return {
    ...value,
    modeId,
    modelId,
    configOptionValues,
  };
};

/**
 * What a Role's row says it will run, in reading order: model, reasoning, then
 * whatever else it pins.
 *
 * Values only, no `key=value`: the machine is in the group heading and the agent
 * is its icon, so this line is the part a user scans to tell two Roles on one
 * agent apart. An option left at the agent's own default still appears — a Role
 * pins concrete values, and hiding one would make two different Roles read the
 * same. A boolean that is OFF is dropped instead, because "fast mode: false"
 * says nothing a missing chip does not.
 */
export const buildAgentRoleRunConfigSummary = (
  runConfig: AgentRoleRunConfig,
  selectors?: Pick<AcpSelectorOptions, 'modelOptions' | 'modeOptions' | 'configOptionSelectors'>
): string[] => {
  // A Role stores option IDS only — the capability's `category` is not part of
  // the row — so the id is tested as both, which also matches an agent whose
  // reasoning option is literally named after the category.
  const isReasoning = (configId: string) =>
    isAcpThoughtLevelConfigOption({ id: configId, category: configId });
  const modeConfigSelector = findModeConfigSelector(selectors?.configOptionSelectors);
  const modelConfigSelector = findModelConfigSelector(selectors?.configOptionSelectors);
  const effectiveModelOptions =
    selectors && selectors.modelOptions.length > 0
      ? selectors.modelOptions
      : (modelConfigSelector?.options ?? []);
  const effectiveModeOptions =
    selectors && selectors.modeOptions.length > 0
      ? selectors.modeOptions
      : (modeConfigSelector?.options ?? []);
  const modelConfigId = modelConfigSelector?.configId ?? 'model';
  const modeConfigId = modeConfigSelector?.configId ?? 'mode';
  const modelFromConfig =
    typeof runConfig.configOptionValues?.[modelConfigId] === 'string'
      ? (runConfig.configOptionValues[modelConfigId] as string)
      : undefined;
  const modeFromConfig =
    typeof runConfig.configOptionValues?.[modeConfigId] === 'string'
      ? (runConfig.configOptionValues[modeConfigId] as string)
      : undefined;
  const effectiveModelId =
    selectors && selectors.modelOptions.length === 0 && modelConfigSelector
      ? (modelFromConfig ?? runConfig.modelId)
      : (runConfig.modelId ?? modelFromConfig);
  const effectiveModeId =
    selectors && selectors.modeOptions.length === 0 && modeConfigSelector
      ? (modeFromConfig ?? runConfig.modeId)
      : (runConfig.modeId ?? modeFromConfig);

  const skipConfigIds = new Set<string>();
  if (
    effectiveModelId &&
    (modelFromConfig === effectiveModelId ||
      (selectors && selectors.modelOptions.length > 0 && !modelConfigSelector))
  ) {
    skipConfigIds.add(modelConfigId);
  }
  if (
    effectiveModeId &&
    (modeFromConfig === effectiveModeId ||
      (selectors && selectors.modeOptions.length > 0 && !modeConfigSelector))
  ) {
    skipConfigIds.add(modeConfigId);
  }

  const options = Object.entries(runConfig.configOptionValues ?? {}).filter(
    ([configId]) => !skipConfigIds.has(configId)
  );
  const reasoning = options.filter(([configId]) => isReasoning(configId));
  const rest = options.filter(([configId]) => !isReasoning(configId));

  const describe = (entries: [string, string | boolean][]): string[] =>
    entries.flatMap(([configId, value]) => {
      const selector = selectors?.configOptionSelectors.find(
        (entry) => entry.configId === configId
      );
      if (typeof value === 'boolean') return value ? [selector?.label ?? configId] : [];
      if (value === ACP_CONFIG_OPTION_OFF_VALUE) return [];
      return [selector?.options.find((option) => option.value === value)?.label ?? value];
    });

  return [
    ...(effectiveModelId
      ? [
          effectiveModelOptions.find((option) => option.value === effectiveModelId)?.label ??
            effectiveModelId,
        ]
      : []),
    ...describe(reasoning),
    ...(effectiveModeId
      ? [
          effectiveModeOptions.find((option) => option.value === effectiveModeId)?.label ??
            effectiveModeId,
        ]
      : []),
    ...describe(rest),
  ];
};

export const createAgentRoleFormValue = (
  machineId: import('@lody/shared').MachineId | null
): import('@lody/shared').AgentRoleFormValue => ({
  ...EMPTY_AGENT_ROLE_FORM_VALUE,
  instances: [
    buildEmptyAgentRoleFormInstance(
      crypto.randomUUID() as import('@lody/shared').AgentRoleInstanceId,
      machineId
    ),
  ],
});
