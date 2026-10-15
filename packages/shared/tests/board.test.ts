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
    ).toBe('waiting_user');
    expect(deriveBoardSessionStatus({ liveStatus: { type: 'requestPermission' } })).toBe(
      'waiting_user'
    );
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
