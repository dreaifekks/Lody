import type { SessionSendState } from '@/lib/session-send-status';
import { hiddenSessionHasUnread } from '@/lib/low-stimulus';
import {
  summarizeSidebarGroupActivity,
  withSessionSendStates,
  type SessionRowStatusFlags,
  type SidebarGroupActivity,
} from './sidebar-row-shared';

/**
 * What a folded family's root row draws: the root and its hidden Sessions
 * counted as a folded group counts its rows, so whatever happens under the
 * root shows on it: send failed, then waiting, working, sending, unread. In
 * low-stimulus mode (`rootReadThrough` given) a hidden Session's unread counts
 * only past how far the root is read (`hiddenSessionHasUnread`); its waiting,
 * work and sends count as they are, and the row draws that work still
 * (`useStillWorkingMark`).
 */
export function foldedFamilyActivity<
  Row extends SessionRowStatusFlags & { latestMessageAt: Date | number | string },
>(
  root: Row,
  hiddenChildren: readonly Row[],
  rootReadThrough: number | undefined,
  getSessionId: (row: Row) => string,
  sendStates: Readonly<Record<string, SessionSendState>>
): SidebarGroupActivity {
  const hidden =
    rootReadThrough === undefined
      ? hiddenChildren
      : hiddenChildren.map((child) => ({
          ...child,
          hasUnreadMessages: hiddenSessionHasUnread(
            child.hasUnreadMessages === true,
            new Date(child.latestMessageAt).getTime(),
            rootReadThrough
          ),
        }));
  return summarizeSidebarGroupActivity(
    withSessionSendStates([root, ...hidden], getSessionId, sendStates)
  );
}
