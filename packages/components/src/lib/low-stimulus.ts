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

/** A hidden family member's own state, as the rules below read it. */
export type HiddenMember = {
  /** Its own unread output, by its own read receipt. */
  unread: boolean;
  /** Its agent is at work. */
  working: boolean;
  /** Its last message, in ms. */
  latestMessageAt: number;
};

/**
 * Whether a hidden family member still asks to be read. A thread reports its
 * children's work, so the member is the root's to announce: while it works it
 * asks for nothing, and once it stops only output newer than the user's last
 * read of the root counts (`familyReadThrough`). Waiting and failed sends are
 * not unread; callers count them for every member.
 */
export function hiddenSessionHasUnread(member: HiddenMember, rootReadThrough: number): boolean {
  return member.unread && !member.working && member.latestMessageAt > rootReadThrough;
}

/**
 * What a child Tab adds to its parent's row and to its own Tab. A Tab an agent
 * opened (`openedBySessionId`) is part of the parent's family: given how far the
 * parent is read, it counts as a hidden member does, so its work draws nothing
 * and its unread counts only past that read. Without it (the mode is off), and
 * for a Tab the user opened, the Tab counts as it always did.
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
  const member = { unread, working, latestMessageAt: child.lastMessageAt ?? 0 };
  return { working: false, unread: hiddenSessionHasUnread(member, parentReadThrough) };
}
