import { useMemo } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Play, Square } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Select } from '@lody/ui/select';
import { Tooltip } from '@lody/ui/tooltip';
import { MACHINE_VOICE_SELECTION_UNSUPPORTED, machineSupportsGeminiVoice } from '@lody/shared';
import { getAllAgentConfigAtom } from '@/atoms';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { voiceAgentScopeAtom, voiceAgentSelectionAtom, voiceNameAtom } from '@/atoms/settings';
import {
  formatVoiceAgentSelection,
  parseVoiceAgentSelection,
  useVoiceAgentSelection,
} from '@/hooks/use-voice-agent-selection';
import { useVoiceList, useVoicePreview } from '@/hooks/use-voice-preview';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import {
  GEMINI_LIVE_DEFAULT_VOICE,
  GEMINI_LIVE_VOICES,
  geminiLiveVoice,
  geminiLiveVoiceLabel,
} from '@/lib/gemini-live-voices';
import type { VoicePreviewFailure } from '@/lib/voice-preview';
import { geminiVoicePreviewKey, voicePreviewClip } from '@/lib/voice-preview-clips';
import { writeWorkspaceVoiceSetting } from '@/lib/workspace-catalog-write';
import { toast } from '@/lib/toast';
import { CompactRow } from './compact-layout';

const styles = stylex.create({
  select: { width: { default: '100%', '@media (min-width: 640px)': '220px' } },
  voiceControl: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.25em',
    width: { default: '100%', '@media (min-width: 640px)': 'auto' },
  },
  voiceSelect: {
    flexGrow: 1,
    minWidth: 0,
    width: { default: 'auto', '@media (min-width: 640px)': '188px' },
  },
});

const NO_VOICES: readonly string[] = [];

/** Gemini voices as Settings stores them; the Live API gets the capitalized names. */
const GEMINI_VOICE_LIST = {
  voices: GEMINI_LIVE_VOICES.map((voice) => voice.name.toLowerCase()),
  defaultVoice: GEMINI_LIVE_DEFAULT_VOICE.name.toLowerCase(),
};

/** The select's value for "follow Codex's default voice"; no Codex voice name has capitals. */
const DEFAULT_VOICE = 'Default';

const voiceLabel = (voice: string) => voice.charAt(0).toUpperCase() + voice.slice(1);

type VoiceScope = 'shared' | 'device';

/**
 * What hosts voice: a built-in Codex agent (and so which account), or Gemini
 * Live with the machine that signs its tokens. Shared, every device of the
 * workspace follows one choice; otherwise this device keeps its own.
 */
export function VoiceAgentRows() {
  const { t } = useTranslation();
  const configs = useAtomValue(getAllAgentConfigAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const { machines } = useVisibleMachineMetas({ includeMachineFlock: false });
  const { voice: sharedVoice } = useWorkspaceCatalog();
  const [scope, setScope] = useAtom(voiceAgentScopeAtom);
  const setDeviceSelection = useSetAtom(voiceAgentSelectionAtom);
  const [, setDeviceVoice] = useAtom(voiceNameAtom);
  const current = useVoiceAgentSelection();

  const scopeOptions = useMemo(
    () => [
      { value: 'shared', label: t('settings.experimental.voiceScopeShared', 'All devices') },
      { value: 'device', label: t('settings.experimental.voiceScopeDevice', 'This device only') },
    ],
    [t]
  );

  const codexOptions = useMemo(
    () =>
      configs
        .filter((config) => config.cliType === 'builtin' && config.agentType === 'codex')
        .map((config) => {
          const machineName = machines.get(config.machineId)?.name;
          return {
            value: formatVoiceAgentSelection({
              provider: 'codex',
              configId: config.id,
              machineId: config.machineId,
            }),
            label: machineName ? `${config.name} · ${machineName}` : config.name,
          };
        }),
    [configs, machines]
  );
  // Any machine whose Lody signs Gemini tokens; it needs its own GEMINI_API_KEY to succeed.
  const geminiOptions = useMemo(
    () =>
      [...machines.values()]
        .filter((machine) => machineSupportsGeminiVoice(machine))
        .map((machine) => ({
          value: formatVoiceAgentSelection({ provider: 'gemini', machineId: machine.id }),
          label: t('settings.experimental.voiceGeminiOption', 'Gemini Live · {{machine}}', {
            machine: machine.name,
          }),
        })),
    [machines, t]
  );
  const agentOptions = useMemo(
    () => [...codexOptions, ...geminiOptions],
    [codexOptions, geminiOptions]
  );

  const selected = current ? formatVoiceAgentSelection(current) : null;

  const choose = (value: string) => {
    const next = parseVoiceAgentSelection(value);
    if (!next) return;
    // A voice belongs to its provider: switching provider returns to the default.
    const sameProvider = current?.provider === next.provider;
    if (scope === 'device') {
      setDeviceSelection(value);
      if (!sameProvider) setDeviceVoice(null);
      return;
    }
    if (!runtime) return;
    const voice = sameProvider && sharedVoice?.voice ? { voice: sharedVoice.voice } : {};
    void writeWorkspaceVoiceSetting(
      runtime,
      next.provider === 'gemini'
        ? { version: 1, provider: 'gemini', machineId: next.machineId, ...voice }
        : // The voice stays when the agent changes; one its Codex lacks falls back to the default.
          { version: 1, configId: next.configId, machineId: next.machineId, ...voice }
    ).catch((error: unknown) => {
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
            {t(
              'settings.experimental.voiceNoHost',
              'Add a Codex agent, or update Lody on a machine for Gemini Live'
            )}
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
                    'Choose a voice agent'
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
      {selected ? <VoiceNameRow /> : null}
    </>
  );
}

/**
 * Which voice calls speak in, kept where the agent choice is kept, and a
 * button that plays the selected voice's bundled sample.
 */
export function VoiceNameRow() {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const scope = useAtomValue(voiceAgentScopeAtom);
  const [, setDeviceVoice] = useAtom(voiceNameAtom);
  const { voice: sharedVoice } = useWorkspaceCatalog();
  const selection = useVoiceAgentSelection();
  const gemini = selection?.provider === 'gemini';
  const machineId = selection?.machineId;
  const configId = selection?.provider === 'codex' ? selection.configId : undefined;
  const agent = useMemo(
    () => (machineId && configId ? { machineId, configId } : null),
    [machineId, configId]
  );
  const codexList = useVoiceList(agent);
  // Gemini's voices are a fixed list; nothing to ask a machine for.
  const list = gemini ? ({ status: 'ready', list: GEMINI_VOICE_LIST } as const) : codexList;
  const preview = useVoicePreview({
    onError: (failure: VoicePreviewFailure, message: string) => {
      toast.error(t('settings.experimental.voicePreviewFailed', 'Could not play this voice'), {
        description:
          failure === 'call-active'
            ? t('settings.experimental.voicePreviewCallActive', 'End the voice call first.')
            : message,
      });
    },
  });

  const voices = list?.status === 'ready' ? list.list.voices : NO_VOICES;
  const defaultVoice = list?.status === 'ready' ? list.list.defaultVoice : null;
  // A stored voice this Codex no longer offers plays the default, so it shows as the default.
  const chosen = selection?.voice && voices.includes(selection.voice) ? selection.voice : null;
  const options = useMemo(
    () => [
      {
        value: DEFAULT_VOICE,
        label: gemini
          ? t('settings.experimental.voiceNameGeminiDefault', 'Gemini default ({{voice}})', {
              voice: geminiLiveVoiceLabel(GEMINI_LIVE_DEFAULT_VOICE),
            })
          : defaultVoice
            ? t('settings.experimental.voiceNameDefaultNamed', 'Codex default ({{voice}})', {
                voice: voiceLabel(defaultVoice),
              })
            : t('settings.experimental.voiceNameDefault', 'Codex default'),
      },
      ...voices.map((voice) => ({
        value: voice,
        label: gemini ? geminiLiveVoiceLabel(geminiLiveVoice(voice)) : voiceLabel(voice),
      })),
    ],
    [defaultVoice, gemini, voices, t]
  );

  const choose = (value: string) => {
    const voice = value === DEFAULT_VOICE ? null : value;
    if (scope === 'device') {
      setDeviceVoice(voice);
      return;
    }
    if (!runtime || !sharedVoice) return;
    const { voice: _previous, ...host } = sharedVoice;
    void writeWorkspaceVoiceSetting(runtime, { ...host, ...(voice ? { voice } : {}) }).catch(
      (error: unknown) => {
        toast.error(t('settings.experimental.voiceNameSaveFailed', 'Could not save the voice'), {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    );
  };

  const label = t('settings.experimental.voiceName', 'Speaking voice');
  if (list?.status === 'error') {
    return (
      <CompactRow label={label}>
        <span className="text-muted-foreground text-xs" title={list.error}>
          {list.error === MACHINE_VOICE_SELECTION_UNSUPPORTED
            ? t(
                'settings.experimental.voiceNameUnsupported',
                "Update Lody on the agent's machine to choose a voice"
              )
            : t('settings.experimental.voiceNameLoadFailed', 'Could not load the voices')}
        </span>
      </CompactRow>
    );
  }

  const voice = chosen ?? defaultVoice;
  // Samples are keyed by voice name; Gemini's carry a prefix, apart from Codex's.
  const target = voice !== null && gemini ? geminiVoicePreviewKey(voice) : voice;
  // A voice Codex added after this build has no sample; it can still be chosen.
  const hasSample = target !== null && voicePreviewClip(target) !== null;
  const previewing = preview.state.status !== 'idle' && preview.state.voice === target;
  const previewLabel = previewing
    ? t('settings.experimental.voicePreviewStop', 'Stop')
    : target !== null && !hasSample
      ? t('settings.experimental.voicePreviewNoSample', 'No sample of this voice yet')
      : preview.callActive
        ? t('settings.experimental.voicePreviewCallActive', 'End the voice call first.')
        : t('settings.experimental.voicePreview', 'Hear this voice');
  return (
    <CompactRow label={label}>
      <div {...stylex.props(styles.voiceControl)}>
        <Select.Root
          items={options}
          value={list?.status === 'ready' ? (chosen ?? DEFAULT_VOICE) : null}
          disabled={list?.status !== 'ready'}
          onValueChange={(value) => {
            if (typeof value === 'string') choose(value);
          }}
        >
          <div {...stylex.props(styles.voiceSelect)}>
            <Select.Trigger>
              <Select.Value
                placeholder={t('settings.experimental.voiceNameLoading', 'Loading voices…')}
              />
            </Select.Trigger>
          </div>
          <Select.Content>
            {options.map((option) => (
              <Select.Item key={option.value} value={option.value}>
                {option.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        <Tooltip.Root>
          <Tooltip.Trigger
            render={
              <Button
                type="button"
                icon
                variant="ghost"
                size="small"
                aria-label={previewLabel}
                aria-pressed={previewing}
                disabled={!hasSample || (preview.callActive && !previewing)}
                onClick={() => {
                  if (previewing) preview.stop();
                  else if (target) preview.play(target);
                }}
              >
                {previewing ? <Square /> : <Play />}
              </Button>
            }
          />
          <Tooltip.Content side="top">{previewLabel}</Tooltip.Content>
        </Tooltip.Root>
      </div>
    </CompactRow>
  );
}
