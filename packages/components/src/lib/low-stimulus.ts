import type { SessionMeta } from '@lody/shared';
import { sessionHasUnreadMessages } from '@/lib/session-read-receipt';

/**
 * Rules of low-stimulus mode (`lowStimulusModeEnabledAtom`): one session family,
 * one row, one mark. Display only: nothing here writes a read receipt, so turning
 * the mode off restores the upstream marks exactly.
 */

/**
 * Whether an opener's opened Sessions are hidden. Without the mode a record of
 * `true` folds them. With it they start folded and `false` is the user's unfold.
 */
export function isOpenerCollapsed(
  lowStimulusMode: boolean,
  record: Readonly<Record<string, boolean>> | undefined,
  openerId: string
): boolean {
  return lowStimulusMode ? record?.[openerId] !== false : record?.[openerId] === true;
}

/**
 * How far the user has read a family's root: its read receipt, or the last time
 * its conversation was on this screen, whichever is later. The receipt alone is
 * not the time of reading. It holds the root's own last message time, so opening
 * a root that has said nothing since would cover nothing its family did after.
 */
export function familyReadThrough(
  rootLastReadAt: number | undefined,
  rootSeenAt: number | undefined
): number {
  return Math.max(rootLastReadAt ?? -Infinity, rootSeenAt ?? -Infinity);
}

/**
 * Whether a hidden family member still asks to be read: its own unread state,
 * further limited to output newer than the user's last read of the root
 * (`familyReadThrough`). A thread reports its children's conclusions, so reading
 * it covers what came before.
 */
export function hiddenSessionHasUnread(
  hasUnread: boolean,
  latestMessageAtMs: number,
  rootReadThrough: number
): boolean {
  return hasUnread && latestMessageAtMs > rootReadThrough;
}

/**
 * What a child Tab adds to its parent's row and to its own Tab. A Tab an agent
 * opened (`openedBySessionId`) is part of the parent's family: given how far the
 * parent is read, it counts as a hidden member does, so its work draws nothing
 * and its unread counts only past that read. Its messages also raise the
 * parent's own `lastMessageAt` (the CLI does this for every Tab), so the parent's
 * row shows them until the parent is read. Without a read-through (the mode is
 * off), and for a Tab the user opened, the Tab counts as it always did.
 */
export function childTabActivity(
  child: Pick<
    SessionMeta,
    'openedBySessionId' | 'lastMessageAt' | 'lastReadAt' | 'isTabClosed' | 'isArchived'
  >,
  working: boolean,
  parentReadThrough: number | undefined
): { working: boolean; unread: boolean } {
  const unread = sessionHasUnreadMessages(child);
  if (parentReadThrough === undefined || child.openedBySessionId === undefined) {
    return { working, unread };
  }
  return {
    working: false,
    unread: hiddenSessionHasUnread(unread, child.lastMessageAt ?? 0, parentReadThrough),
  };
}
