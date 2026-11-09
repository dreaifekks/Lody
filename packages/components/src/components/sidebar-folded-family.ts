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
 * hidden Sessions counted as a folded group counts its rows. The root counts as
 * its own row would. A hidden Session's work is the root's to report, so it
 * draws no working mark, and its unread counts only once it stops and only past
 * how far the root is read (`hiddenSessionHasUnread`); its waiting and its
 * local sends count as they are.
 */
export function foldedFamilyActivity<
  Row extends SessionRowStatusFlags & { latestMessageAt: Date | number | string },
>(
  root: Row,
  hiddenChildren: readonly Row[],
  rootReadThrough: number,
  getSessionId: (row: Row) => string,
  sendStates: Readonly<Record<string, SessionSendState>>
): SidebarGroupActivity {
  const narrowed = hiddenChildren.map((child) => ({
    ...child,
    isWorking: false,
    hasUnreadMessages: hiddenSessionHasUnread(
      {
        unread: child.hasUnreadMessages === true,
        working: child.isWorking === true,
        latestMessageAt: new Date(child.latestMessageAt).getTime(),
      },
      rootReadThrough
    ),
  }));
  return summarizeSidebarGroupActivity(
    withSessionSendStates([root, ...narrowed], getSessionId, sendStates)
  );
}
