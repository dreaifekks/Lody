import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { atom, useAtomValue } from 'jotai';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { getMachineFlockLocalProjects, getSessionRoomId, type SessionId } from '@lody/shared';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import {
  sessionLiveStatusAtomFamily,
  machineOnlineStatusAtomFamily,
  lodyPresenceSyncStateAtom,
} from '@/atoms/presence';
import { useMachineFlockRowsByMachineIds } from '@/hooks/use-machine-flock-rows';
import {
  useVisibleSessionMetas,
  useVisibleArchivedSessionMetas,
} from '@/hooks/use-visible-session-metas';
import { sessionHasUnreadMessages } from '@/lib/session-read-receipt';
import type { SessionNavigationTarget } from '@/lib/session-navigation';
import { styles as taskStyles } from '../ai-gui/subagent-task-panel.stylex';
import { useSessionDetail } from './board-side-panel';
import { boardThreadFamilies, BoardThreadStatusMark } from './board-thread-list';
import { boardThreadStatus, buildBoardRows } from './board-threads';

const styles = stylex.create({
  root: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 },
  title: {
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.label,
    textAlign: 'start',
    fontWeight: 400,
  },
  detail: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.tertiaryLabel,
    textAlign: 'start',
  },
});

/**
 * A thread the Board's main session assigned, as it is now rather than as its
 * creation went: the Board panel row's mark (✋, working, unread), its title and
 * where it runs. No reply text: the thread tells the user itself.
 */
export function BoardThreadStatusCard({
  sessionId,
  fallbackTitle,
  onNavigateSession,
}: {
  sessionId: SessionId;
  fallbackTitle?: string;
  onNavigateSession?: (target: SessionNavigationTarget) => void;
}) {
  const { t } = useTranslation();
  const session = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(sessionId)));
  const { allActiveSessions } = useVisibleSessionMetas();
  const { archivedSessions } = useVisibleArchivedSessionMetas();
  const rows = useMemo(
    () =>
      buildBoardRows(
        (session?.isArchived ? archivedSessions : allActiveSessions).filter(
          (member) => member.boardId === session?.boardId && member.boardRole !== 'coordinator'
        )
      ),
    [allActiveSessions, archivedSessions, session?.boardId, session?.isArchived]
  );
  const familyAtom = useMemo(
    () =>
      atom((get) => {
        const families = boardThreadFamilies(
          rows.map(({ session: member, depth }) => ({
            session: member,
            depth,
            archived: member.isArchived,
            status: boardThreadStatus(member, get(sessionLiveStatusAtomFamily(member.id)), (id) =>
              get(sessionMetaAtomFamily(getSessionRoomId(id)))
            ),
          }))
        );
        const family = families.find(({ items }) =>
          items.some(({ session: member }) => member.id === sessionId)
        );
        if (!family) return null;
        return {
          status: family.status,
          unread: family.items.some(({ session: member }) => sessionHasUnreadMessages(member)),
          completed:
            get(lodyPresenceSyncStateAtom) === 'synced' &&
            family.items.every(
              ({ session: member, status }) =>
                status === 'idle' &&
                get(machineOnlineStatusAtomFamily(member.machineId)) === 'online'
            ),
        };
      }),
    [rows, sessionId]
  );
  const family = useAtomValue(familyAtom);
  const machineRows = useMachineFlockRowsByMachineIds(session ? [session.machineId] : [], {
    families: ['localProject'],
  });
  const detail = useSessionDetail();
  const title =
    session?.title?.trim() || fallbackTitle?.trim() || t('sessions.untitled', 'Untitled session');
  const localRows = session ? machineRows.get(session.machineId) : undefined;
  const where = session
    ? detail(session, localRows ? getMachineFlockLocalProjects(localRows) : undefined)
    : undefined;
  return (
    <div data-board-thread-card={sessionId} {...stylex.props(styles.root)}>
      <Button
        variant="ghost"
        size="small"
        disabled={!onNavigateSession}
        title={where ? `${title} · ${where}` : title}
        aria-label={`${t('sessions.openedBy.viewSession', 'View session')}: ${title}`}
        onClick={onNavigateSession ? () => onNavigateSession({ sessionId }) : undefined}
      >
        <span {...stylex.props(taskStyles.line)}>
          <span {...stylex.props(styles.title)}>{title}</span>
          {where ? <span {...stylex.props(styles.detail)}>· {where}</span> : null}
          <span aria-hidden="true" {...stylex.props(taskStyles.mark)}>
            {session && family ? (
              <BoardThreadStatusMark
                status={family.status}
                unread={family.unread}
                completed={
                  family.completed &&
                  session.lastMessageAt !== undefined &&
                  !sessionHasUnreadMessages(session)
                }
              />
            ) : null}
          </span>
        </span>
      </Button>
    </div>
  );
}
