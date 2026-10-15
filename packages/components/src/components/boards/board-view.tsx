import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { ChevronDown, ChevronRight, GitPullRequest } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BoardMeta, BoardSessionStatus, SessionMeta } from '@lody/shared';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import type { ReactNode } from 'react';

export const boardStyles = stylex.create({
  split: { display: 'flex', flexWrap: 'wrap', gap: space[4], alignItems: 'flex-start' },
  overview: { flex: '2 1 500px', minWidth: 0 },
  notesPanel: {
    flex: '1 1 300px',
    minWidth: 0,
    maxWidth: '100%',
    padding: space[3],
    backgroundColor: colors.elevatedBackground,
    borderRadius: radius.large,
  },
  page: { padding: space[6], overflow: 'auto', height: '100%', minHeight: 0, color: colors.label },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    marginBottom: space[4],
  },
  title: { fontSize: '1.3em', fontWeight: 600, margin: 0 },
  muted: { color: colors.secondaryLabel, fontSize: '0.9em' },
  card: {
    backgroundColor: colors.elevatedBackground,
    borderRadius: radius.large,
    boxShadow: shadow.card,
    marginTop: space[4],
    overflow: 'hidden',
  },
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[2],
    padding: space[3],
    borderBottom: `1px solid ${colors.separator}`,
  },
  nested: { paddingLeft: space[8] },
  name: { flex: '1 1 200px', minWidth: 0 },
  preview: {
    padding: space[4],
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    maxHeight: '320px',
    overflow: 'auto',
    fontSize: '0.9em',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[4],
    minHeight: 0,
    overflowY: 'auto',
  },
  field: { display: 'flex', flexDirection: 'column', gap: space[2] },
  controls: { display: 'flex', flexWrap: 'wrap', gap: space[2], alignItems: 'center' },
  error: { color: colors.destructive },
});

export function BoardListView({
  boards,
  onCreate,
  onOpen,
}: {
  boards: readonly BoardMeta[];
  onCreate: () => void;
  onOpen: (board: BoardMeta) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <header {...stylex.props(boardStyles.header)}>
        <h1 {...stylex.props(boardStyles.title)}>{t('boards.title', 'Boards')}</h1>
        <Button onClick={onCreate}>{t('boards.create', 'New board')}</Button>
      </header>
      {boards.length === 0 ? (
        <p {...stylex.props(boardStyles.muted)}>
          {t('boards.empty', 'Create a board to bring a coordinator and its sessions together.')}
        </p>
      ) : null}
      <div {...stylex.props(boardStyles.card)}>
        {boards.map((board) => (
          <div key={board.id} {...stylex.props(boardStyles.row)}>
            <div {...stylex.props(boardStyles.name)}>
              <Button
                variant="ghost"
                data-scope-item="row"
                data-id={board.id}
                onClick={() => onOpen(board)}
              >
                {board.name}
              </Button>
              <div {...stylex.props(boardStyles.muted)}>{board.purpose}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

export function BoardSessionRowView({
  session,
  detail,
  status,
  depth = 0,
  expanded,
  onExpand,
  onOpen,
  children,
}: {
  session: SessionMeta;
  detail: string;
  status: BoardSessionStatus;
  depth?: number;
  expanded: boolean;
  onExpand: () => void;
  onOpen: () => void;
  children?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const labels: Record<BoardSessionStatus, string> = {
    running: t('boards.status.running', 'Running'),
    initializing: t('boards.status.initializing', 'Starting'),
    finalizing: t('boards.status.finalizing', 'Finalizing'),
    waiting_user: t('boards.status.waitingUser', 'Waiting for you'),
    failed: t('boards.status.failed', 'Failed'),
    waiting_coordinator: t('boards.status.waitingCoordinator', 'Idle · waiting for coordinator'),
    idle: t('boards.status.idle', 'Idle'),
  };
  return (
    <div data-board-session={session.id}>
      <div {...stylex.props(boardStyles.row, depth > 0 && boardStyles.nested)}>
        <Button
          variant="ghost"
          size="small"
          aria-expanded={expanded}
          aria-label={t('boards.preview', 'Show latest messages')}
          onClick={onExpand}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </Button>
        <div {...stylex.props(boardStyles.name)}>
          <Button variant="ghost" data-scope-item="row" data-id={session.id} onClick={onOpen}>
            {session.title || t('boards.untitled', 'Untitled session')}
          </Button>
          <div {...stylex.props(boardStyles.muted)}>{detail}</div>
        </div>
        {session.pullRequests?.length ? (
          <GitPullRequest size={16} aria-label={t('boards.pullRequest', 'Pull request')} />
        ) : null}
        {session.diffStats ? (
          <span {...stylex.props(boardStyles.muted)}>
            +{session.diffStats.allChange.add} −{session.diffStats.allChange.del}
          </span>
        ) : null}
        <span>{labels[status]}</span>
        <time {...stylex.props(boardStyles.muted)}>
          {new Date(session.lastMessageAt ?? session.createdAt).toLocaleString(
            toIntlLocaleOrEn(i18n.language)
          )}
        </time>
      </div>
      {expanded ? children : null}
    </div>
  );
}
