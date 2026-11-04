import type { SessionSendState } from '@/lib/session-send-status';
import { hiddenSessionHasUnread } from '@/lib/low-stimulus';
import {
  summarizeSidebarGroupActivity,
  withSessionSendStates,
  type SessionRowStatusFlags,
  type SidebarGroupActivity,
} from './sidebar-row-shared';

/**
 * What a folded family's root row draws in low-stimulus mode: the root and its
 * hidden Sessions counted as a folded group counts its rows, with each hidden
 * Session's unread state first narrowed by the root's last read.
 */
export function foldedFamilyActivity<
  Row extends SessionRowStatusFlags & { latestMessageAt: Date | number | string },
>(
  root: Row,
  hiddenChildren: readonly Row[],
  rootLastReadAt: number | undefined,
  getSessionId: (row: Row) => string,
  sendStates: Readonly<Record<string, SessionSendState>>
): SidebarGroupActivity {
  const narrowed = hiddenChildren.map((child) => ({
    ...child,
    hasUnreadMessages: hiddenSessionHasUnread(
      child.hasUnreadMessages === true,
      new Date(child.latestMessageAt).getTime(),
      rootLastReadAt
    ),
  }));
  return summarizeSidebarGroupActivity(
    withSessionSendStates([root, ...narrowed], getSessionId, sendStates)
  );
}
