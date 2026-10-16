import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Spinner } from '@lody/ui/spinner';
import { ChevronDown, ChevronRight, CircleAlert, CircleSlash, Hand } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardSessionStatus } from '@lody/shared';

export interface BoardThreadItem {
  id: string;
  title: string;
  status: BoardSessionStatus;
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
  list: { display: 'flex', flexDirection: 'column', gap: space[3], padding: space[2] },
  group: { display: 'flex', flexDirection: 'column', gap: '1px' },
  groupHeader: {
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
  warning: { color: colors.warning },
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

function StatusMark({ status }: { status: BoardSessionStatus }) {
  const { t } = useTranslation();
  if (status === 'waiting_user')
    return (
      <Hand
        size={14}
        aria-label={t('boards.status.waitingUser', 'Waiting for you')}
        {...stylex.props(styles.warning)}
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
  if (GROUP_BY_STATUS[status] === 'active')
    return <Spinner size="small" label={t('boards.status.running', 'Running')} />;
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
  return (
    <div {...stylex.props(styles.list)}>
      {GROUP_ORDER.map((key) => {
        const items = families
          .filter((family) => family.group === key)
          .flatMap((family) => family.items);
        if (items.length === 0) return null;
        const isFolded = folded[key] === true;
        return (
          <section key={key} {...stylex.props(styles.group)}>
            <button
              type="button"
              aria-expanded={!isFolded}
              onClick={() => setFolded({ ...folded, [key]: !isFolded })}
              {...stylex.props(styles.groupHeader)}
            >
              {isFolded ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              {labels[key]}
              <span {...stylex.props(styles.count)}>{items.length}</span>
            </button>
            {isFolded
              ? null
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
                      <StatusMark status={item.status} />
                    </span>
                    <span {...stylex.props(styles.title)}>{item.title}</span>
                    <span {...stylex.props(styles.time)}>{item.updatedLabel}</span>
                    <span {...stylex.props(styles.secondLine)}>{item.summary ?? item.detail}</span>
                  </button>
                ))}
          </section>
        );
      })}
    </div>
  );
}
