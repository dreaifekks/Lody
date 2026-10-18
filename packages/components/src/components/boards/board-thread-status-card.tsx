import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import {
  deriveBoardSessionStatus,
  getMachineFlockLocalProjects,
  getSessionRoomId,
  type SessionId,
} from '@lody/shared';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import {
  sessionLiveStatusAtomFamily,
  machineOnlineStatusAtomFamily,
  lodyPresenceSyncStateAtom,
} from '@/atoms/presence';
import { useMachineFlockRowsByMachineIds } from '@/hooks/use-machine-flock-rows';
import { sessionHasUnreadMessages } from '@/lib/session-read-receipt';
import type { SessionNavigationTarget } from '@/lib/session-navigation';
import { styles as taskStyles } from '../ai-gui/subagent-task-panel.stylex';
import { useSessionDetail } from './board-side-panel';
import { BoardThreadStatusMark } from './board-thread-list';

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
  successfulTurnId,
  onNavigateSession,
}: {
  sessionId: SessionId;
  fallbackTitle?: string;
  /** Explicit successful create-Operation result, bound to its exact user turn. */
  successfulTurnId?: string;
  onNavigateSession?: (target: SessionNavigationTarget) => void;
}) {
  const { t } = useTranslation();
  const session = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(sessionId)));
  const live = useAtomValue(sessionLiveStatusAtomFamily(sessionId));
  const machineStatus = useAtomValue(machineOnlineStatusAtomFamily(session?.machineId));
  const presenceSynced = useAtomValue(lodyPresenceSyncStateAtom) === 'synced';
  const completed = Boolean(
    successfulTurnId &&
    successfulTurnId === session?.latestUserMsgId &&
    successfulTurnId === session.lastHandledUserMsgId &&
    !session.processingUserMsgId &&
    presenceSynced &&
    machineStatus === 'online'
  );
  const machineRows = useMachineFlockRowsByMachineIds(session ? [session.machineId] : [], {
    families: ['localProject'],
  });
  const detail = useSessionDetail();
  const title =
    session?.title?.trim() || fallbackTitle?.trim() || t('sessions.untitled', 'Untitled session');
  const rows = session ? machineRows.get(session.machineId) : undefined;
  const where = session
    ? detail(session, rows ? getMachineFlockLocalProjects(rows) : undefined)
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
            {session ? (
              <BoardThreadStatusMark
                status={deriveBoardSessionStatus({
                  liveStatus: live,
                  awaitingUserSince: session.awaitingUserSince,
                  lastMessageAt: session.lastMessageAt,
                  collaborationStopped: session.collaborationStopped === true,
                })}
                unread={sessionHasUnreadMessages(session)}
                completed={completed}
              />
            ) : null}
          </span>
        </span>
      </Button>
    </div>
  );
}
