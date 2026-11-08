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
 * Whether a hidden family member still asks to be read: its own unread state,
 * further limited to output newer than the user's last read of the root. A thread
 * reports its children's conclusions, so reading it covers what came before.
 */
export function hiddenSessionHasUnread(
  hasUnread: boolean,
  latestMessageAtMs: number,
  rootLastReadAt: number | undefined
): boolean {
  return hasUnread && latestMessageAtMs > (rootLastReadAt ?? -Infinity);
}
