import { useAtom, useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { Switch } from '@lody/ui/switch';
import {
  experimentalFeaturesEnabledAtom,
  reviewAgentExperimentEnabledAtom,
  voiceExperimentEnabledAtom,
} from '@/atoms/settings';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import { toast } from '@/lib/toast';
import { writeWorkspacePromptSuggestionsSetting } from '@/lib/workspace-catalog-write';
import { CompactRow, CompactSection } from './compact-layout';
import { VoiceAgentRows } from './voice-agent-select';

/**
 * User-facing experimental features.
 *
 * Unlike the Developer-mode beta section, the master switch is always visible:
 * a feature nobody can find is a feature nobody evaluates. Turning the master
 * switch off hides the list but keeps each opt-in, so flipping it back on
 * restores the previous choices rather than silently resetting them.
 */
export function ExperimentalFeaturesSection() {
  const { t } = useTranslation();
  return (
    <CompactSection title={t('settings.experimental.title', 'Experimental features')}>
      <ExperimentalFeatureRows />
    </CompactSection>
  );
}

/** The master switch and, while it is on, each feature's own switch. */
export function ExperimentalFeatureRows() {
  const { t } = useTranslation();
  const [experimentalEnabled, setExperimentalEnabled] = useAtom(experimentalFeaturesEnabledAtom);
  const [reviewAgentEnabled, setReviewAgentEnabled] = useAtom(reviewAgentExperimentEnabledAtom);
  const [voiceEnabled, setVoiceEnabled] = useAtom(voiceExperimentEnabledAtom);

  return (
    <>
      <CompactRow label={t('settings.experimental.enable', 'Enable experimental features')}>
        <Switch
          checked={experimentalEnabled}
          onCheckedChange={setExperimentalEnabled}
          aria-label={t('settings.experimental.enable', 'Enable experimental features')}
        />
      </CompactRow>

      {experimentalEnabled ? (
        <>
          <CompactRow
            label={t('settings.experimental.reviewAgent', 'Review agent')}
            helper={t(
              'settings.experimental.reviewAgentHelper',
              'Let a review agent check a branch, hand fixes back to the session, and merge once CI is green. You choose per session.'
            )}
          >
            <Switch
              checked={reviewAgentEnabled}
              onCheckedChange={setReviewAgentEnabled}
              aria-label={t('settings.experimental.reviewAgent', 'Review agent')}
            />
          </CompactRow>
          <CompactRow
            label={t('settings.experimental.voice', 'Voice')}
            helper={t(
              'settings.experimental.voiceHelper',
              'Dictate into the composer, or talk with a session out loud. Runs on the Codex agent you choose and uses its account.'
            )}
          >
            <Switch
              checked={voiceEnabled}
              onCheckedChange={setVoiceEnabled}
              aria-label={t('settings.experimental.voice', 'Voice')}
            />
          </CompactRow>
          {voiceEnabled ? <VoiceAgentRows /> : null}
          <PromptSuggestionsRow />
        </>
      ) : null}
    </>
  );
}

/**
 * Claude's guess at the next message, shown in the empty composer.
 *
 * Workspace-wide rather than per device: the machine running a session asks
 * Claude for guesses when Claude starts, whichever device sent the message.
 */
function PromptSuggestionsRow() {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const { promptSuggestions } = useWorkspaceCatalog();
  const label = t('settings.experimental.promptSuggestions', 'Next message suggestions');

  const change = (enabled: boolean) => {
    if (!runtime) return;
    void writeWorkspacePromptSuggestionsSetting(runtime, enabled).catch((error: unknown) => {
      toast.error(
        t(
          'settings.experimental.promptSuggestionsSaveFailed',
          'Could not save next message suggestions'
        ),
        { description: error instanceof Error ? error.message : String(error) }
      );
    });
  };

  return (
    <CompactRow
      label={label}
      helper={t(
        'settings.experimental.promptSuggestionsHelper',
        'After each Claude reply, suggest what you might send next. Press Tab to use it. Applies to every device.'
      )}
    >
      <Switch
        checked={promptSuggestions}
        onCheckedChange={change}
        disabled={!runtime}
        aria-label={label}
      />
    </CompactRow>
  );
}

/** Whether any experimental feature row should render. */
export function useHasExperimentalFeatures(): boolean {
  return useAtomValue(experimentalFeaturesEnabledAtom);
}
