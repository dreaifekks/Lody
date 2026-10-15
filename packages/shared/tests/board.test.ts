import { LoroDoc } from 'loro-crdt';
import { readBoardDocument, writeBoardNotes, BOARD_NOTES_MAX_BYTES } from '../src/board-repository';
import { describe, expect, it } from 'vitest';
import { normalizeBoardMeta, deriveBoardSessionStatus } from '../src/board';
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
      rules: { maxRoundsPerThread: 4, reportHumanTurns: false, executorConstraints: '' },
    });
    expect(normalizeBoardMeta({ ...board, name: '😀'.repeat(81) })).toBeNull();
    expect(normalizeBoardMeta({ ...board, purpose: 'x'.repeat(4001) })).toBeNull();
    expect(normalizeBoardMeta({ ...board, rules: { maxRoundsPerThread: 0 } })).toBeNull();
    expect(
      normalizeBoardMeta({ ...board, rules: { executorConstraints: 'x'.repeat(2001) } })
    ).toBeNull();
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
