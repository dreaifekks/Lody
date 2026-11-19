import { describe, expect, it } from 'vitest';
import type { SessionId, SessionMeta } from '@lody/shared';
import {
  archiveRowDataId,
  flattenVisibleArchiveRows,
  type ArchiveListGroupInput,
} from '../src/lib/archive-list-virtualization';
import { buildArchivedSessionTree } from '../src/lib/archived-session-tree';

describe('archive-list-virtualization', () => {
  function session(id: string, relations: Partial<SessionMeta> = {}): SessionMeta {
    return { id: id as SessionId, title: id, ...relations } as SessionMeta;
  }

  function group(
    key: string,
    sessions: SessionMeta[],
    extra: Partial<ArchiveListGroupInput> = {}
  ): ArchiveListGroupInput {
    return {
      key,
      kind: extra.kind ?? 'repo',
      collapsed: extra.collapsed ?? false,
      sessions,
    };
  }

  describe('archive list virtualization helpers', () => {
    it('previews ten roots with their children and expands only the requested group', () => {
      const roots = Array.from({ length: 12 }, (_, i) => session(`root-${i}`));
      const sessions = [
        ...roots,
        session('child-9', { openedBySessionId: roots[9]!.id }),
        session('child-10', { openedBySessionId: roots[10]!.id }),
      ];
      const groups = [
        group('a', sessions),
        group(
          'b',
          roots.map((s) => session(`b-${s.id}`))
        ),
      ];
      const preview = flattenVisibleArchiveRows(groups, { hideGroupHeader: false });
      const firstGroup = preview.filter((row) => row.groupKey === 'a');
      expect(firstGroup.filter((row) => row.kind === 'session').map((row) => row.key)).toEqual([
        ...roots.slice(0, 10).map((s) => `session:${s.id}`),
        'session:child-9',
      ]);
      expect(firstGroup.at(-1)).toMatchObject({
        kind: 'more',
        remainingCount: 2,
        isLastInGroup: true,
      });
      expect(archiveRowDataId(firstGroup.at(-1)!)).toBe('archive-more:a');
      expect(firstGroup.at(-2)?.isLastInGroup).toBe(false);
      const expanded = flattenVisibleArchiveRows(groups, {
        hideGroupHeader: false,
        expandedGroupKeys: new Set(['a']),
      });
      expect(expanded.filter((row) => row.kind === 'session' && row.groupKey === 'a')).toHaveLength(
        14
      );
      expect(expanded.filter((row) => row.kind === 'more').map((row) => row.groupKey)).toEqual([
        'b',
      ]);
      const flat = flattenVisibleArchiveRows([group('__all__', sessions)], {
        hideGroupHeader: true,
      });
      expect(flat).toHaveLength(14);
      expect(flat.every((row) => row.kind === 'session')).toBe(true);
    });
    it('flattens project groups into headers plus opened-by session rows', () => {
      const root = session('root');
      const opened = session('opened', { openedBySessionId: root.id });
      const rows = flattenVisibleArchiveRows(
        [
          group('acme/app', [opened, root, session('other')]),
          group('__chats__', [session('chat-1')], { kind: 'chat' }),
        ],
        { hideGroupHeader: false }
      );

      expect(rows.map((row) => ({ kind: row.kind, key: row.key, extra: rowExtra(row) }))).toEqual([
        { kind: 'header', key: 'header:acme/app', extra: { isFirst: true, isLastInGroup: false } },
        { kind: 'session', key: 'session:root', extra: { depth: 0, isLastInGroup: false } },
        { kind: 'session', key: 'session:opened', extra: { depth: 1, isLastInGroup: false } },
        { kind: 'session', key: 'session:other', extra: { depth: 0, isLastInGroup: true } },
        {
          kind: 'header',
          key: 'header:__chats__',
          extra: { isFirst: false, isLastInGroup: false },
        },
        { kind: 'session', key: 'session:chat-1', extra: { depth: 0, isLastInGroup: true } },
      ]);
      expect(archiveRowDataId(rows[0]!)).toBe('archive-group:acme/app');
      expect(archiveRowDataId(rows[1]!)).toBe('archive-session:root');
    });

    it('omits sessions of collapsed groups but keeps the header', () => {
      const rows = flattenVisibleArchiveRows(
        [
          group('acme/app', [session('a'), session('b')], { collapsed: true }),
          group('other/app', [session('c')]),
        ],
        { hideGroupHeader: false }
      );

      expect(rows.map((row) => row.key)).toEqual([
        'header:acme/app',
        'header:other/app',
        'session:c',
      ]);
      expect(rows[0]).toMatchObject({ kind: 'header', isFirst: true, isLastInGroup: true });
    });

    it('hides group headers in the flat list', () => {
      const rows = flattenVisibleArchiveRows(
        [group('__all__', [session('a'), session('b')], { kind: 'chat' })],
        { hideGroupHeader: true }
      );
      expect(rows).toEqual([
        expect.objectContaining({ kind: 'session', sessionId: 'a', isLastInGroup: false }),
        expect.objectContaining({ kind: 'session', sessionId: 'b', isLastInGroup: true }),
      ]);
    });
  });

  function rowExtra(row: ReturnType<typeof flattenVisibleArchiveRows>[number]) {
    if (row.kind === 'header') {
      return { isFirst: row.isFirst, isLastInGroup: row.isLastInGroup };
    }
    if (row.kind === 'more') return { remainingCount: row.remainingCount };
    return { depth: row.depth, isLastInGroup: row.isLastInGroup };
  }
});

describe('archived-session-tree', () => {
  function session(id: string, relations: Partial<SessionMeta> = {}): SessionMeta {
    return { id: id as SessionId, ...relations } as SessionMeta;
  }

  describe('buildArchivedSessionTree', () => {
    it('keeps agent-opened sessions indented below their archived root', () => {
      const root = session('root');
      const opened = session('opened', { openedBySessionId: root.id });
      const openedFromTab = session('opened-from-tab', {
        openedBySessionId: 'tab' as SessionId,
        openedByRootSessionId: root.id,
      });

      expect(buildArchivedSessionTree([root, opened, openedFromTab, session('unrelated')])).toEqual(
        [
          expect.objectContaining({ id: 'root', depth: 0, childCount: 2 }),
          expect.objectContaining({ id: 'opened', depth: 1, openedById: 'root' }),
          expect.objectContaining({ id: 'opened-from-tab', depth: 1, openedById: 'root' }),
          expect.objectContaining({ id: 'unrelated', depth: 0 }),
        ]
      );
    });
  });
});
