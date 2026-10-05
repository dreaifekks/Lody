import { useAtom, useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { Switch } from '@lody/ui/switch';
import {
  experimentalFeaturesEnabledAtom,
  reviewAgentExperimentEnabledAtom,
  voiceExperimentEnabledAtom,
} from '@/atoms/settings';
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
        </>
      ) : null}
    </>
  );
}

/** Whether any experimental feature row should render. */
export function useHasExperimentalFeatures(): boolean {
  return useAtomValue(experimentalFeaturesEnabledAtom);
}
