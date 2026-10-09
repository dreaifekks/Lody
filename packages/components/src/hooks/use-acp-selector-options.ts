import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  buildAcpSelectorOptions,
  type AcpSelectorOptions,
  type AcpSelectorTarget,
} from '@/components/shared/acp-selector-options';
import { localizeBuiltinGrokSelectorOptions } from '@/lib/grok-acp-selector-i18n';

/** `useAcpSelectorOptions` outside a hook, for a surface that resolves several targets. */
export function resolveAcpSelectorOptions(
  target: AcpSelectorTarget | undefined,
  t: TFunction
): AcpSelectorOptions {
  const options = buildAcpSelectorOptions(target);
  return target?.cliType === 'builtin' && target.agentType?.toLowerCase() === 'grok'
    ? localizeBuiltinGrokSelectorOptions(options, t)
    : options;
}

/**
 * Hook that builds ACP selector options for the given target.
 *
 * Mode/model names and descriptions are taken verbatim from agent-reported
 * capabilities. The Lody-owned builtin Grok compatibility options are localized
 * because those strings are synthesized by Lody rather than authored upstream.
 */
export function useAcpSelectorOptions(target?: AcpSelectorTarget): AcpSelectorOptions {
  const { t } = useTranslation();
  const targetConfigId = target?.configId;
  const targetCliType = target?.cliType;
  const targetAgentType = target?.agentType;
  const targetSelectedModeId = target?.selectedModeId;
  const targetSelectedModelId = target?.selectedModelId;
  const targetConfigOptionValues = target?.configOptionValues;
  const targetRuntimeOverrides = target?.runtimeOverrides;
  const targetMachine = target?.machine;

  return useMemo(() => {
    return resolveAcpSelectorOptions(
      targetCliType && targetAgentType
        ? {
            configId: targetConfigId,
            cliType: targetCliType,
            agentType: targetAgentType,
            selectedModeId: targetSelectedModeId,
            selectedModelId: targetSelectedModelId,
            configOptionValues: targetConfigOptionValues,
            runtimeOverrides: targetRuntimeOverrides,
            machine: targetMachine,
          }
        : undefined,
      t
    );
  }, [
    targetConfigId,
    targetMachine,
    targetAgentType,
    targetCliType,
    targetConfigOptionValues,
    targetRuntimeOverrides,
    targetSelectedModeId,
    targetSelectedModelId,
    t,
  ]);
}
