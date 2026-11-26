import { describe, expect, it } from 'vitest';
import {
  SESSION_ROLLOVER_TURN_PREFIX,
  SessionRolloverNoticeMetaSchema,
  buildReplayPromptFromHistory,
  createReplayPromptBuilder,
  decideSessionAutoRollover,
  isSessionRolloverEntry,
  isSessionRolloverRenewEntry,
  isSessionRolloverSealEntry,
  isSessionRolloverTurnId,
  isSilentSessionRollover,
  readSessionRolloverNotice,
  sessionRolloverStepId,
  sessionRolloverThreshold,
  sessionRolloverTurn,
  sessionRolloverTurnId,
  type SessionHistoryInput,
  type SessionRolloverNoticeMeta,
} from '../src/index';
import { resolveEditableTail } from '../src/session-data/planner';

describe('session-rollover shared contracts', () => {
  it('classifies rollover turn ids, step ids, and hidden entries', () => {
    const runId = 'run-42';
    const dividerId = sessionRolloverTurnId(runId);
    const sealId = sessionRolloverStepId(runId, 'seal');
    const renewId = sessionRolloverStepId(runId, 'renew');

    expect(dividerId).toBe(`${SESSION_ROLLOVER_TURN_PREFIX}${runId}`);
    expect(sealId).toBe(`${SESSION_ROLLOVER_TURN_PREFIX}${runId}:seal`);
    expect(renewId).toBe(`${SESSION_ROLLOVER_TURN_PREFIX}${runId}:renew`);

    expect(isSessionRolloverTurnId(dividerId)).toBe(true);
    expect(isSessionRolloverTurnId(sealId)).toBe(true);
    expect(isSessionRolloverTurnId(renewId)).toBe(true);
    expect(isSessionRolloverTurnId('user-1')).toBe(false);
    expect(isSessionRolloverTurnId(undefined)).toBe(false);

    const sealEntry = { role: 'assistant' as const, userTurnId: sealId };
    const renewEntry = { role: 'assistant' as const, userTurnId: renewId };
    const normalEntry = { role: 'assistant' as const, userTurnId: 'user-1' };

    expect(isSessionRolloverEntry(sealEntry)).toBe(true);
    expect(isSessionRolloverSealEntry(sealEntry)).toBe(true);
    expect(isSessionRolloverRenewEntry(sealEntry)).toBe(false);

    expect(isSessionRolloverEntry(renewEntry)).toBe(true);
    expect(isSessionRolloverSealEntry(renewEntry)).toBe(false);
    expect(isSessionRolloverRenewEntry(renewEntry)).toBe(true);

    expect(isSessionRolloverEntry(normalEntry)).toBe(false);
    expect(isSessionRolloverEntry({ role: 'user', userTurnId: sealId })).toBe(false);
  });

  it('builds and parses rollover divider notices and silent auto-interruption flags', () => {
    const doneMeta: SessionRolloverNoticeMeta = {
      kind: 'linear_rollover',
      trigger: 'auto',
      status: 'done',
      generation: 2,
      nodeId: 'n_0002',
      usedBefore: 352_000,
      usedAfter: 26_000,
    };
    const doneTurn = sessionRolloverTurn('r1', doneMeta, '2026-11-27T04:00:00.000Z');
    expect(doneTurn.finished).toBe(true);
    expect(readSessionRolloverNotice(doneTurn)).toEqual(doneMeta);
    expect(readSessionRolloverNotice({ ...doneTurn, id: 'other-id' })).toBeUndefined();
    expect(SessionRolloverNoticeMetaSchema.safeParse(doneMeta).success).toBe(true);

    const sealedTurn = sessionRolloverTurn(
      'r2',
      { kind: 'linear_rollover', trigger: 'manual', status: 'sealed', generation: 1 },
      '2026-11-27T04:00:00.000Z'
    );
    expect(sealedTurn.finished).toBeUndefined();

    expect(
      isSilentSessionRollover({
        kind: 'linear_rollover',
        trigger: 'auto',
        status: 'interrupted',
        generation: 1,
      })
    ).toBe(true);
    expect(
      isSilentSessionRollover({
        kind: 'linear_rollover',
        trigger: 'manual',
        status: 'interrupted',
        generation: 1,
      })
    ).toBe(false);
  });

  it('computes thresholds across window sizes and fallback', () => {
    expect(sessionRolloverThreshold(1_000_000)).toBe(350_000);
    expect(sessionRolloverThreshold(200_000)).toBe(70_000);
    expect(sessionRolloverThreshold(400_000)).toBe(140_000);
    expect(sessionRolloverThreshold(2_000_000)).toBe(350_000);
    expect(sessionRolloverThreshold(undefined)).toBe(350_000);
    expect(sessionRolloverThreshold(0)).toBe(350_000);
    expect(sessionRolloverThreshold(1_000_000, { maxTokens: 200_000, windowRatio: 0.4 })).toBe(
      200_000
    );
  });

  it('enforces all auto-rollover safety gates and min 80k delta', () => {
    const base = {
      usage: { size: 1_000_000, used: 360_000 },
      usedAfterLastRollover: 30_000,
    };
    expect(decideSessionAutoRollover(base)).toEqual({
      shouldRollover: true,
      threshold: 350_000,
      used: 360_000,
      delta: 330_000,
    });

    // Delta < 80k blocked (prevents flapping)
    expect(
      decideSessionAutoRollover({
        usage: { size: 1_000_000, used: 360_000 },
        usedAfterLastRollover: 300_000,
      })
    ).toMatchObject({ shouldRollover: false, reason: 'below_min_delta' });

    // Below threshold blocked
    expect(
      decideSessionAutoRollover({
        usage: { size: 1_000_000, used: 349_999 },
      })
    ).toMatchObject({ shouldRollover: false, reason: 'below_threshold', threshold: 350_000 });

    // Safety gates
    expect(decideSessionAutoRollover({ ...base, enabled: false })).toMatchObject({
      shouldRollover: false,
      reason: 'disabled',
    });
    expect(decideSessionAutoRollover({ ...base, isBoardCoordinator: true })).toMatchObject({
      shouldRollover: false,
      reason: 'coordinator',
    });
    expect(decideSessionAutoRollover({ ...base, isGoalActive: true })).toMatchObject({
      shouldRollover: false,
      reason: 'goal_active',
    });
    expect(decideSessionAutoRollover({ ...base, hasPinnedNativeSessionId: true })).toMatchObject({
      shouldRollover: false,
      reason: 'pinned_native_session',
    });
    expect(decideSessionAutoRollover({ ...base, hasPendingNativeWork: true })).toMatchObject({
      shouldRollover: false,
      reason: 'pending_native_work',
    });
    expect(decideSessionAutoRollover({ ...base, hasQueuedUserMessages: true })).toMatchObject({
      shouldRollover: false,
      reason: 'queued_messages',
    });
    expect(decideSessionAutoRollover({ ...base, hasPendingSwitch: true })).toMatchObject({
      shouldRollover: false,
      reason: 'pending_switch',
    });
    expect(decideSessionAutoRollover({ ...base, compactedInThisTurn: true })).toMatchObject({
      shouldRollover: false,
      reason: 'compacted_in_turn',
    });
    expect(decideSessionAutoRollover({ ...base, usage: undefined })).toMatchObject({
      shouldRollover: false,
      reason: 'no_usage',
    });
  });

  it('replay-prompt-builder respects afterTurnId boundary and skips rollover turns (Hard Trap #2)', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'u1',
        role: 'user',
        timestamp: '2026-11-27T01:00:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'OLD PRE-ROLLOVER SECRET CONTEXT' }],
      },
      {
        id: 'assistant:u1',
        role: 'assistant',
        userTurnId: 'u1',
        timestamp: '2026-11-27T01:00:05Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'OLD PRE-ROLLOVER ANSWER' }],
      },
      sessionRolloverTurn(
        'r1',
        { kind: 'linear_rollover', trigger: 'manual', status: 'done', generation: 1 },
        '2026-11-27T01:01:00Z'
      ),
      {
        id: `assistant:${sessionRolloverStepId('r1', 'seal')}`,
        role: 'assistant',
        userTurnId: sessionRolloverStepId('r1', 'seal'),
        timestamp: '2026-11-27T01:01:01Z',
        fileDiff: [],
        items: [{ type: 'text', text: '{"stateCard":{}}' }],
      },
      {
        id: `assistant:${sessionRolloverStepId('r1', 'renew')}`,
        role: 'assistant',
        userTurnId: sessionRolloverStepId('r1', 'renew'),
        timestamp: '2026-11-27T01:01:02Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Ready.' }],
      },
      {
        id: 'u2',
        role: 'user',
        timestamp: '2026-11-27T01:02:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'NEW NODE QUESTION' }],
      },
      {
        id: 'assistant:u2',
        role: 'assistant',
        userTurnId: 'u2',
        timestamp: '2026-11-27T01:02:05Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'NEW NODE ANSWER' }],
      },
      {
        id: 'u3',
        role: 'user',
        timestamp: '2026-11-27T01:03:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'CURRENT EXCLUDED TURN' }],
      },
    ];

    const fromHistory = buildReplayPromptFromHistory({
      history,
      afterTurnId: 'assistant:u1',
      excludeTurnId: 'u3',
    });
    expect(fromHistory.promptText).not.toContain('OLD PRE-ROLLOVER');
    expect(fromHistory.promptText).not.toContain('{"stateCard":{}}');
    expect(fromHistory.promptText).not.toContain('Ready.');
    expect(fromHistory.promptText).toContain('NEW NODE QUESTION');
    expect(fromHistory.promptText).toContain('NEW NODE ANSWER');
    expect(fromHistory.promptText).not.toContain('CURRENT EXCLUDED TURN');
    expect(fromHistory.stats.messagesIncluded).toBe(2);

    const streaming = createReplayPromptBuilder({
      afterTurnId: 'assistant:u1',
      excludeTurnId: 'u3',
    });
    for (const entry of history) streaming.add(entry);
    const streamed = streaming.finish();
    expect(streamed.promptText).toBe(fromHistory.promptText);
    expect(streamed.stats.messagesIncluded).toBe(2);
  });

  it('resolveEditableTail skips :seal, uses :renew acpTurnId, and blocks crossing done rollover dividers (Hard Trap #5)', () => {
    const sealId = sessionRolloverStepId('r1', 'seal');
    const renewId = sessionRolloverStepId('r1', 'renew');
    const doneDivider = sessionRolloverTurn(
      'r1',
      { kind: 'linear_rollover', trigger: 'manual', status: 'done', generation: 1 },
      '2026-11-27T01:01:00Z'
    );
    const sealedDivider = sessionRolloverTurn(
      'r1',
      { kind: 'linear_rollover', trigger: 'manual', status: 'sealed', generation: 1 },
      '2026-11-27T01:01:00Z'
    );

    // 1. Sealed (not yet switched) + hidden :seal assistant before a user turn -> skips :seal and uses A1.
    const beforeSwitch = [
      { id: 'u1', role: 'user', status: 'handled' },
      { id: 'assistant:u1', role: 'assistant', userTurnId: 'u1', finished: true, acpTurnId: 't1' },
      sealedDivider,
      { id: `assistant:${sealId}`, role: 'assistant', userTurnId: sealId, finished: true },
      { id: 'u2', role: 'user', status: 'handled' },
    ];
    expect(resolveEditableTail(beforeSwitch, 'u2')).toEqual({
      userIndex: 4,
      turn: beforeSwitch[4],
      forkTurnId: 't1',
    });

    // 2. Switched (done divider) + :renew with acpTurnId -> first user turn in new node uses :renew boundary!
    const afterSwitchWithRenew = [
      { id: 'u1', role: 'user', status: 'handled' },
      { id: 'assistant:u1', role: 'assistant', userTurnId: 'u1', finished: true, acpTurnId: 't1' },
      doneDivider,
      { id: `assistant:${sealId}`, role: 'assistant', userTurnId: sealId, finished: true },
      {
        id: `assistant:${renewId}`,
        role: 'assistant',
        userTurnId: renewId,
        finished: true,
        acpTurnId: 't-renew-1',
      },
      { id: 'u2', role: 'user', status: 'handled' },
      { id: 'assistant:u2', role: 'assistant', userTurnId: 'u2', finished: true, acpTurnId: 't2' },
    ];
    expect(resolveEditableTail(afterSwitchWithRenew, 'u2')).toEqual({
      userIndex: 5,
      turn: afterSwitchWithRenew[5],
      forkTurnId: 't-renew-1',
    });

    // 3. Second user turn in new node uses A2's acpTurnId.
    const secondTurnInNewNode = [
      ...afterSwitchWithRenew,
      { id: 'u3', role: 'user', status: 'handled' },
      { id: 'assistant:u3', role: 'assistant', userTurnId: 'u3', finished: true, acpTurnId: 't3' },
    ];
    expect(resolveEditableTail(secondTurnInNewNode, 'u3')).toEqual({
      userIndex: 7,
      turn: secondTurnInNewNode[7],
      forkTurnId: 't2',
    });

    // 4. New-node user turn WITHOUT a valid :renew acpTurnId CANNOT cross done divider to borrow old t1!
    // Works for both full turns (items present) and scalar-only directory rows (items absent, finished: true).
    const noRenewBoundaryFull = [
      { id: 'u1', role: 'user', status: 'handled' },
      { id: 'assistant:u1', role: 'assistant', userTurnId: 'u1', finished: true, acpTurnId: 't1' },
      doneDivider,
      { id: `assistant:${sealId}`, role: 'assistant', userTurnId: sealId, finished: true },
      { id: 'u2', role: 'user', status: 'handled' },
    ];
    expect(resolveEditableTail(noRenewBoundaryFull, 'u2')).toBeNull();

    const noRenewBoundaryScalarsOnly = [
      { id: 'u1', role: 'user', status: 'handled' },
      { id: 'assistant:u1', role: 'assistant', userTurnId: 'u1', finished: true, acpTurnId: 't1' },
      { id: sessionRolloverTurnId('r1'), role: 'system', finished: true },
      { id: `assistant:${sealId}`, role: 'assistant', userTurnId: sealId, finished: true },
      { id: 'u2', role: 'user', status: 'handled' },
    ];
    expect(resolveEditableTail(noRenewBoundaryScalarsOnly, 'u2')).toBeNull();

    // 5. Old-node last user turn followed by a completed done divider is NOT editable.
    const oldNodeClosed = [
      { id: 'u1', role: 'user', status: 'handled' },
      { id: 'assistant:u1', role: 'assistant', userTurnId: 'u1', finished: true, acpTurnId: 't1' },
      doneDivider,
    ];
    expect(resolveEditableTail(oldNodeClosed, 'u1')).toBeNull();
  });
});
