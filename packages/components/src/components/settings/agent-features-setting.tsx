import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { Switch } from '@lody/ui/switch';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import { writeWorkspacePromptSuggestionsSetting } from '@/lib/workspace-catalog-write';
import { CompactRow, CompactSection } from './compact-layout';

/** Agent features that graduated from Experimental features. */
export function AgentFeaturesSection() {
  const { t } = useTranslation();
  return (
    <CompactSection title={t('settings.agentFeatures.title', 'Agent features')}>
      <PromptSuggestionsRow />
    </CompactSection>
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
  const label = t('settings.agentFeatures.promptSuggestions', 'Next message suggestions');

  const change = (enabled: boolean) => {
    if (!runtime) return;
    void writeWorkspacePromptSuggestionsSetting(runtime, enabled).catch((error: unknown) => {
      toast.error(
        t(
          'settings.agentFeatures.promptSuggestionsSaveFailed',
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
        'settings.agentFeatures.promptSuggestionsHelper',
        'Claude only. After each reply, suggest what you might send next; press Tab to use it. Applies to every device.'
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
