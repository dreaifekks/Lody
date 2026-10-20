import {
  readLatestDrivingTurn,
  boardReportOperationId,
  assistantOutputPreview,
  isBoardSessionStopped,
} from '../src/board';
import { LodyOperationIdSchema } from '../src/session-orchestration';
import type { SessionId } from '../src/ids';
import type { SessionHistoryInput, SessionMeta } from '../src/schema';
import { LoroDoc } from 'loro-crdt';
import { readBoardDocument, writeBoardNotes, BOARD_NOTES_MAX_BYTES } from '../src/board-repository';
import { describe, expect, it } from 'vitest';
import {
  normalizeBoardMeta,
  deriveBoardSessionStatus,
  boardProjectScope,
  isProjectInBoardScope,
} from '../src/board';
import {
  DEFAULT_BOARD_CONTINUITY,
  boardCompactionThreshold,
  boardMaintenanceTurn,
  decideBoardIdleCompaction,
  isBoardMaintenanceEntry,
  readBoardMaintenance,
} from '../src/board-continuity';
import { MessageContentSchema } from '../src/message-schemas';
import {
  applyWorkspaceFlockRowEvents,
  listWorkspaceBoards,
  parseWorkspaceFlockRow,
} from '../src/workspace-flock';

const board = {
  version: 1,
  id: 'bd_test',
  name: 'Board',
  purpose: 'Build a feature',
  coordinatorSessionId: 'coordinator',
  createdAtMs: 1,
  createdByUserId: 'user',
};

describe('boards in the workspace catalog', () => {
  it('normalizes defaults and preserves bounded Unicode text and future fields safely', () => {
    expect(normalizeBoardMeta({ ...board, name: '看'.repeat(80), future: true })).toEqual({
      ...board,
      name: '看'.repeat(80),
      instructions: '',
      rules: { maxRoundsPerThread: 4, reportHumanTurns: false, executorConstraints: '' },
      continuity: { idleCompaction: true, idleMinutes: 10, maxTokens: 150_000, windowPercent: 40 },
    });
    // A Board may start from its name alone.
    const { purpose: _purpose, ...named } = board;
    expect(normalizeBoardMeta(named)).toMatchObject({ purpose: '', instructions: '' });
    expect(normalizeBoardMeta({ ...board, instructions: 'x'.repeat(16_000) })).not.toBeNull();
    expect(normalizeBoardMeta({ ...board, instructions: 'x'.repeat(16_001) })).toBeNull();
    expect(normalizeBoardMeta({ ...board, name: '😀'.repeat(81) })).toBeNull();
    expect(normalizeBoardMeta({ ...board, purpose: 'x'.repeat(4001) })).toBeNull();
    expect(normalizeBoardMeta({ ...board, rules: { maxRoundsPerThread: 0 } })).toBeNull();
    expect(
      normalizeBoardMeta({ ...board, rules: { executorConstraints: 'x'.repeat(2001) } })
    ).toBeNull();
  });
  it('reads a project scope, where a missing or empty list means every project', () => {
    const old = normalizeBoardMeta(board);
    expect(old?.context).toBeUndefined();
    expect(old && boardProjectScope(old)).toBeUndefined();
    const empty = normalizeBoardMeta({ ...board, context: { projects: [] } });
    expect(empty && boardProjectScope(empty)).toBeUndefined();
    const projects = [
      { kind: 'local', machineId: 'm1', localProjectId: 'p1', name: 'Lody' },
      { kind: 'local', machineId: 'm2', localProjectId: 'p2', name: 'Lody' },
      { kind: 'github', repoFullName: 'Owner/Repo' },
    ];
    const narrowed = normalizeBoardMeta({ ...board, context: { projects } });
    const scope = (narrowed && boardProjectScope(narrowed)) ?? [];
    expect(scope).toEqual(projects);
    expect(normalizeBoardMeta({ ...board, context: { projects: [{ kind: 'local' }] } })).toBeNull();
    // A local project matches only on its own machine; a repository by name.
    const local = { kind: 'local', machineId: 'm2', localProjectId: 'p2' } as const;
    expect(isProjectInBoardScope(scope, local)).toBe(true);
    expect(isProjectInBoardScope(scope, { ...local, machineId: 'm1' })).toBe(false);
    expect(isProjectInBoardScope(scope, { kind: 'github', repoFullName: 'owner/repo' })).toBe(
      true
    );
    expect(isProjectInBoardScope(scope, { kind: 'github', repoFullName: 'owner/other' })).toBe(
      false
    );
  });
  it('lists, updates and removes rows and rejects mismatched row identities', () => {
    const key = ['board', board.id];
    expect(parseWorkspaceFlockRow(['board', 'bd_other'], board)).toBeUndefined();
    const rows = applyWorkspaceFlockRowEvents({}, [{ key, value: board }]);
    expect(listWorkspaceBoards(rows).map((entry) => entry.name)).toEqual(['Board']);
    const changed = applyWorkspaceFlockRowEvents(rows, [
      { key, value: { ...board, name: 'Renamed' } },
    ]);
    expect(listWorkspaceBoards(changed)[0]?.name).toBe('Renamed');
    expect(listWorkspaceBoards(applyWorkspaceFlockRowEvents(changed, [{ key }]))).toEqual([]);
  });
});

describe('board status', () => {
  it('uses live activity, waiting and finalization signals ahead of transcript facts', () => {
    expect(
      deriveBoardSessionStatus({
        liveStatus: { type: 'running' },
        lastUserTurn: { status: 'failed' },
      })
    ).toBe('running');
    expect(deriveBoardSessionStatus({ liveStatus: { type: 'initializing' } })).toBe('initializing');
    expect(deriveBoardSessionStatus({ liveStatus: { type: 'running', phase: 'finalizing' } })).toBe(
      'finalizing'
    );
    expect(
      deriveBoardSessionStatus({ liveStatus: { type: 'running' }, awaitingUserSince: 10 })
    ).toBe('running');
    expect(deriveBoardSessionStatus({ liveStatus: { type: 'requestPermission' } })).toBe(
      'waiting_user'
    );
  });
  it('only uses a waiting marker newer than the last completed turn when presence is absent', () => {
    expect(deriveBoardSessionStatus({ awaitingUserSince: 10, lastMessageAt: 20 })).toBe('idle');
    expect(deriveBoardSessionStatus({ awaitingUserSince: 20, lastMessageAt: 20 })).toBe('idle');
    expect(deriveBoardSessionStatus({ awaitingUserSince: 21, lastMessageAt: 20 })).toBe(
      'waiting_user'
    );
    expect(
      deriveBoardSessionStatus({
        awaitingUserSince: 21,
        lastMessageAt: 20,
        liveStatus: { type: 'initializing' },
      })
    ).toBe('initializing');
    expect(
      deriveBoardSessionStatus({
        awaitingUserSince: 21,
        lastMessageAt: 20,
        liveStatus: { type: 'running', phase: 'finalizing' },
      })
    ).toBe('finalizing');
  });
  it('distinguishes failed, agent-dispatched and human turns while idle', () => {
    expect(deriveBoardSessionStatus({ lastUserTurn: { status: 'failed' } })).toBe('failed');
    expect(deriveBoardSessionStatus({ chatFailed: true })).toBe('failed');
    expect(
      deriveBoardSessionStatus({
        lastUserTurn: { author: { v: 1, kind: 'agent', sessionId: 'executor' as never } },
      })
    ).toBe('waiting_coordinator');
    expect(
      deriveBoardSessionStatus({
        lastUserTurn: { author: { v: 1, kind: 'human', userId: 'user' } },
      })
    ).toBe('idle');
    expect(deriveBoardSessionStatus({})).toBe('idle');
  });
});

describe('shared Board notes', () => {
  it('merges simultaneous appends from two replicas without losing either section', () => {
    const a = new LoroDoc();
    writeBoardNotes(a, { kind: 'replace', text: 'Goal\n', updatedBy: 'user', now: 1 });
    const b = new LoroDoc();
    b.import(a.export({ mode: 'snapshot' }));
    writeBoardNotes(a, { kind: 'append', text: '## A\nresult A\n', updatedBy: 'a', now: 2 });
    writeBoardNotes(b, { kind: 'append', text: '## B\nresult B\n', updatedBy: 'b', now: 2 });
    const aChanges = a.export({ mode: 'update' });
    const bChanges = b.export({ mode: 'update' });
    a.import(bChanges);
    b.import(aChanges);
    expect(readBoardDocument(a)).toEqual(readBoardDocument(b));
    expect(readBoardDocument(a).notes).toMatch(/^Goal\n/);
    expect(readBoardDocument(a).notes).toContain('## A\nresult A\n');
    expect(readBoardDocument(a).notes).toContain('## B\nresult B\n');
  });
  it('rejects UTF-8 overflow before modifying text or metadata and permits a reducing replacement', () => {
    const doc = new LoroDoc();
    const full = 'x'.repeat(BOARD_NOTES_MAX_BYTES - 2);
    writeBoardNotes(doc, { kind: 'replace', text: full, updatedBy: 'user', now: 1 });
    expect(() =>
      writeBoardNotes(doc, { kind: 'append', text: '看', updatedBy: 'agent', now: 2 })
    ).toThrow('BOARD_NOTES_CAPACITY');
    expect(readBoardDocument(doc)).toEqual({
      notes: full,
      meta: { updatedBy: 'user', updatedAtMs: 1 },
    });
    writeBoardNotes(doc, { kind: 'replace', text: 'short', updatedBy: 'user', now: 3 });
    expect(readBoardDocument(doc).notes).toBe('short');
  });
});

describe('Board report state', () => {
  const turn = (id: string, extra: Partial<SessionHistoryInput> = {}): SessionHistoryInput => ({
    id,
    role: 'user',
    timestamp: '2026-10-16T00:00:00.000Z',
    inputConfig: { chainDepth: 2 },
    items: [],
    ...extra,
  });
  it('finds system-driven work without treating progress and limit notices as inputs', () => {
    const continuation = turn('batch', { role: 'system' });
    expect(
      readLatestDrivingTurn([
        turn('user'),
        continuation,
        turn('progress', { role: 'system', inputConfig: undefined }),
      ])
    ).toEqual(continuation);
  });
  it('produces scoped deterministic ids accepted by the existing Operation schema', () => {
    const event = {
      sessionId: 'very:long/member/'.repeat(20) as SessionId,
      turnId: 'turn:with:punctuation',
      kind: 'notice' as const,
      noticeId: 'notice',
    };
    const id = boardReportOperationId(event);
    expect(LodyOperationIdSchema.parse(id)).toBe(id);
    expect(boardReportOperationId(event)).toBe(id);
    expect(boardReportOperationId({ ...event, noticeId: 'other' })).not.toBe(id);
  });
  it('keeps a tail-weighted UTF-8 preview and omission evidence', () => {
    const text = 'Start '.repeat(5000) + 'End 结论'.repeat(10000);
    const output = assistantOutputPreview({ items: [{ type: 'text', text }] })!;
    expect(new TextEncoder().encode(output.text).byteLength).toBeLessThanOrEqual(32 * 1024);
    expect(output).toMatchObject({ truncated: true });
    expect(output.text.startsWith('Start')).toBe(true);
    expect(output.text.endsWith('End 结论')).toBe(true);
    expect(output.omittedBytes).toBeGreaterThan(0);
  });
});

it('shows an inherited collaboration stop even when the ancestor is outside the Board', () => {
  const root = { id: 'root', collaborationStopped: true } as SessionMeta;
  const member = { id: 'member', openedBySessionId: 'root' } as SessionMeta;
  expect(isBoardSessionStopped(member, (id) => (id === root.id ? root : undefined))).toBe(true);
  expect(deriveBoardSessionStatus({ collaborationStopped: true })).toBe('stopped');
});

describe('coordinator continuity', () => {
  const idle = (overrides: Partial<Parameters<typeof decideBoardIdleCompaction>[0]> = {}) =>
    decideBoardIdleCompaction({
      settings: DEFAULT_BOARD_CONTINUITY,
      usage: { used: 160_000, size: 1_000_000 },
      pendingTokens: 0,
      idleSinceMs: 0,
      nowMs: 10 * 60_000,
      ...overrides,
    });

  it('compacts at the smaller of the token cap and the window share', () => {
    expect(boardCompactionThreshold(1_000_000, DEFAULT_BOARD_CONTINUITY)).toBe(150_000);
    expect(boardCompactionThreshold(200_000, DEFAULT_BOARD_CONTINUITY)).toBe(80_000);
    expect(boardCompactionThreshold(undefined, DEFAULT_BOARD_CONTINUITY)).toBe(150_000);
  });

  it('waits for the idle period, needs the threshold and honors the switch', () => {
    expect(idle()).toEqual({ kind: 'compact' });
    expect(idle({ nowMs: 4 * 60_000 })).toEqual({ kind: 'wait', delayMs: 6 * 60_000 });
    expect(idle({ usage: { used: 149_999, size: 1_000_000 } })).toEqual({
      kind: 'none',
      reason: 'below-threshold',
    });
    expect(idle({ usage: { used: 81_000, size: 200_000 } })).toEqual({ kind: 'compact' });
    // Results waiting for the next input count: they arrive with it.
    expect(idle({ usage: { used: 140_000, size: 1_000_000 }, pendingTokens: 10_000 })).toEqual({
      kind: 'compact',
    });
    expect(
      idle({ usage: { used: 140_000, size: 1_000_000 }, pendingTokens: 10_000, nowMs: 60_000 })
    ).toEqual({ kind: 'wait', delayMs: 9 * 60_000 });
    expect(idle({ usage: { used: 140_000, size: 1_000_000 }, pendingTokens: 9_999 })).toEqual({
      kind: 'none',
      reason: 'below-threshold',
    });
    expect(idle({ usage: undefined, pendingTokens: 200_000 })).toEqual({
      kind: 'none',
      reason: 'no-usage',
    });
    expect(idle({ usage: undefined })).toEqual({ kind: 'none', reason: 'no-usage' });
    expect(
      idle({ settings: { ...DEFAULT_BOARD_CONTINUITY, idleCompaction: false } })
    ).toEqual({ kind: 'none', reason: 'disabled' });
    expect(normalizeBoardMeta({ ...board, continuity: { idleMinutes: 0 } })).toBeNull();
  });

  it('stores a divider that history accepts and hides only maintenance replies', () => {
    const turn = boardMaintenanceTurn(
      'run-1',
      { boardId: 'bd_1', kind: 'compact', trigger: 'idle', status: 'done', usedBefore: 1 },
      '2026-10-17T00:00:00.000Z'
    );
    // The history writer parses each item with the shared content schema.
    expect(turn.items?.every((item) => MessageContentSchema.safeParse(item).success)).toBe(true);
    expect(readBoardMaintenance(turn)).toMatchObject({ kind: 'compact', status: 'done' });
    expect(readBoardMaintenance({ ...turn, id: 'other' })).toBeUndefined();
    expect(
      isBoardMaintenanceEntry({ role: 'assistant', userTurnId: 'board-maintenance:run-1:memory' })
    ).toBe(true);
    expect(isBoardMaintenanceEntry({ role: 'assistant', userTurnId: 'user-1' })).toBe(false);
  });
});
