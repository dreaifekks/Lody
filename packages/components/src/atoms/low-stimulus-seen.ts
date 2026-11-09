import { atom } from 'jotai';
import { createJSONStorage } from 'jotai/utils';
import { familyReadThrough } from '@/lib/low-stimulus';

type SeenAt = Readonly<Record<string, number>>;

const SEEN_AT_KEY = 'lody-low-stimulus-seen-at';

/** Conversations this device remembers seeing; an older root falls back to its read receipt. */
const SEEN_LIMIT = 200;

const seenAtStorage = createJSONStorage<SeenAt>();

const readStoredSeenAt = (): SeenAt => seenAtStorage.getItem(SEEN_AT_KEY, {});

/**
 * Several tables as one: each conversation at its latest time, the newest
 * `SEEN_LIMIT` kept. The windows of a device store the whole table under one
 * key, so a table is only ever merged with another, never put in its place.
 */
function mergeSeenAt(...tables: readonly SeenAt[]): SeenAt {
  const merged: Record<string, number> = {};
  for (const table of tables) {
    for (const [sessionId, at] of Object.entries(table)) {
      if (at > (merged[sessionId] ?? -Infinity)) merged[sessionId] = at;
    }
  }
  const entries = Object.entries(merged);
  return entries.length > SEEN_LIMIT
    ? Object.fromEntries(entries.sort((left, right) => right[1] - left[1]).slice(0, SEEN_LIMIT))
    : merged;
}

/**
 * When this device last had each conversation on screen, in server time. Device
 * state like the mode itself: nothing is written to a session, and turning the
 * mode off leaves every upstream mark as it was. This is one window's copy; it
 * takes in what the device's other windows store.
 */
const conversationSeenAtAtom = atom<SeenAt>(readStoredSeenAt());
conversationSeenAtAtom.onMount = (setSeenAt) => {
  const takeIn = (stored: SeenAt) => setSeenAt((seenAt) => mergeSeenAt(seenAt, stored));
  takeIn(readStoredSeenAt());
  return seenAtStorage.subscribe?.(SEEN_AT_KEY, takeIn, {});
};

/** Conversations on screen right now. Never stored: after a restart none is. */
const conversationsOnScreenAtom = atom<ReadonlySet<string>>(new Set<string>());

/**
 * A conversation came on screen or left it at `now`. Both moments are kept, so a
 * restart while it was showing still remembers that it was seen.
 */
export const setConversationOnScreenAtom = atom(
  null,
  (get, set, sessionId: string, onScreen: boolean, now: number) => {
    set(conversationsOnScreenAtom, (current) => {
      const next = new Set(current);
      if (onScreen) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
    // From what is stored as well: another window may have written since this one last heard.
    const seenAt = mergeSeenAt(readStoredSeenAt(), get(conversationSeenAtAtom), {
      [sessionId]: now,
    });
    set(conversationSeenAtAtom, seenAt);
    try {
      seenAtStorage.setItem(SEEN_AT_KEY, seenAt);
    } catch {
      // The write runs as a conversation mounts: a full storage must not fail it.
    }
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
