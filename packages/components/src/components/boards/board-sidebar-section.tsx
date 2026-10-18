import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { ContextMenu } from '@lody/ui/context-menu';
import { Archive, LayoutDashboard, Link2, Pencil, Plus, Share2 } from 'lucide-react';
import { useAtomValue, useStore } from 'jotai';
import { memo, useMemo, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { getSessionRoomId, type BoardMeta, type SessionId, type SessionMeta } from '@lody/shared';
import { selectAtom } from 'jotai/utils';
import { currentWorkspaceIdAtom } from '@/atoms';
import { allActiveSessionsAtom, sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import { useAppCapability } from '@/lib/app-platform';
import { useLanSharing } from '@/lib/lan-session-share';
import { cn } from '@/lib/utils';
import { LanSessionShareDialog } from '../sharing/lan-session-share-dialog';
import { SessionShareDialog } from '../sharing/session-share-dialog';
import { SessionRowLeadingSlot } from '../session-row-leading-slot';
import { SessionWindowMenuItem } from '../session-window-menu-item';
import {
  SidebarRowArchiveButton,
  SidebarRowEndSlot,
  SidebarSectionHeader,
} from '../sidebar-row-shared';
import { useBoardActions } from './board-lifecycle';
import { BoardRenameDialog } from './board-rename-dialog';
import { resolveSidebarBoardSelection, type BoardActivity } from './board-threads';

export interface BoardSidebarItem {
  id: string;
  name: string;
  /** Opening the Board opens this conversation. */
  coordinatorSessionId: SessionId;
  /** Every member's marks together: waiting, working, unread. */
  activity: BoardActivity;
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
  menuOpen: { backgroundColor: colors.hoverFill },
  glyph: { flexShrink: 0, color: colors.secondaryLabel },
  name: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

/** What a Board row offers beside opening it, as a conversation row does. */
export interface BoardSidebarActions {
  onRename: (board: BoardSidebarItem) => void;
  onCopyUrl: (board: BoardSidebarItem) => void;
  /** Shares the coordinator's conversation; absent where nothing can publish. */
  onShare?: (board: BoardSidebarItem) => void;
  onArchive: (board: BoardSidebarItem) => void;
}

/**
 * Boards in the sidebar, above the machines and chats: a Board is opened the way
 * a conversation is, so it is listed the way conversations are, with the same
 * hover ⋯, hover Archive and right-click menu. The row mark is the one the
 * Session rows use, over all members: ✋, working, or the unread dot; a Board
 * with nothing going on draws none.
 */
export function BoardSidebarSection({
  boards,
  selectedId,
  collapsed,
  isMobile,
  onToggleCollapsed,
  onOpen,
  onCreate,
  actions,
}: {
  boards: readonly BoardSidebarItem[];
  selectedId?: string | null;
  collapsed: boolean;
  isMobile?: boolean;
  onToggleCollapsed: () => void;
  onOpen: (board: BoardSidebarItem) => void;
  onCreate: () => void;
  actions?: BoardSidebarActions;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.section)}>
      <SidebarSectionHeader
        label={t('boards.title', 'Boards')}
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
        isMobile={isMobile}
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
            <BoardSidebarRow
              key={board.id}
              board={board}
              selected={board.id === selectedId}
              // Conversation rows keep their menus to the desktop too.
              actions={isMobile ? undefined : actions}
              onOpen={onOpen}
            />
          ))}
    </div>
  );
}

function BoardSidebarRowView({
  board,
  selected,
  actions,
  onOpen,
}: {
  board: BoardSidebarItem;
  selected: boolean;
  actions?: BoardSidebarActions;
  onOpen: (board: BoardSidebarItem) => void;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const row = (
    <div
      role="button"
      tabIndex={0}
      aria-label={board.name}
      data-scope-item="row"
      data-id={board.id}
      data-sidebar-session-id={board.coordinatorSessionId}
      data-menu-open={menuOpen ? '' : undefined}
      aria-current={selected ? 'page' : undefined}
      onClick={() => onOpen(board)}
      onKeyDown={(event: KeyboardEvent) => {
        // ⋯ and Archive inside the row keep their own keys.
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onOpen(board);
      }}
      className={cn(
        'group',
        stylex.props(styles.row, menuOpen && styles.menuOpen, selected && styles.selected).className
      )}
    >
      <SessionRowLeadingSlot
        showMenuButton={actions !== undefined}
        menuLabel={t('sessions.moreActions', 'More actions')}
        restIcon={<LayoutDashboard size={14} aria-hidden {...stylex.props(styles.glyph)} />}
      />
      <span {...stylex.props(styles.name)}>{board.name}</span>
      <SidebarRowEndSlot
        sessionId={board.coordinatorSessionId}
        isWaitingPermission={board.activity.isWaitingPermission}
        isWorking={board.activity.isWorking}
        hasUnreadMessages={board.activity.hasUnreadMessages}
        archive={
          actions ? (
            <SidebarRowArchiveButton
              label={t('boards.settings.archive', 'Archive Board')}
              confirmLabel={t('common.confirm', 'Confirm')}
              onConfirm={() => actions.onArchive(board)}
            />
          ) : undefined
        }
      />
    </div>
  );
  if (!actions) return row;
  return (
    <ContextMenu.Root onOpenChange={setMenuOpen}>
      <ContextMenu.Trigger>{row}</ContextMenu.Trigger>
      <ContextMenu.Content className="min-w-[180px]">
        <ContextMenu.Item icon={Pencil} onClick={() => actions.onRename(board)}>
          {t('boards.rename', 'Rename Board')}
        </ContextMenu.Item>
        <ContextMenu.Separator />
        <ContextMenu.Item icon={Link2} onClick={() => actions.onCopyUrl(board)}>
          {t('boards.copyUrl', 'Copy Board URL')}
        </ContextMenu.Item>
        {actions.onShare ? (
          <ContextMenu.Item icon={Share2} onClick={() => actions.onShare?.(board)}>
            {t('sharing.manager.title', 'Share')}
          </ContextMenu.Item>
        ) : null}
        <SessionWindowMenuItem sessionId={board.coordinatorSessionId} />
        <ContextMenu.Separator />
        <ContextMenu.Item icon={Archive} onClick={() => actions.onArchive(board)}>
          {t('boards.settings.archive', 'Archive Board')}
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}

const BoardSidebarRow = memo(
  BoardSidebarRowView,
  (previous, next) =>
    previous.selected === next.selected &&
    previous.actions === next.actions &&
    previous.onOpen === next.onOpen &&
    previous.board.id === next.board.id &&
    previous.board.name === next.board.name &&
    previous.board.coordinatorSessionId === next.board.coordinatorSessionId &&
    previous.board.activity.isWorking === next.board.activity.isWorking &&
    previous.board.activity.isWaitingPermission === next.board.activity.isWaitingPermission &&
    previous.board.activity.hasUnreadMessages === next.board.activity.hasUnreadMessages
);

type BoardSidebarSectionProps = Parameters<typeof BoardSidebarSection>[0];

/**
 * The sidebar's Boards with their rows' actions: rename and archive act on the
 * Board, share opens the coordinator conversation's share editor, the way its
 * page's header does.
 */
export function BoardSidebar({
  onCopyUrl,
  onArchived,
  routeSessionId,
  tabSessionId,
  ...section
}: Omit<BoardSidebarSectionProps, 'actions' | 'selectedId'> & {
  routeSessionId: string | null;
  tabSessionId?: string;
  onCopyUrl: (board: BoardSidebarItem) => void;
  /** After a Board was archived, so a page showing it can leave. */
  onArchived: (board: BoardMeta) => void;
}) {
  // This leaf selects two low-frequency membership scalars; the layout acquires no new metadata subscription.
  const routeMembership = useMemo(
    () =>
      selectAtom(
        sessionMetaAtomFamily(getSessionRoomId((routeSessionId ?? '') as SessionId)),
        (session) => session?.boardId
      ),
    [routeSessionId]
  );
  const tabMembership = useMemo(
    () =>
      selectAtom(
        sessionMetaAtomFamily(getSessionRoomId((tabSessionId ?? '') as SessionId)),
        (session) => session?.boardId
      ),
    [tabSessionId]
  );
  const routeBoardId = useAtomValue(routeMembership);
  const tabBoardId = useAtomValue(tabMembership);
  const selectedId = resolveSidebarBoardSelection({
    boards: section.boards,
    routeSessionId,
    routeBoardId,
    tabSessionId,
    tabBoardId,
  });
  const store = useStore();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const { boards } = useWorkspaceCatalog();
  const { archive } = useBoardActions();
  const [renaming, setRenaming] = useState<BoardMeta | null>(null);
  const [sharing, setSharing] = useState<SessionMeta | null>(null);
  const hostedSharing = useAppCapability('teamSharing');
  const lanSharing = useLanSharing(workspaceId);
  const shareWorkspaceId = (hostedSharing || lanSharing) && workspaceId ? workspaceId : undefined;
  const actions = useMemo<BoardSidebarActions>(() => {
    const boardOf = (item: BoardSidebarItem) => boards.find((board) => board.id === item.id);
    return {
      onRename: (item) => setRenaming(boardOf(item) ?? null),
      onCopyUrl,
      onShare: shareWorkspaceId
        ? (item) =>
            setSharing(
              store
                .get(allActiveSessionsAtom)
                .find((session) => session.id === item.coordinatorSessionId) ?? null
            )
        : undefined,
      onArchive: (item) => {
        const board = boardOf(item);
        if (!board) return;
        void archive(board).then((archived) => {
          if (archived) onArchived(board);
        });
      },
    };
  }, [archive, boards, onArchived, onCopyUrl, shareWorkspaceId, store]);
  return (
    <>
      <BoardSidebarSection {...section} selectedId={selectedId} actions={actions} />
      <BoardRenameDialog board={renaming} onClose={() => setRenaming(null)} />
      {shareWorkspaceId && sharing ? (
        lanSharing ? (
          <LanSessionShareDialog
            workspaceId={shareWorkspaceId}
            session={sharing}
            onClose={() => setSharing(null)}
          />
        ) : (
          <SessionShareDialog
            workspaceId={shareWorkspaceId}
            session={sharing}
            onClose={() => setSharing(null)}
          />
        )
      ) : null}
    </>
  );
}
