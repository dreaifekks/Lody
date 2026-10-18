import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { ChevronDown, ChevronRight, CircleAlert, CircleSlash } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardSessionStatus } from '@lody/shared';
import { useWorkingHandOver } from '@/ui/working-status-mark';
import {
  UpdatedItemRow,
  useSidebarSessionMenuLabels,
  type UpdatedItemRowProps,
} from '../sidebar-updated-session-list';
import { SessionRowStatusIndicator } from '../sidebar-row-shared';

export interface BoardThreadItem {
  id: string;
  title: string;
  status: BoardSessionStatus;
  /** Output the user has not seen, as a sidebar row's blue dot. */
  unread?: boolean;
  /** The latest conclusion's first line, only once it has been read. */
  summary?: string;
  /** "Agent · machine · project", the facts that say where it runs. */
  detail: string;
  updatedLabel: string;
  updatedAt: number;
  /** Opened by another thread, or a contained Tab: drawn one step in. */
  depth?: number;
  archived?: boolean;
  branchName?: string;
  openedBySessionId?: string;
  openedByRowSessionId?: string;
}

type GroupKey = 'attention' | 'active' | 'idle' | 'archived';

const GROUP_BY_STATUS: Record<BoardSessionStatus, GroupKey> = {
  waiting_user: 'attention',
  failed: 'attention',
  stopped: 'attention',
  running: 'active',
  initializing: 'active',
  finalizing: 'active',
  idle: 'idle',
  waiting_coordinator: 'idle',
  cancelled: 'idle',
};

/** Which group a status reads as. The group says the state, so rows need no status word. */
export function boardThreadGroup(item: Pick<BoardThreadItem, 'status' | 'archived'>): GroupKey {
  return item.archived === true ? 'archived' : GROUP_BY_STATUS[item.status];
}

const GROUP_ORDER = ['attention', 'active', 'idle', 'archived'] as const;

/**
 * Threads with the sessions they opened, in list order (a root, then its rows
 * one or more steps in). A family stays together under the strongest state of
 * its members, so a reviewer waiting for the user lifts its thread into
 * "Needs you" instead of standing apart from it.
 */
export function boardThreadFamilies(
  threads: readonly BoardThreadItem[]
): { group: GroupKey; items: BoardThreadItem[] }[] {
  const families: BoardThreadItem[][] = [];
  for (const item of threads) {
    const last = families.at(-1);
    if ((item.depth ?? 0) > 0 && last) last.push(item);
    else families.push([item]);
  }
  return families.map((items) => ({
    items,
    group:
      items[0]?.archived === true
        ? 'archived'
        : GROUP_ORDER[
            Math.min(...items.map((item) => GROUP_ORDER.indexOf(boardThreadGroup(item))))
          ]!,
  }));
}

const styles = stylex.create({
  // One flat column: a row that changes group moves, keeping its mark's state.
  list: { display: 'flex', flexDirection: 'column', gap: '1px', padding: space[2] },
  groupHeader: {
    marginTop: { default: space[3], ':first-child': 0 },
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    height: '28px',
    paddingInline: space[2],
    borderWidth: 0,
    borderRadius: radius.medium,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    fontWeight: 600,
    cursor: 'pointer',
    textAlign: 'start',
  },
  count: { fontWeight: 400, color: colors.tertiaryLabel },
  indent: (depth: number) => ({ paddingInlineStart: `${depth * 18}px` }),
  time: { fontSize: text.footnoteSize, color: colors.tertiaryLabel, whiteSpace: 'nowrap' },
  danger: { color: colors.destructive },
  quiet: { color: colors.tertiaryLabel },
  empty: {
    margin: 0,
    paddingInline: space[2],
    paddingBlock: space[6],
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    textAlign: 'center',
  },
});

/**
 * A thread row's mark is a sidebar row's: ✋ waiting, the working grid, then the
 * unread dot it settles into. Only Board states with no sidebar mark (failed,
 * stopped) draw their own glyph, and only when none of those apply.
 */
export function BoardThreadStatusMark({
  status,
  unread,
}: {
  status: BoardSessionStatus;
  unread: boolean;
}) {
  const { t } = useTranslation();
  const working = useWorkingHandOver(GROUP_BY_STATUS[status] === 'active', unread);
  if (status === 'waiting_user' || working || unread)
    return (
      <SessionRowStatusIndicator
        isWaitingPermission={status === 'waiting_user'}
        isWorking={working}
        hasUnreadMessages={unread}
      />
    );
  if (status === 'failed')
    return (
      <CircleAlert
        size={14}
        aria-label={t('boards.status.failed', 'Failed')}
        {...stylex.props(styles.danger)}
      />
    );
  if (status === 'stopped')
    return (
      <CircleSlash
        size={14}
        aria-label={t('boards.status.stopped', 'Stopped')}
        {...stylex.props(styles.quiet)}
      />
    );
  return null;
}

export type BoardThreadActions = Pick<
  UpdatedItemRowProps,
  'onArchive' | 'onRestore' | 'onMarkUnread' | 'onRename' | 'onCopyUrl' | 'onBeginRename'
>;

const noop = () => {};
const BoardThreadRow = memo(function BoardThreadRow({
  actions,
  onOpen,
  selected,
  now,
  ...thread
}: BoardThreadItem & {
  now: Date;
  actions?: BoardThreadActions;
  onOpen: (id: string, tabSessionId?: string) => void;
  selected: boolean;
}) {
  const { t } = useTranslation();
  const labels = useSidebarSessionMenuLabels();
  const item = useMemo(
    () => ({
      id: thread.id,
      kind: 'chat' as const,
      title: thread.title,
      sectionLabel: thread.detail,
      latestMessageAt: thread.updatedAt,
      branchName: thread.branchName,
      openedBySessionId: thread.openedBySessionId,
      openedByRowSessionId: thread.openedByRowSessionId,
      hasUnreadMessages: thread.unread,
      isWaitingPermission: thread.status === 'waiting_user',
      isWorking: GROUP_BY_STATUS[thread.status] === 'active',
    }),
    [
      thread.id,
      thread.title,
      thread.detail,
      thread.updatedAt,
      thread.branchName,
      thread.openedBySessionId,
      thread.openedByRowSessionId,
      thread.unread,
      thread.status,
    ]
  );
  return (
    <div {...stylex.props(styles.indent(thread.depth ?? 0))}>
      <UpdatedItemRow
        rowId={thread.id}
        item={item}
        now={now}
        selected={selected}
        isMobile={false}
        showPinnedIcon={false}
        detailLine={thread.summary ?? thread.detail}
        restIcon={
          <>
            <BoardThreadStatusMark status={thread.status} unread={thread.unread === true} />
            <span {...stylex.props(styles.time)}>{thread.updatedLabel}</span>
          </>
        }
        onSelect={onOpen}
        {...actions}
        onBeginRename={actions?.onBeginRename ?? noop}
        onArchive={thread.archived ? undefined : actions?.onArchive}
        onRestore={thread.archived ? actions?.onRestore : undefined}
        contextMenuLabels={labels}
        archiveTooltipLabel={t('sessions.archive', 'Archive session')}
        archiveActionLabel={t('archive.title', 'Archive')}
        archiveConfirmLabel={t('common.confirm', 'Confirm')}
      />
    </div>
  );
});

/**
 * Threads grouped by what they need: the user, time, or nothing. Empty groups
 * are not drawn, archived threads stay folded, and a row's second line is its
 * latest conclusion when known, otherwise where it runs.
 */
export function BoardThreadListView({
  threads,
  selectedId,
  onOpen,
  actions,
  now,
}: {
  now: Date;
  actions?: BoardThreadActions;
  threads: readonly BoardThreadItem[];
  selectedId?: string | null;
  onOpen: (id: string, tabSessionId?: string) => void;
}) {
  const { t } = useTranslation();
  const [folded, setFolded] = useState<Partial<Record<GroupKey, boolean>>>({ archived: true });
  const labels: Record<GroupKey, string> = {
    attention: t('boards.groups.attention', 'Needs you'),
    active: t('boards.groups.active', 'Working'),
    idle: t('boards.groups.idle', 'Idle'),
    archived: t('boards.groups.archived', 'Archived'),
  };
  const families = boardThreadFamilies(threads);
  if (threads.length === 0)
    return (
      <p {...stylex.props(styles.empty)}>
        {t('boards.noThreads', 'Sessions created by the coordinator will appear here.')}
      </p>
    );
  // Headers and rows are siblings under one parent, keyed by id: a thread that
  // finishes moves from Working to Idle without remounting, so the working →
  // unread transition still plays.
  return (
    <div {...stylex.props(styles.list)}>
      {GROUP_ORDER.flatMap((key) => {
        const items = families
          .filter((family) => family.group === key)
          .flatMap((family) => family.items);
        if (items.length === 0) return [];
        const isFolded = folded[key] === true;
        return [
          <button
            key={`group:${key}`}
            type="button"
            aria-expanded={!isFolded}
            onClick={() => setFolded({ ...folded, [key]: !isFolded })}
            {...stylex.props(styles.groupHeader)}
          >
            {isFolded ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            {labels[key]}
            <span {...stylex.props(styles.count)}>{items.length}</span>
          </button>,
          ...(isFolded
            ? []
            : items.map((item) => (
                <BoardThreadRow
                  key={item.id}
                  {...item}
                  selected={item.id === selectedId}
                  onOpen={onOpen}
                  actions={actions}
                  now={now}
                />
              ))),
        ];
      })}
    </div>
  );
}
