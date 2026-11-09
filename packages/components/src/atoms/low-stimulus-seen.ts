import { atom } from 'jotai';
import { atomWithStorage, createJSONStorage } from 'jotai/utils';
import { familyReadThrough } from '@/lib/low-stimulus';

/** Conversations this device remembers seeing; an older root falls back to its read receipt. */
const SEEN_LIMIT = 200;

const seenAtStorage = createJSONStorage<Record<string, number>>();

/**
 * When this device last had each conversation on screen, in server time. Device
 * state like the mode itself: nothing is written to a session, and turning the
 * mode off leaves every upstream mark as it was.
 */
const conversationSeenAtAtom = atomWithStorage<Record<string, number>>(
  'lody-low-stimulus-seen-at',
  {},
  {
    ...seenAtStorage,
    setItem: (key, seenAt) => {
      try {
        seenAtStorage.setItem(key, seenAt);
      } catch {
        // The write runs as a conversation mounts: a full storage must not fail it.
      }
    },
  },
  { getOnInit: true }
);

/** Conversations on screen right now. Never stored: after a restart none is. */
const conversationsOnScreenAtom = atom<ReadonlySet<string>>(new Set<string>());

function rememberSeen(
  seenAt: Readonly<Record<string, number>>,
  sessionId: string,
  now: number
): Record<string, number> {
  const entries = Object.entries({ ...seenAt, [sessionId]: now });
  return Object.fromEntries(
    entries.length > SEEN_LIMIT
      ? entries.sort((left, right) => right[1] - left[1]).slice(0, SEEN_LIMIT)
      : entries
  );
}

/**
 * A conversation came on screen or left it at `now`. Both moments are kept, so a
 * restart while it was showing still remembers that it was seen.
 */
export const setConversationOnScreenAtom = atom(
  null,
  (_get, set, sessionId: string, onScreen: boolean, now: number) => {
    set(conversationsOnScreenAtom, (current) => {
      const next = new Set(current);
      if (onScreen) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
    set(conversationSeenAtAtom, (seenAt) => rememberSeen(seenAt, sessionId, now));
  }
);

/**
 * `(rootId, rootLastReadAt) =>` how far this device's user has read that root
 * (`familyReadThrough`). A root on screen is being read now, so nothing its
 * family does meanwhile counts as unread.
 */
export const familyReadThroughAtom = atom((get) => {
  const seenAt = get(conversationSeenAtAtom);
  const onScreen = get(conversationsOnScreenAtom);
  return (rootId: string, rootLastReadAt: number | undefined): number =>
    familyReadThrough(rootLastReadAt, onScreen.has(rootId) ? Infinity : seenAt[rootId]);
});
