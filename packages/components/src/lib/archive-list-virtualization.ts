import type { SessionId, SessionMeta } from '@lody/shared';
import { buildArchivedSessionTree } from './archived-session-tree';

export const ARCHIVE_LIST_VIRTUALIZE_THRESHOLD = 50;
export const ARCHIVE_HEADER_ROW_ESTIMATE_PX = 36;
export const ARCHIVE_LOCAL_HEADER_ROW_ESTIMATE_PX = 40;
export const ARCHIVE_DESKTOP_SESSION_ROW_ESTIMATE_PX = 36;
export const ARCHIVE_MOBILE_SESSION_ROW_ESTIMATE_PX = 56;
export const ARCHIVE_GROUP_GAP_PX = 16;
export const ARCHIVE_LIST_OVERSCAN = 12;
export const ARCHIVE_GROUP_PREVIEW_COUNT = 10;

export type ArchiveListGroupInput = {
  key: string;
  kind: 'repo' | 'chat' | 'local';
  collapsed: boolean;
  sessions: readonly SessionMeta[];
};

export type ArchiveVirtualRow =
  | {
      kind: 'more';
      key: string;
      groupKey: string;
      remainingCount: number;
      isLastInGroup: true;
    }
  | {
      kind: 'header';
      key: string;
      groupKey: string;
      isFirst: boolean;
      isLastInGroup: boolean;
      local: boolean;
    }
  | {
      kind: 'session';
      key: string;
      groupKey: string;
      sessionId: SessionId;
      depth: 0 | 1;
      isLastInGroup: boolean;
    };

/**
 * Whether the flattened visible row list is long enough to virtualize.
 *
 * This is the SINGLE virtualization gate for the archive page. It counts
 * VISIBLE rows (headers plus sessions in expanded groups). Counting every
 * archived session including collapsed groups would swap renderers when the
 * user folds a large project, which is the same thrash the file tree already
 * rejected.
 */
export function shouldVirtualizeVisibleArchiveRows(
  rowCount: number,
  threshold = ARCHIVE_LIST_VIRTUALIZE_THRESHOLD
): boolean {
  return rowCount > threshold;
}

export function flattenVisibleArchiveRows(
  groups: readonly ArchiveListGroupInput[],
  options: { hideGroupHeader: boolean; expandedGroupKeys?: ReadonlySet<string> }
): ArchiveVirtualRow[] {
  const rows: ArchiveVirtualRow[] = [];
  let isFirstHeader = true;

  for (const group of groups) {
    const showHeader = !options.hideGroupHeader;
    const showSessions = options.hideGroupHeader || !group.collapsed;
    if (showHeader) {
      rows.push({
        kind: 'header',
        key: `header:${group.key}`,
        groupKey: group.key,
        isFirst: isFirstHeader,
        isLastInGroup: !showSessions,
        local: group.kind === 'local',
      });
      isFirstHeader = false;
    }
    if (!showSessions) continue;

    const tree = buildArchivedSessionTree(group.sessions);
    const rootCount = tree.filter((node) => node.depth === 0).length;
    const limited = !options.hideGroupHeader && options.expandedGroupKeys?.has(group.key) !== true;
    const remainingCount = limited ? Math.max(0, rootCount - ARCHIVE_GROUP_PREVIEW_COUNT) : 0;
    let visibleRoots = 0;
    const visibleTree =
      remainingCount > 0
        ? tree.filter((node) => {
            if (node.depth === 0) visibleRoots += 1;
            return visibleRoots <= ARCHIVE_GROUP_PREVIEW_COUNT;
          })
        : tree;
    visibleTree.forEach((node, index) => {
      rows.push({
        kind: 'session',
        key: `session:${node.item.id}`,
        groupKey: group.key,
        sessionId: node.item.id,
        depth: node.depth,
        isLastInGroup: remainingCount === 0 && index === visibleTree.length - 1,
      });
    });
    if (remainingCount > 0) {
      rows.push({
        kind: 'more',
        key: `more:${group.key}`,
        groupKey: group.key,
        remainingCount,
        isLastInGroup: true,
      });
    }
  }

  return rows;
}

export function archiveRowDataId(row: ArchiveVirtualRow): string {
  if (row.kind === 'more') return `archive-more:${row.groupKey}`;
  return row.kind === 'header'
    ? `archive-group:${row.groupKey}`
    : `archive-session:${row.sessionId}`;
}

export function estimateArchiveRowSize(
  row: ArchiveVirtualRow | undefined,
  options: { isMobile: boolean }
): number {
  if (!row) return ARCHIVE_DESKTOP_SESSION_ROW_ESTIMATE_PX;
  if (row.kind === 'header') {
    const base = row.local ? ARCHIVE_LOCAL_HEADER_ROW_ESTIMATE_PX : ARCHIVE_HEADER_ROW_ESTIMATE_PX;
    return (
      base +
      (row.isFirst ? 0 : ARCHIVE_GROUP_GAP_PX) +
      (row.isLastInGroup ? ARCHIVE_GROUP_GAP_PX : 0)
    );
  }
  const base = options.isMobile
    ? ARCHIVE_MOBILE_SESSION_ROW_ESTIMATE_PX
    : ARCHIVE_DESKTOP_SESSION_ROW_ESTIMATE_PX;
  return base + (row.isLastInGroup ? ARCHIVE_GROUP_GAP_PX : 0);
}
