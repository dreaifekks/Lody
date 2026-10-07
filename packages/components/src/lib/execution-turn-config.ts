import {
  LODY_PLAN_MODE_CONFIG_ID,
  ACP_COLLABORATION_MODE_CONFIG_ID,
  ACP_COLLABORATION_MODE_DEFAULT_VALUE,
  ACP_COLLABORATION_MODE_PLAN_VALUE,
  ACP_PLAN_PERMISSION_MODE_ID,
  isAcpPlanModeConfigOption,
  type AcpConfigOptionValue,
} from '@lody/shared';

export type ExecutionTurnConfigOverrides = {
  modeIdOverride: string | null;
  configOptionValuesOverride: Record<string, AcpConfigOptionValue>;
};

export type ExecutionTurnConfigInput = Parameters<typeof buildExecutionTurnConfigOverrides>[0];

/**
 * The run config of a plan review's answer. Approving starts the work, so it
 * leaves planning the way "Implement the plan" does; asking for changes keeps
 * planning, so the turn inherits the current configuration (`undefined`).
 */
export function buildPlanReviewTurnConfigOverrides(
  decision: 'approve' | 'request_changes',
  current: ExecutionTurnConfigInput
): ExecutionTurnConfigOverrides | undefined {
  return decision === 'approve' ? buildExecutionTurnConfigOverrides(current) : undefined;
}

export function buildExecutionTurnConfigOverrides(args: {
  selectedModeId: string | null;
  defaultModeId: string | null;
  modeOptions: readonly { value: string }[];
  configOptionSelectors: readonly {
    configId: string;
    category?: string;
    type: 'select' | 'boolean';
    options: readonly { value: string }[];
    currentValue: AcpConfigOptionValue;
  }[];
  configOptionValues: Record<string, AcpConfigOptionValue>;
}): ExecutionTurnConfigOverrides {
  const { selectedModeId, defaultModeId, modeOptions, configOptionSelectors, configOptionValues } =
    args;
  const nonPlanModeId =
    defaultModeId && defaultModeId !== ACP_PLAN_PERMISSION_MODE_ID
      ? defaultModeId
      : modeOptions.find((option) => option.value !== ACP_PLAN_PERMISSION_MODE_ID)?.value;
  const modeIdOverride =
    selectedModeId === ACP_PLAN_PERMISSION_MODE_ID && nonPlanModeId
      ? nonPlanModeId
      : selectedModeId;
  const corePlanSelector = configOptionSelectors.find(
    (selector) => selector.configId === LODY_PLAN_MODE_CONFIG_ID && selector.type === 'boolean'
  );
  const corePlanValue =
    configOptionValues[LODY_PLAN_MODE_CONFIG_ID] ?? corePlanSelector?.currentValue;
  if (typeof corePlanValue === 'boolean') {
    return {
      modeIdOverride,
      configOptionValuesOverride: corePlanValue
        ? { ...configOptionValues, [LODY_PLAN_MODE_CONFIG_ID]: false }
        : configOptionValues,
    };
  }
  const planSelector = configOptionSelectors.find(
    (selector) =>
      selector.type === 'select' &&
      isAcpPlanModeConfigOption({
        id: selector.configId,
        category: selector.category,
      })
  );
  const planConfigId = planSelector?.configId ?? ACP_COLLABORATION_MODE_CONFIG_ID;
  const currentPlanValue = configOptionValues[planConfigId] ?? planSelector?.currentValue;
  const nonPlanConfigValue =
    planSelector?.options.find((option) => option.value === ACP_COLLABORATION_MODE_DEFAULT_VALUE)
      ?.value ??
    (planConfigId === ACP_COLLABORATION_MODE_CONFIG_ID
      ? ACP_COLLABORATION_MODE_DEFAULT_VALUE
      : undefined);
  const configOptionValuesOverride =
    currentPlanValue === ACP_COLLABORATION_MODE_PLAN_VALUE && nonPlanConfigValue
      ? {
          ...configOptionValues,
          [planConfigId]: nonPlanConfigValue,
        }
      : configOptionValues;

  return { modeIdOverride, configOptionValuesOverride };
}
