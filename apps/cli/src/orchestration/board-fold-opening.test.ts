import {
  boardMaintenanceStepId,
  boardMaintenanceTurn,
  estimateTokenCount,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { describe, expect, it } from 'vitest';
import {
  buildBoardLineTree,
  type BoardLineFoldNode,
  type BoardLineNode,
  type BoardLineSegmentNode,
} from '@/lib/board-line-store';
import {
  BOARD_FOLD_OPENING_MAX_TOKENS,
  BOARD_FOLD_OPENING_MIN_CORE_BUDGET,
  buildBoardFoldOpening,
  extractRecentCoordinatorContext,
  isHumanUserTurn,
} from './board-fold-opening';

const seg = (
  seq: number,
  overrides: Partial<BoardLineSegmentNode['meta']> = {},
  summary?: string
): BoardLineSegmentNode => ({
  meta: {
    v: 1,
    id: `seg_${seq.toString(16).padStart(8, '0')}`,
    kind: 'segment',
    seq,
    level: 0,
    coversFrom: `2026-11-${String((seq % 28) + 1).padStart(2, '0')}T08:00:00.000Z`,
    coversTo: `2026-11-${String((seq % 28) + 1).padStart(2, '0')}T09:30:00.000Z`,
    title: `Segment ${seq} title`,
    tags: ['design', `t${seq}`],
    summaryQuality: 'written',
    createdAt: `2026-11-${String((seq % 28) + 1).padStart(2, '0')}T09:35:00.000Z`,
    turnRange: { startTurnId: `u-${seq}`, endTurnId: `a-${seq}`, turnCount: 4 },
    outcome: 'rolled',
    ...overrides,
  },
  summary: summary ?? `Detailed first-person summary of segment ${seq}.`,
});

const fold = (
  seq: number,
  covers: string[],
  level = 1,
  summary = `Merged fold summary ${seq}.`
): BoardLineFoldNode => ({
  meta: {
    v: 1,
    id: `fld_${seq.toString(16).padStart(8, '0')}`,
    kind: 'fold',
    seq,
    level,
    coversFrom: '2026-11-01T08:00:00.000Z',
    coversTo: '2026-11-05T09:30:00.000Z',
    title: `Fold ${seq}`,
    tags: ['milestone'],
    summaryQuality: 'written',
    createdAt: '2026-11-05T10:00:00.000Z',
    covers,
    coveredTurns: 20,
    coveredSegments: 5,
  },
  summary,
});

describe('extractRecentCoordinatorContext', () => {
  it('filters maintenance entries, strips thinking/tool output, and keeps last 4 user messages + last 2 Q&A rounds', () => {
    const history: SessionHistoryInput[] = [];
    for (let i = 1; i <= 6; i++) {
      history.push({
        id: `u-${i}`,
        role: 'user',
        timestamp: `2026-11-25T10:0${i}:00.000Z`,
        items: [{ type: 'text', text: `User message ${i}` }],
        fileDiff: [],
      });
      history.push({
        id: `a-${i}`,
        role: 'assistant',
        userTurnId: `u-${i}`,
        timestamp: `2026-11-25T10:0${i}:30.000Z`,
        finished: true,
        items: [
          { type: 'thought', text: `Secret reasoning ${i}` },
          {
            type: 'tool_call',
            toolCallId: `tc-${i}`,
            title: 'Huge tool output',
            status: 'completed',
          },
          { type: 'text', text: `Visible answer ${i}` },
        ],
        fileDiff: [],
      });
    }
    // Interleave a maintenance divider and its hidden assistant replies.
    history.push(
      boardMaintenanceTurn(
        'run-1',
        { boardId: 'bd_1', kind: 'fold_rollover', trigger: 'idle', status: 'running' },
        '2026-11-25T10:10:00.000Z'
      )
    );
    history.push({
      id: `assistant:${boardMaintenanceStepId('run-1', 'seal')}`,
      role: 'assistant',
      userTurnId: boardMaintenanceStepId('run-1', 'seal'),
      timestamp: '2026-11-25T10:10:05.000Z',
      finished: true,
      items: [{ type: 'text', text: '{"title":"seal","summary":"internal"}' }],
      fileDiff: [],
    });

    const extracted = extractRecentCoordinatorContext(history);
    expect(extracted.recentUserMessages.map((m) => m.text)).toEqual([
      'User message 3',
      'User message 4',
      'User message 5',
      'User message 6',
    ]);
    expect(extracted.recentExchanges).toHaveLength(2);
    expect(extracted.recentExchanges[0]).toMatchObject({
      userTurnId: 'u-5',
      userText: 'User message 5',
      assistantText: 'Visible answer 5',
    });
    expect(extracted.recentExchanges[1]).toMatchObject({
      userTurnId: 'u-6',
      userText: 'User message 6',
      assistantText: 'Visible answer 6',
    });
    expect(JSON.stringify(extracted)).not.toContain('Secret reasoning');
    expect(JSON.stringify(extracted)).not.toContain('Huge tool output');
    expect(JSON.stringify(extracted)).not.toContain('internal');
  });

  it('excludes agent/system/unknown-authored and legacy agent-sender role:user turns from human context', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'u-human-explicit',
        role: 'user',
        timestamp: '2026-11-25T10:00:00.000Z',
        author: { v: 1, kind: 'human', userId: 'user-1' },
        items: [{ type: 'text', text: 'Explicit human ask' }],
        fileDiff: [],
      },
      {
        id: 'a-human-explicit',
        role: 'assistant',
        userTurnId: 'u-human-explicit',
        timestamp: '2026-11-25T10:00:05.000Z',
        finished: true,
        items: [{ type: 'text', text: 'Reply to human' }],
        fileDiff: [],
      },
      {
        id: 'u-agent-author',
        role: 'user',
        timestamp: '2026-11-25T10:01:00.000Z',
        author: {
          v: 1,
          kind: 'agent',
          sessionId: 'worker-1',
          turnId: 'worker-turn-1',
          name: 'Worker',
        },
        items: [{ type: 'text', text: 'Agent delegated report payload' }],
        fileDiff: [],
      },
      {
        id: 'u-system-author',
        role: 'user',
        timestamp: '2026-11-25T10:02:00.000Z',
        author: { v: 1, kind: 'system' },
        items: [{ type: 'text', text: 'System trigger payload' }],
        fileDiff: [],
      },
      {
        id: 'u-legacy-agent-header',
        role: 'user',
        timestamp: '2026-11-25T10:03:00.000Z',
        items: [
          {
            type: 'text',
            text: '[Lody] This message was sent by another agent, not by a human.\nWorker done.',
          },
        ],
        fileDiff: [],
      },
      {
        id: 'u-legacy-human',
        role: 'user',
        timestamp: '2026-11-25T10:04:00.000Z',
        items: [{ type: 'text', text: 'Legacy unattributed human ask' }],
        fileDiff: [],
      },
      {
        id: 'a-legacy-human',
        role: 'assistant',
        userTurnId: 'u-legacy-human',
        timestamp: '2026-11-25T10:04:05.000Z',
        finished: true,
        items: [{ type: 'text', text: 'Reply to legacy human' }],
        fileDiff: [],
      },
    ];

    expect(isHumanUserTurn(history[0]!)).toBe(true);
    expect(isHumanUserTurn(history[2]!)).toBe(false);
    expect(isHumanUserTurn(history[3]!)).toBe(false);
    expect(isHumanUserTurn(history[4]!)).toBe(false);
    expect(isHumanUserTurn(history[5]!)).toBe(true);

    const extracted = extractRecentCoordinatorContext(history);
    expect(extracted.recentUserMessages.map((m) => m.turnId)).toEqual([
      'u-human-explicit',
      'u-legacy-human',
    ]);
    expect(extracted.recentExchanges.map((e) => e.userTurnId)).toEqual([
      'u-human-explicit',
      'u-legacy-human',
    ]);
    expect(JSON.stringify(extracted)).not.toContain('Agent delegated report payload');
    expect(JSON.stringify(extracted)).not.toContain('System trigger payload');
    expect(JSON.stringify(extracted)).not.toContain('Worker done.');
  });
});

describe('buildBoardFoldOpening', () => {
  it('deterministically renders folds, pinned nodes, recent tree (1-line earlier + 2 full recent), threads, verbatim context, and expand guide', () => {
    const s1 = seg(1);
    const s2 = seg(2);
    const f1 = fold(3, [s1.meta.id, s2.meta.id], 1, 'Early architecture settled.');
    const s3 = seg(4, {}, 'Third segment summary that should appear only as one line.');
    const s4 = seg(5, {}, 'Fourth segment full summary A.');
    const s5 = seg(6, {}, 'Fifth segment full summary B.');
    const tree = buildBoardLineTree([s1, s2, f1, s3, s4, s5], [s1.meta.id]);

    const threads: SessionMeta[] = [
      { id: 't-active' as SessionId, title: 'Implement store', isArchived: false } as SessionMeta,
      { id: 't-old' as SessionId, title: 'Old spike', isArchived: true } as SessionMeta,
    ];
    const input = {
      sessionId: 'coord-1' as SessionId,
      board: { id: 'bd_1' as never, name: 'Lody Lan' },
      tree,
      threads,
      recentUserMessages: [
        { turnId: 'u1', timestamp: '2026-11-25T10:00:00.000Z', text: 'First recent ask' },
        { turnId: 'u2', timestamp: '2026-11-25T10:05:00.000Z', text: 'Second recent ask' },
        { turnId: 'u3', timestamp: '2026-11-25T10:10:00.000Z', text: 'Third recent ask' },
        { turnId: 'u4', timestamp: '2026-11-25T10:15:00.000Z', text: 'Fourth recent ask' },
      ],
      recentExchanges: [
        {
          userTurnId: 'u3',
          timestamp: '2026-11-25T10:10:00.000Z',
          userText: 'Third recent ask',
          assistantText: 'Third visible reply',
        },
        {
          userTurnId: 'u4',
          timestamp: '2026-11-25T10:15:00.000Z',
          userText: 'Fourth recent ask',
          assistantText: 'Fourth visible reply',
        },
      ],
      nowIso: '2026-11-25T10:30:00.000Z',
      lastSegmentEndedAtIso: '2026-11-25T10:15:00.000Z',
      usage: { used: 168_000, size: 1_000_000 },
    };

    const out1 = buildBoardFoldOpening(input);
    const out2 = buildBoardFoldOpening(input);
    expect(out1).toBe(out2);

    // Folded history + [PINNED] preserved separately at the end of folded section.
    expect(out1).toContain(
      '[fld_00000003 · 2026-11-01 ~ 2026-11-05 · 覆盖 5 段 / 20 轮] Early architecture settled.'
    );
    expect(out1).toContain('[PINNED] [seg_00000001 ·');
    expect(out1.indexOf('Early architecture settled.')).toBeLessThan(out1.indexOf('[PINNED]'));

    // Recent segment tree: s3 one-line (no full body), s4 and s5 full summaries.
    expect(out1).toContain('seg_00000004 |');
    expect(out1).not.toContain('Third segment summary that should appear only as one line.');
    expect(out1).toContain('Fourth segment full summary A.');
    expect(out1).toContain('Fifth segment full summary B.');

    // Threads + verbatim + expand guide.
    expect(out1).toContain('Implement store — t-active');
    expect(out1).toContain('Old spike — t-old (archived)');
    expect(out1).toContain('First recent ask');
    expect(out1).toContain('Fourth visible reply');
    expect(out1).toContain('15m');
    expect(out1).toContain('168000 / 1000000');
    expect(out1).toContain('lody_board_line_expand');
    expect(out1).toContain('lody_board_line_pin');
    expect(estimateTokenCount(out1)).toBeLessThanOrEqual(BOARD_FOLD_OPENING_MAX_TOKENS);
  });

  it('strictly stays within the 14,000-token ceiling under huge history, many folds, and many threads', () => {
    const nodes: BoardLineNode[] = [];
    const hugeParagraph = '大量历史决策与细节记录。'.repeat(2500);
    for (let i = 1; i <= 10; i++) {
      const a = seg(i * 3 - 2, {}, hugeParagraph);
      const b = seg(i * 3 - 1, {}, hugeParagraph);
      const f = fold(i * 3, [a.meta.id, b.meta.id], 1, hugeParagraph);
      nodes.push(a, b, f);
    }
    for (let i = 31; i <= 42; i++) {
      nodes.push(seg(i, {}, hugeParagraph));
    }
    const pinnedId = nodes[0]!.meta.id;
    const tree = buildBoardLineTree(nodes, [pinnedId]);
    const threads = Array.from({ length: 200 }, (_, i) => ({
      id: `thread-${String(i).padStart(3, '0')}` as SessionId,
      title: `Long running thread title number ${i} with extra words`,
      isArchived: i >= 120,
    })) as SessionMeta[];
    const hugeUtterance = '用户长消息原文 '.repeat(3000);
    const opening = buildBoardFoldOpening({
      sessionId: 'coord-huge' as SessionId,
      board: { id: 'bd_huge' as never, name: 'Huge Board' },
      tree,
      threads,
      recentUserMessages: Array.from({ length: 4 }, (_, i) => ({
        turnId: `u-${i}`,
        timestamp: `2026-11-25T10:0${i}:00.000Z`,
        text: hugeUtterance,
      })),
      recentExchanges: Array.from({ length: 2 }, (_, i) => ({
        userTurnId: `u-${i + 2}`,
        timestamp: `2026-11-25T10:0${i + 2}:00.000Z`,
        userText: hugeUtterance,
        assistantText: hugeUtterance,
      })),
      nowIso: '2026-11-25T12:00:00.000Z',
      lastSegmentEndedAtIso: '2026-11-25T10:00:00.000Z',
      usage: { used: 195_000, size: 200_000 },
    });

    expect(estimateTokenCount(opening)).toBeLessThanOrEqual(BOARD_FOLD_OPENING_MAX_TOKENS);
    expect(opening).toContain(`[PINNED] [${pinnedId}`);
    expect(opening).toContain('lody_board_line_expand');
  });

  it('deducts reservedTokens for appended Board instructions and preserves core header floor on extreme instructions', () => {
    const hugeParagraph = '大量历史决策与上下文细节记录。'.repeat(1800);
    const s1 = seg(1, {}, hugeParagraph);
    const s2 = seg(2, {}, hugeParagraph);
    const s3 = seg(3, {}, hugeParagraph);
    const tree = buildBoardLineTree([s1, s2, s3], [s1.meta.id]);
    const baseInput = {
      sessionId: 'coord-reserved' as SessionId,
      board: { id: 'bd_reserved' as never, name: 'Reserved Budget Board' },
      tree,
      threads: Array.from({ length: 40 }, (_, i) => ({
        id: `t-${i}` as SessionId,
        title: `Thread ${i}`,
      })) as SessionMeta[],
      recentUserMessages: [
        { turnId: 'u-1', timestamp: '2026-11-25T10:00:00.000Z', text: hugeParagraph },
      ],
      recentExchanges: [
        {
          userTurnId: 'u-1',
          timestamp: '2026-11-25T10:00:00.000Z',
          userText: hugeParagraph,
          assistantText: hugeParagraph,
        },
      ],
      nowIso: '2026-11-25T12:00:00.000Z',
      lastSegmentEndedAtIso: '2026-11-25T10:00:00.000Z',
    };

    for (const reservedTokens of [4_000, 9_500]) {
      const opening = buildBoardFoldOpening({ ...baseInput, reservedTokens });
      expect(estimateTokenCount(opening) + reservedTokens).toBeLessThanOrEqual(
        BOARD_FOLD_OPENING_MAX_TOKENS
      );
      expect(opening).toContain(`[PINNED] [${s1.meta.id}`);
      expect(opening).toContain('lody_board_line_expand');
    }

    // Even if user Board instructions exceed 14,000 tokens alone, opening falls back cleanly to core floor.
    const extreme = buildBoardFoldOpening({ ...baseInput, reservedTokens: 16_000 });
    expect(estimateTokenCount(extreme)).toBeLessThanOrEqual(BOARD_FOLD_OPENING_MIN_CORE_BUDGET);
    expect(extreme).toContain('Board coordinator');
    expect(extreme).toContain('lody_board_line_expand');
  });
});
