import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { Hand, LayoutDashboard, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SessionRowStatusIndicator, SidebarSectionHeader } from '../sidebar-row-shared';

export interface BoardSidebarItem {
  id: string;
  name: string;
  /** Strongest member state: someone waits for the user, or someone works. */
  activity: 'waiting' | 'working' | null;
}

const styles = stylex.create({
  section: { display: 'flex', flexDirection: 'column', gap: '1px', paddingBottom: space[2] },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    height: '30px',
    width: '100%',
    paddingInline: space[2],
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.label,
    fontSize: text.bodySize,
    textAlign: 'start',
    cursor: 'pointer',
  },
  selected: { backgroundColor: colors.selectedFill },
  glyph: { flexShrink: 0, color: colors.secondaryLabel },
  name: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  waiting: { color: colors.warning },
});

/**
 * Boards in the sidebar, above the machines and chats: a Board is opened the way
 * a conversation is, so it is listed the way conversations are. The row mark is
 * the one the Session rows use; a Board with nothing going on draws none.
 */
export function BoardSidebarSection({
  boards,
  selectedId,
  collapsed,
  onToggleCollapsed,
  onOpen,
  onCreate,
}: {
  boards: readonly BoardSidebarItem[];
  selectedId?: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.section)}>
      <SidebarSectionHeader
        label={t('boards.title', 'Boards')}
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
        toggleLabel={t('boards.title', 'Boards')}
        action={
          <Button
            variant="ghost"
            size="mini"
            icon
            aria-label={t('boards.create', 'New board')}
            onClick={onCreate}
          >
            <Plus size={14} />
          </Button>
        }
      />
      {collapsed
        ? null
        : boards.map((board) => (
            <button
              key={board.id}
              type="button"
              data-scope-item="row"
              data-id={board.id}
              aria-current={board.id === selectedId ? 'page' : undefined}
              onClick={() => onOpen(board.id)}
              {...stylex.props(styles.row, board.id === selectedId && styles.selected)}
            >
              <LayoutDashboard size={14} aria-hidden {...stylex.props(styles.glyph)} />
              <span {...stylex.props(styles.name)}>{board.name}</span>
              {board.activity === 'waiting' ? (
                <Hand
                  size={12}
                  aria-label={t('boards.status.waitingUser', 'Waiting for you')}
                  {...stylex.props(styles.waiting)}
                />
              ) : board.activity === 'working' ? (
                <SessionRowStatusIndicator isWorking />
              ) : null}
            </button>
          ))}
    </div>
  );
}
