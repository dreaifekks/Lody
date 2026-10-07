import { useEffect, useRef } from 'react';
import { atom, useAtomValue, useSetAtom } from 'jotai';
import { getCurrentPromptSuggestion, type SessionMeta } from '@lody/shared';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';

/**
 * Guesses this device already let go of, by session: typed over or left
 * behind. Kept for the app's lifetime so returning to a session does not bring
 * one back; a new turn brings a new guess.
 */
const dismissedPromptSuggestionsAtom = atom<Readonly<Record<string, string>>>({});

/**
 * Claude's guess at the next message for this session's composer, or null.
 *
 * The machine writes the guess into session meta after a turn and clears it
 * when the next one starts, so every device of the workspace sees the same one.
 */
export function useSessionPromptSuggestion(
  session: SessionMeta,
  { inputEmpty, agentBusy }: { inputEmpty: boolean; agentBusy: boolean }
): string | null {
  const { promptSuggestions } = useWorkspaceCatalog();
  const dismissed = useAtomValue(dismissedPromptSuggestionsAtom);
  const setDismissed = useSetAtom(dismissedPromptSuggestionsAtom);

  const current =
    promptSuggestions && session.agentType === 'claude' && !agentBusy
      ? (getCurrentPromptSuggestion(session) ?? null)
      : null;
  const offered = current !== null && dismissed[session.id] !== current ? current : null;

  const dismiss = useRef((sessionId: string, text: string) => {
    setDismissed((previous) =>
      previous[sessionId] === text ? previous : { ...previous, [sessionId]: text }
    );
  }).current;

  // Typing anything lets the guess go, including when the text is cleared again.
  useEffect(() => {
    if (offered !== null && !inputEmpty) dismiss(session.id, offered);
  }, [dismiss, inputEmpty, offered, session.id]);

  // Leaving the session lets it go too. The composer switches sessions in place,
  // so this runs on a session change as well as on unmount. The ref is set in
  // an effect, so the cleanup still sees what the previous commit offered.
  const shown = useRef<{ sessionId: string; text: string } | null>(null);
  useEffect(() => {
    shown.current = offered === null ? null : { sessionId: session.id, text: offered };
  }, [offered, session.id]);
  useEffect(() => {
    const sessionId = session.id;
    return () => {
      const last = shown.current;
      if (last?.sessionId === sessionId) dismiss(sessionId, last.text);
    };
  }, [dismiss, session.id]);

  return offered;
}
