import { getServerNow } from '@lody/shared';
import { useAtomValue, useSetAtom } from 'jotai';
import { useEffect } from 'react';
import { setConversationOnScreenAtom } from '@/atoms/low-stimulus-seen';
import { lowStimulusModeEnabledAtom } from '@/atoms/settings';

/**
 * Low-stimulus mode: records that a conversation is on this screen, which is what
 * a folded family reads its root against (`familyReadThroughAtom`). The caller
 * passes the same visibility its read receipt requires.
 */
export function useLowStimulusConversationSeen(sessionId: string, onScreen: boolean): void {
  const enabled = useAtomValue(lowStimulusModeEnabledAtom);
  const setOnScreen = useSetAtom(setConversationOnScreenAtom);
  useEffect(() => {
    if (!enabled || !onScreen) return;
    setOnScreen(sessionId, true, getServerNow());
    return () => setOnScreen(sessionId, false, getServerNow());
  }, [enabled, onScreen, sessionId, setOnScreen]);
}
