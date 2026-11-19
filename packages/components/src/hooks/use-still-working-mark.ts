import { atom, useAtomValue } from 'jotai';
import { atomFamily } from 'jotai/utils';
import { useState } from 'react';
import type { SessionId } from '@lody/shared';
import { sessionLiveStatusAtomFamily } from '@/atoms/presence';
import { lowStimulusModeEnabledAtom } from '@/atoms/settings';

/** Whether a Session itself runs, as a boolean so a mark re-renders only when it flips. */
const sessionRunsAtomFamily = atomFamily((sessionId: SessionId) =>
  atom((get) => get(sessionLiveStatusAtomFamily(sessionId)) !== null)
);
const NEVER_RUNS = atom(false);

/**
 * Low-stimulus mode: whether a row's working mark stands still. A row moves only
 * while its own Session runs; the work it shows for what sits under it (hidden
 * family members, Tabs, a Board's threads) is drawn still, so a folded family
 * says it is busy without moving. `working` is the row's current work, before
 * any hand-over hold: the style is settled while the row works and kept through
 * the hold, so a finishing mark never changes style on its way out. A row
 * without a Session id keeps its moving mark.
 */
export function useStillWorkingMark(sessionId: string | undefined, working: boolean): boolean {
  const lowStimulusMode = useAtomValue(lowStimulusModeEnabledAtom);
  const runs = useAtomValue(
    lowStimulusMode && sessionId ? sessionRunsAtomFamily(sessionId as SessionId) : NEVER_RUNS
  );
  const stillNow = lowStimulusMode && Boolean(sessionId) && !runs;
  const [still, setStill] = useState(stillNow);
  if (working && still !== stillNow) setStill(stillNow);
  return still;
}
