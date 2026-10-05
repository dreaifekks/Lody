import { useMemo } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Select } from '@lody/ui/select';
import type { AgentConfigId, MachineId } from '@lody/shared';
import { getAllAgentConfigAtom } from '@/atoms';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { voiceAgentScopeAtom, voiceAgentSelectionAtom } from '@/atoms/settings';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import { writeWorkspaceVoiceSetting } from '@/lib/workspace-catalog-write';
import { toast } from '@/lib/toast';
import { CompactRow } from './compact-layout';

const styles = stylex.create({
  select: { width: { default: '100%', '@media (min-width: 640px)': '220px' } },
});

type VoiceScope = 'shared' | 'device';

/**
 * Which built-in Codex agent (and so which account) hosts voice. Shared, every
 * device of the workspace follows one choice; otherwise this device keeps its own.
 */
export function VoiceAgentRows() {
  const { t } = useTranslation();
  const configs = useAtomValue(getAllAgentConfigAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const { machines } = useVisibleMachineMetas({ includeMachineFlock: false });
  const { voice: sharedVoice } = useWorkspaceCatalog();
  const [scope, setScope] = useAtom(voiceAgentScopeAtom);
  const [deviceSelection, setDeviceSelection] = useAtom(voiceAgentSelectionAtom);

  const scopeOptions = useMemo(
    () => [
      { value: 'shared', label: t('settings.experimental.voiceScopeShared', 'All devices') },
      { value: 'device', label: t('settings.experimental.voiceScopeDevice', 'This device only') },
    ],
    [t]
  );

  const agentOptions = useMemo(
    () =>
      configs
        .filter((config) => config.cliType === 'builtin' && config.agentType === 'codex')
        .map((config) => {
          const machineName = machines.get(config.machineId)?.name;
          return {
            value: `${config.id}:${config.machineId}`,
            label: machineName ? `${config.name} · ${machineName}` : config.name,
          };
        }),
    [configs, machines]
  );

  const selected =
    scope === 'shared'
      ? sharedVoice
        ? `${sharedVoice.configId}:${sharedVoice.machineId}`
        : null
      : deviceSelection;

  const choose = (value: string) => {
    if (scope === 'device') {
      setDeviceSelection(value);
      return;
    }
    if (!runtime) return;
    const separator = value.indexOf(':');
    void writeWorkspaceVoiceSetting(runtime, {
      version: 1,
      configId: value.slice(0, separator) as AgentConfigId,
      machineId: value.slice(separator + 1) as MachineId,
    }).catch((error: unknown) => {
      toast.error(
        t('settings.experimental.voiceAgentSaveFailed', 'Could not save the voice agent'),
        {
          description: error instanceof Error ? error.message : String(error),
        }
      );
    });
  };

  return (
    <>
      <CompactRow
        label={t('settings.experimental.voiceScope', 'Voice agent for')}
        helper={
          scope === 'shared'
            ? t(
                'settings.experimental.voiceScopeSharedHelper',
                'Every device uses this agent; audio still goes straight from each device.'
              )
            : undefined
        }
      >
        <Select.Root
          items={scopeOptions}
          value={scope}
          onValueChange={(value) => {
            if (value === 'shared' || value === 'device') setScope(value satisfies VoiceScope);
          }}
        >
          <div {...stylex.props(styles.select)}>
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
          </div>
          <Select.Content>
            {scopeOptions.map((option) => (
              <Select.Item key={option.value} value={option.value}>
                {option.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </CompactRow>
      <CompactRow label={t('settings.experimental.voiceAgent', 'Voice agent')}>
        {agentOptions.length === 0 ? (
          <span className="text-muted-foreground text-xs">
            {t('settings.experimental.voiceNoCodex', 'Add a Codex agent first')}
          </span>
        ) : (
          <Select.Root
            items={agentOptions}
            value={agentOptions.some((option) => option.value === selected) ? selected : null}
            onValueChange={(value) => {
              if (typeof value === 'string') choose(value);
            }}
          >
            <div {...stylex.props(styles.select)}>
              <Select.Trigger>
                <Select.Value
                  placeholder={t(
                    'settings.experimental.voiceAgentPlaceholder',
                    'Choose a Codex agent'
                  )}
                />
              </Select.Trigger>
            </div>
            <Select.Content>
              {agentOptions.map((option) => (
                <Select.Item key={option.value} value={option.value}>
                  {option.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        )}
      </CompactRow>
    </>
  );
}
