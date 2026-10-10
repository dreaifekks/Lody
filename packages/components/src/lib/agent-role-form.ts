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
  type AcpSelectorOptions,
} from '@/components/shared/acp-selector-options';

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

  const modelId =
    value.modelId ??
    (selectorOptions.modelOptions.length > 0
      ? (selectorOptions.defaultModelId ?? selectorOptions.modelOptions[0]?.value ?? null)
      : null);
  const modeId =
    value.modeId ??
    (selectorOptions.modeOptions.length > 0
      ? (selectorOptions.defaultModeId ?? selectorOptions.modeOptions[0]?.value ?? null)
      : null);

  const configOptionValues = { ...value.configOptionValues };
  for (const selector of selectAuthorableAgentRoleConfigOptions(
    selectorOptions.configOptionSelectors
  )) {
    if (configOptionValues[selector.configId] !== undefined) continue;
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

export const carryAgentRoleOptionsToModel = (
  values: AgentRoleFormInstance['configOptionValues'],
  outgoing: readonly AcpConfigOptionSelector[],
  incoming: readonly AcpConfigOptionSelector[]
): AgentRoleFormInstance['configOptionValues'] =>
  Object.fromEntries(
    Object.entries(values).filter(([configId, value]) => {
      if (!outgoing.some((selector) => selector.configId === configId)) return true;
      const next = incoming.find((selector) => selector.configId === configId);
      return next !== undefined && isConfigOptionValueValid(next, value);
    })
  );

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
 * Reported rather than repaired. A Role whose model disappeared must say so and
 * stay unavailable until its owner picks a new one — quietly substituting the
 * agent's default is the failure mode this feature exists to avoid.
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

  const issues: AgentRoleRunConfigIssue[] = [];
  if (
    runConfig.modeId &&
    !selectorOptions.modeOptions.some((option) => option.value === runConfig.modeId)
  ) {
    issues.push({ kind: 'mode_unsupported', value: runConfig.modeId });
  }
  if (
    runConfig.modelId &&
    !selectorOptions.modelOptions.some((option) => option.value === runConfig.modelId)
  ) {
    issues.push({ kind: 'model_unsupported', value: runConfig.modelId });
  }

  for (const [configId, value] of Object.entries(runConfig.configOptionValues ?? {})) {
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
