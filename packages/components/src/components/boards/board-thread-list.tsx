import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { ChevronDown, ChevronRight, CircleAlert, CircleSlash } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardSessionStatus } from '@lody/shared';
import { useWorkingHandOver } from '@/ui/working-status-mark';
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
  /** Opened by another thread, or a contained Tab: drawn one step in. */
  depth?: number;
  archived?: boolean;
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
  row: {
    display: 'grid',
    gridTemplateColumns: '16px minmax(0, 1fr) auto',
    columnGap: space[2],
    rowGap: '2px',
    alignItems: 'center',
    width: '100%',
    paddingBlock: space[2],
    paddingInline: space[2],
    borderWidth: 0,
    borderRadius: radius.medium,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.label,
    textAlign: 'start',
    cursor: 'pointer',
  },
  selected: { backgroundColor: colors.selectedFill },
  indent: (depth: number) => ({ paddingInlineStart: `calc(${space[2]} + ${depth * 18}px)` }),
  mark: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '16px' },
  title: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.bodySize,
  },
  time: { fontSize: text.footnoteSize, color: colors.tertiaryLabel, whiteSpace: 'nowrap' },
  secondLine: {
    gridColumn: '2 / 4',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
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

/**
 * Threads grouped by what they need: the user, time, or nothing. Empty groups
 * are not drawn, archived threads stay folded, and a row's second line is its
 * latest conclusion when known, otherwise where it runs.
 */
export function BoardThreadListView({
  threads,
  selectedId,
  onOpen,
}: {
  threads: readonly BoardThreadItem[];
  selectedId?: string | null;
  onOpen: (id: string) => void;
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
                <button
                  key={item.id}
                  type="button"
                  data-scope-item="row"
                  data-id={item.id}
                  aria-current={item.id === selectedId ? 'true' : undefined}
                  onClick={() => onOpen(item.id)}
                  {...stylex.props(
                    styles.row,
                    item.id === selectedId && styles.selected,
                    (item.depth ?? 0) > 0 && styles.indent(item.depth ?? 0)
                  )}
                >
                  <span {...stylex.props(styles.mark)}>
                    <BoardThreadStatusMark status={item.status} unread={item.unread === true} />
                  </span>
                  <span {...stylex.props(styles.title)}>{item.title}</span>
                  <span {...stylex.props(styles.time)}>{item.updatedLabel}</span>
                  <span {...stylex.props(styles.secondLine)}>{item.summary ?? item.detail}</span>
                </button>
              ))),
        ];
      })}
    </div>
  );
}
