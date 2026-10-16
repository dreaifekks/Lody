import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { LayoutDashboard } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BoardMeta } from '@lody/shared';
import { boardEnabledAtom } from '@/atoms/settings';
import { useAtomValue } from 'jotai';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import { useVisibleArchivedSessionMetas } from '@/hooks/use-visible-session-metas';
import { toast } from '@/lib/toast';
import { useBoardLifecycle } from './board-lifecycle';

const styles = stylex.create({
  section: { display: 'flex', flexDirection: 'column', gap: space[2], paddingBlock: space[3] },
  heading: {
    margin: 0,
    paddingInline: space[1],
    fontSize: text.footnoteSize,
    fontWeight: 600,
    color: colors.secondaryLabel,
  },
  card: {
    backgroundColor: colors.elevatedBackground,
    borderRadius: radius.large,
    boxShadow: shadow.card,
    overflow: 'hidden',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    paddingInline: space[3],
    paddingBlock: space[2],
    boxShadow: { default: `inset 0 1px 0 ${colors.separator}`, ':first-child': 'none' },
  },
  glyph: { flexShrink: 0, color: colors.secondaryLabel },
  name: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.bodySize,
  },
});

export function ArchivedBoardsView({
  boards,
  onRestore,
}: {
  boards: readonly BoardMeta[];
  onRestore: (board: BoardMeta) => void;
}) {
  const { t } = useTranslation();
  if (boards.length === 0) return null;
  return (
    <section {...stylex.props(styles.section)}>
      <h2 {...stylex.props(styles.heading)}>{t('boards.archivedBoards', 'Archived Boards')}</h2>
      <div {...stylex.props(styles.card)}>
        {boards.map((board) => (
          <div key={board.id} data-archived-board={board.id} {...stylex.props(styles.row)}>
            <LayoutDashboard size={14} aria-hidden {...stylex.props(styles.glyph)} />
            <span {...stylex.props(styles.name)}>{board.name}</span>
            <Button variant="secondary" size="small" onClick={() => onRestore(board)}>
              {t('boards.restore', 'Restore')}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Archived Boards on the Archive page; restoring brings back the coordinator and every thread. */
export function ArchivedBoardsSection() {
  const { t } = useTranslation();
  const enabled = useAtomValue(boardEnabledAtom);
  const { boards } = useWorkspaceCatalog();
  const { archivedSessions } = useVisibleArchivedSessionMetas();
  const { restoreBoard } = useBoardLifecycle();
  if (!enabled) return null;
  return (
    <ArchivedBoardsView
      boards={boards.filter((board) => board.archivedAtMs !== undefined)}
      onRestore={(board) => {
        void restoreBoard(board, archivedSessions).catch((cause: unknown) =>
          toast.error(
            cause instanceof Error && cause.message === 'BOARD_LIMIT'
              ? t(
                  'boards.restoreLimit',
                  'A workspace can have up to 50 active Boards. Archive one first.'
                )
              : t('boards.restoreFailed', 'Could not restore the Board.')
          )
        );
      }}
    />
  );
}
