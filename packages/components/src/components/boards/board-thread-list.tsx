import { BoardThreadBreadcrumb } from './board-thread-breadcrumb';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Check, ChevronDown, ChevronRight, CircleAlert, CircleSlash } from 'lucide-react';
import { useAtomValue, useSetAtom } from 'jotai';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardSessionStatus } from '@lody/shared';
import {
  sidebarCollapsedOpenedBySessionsAtom,
  toggleSidebarCollapsedOpenedBySessionAtom,
} from '@/atoms/focus-layer';
import { familyReadThroughAtom } from '@/atoms/low-stimulus-seen';
import { lowStimulusModeEnabledAtom } from '@/atoms/settings';
import { sessionSendStatesAtom } from '@/atoms/session-send-status';
import type { SessionSendState } from '@/lib/session-send-status';
import { hiddenSessionHasUnread, isOpenerCollapsed } from '@/lib/low-stimulus';
import { useWorkingHandOver } from '@/ui/working-status-mark';
import {
  UpdatedItemRow,
  useSidebarSessionMenuLabels,
  type UpdatedItemRowProps,
} from '../sidebar-updated-session-list';
import { foldedFamilyActivity } from '../sidebar-folded-family';
import {
  buildSessionRowOpenedByTreeSlot,
  SessionRowStatusIndicator,
  type SessionRowOpenedByTreeSlot,
  type SidebarGroupActivity,
} from '../sidebar-row-shared';

export interface BoardThreadItem {
  id: string;
  title: string;
  status: BoardSessionStatus;
  /** Output the user has not seen, as a sidebar row's blue dot. */
  unread?: boolean;
  /** The session's own read receipt, one half of how far a folded family's root is read. */
  lastReadAt?: number;
  /** The latest conclusion's first line, only once it has been read. */
  summary?: string;
  /** "Agent · machine · project", the facts that say where it runs. */
  detail: string;
  updatedLabel: string;
  updatedAt: number;
  parentId?: string;
  parentTitle?: string;
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
const STATUS_ORDER: readonly BoardSessionStatus[] = [
  'waiting_user',
  'running',
  'initializing',
  'finalizing',
  'failed',
  'stopped',
  'cancelled',
  'waiting_coordinator',
  'idle',
];

function strongestBoardStatus(items: readonly Pick<BoardThreadItem, 'status'>[]) {
  return items.reduce(
    (strongest, item) =>
      STATUS_ORDER.indexOf(item.status) < STATUS_ORDER.indexOf(strongest) ? item.status : strongest,
    items[0]!.status
  );
}

const isBoardItemWorking = (item: Pick<BoardThreadItem, 'status'>) =>
  GROUP_BY_STATUS[item.status] === 'active';

/**
 * Low-stimulus mode's root row of a folded family: the family's strongest state
 * and merged unread, as the one mark every other row of it would have drawn. A
 * hidden member at work is the root's to report, so its work is not part of the
 * row's state (the family still sits under Working); its waiting and failure are.
 * Only an unread member has a last message, which is what `updatedAt` then holds.
 */
export function foldedBoardThreadRoot(
  items: readonly BoardThreadItem[],
  rootReadThrough: number
): BoardThreadItem {
  const root = items[0]!;
  const hidden = items.slice(1);
  return {
    ...root,
    status: strongestBoardStatus([
      root,
      ...hidden.filter((item) => item.archived !== true && !isBoardItemWorking(item)),
    ]),
    unread:
      root.unread === true ||
      hidden.some((item) =>
        hiddenSessionHasUnread(item.unread === true, item.updatedAt, rootReadThrough)
      ),
  };
}

/** A member as the row flags a folded family counts; its send state joins later. */
function boardFamilyRow(item: BoardThreadItem) {
  return {
    id: item.id,
    isWaitingPermission: item.status === 'waiting_user',
    isWorking: GROUP_BY_STATUS[item.status] === 'active',
    hasUnreadMessages: item.unread === true,
    latestMessageAt: item.updatedAt,
  };
}

/**
 * The one mark a folded family's root draws, counted as the sidebar counts a
 * folded family: every member's live state, the hidden members' unread narrowed
 * by how far the root is read, and every member's local send state, so a hidden
 * member's failed send still outranks everything.
 */
export function boardFamilyActivity(
  items: readonly BoardThreadItem[],
  sendStates: Readonly<Record<string, SessionSendState>>,
  rootReadThrough: number
): SidebarGroupActivity {
  return foldedFamilyActivity(
    boardFamilyRow(items[0]!),
    items.slice(1).filter((item) => item.archived !== true).map(boardFamilyRow),
    rootReadThrough,
    (row) => row.id,
    sendStates
  );
}

/**
 * Threads with the sessions they opened, in list order (a root, then its rows
 * one or more steps in). A family stays together under the strongest state of
 * its members, so a reviewer waiting for the user lifts its thread into
 * "Needs you" instead of standing apart from it.
 */
export function boardThreadFamilies<
  T extends Pick<BoardThreadItem, 'depth' | 'status' | 'archived'>,
>(threads: readonly T[]): { group: GroupKey; status: BoardSessionStatus; items: T[] }[] {
  const families: T[][] = [];
  for (const item of threads) {
    const last = families.at(-1);
    if ((item.depth ?? 0) > 0 && last) last.push(item);
    else families.push([item]);
  }
  return families.map((items) => ({
    items,
    status: strongestBoardStatus(items),
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
  completed: { color: colors.secondaryLabel },
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
  completed = false,
}: {
  status: BoardSessionStatus;
  unread: boolean;
  /** Conversation cards only; list rows never add a resting done mark. */
  completed?: boolean;
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
  if (status === 'idle' && completed)
    return (
      <Check
        size={14}
        aria-label={t('sessions.openedBy.status.succeeded', 'Completed')}
        {...stylex.props(styles.completed)}
      />
    );
  return null;
}

export type BoardThreadActions = Pick<
  UpdatedItemRowProps,
  'onArchive' | 'onRestore' | 'onMarkUnread' | 'onRename' | 'onCopyUrl' | 'onBeginRename'
>;

type FamilyDisclosure = {
  /** Low-stimulus mode's family disclosure on a root thread. */
  openedByTree?: SessionRowOpenedByTreeSlot;
  /** The one mark of the family folded under this row. */
  familyActivity?: SidebarGroupActivity;
};

const noop = () => {};
const BoardThreadRow = memo(function BoardThreadRow({
  actions,
  onOpen,
  selected,
  now,
  openedByTree,
  familyActivity,
  ...thread
}: BoardThreadItem & {
  now: Date;
  actions?: BoardThreadActions;
  onOpen: (id: string, tabSessionId?: string) => void;
  selected: boolean;
} & FamilyDisclosure) {
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
        titleContent={
          thread.parentId && thread.parentTitle ? (
            <BoardThreadBreadcrumb
              parentTitle={thread.parentTitle}
              title={thread.title}
              onOpenParent={() => onOpen(thread.parentId!)}
            />
          ) : undefined
        }
        openedByTree={openedByTree}
        familyActivity={familyActivity}
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
  const lowStimulusMode = useAtomValue(lowStimulusModeEnabledAtom);
  const collapsedFamilies = useAtomValue(sidebarCollapsedOpenedBySessionsAtom);
  const toggleFamily = useSetAtom(toggleSidebarCollapsedOpenedBySessionAtom);
  const sendStates = useAtomValue(sessionSendStatesAtom);
  const familyReadThrough = useAtomValue(familyReadThroughAtom);
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
        const rows = families
          .filter((family) => family.group === key)
          .flatMap(({ items }): (BoardThreadItem & FamilyDisclosure)[] => {
            const root = items[0]!;
            if (!lowStimulusMode || items.length === 1) return items;
            const expanded = !isOpenerCollapsed(lowStimulusMode, collapsedFamilies, root.id);
            const openedByTree = buildSessionRowOpenedByTreeSlot(
              { depth: 0, childCount: items.length - 1, expanded, isLastChild: false },
              t,
              () => toggleFamily(root.id)
            );
            if (expanded) return [{ ...root, openedByTree }, ...items.slice(1)];
            const rootReadThrough = familyReadThrough(root.id, root.lastReadAt);
            return [
              {
                ...foldedBoardThreadRoot(items, rootReadThrough),
                openedByTree,
                familyActivity: boardFamilyActivity(items, sendStates, rootReadThrough),
              },
            ];
          });
        if (rows.length === 0) return [];
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
            <span {...stylex.props(styles.count)}>{rows.length}</span>
          </button>,
          ...(isFolded
            ? []
            : rows.map((item) => (
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
