import {
  estimateTokenCount,
  type ACPSessionId,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type SessionRolloverNoticeMeta,
} from '@lody/shared';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@/utils/logger';
import { BOARD_CONTEXT_REMINDER_HEADER } from './board-compact-reinject';
import {
  SESSION_ROLLOVER_OPENING_MAX_TOKENS,
  buildColdTextStreamForSeal,
  buildLinearRolloverOpening,
  parseRolloverSealJson,
  parseSessionRolloverCommand,
  sliceRolloverSegmentEntries,
} from './session-rollover-opening';
import {
  SESSION_ROLLOVER_WARM_CACHE_TTL_MS,
  SessionRolloverService,
  buildLowEffortRunConfigForRenew,
  chooseSessionRolloverSealMode,
  createIsolatedColdRolloverSummarizer,
} from './session-rollover-service';
import {
  SESSION_ROLLOVER_MAX_SPINE_ENTRIES,
  SessionRolloverStoreReadError,
  createEmptySessionRolloverStateCard,
  createFileSessionRolloverStore,
  createMemorySessionRolloverStore,
  type SessionRolloverSpineItem,
  type SessionRolloverStateCard,
} from './session-rollover-store';

const SESSION_ID = 'session-rollover-unit' as SessionId;

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

const makeMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: SESSION_ID,
    title: 'Unit Test Session',
    machineId: 'machine-1',
    userId: 'user-1',
    cliType: 'registry',
    agentType: 'antigravity',
    acpSessionId: 'acp-1' as ACPSessionId,
    contextWindowUsage: { size: 1_000_000, used: 360_000 },
    ...overrides,
  }) as SessionMeta;

describe('session-rollover command parsing & pure helpers', () => {
  it('parses /rollover with and without hint and rejects prefix collisions', () => {
    expect(parseSessionRolloverCommand('/rollover')).toEqual({ matched: true });
    expect(parseSessionRolloverCommand('  /ROLLOVER  keep UI invariants  ')).toEqual({
      matched: true,
      hint: 'keep UI invariants',
    });
    expect(parseSessionRolloverCommand('/rollover2')).toEqual({ matched: false });
    expect(parseSessionRolloverCommand('/compact')).toEqual({ matched: false });
  });

  it('chooses warm vs cold seal mode strictly by process, TTL, and native-compact degradation', () => {
    const base = {
      hasLiveSession: true,
      hasLiveProcess: true,
      degradedByNativeCompact: false,
      lastActivityMs: 1_000_000,
      nowMs: 1_000_000 + 60_000,
    };
    expect(chooseSessionRolloverSealMode(base)).toBe('warm');
    expect(
      chooseSessionRolloverSealMode({
        ...base,
        nowMs: base.lastActivityMs + SESSION_ROLLOVER_WARM_CACHE_TTL_MS + 1,
      })
    ).toBe('cold');
    expect(chooseSessionRolloverSealMode({ ...base, hasLiveSession: false })).toBe('cold');
    expect(chooseSessionRolloverSealMode({ ...base, hasLiveProcess: false })).toBe('cold');
    expect(chooseSessionRolloverSealMode({ ...base, degradedByNativeCompact: true })).toBe('cold');
  });

  it('lowers thought_level / reasoning_effort to low for :renew and falls back silently when unsupported', () => {
    const supported = buildLowEffortRunConfigForRenew(
      { modelId: 'gemini-4-neon', configOptionValues: { thought_level: 'xhigh' } },
      [
        {
          id: 'thought_level',
          name: 'Thinking',
          category: 'thought_level',
          type: 'select',
          currentValue: 'xhigh',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' },
            { value: 'xhigh', name: 'XHigh' },
          ],
        },
      ]
    );
    expect(supported.appliedLow).toBe(true);
    expect(supported.config.configOptionValues?.thought_level).toBe('low');

    // Advertises options without `low` -> untouched, no warning risk.
    const unsupported = buildLowEffortRunConfigForRenew(
      { modelId: 'custom-model', configOptionValues: { thought_level: 'high' } },
      [
        {
          id: 'thought_level',
          name: 'Thinking',
          category: 'thought_level',
          type: 'select',
          currentValue: 'high',
          options: [{ value: 'high', name: 'High' }],
        },
      ]
    );
    expect(unsupported.appliedLow).toBe(false);
    expect(unsupported.config.configOptionValues?.thought_level).toBe('high');

    // No advertised options -> falls back to lowering existing reasoning_effort key.
    const fallbackKey = buildLowEffortRunConfigForRenew({
      configOptionValues: { reasoning_effort: 'high' },
    });
    expect(fallbackKey.appliedLow).toBe(true);
    expect(fallbackKey.config.configOptionValues?.reasoning_effort).toBe('low');
    expect(fallbackKey.overriddenKey).toBe('reasoning_effort');
    expect(fallbackKey.restoreValue).toBe('high');

    // Implicit default (no user configOptionValues): records advertised currentValue for restoration.
    const implicitDefault = buildLowEffortRunConfigForRenew({ modelId: 'gemini-4-neon' }, [
      {
        id: 'thought_level',
        name: 'Thinking',
        category: 'thought_level',
        type: 'select',
        currentValue: 'xhigh',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'xhigh', name: 'XHigh' },
        ],
      },
    ]);
    expect(implicitDefault).toMatchObject({
      appliedLow: true,
      overriddenKey: 'thought_level',
      restoreValue: 'xhigh',
    });
    expect(implicitDefault.config.configOptionValues?.thought_level).toBe('low');

    // Unknown implicit currentValue -> skips `low` override so `low` can NEVER leak to user message M.
    const unknownDefault = buildLowEffortRunConfigForRenew({ modelId: 'gemini-4-neon' }, [
      {
        id: 'thought_level',
        name: 'Thinking',
        category: 'thought_level',
        type: 'select',
        currentValue: '',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      },
    ]);
    expect(unknownDefault.appliedLow).toBe(false);
    expect(unknownDefault.config.configOptionValues).toBeUndefined();
  });

  it('sliceRolloverSegmentEntries fails closed (returns []) when throughTurnId is missing from history', () => {
    const entries: SessionHistoryInput[] = [
      {
        id: 'u1',
        role: 'user',
        timestamp: '2026-11-27T01:00:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'First' }],
      },
      {
        id: 'u2',
        role: 'user',
        timestamp: '2026-11-27T01:01:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Rewritten tail' }],
      },
    ];
    expect(sliceRolloverSegmentEntries(entries, { throughTurnId: 'deleted-by-edit' })).toEqual([]);
  });

  it('never truncates any lockedInvariant mid-sentence when overflowing inline budget', () => {
    const invariants = Array.from(
      { length: 45 },
      (_, idx) =>
        `INVARIANT_${String(idx + 1).padStart(2, '0')}: must keep exact contract #${idx + 1} across all nodes and drawer/composer surfaces with deterministic end marker END_${idx + 1}.`
    );
    const opening = buildLinearRolloverOpening({
      sessionId: SESSION_ID,
      generation: 1,
      nodeId: 'n_0001',
      history: [],
      stateCard: {
        goalAndPlan: 'Verify invariant overflow',
        lockedInvariants: invariants,
        decisionsAndDeadEnds: [],
        workspaceFacts: '',
        openAndNext: '',
      },
      spine: [],
      workspace: { invariantsDocPath: 'invariants.md' },
      nowIso: '2026-11-27T04:00:00.000Z',
    });

    expect(estimateTokenCount(opening)).toBeLessThanOrEqual(SESSION_ROLLOVER_OPENING_MAX_TOKENS);
    // Newest invariants must appear COMPLETE (no mid-sentence `...` clipping).
    expect(opening).toContain(invariants.at(-1)!);
    expect(opening).toContain('earlier locked invariant(s) omitted from inline budget');
    expect(opening).toContain('invariants.md');
    expect(opening).toContain('lody_session_history');
    // Every rendered bullet in the locked invariants section must equal a full original invariant!
    const sectionMatch = opening.match(
      /## 2\. Locked Invariants \(Protected — Must Not Regress\)[\s\S]*?(?=\n## |$)/
    );
    expect(sectionMatch).not.toBeNull();
    const bulletLines = sectionMatch![0]
      .split('\n')
      .filter((line) => line.startsWith('- INVARIANT_'));
    expect(bulletLines.length).toBeGreaterThan(0);
    expect(bulletLines.length).toBeLessThan(invariants.length);
    for (const line of bulletLines) {
      expect(invariants).toContain(line.slice(2));
    }
  });
});

describe('10-generation anti-bloat steady-state opening invariants', () => {
  it('stays <= 7,500 tokens across 10 consecutive generations with 0 delegation leaks, 100% lockedInvariants preservation, and spine capped at 8', () => {
    const longOrigin =
      `Build the Orbit v4 sidebar layout. ${'Keep strict alignment and equal height composer. '.repeat(200)}` +
      '中文长期约束检查：严禁回退已有功能。'.repeat(120);
    const history: SessionHistoryInput[] = [
      {
        id: 'u-origin',
        role: 'user',
        author: { v: 1, kind: 'human', userId: 'u1' },
        timestamp: '2026-11-27T01:00:00.000Z',
        fileDiff: [],
        items: [{ type: 'text', text: longOrigin }],
      },
      {
        id: 'assistant:u-origin',
        role: 'assistant',
        userTurnId: 'u-origin',
        timestamp: '2026-11-27T01:00:10.000Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Understood, starting implementation.' }],
      },
    ];

    const protectedInvariants = [
      'NEVER remove the equal-height composer alignment across main and drawer',
      'Keep native /compact untouched for AB comparison',
      'Drawer must reuse main session Composer and theme tokens',
    ];

    let stateCard: SessionRolloverStateCard = {
      goalAndPlan: 'Initial Orbit v4 implementation plan.',
      lockedInvariants: [...protectedInvariants],
      decisionsAndDeadEnds: ['Decision 0: chosen option A'],
      workspaceFacts: 'Repo clean on branch feat/orbit-v4.',
      openAndNext: 'Start phase 1.',
    };
    let spine: SessionRolloverSpineItem[] = [];
    let previousLastSealedTurnId: string | undefined;

    for (let gen = 1; gen <= 10; gen++) {
      // Append delegation receipt (MUST be filtered out of Tail!)
      const receiptId = `u-delegation-${gen}`;
      history.push(
        {
          id: receiptId,
          role: 'user',
          timestamp: `2026-11-27T0${Math.min(gen, 9)}:10:00.000Z`,
          fileDiff: [],
          items: [
            {
              type: 'text',
              text: `[Lody] This message was sent by another agent, not by a human. DELEGATION_RECEIPT_GEN_${gen} ${'noise '.repeat(400)}`,
            },
          ],
        },
        {
          id: `assistant:${receiptId}`,
          role: 'assistant',
          userTurnId: receiptId,
          timestamp: `2026-11-27T0${Math.min(gen, 9)}:10:05.000Z`,
          fileDiff: [],
          items: [{ type: 'text', text: `Processed delegation receipt ${gen}` }],
        }
      );

      // Append 3 human Q&A rounds with massive thinking, huge tool output, and <board_context_reminder>
      let lastTurnId = `assistant:${receiptId}`;
      for (let round = 1; round <= 3; round++) {
        const uid = `u-g${gen}-r${round}`;
        const aid = `assistant:${uid}`;
        history.push(
          {
            id: uid,
            role: 'user',
            author: { v: 1, kind: 'human', userId: 'u1' },
            timestamp: `2026-11-27T0${Math.min(gen, 9)}:2${round}:00.000Z`,
            fileDiff: [],
            items: [
              {
                type: 'text',
                text:
                  `Gen ${gen} human round ${round}: refine module ${round}. ` +
                  `<board_context_reminder>\n${BOARD_CONTEXT_REMINDER_HEADER}\nLEAKED_REMINDER_CONTENT\n</board_context_reminder>`,
              },
            ],
          },
          {
            id: aid,
            role: 'assistant',
            userTurnId: uid,
            timestamp: `2026-11-27T0${Math.min(gen, 9)}:2${round}:05.000Z`,
            fileDiff: [],
            items: [
              {
                type: 'thought',
                text: `PRIVATE_THINKING_SECRET_${gen}_${round} ${'x'.repeat(3000)}`,
              },
              {
                type: 'tool_call',
                toolCallId: `tc-${gen}-${round}`,
                title: 'Edit file',
                kind: 'edit',
                status: 'completed',
                locations: [{ path: `src/gen${gen}/file${round}.ts` }],
                content: [
                  {
                    type: 'terminal_output',
                    output: `MASSIVE_TOOL_OUTPUT_${gen}_${round} ${'y'.repeat(10_000)}`,
                  },
                ],
              },
              {
                type: 'text',
                text: `Gen ${gen} assistant answer ${round}. ${'Detailed prose summary. '.repeat(80)}`,
              },
            ],
          }
        );
        lastTurnId = aid;
      }

      // Simulate an LLM `:seal` trying to drop lockedInvariants and emitting huge fields!
      const rawSealJson = JSON.stringify({
        oneLiner: `Completed generation ${gen} milestone with extensive verification details and notes`,
        stateCard: {
          goalAndPlan: `Updated plan for gen ${gen}. ${'Phase details. '.repeat(250)}`,
          lockedInvariants: [
            // Deliberately omits previous invariants to test protection!
            `Gen ${gen} additional note`,
          ],
          decisionsAndDeadEnds: Array.from(
            { length: 20 },
            (_, idx) => `Gen ${gen} decision #${idx + 1}: verified rationale and rejected fallback`
          ),
          workspaceFacts: `Facts at gen ${gen}. ${'File status summary. '.repeat(200)}`,
          openAndNext: `Next step after gen ${gen}. ${'Follow-up action. '.repeat(200)}`,
        },
      });
      const parsed = parseRolloverSealJson(rawSealJson, stateCard);
      expect(parsed).not.toBeNull();
      stateCard = parsed!.stateCard;

      // Protected invariants MUST stay 100% present even though LLM omitted them!
      for (const invariant of protectedInvariants) {
        expect(stateCard.lockedInvariants).toContain(invariant);
      }

      spine = [
        ...spine,
        {
          gen,
          nodeId: `n_${String(gen).padStart(4, '0')}`,
          window: `11-27 0${Math.min(gen, 9)}:10~0${Math.min(gen, 9)}:23`,
          startTurnId: receiptId,
          endTurnId: lastTurnId,
          turnCount: 3,
          oneLiner: parsed!.oneLiner,
          quality: 'warm_llm' as const,
        },
      ].slice(-SESSION_ROLLOVER_MAX_SPINE_ENTRIES);

      const opening = buildLinearRolloverOpening({
        sessionId: SESSION_ID,
        generation: gen,
        nodeId: `n_${String(gen).padStart(4, '0')}`,
        history,
        originTurnId: 'u-origin',
        previousLastSealedTurnId,
        sealedThroughTurnId: lastTurnId,
        stateCard,
        spine,
        workspace: {
          cwd: '/repo/lody',
          gitBranch: 'feat/session-linear-rollover',
          gitHead: '65dec718d',
          invariantsDocPath: 'invariants.md',
        },
        nowIso: '2026-11-27T04:00:00.000Z',
        usedBefore: 355_000,
      });

      expect(estimateTokenCount(opening)).toBeLessThanOrEqual(SESSION_ROLLOVER_OPENING_MAX_TOKENS);
      expect(opening).not.toContain(`DELEGATION_RECEIPT_GEN_${gen}`);
      expect(opening).not.toContain('PRIVATE_THINKING_SECRET_');
      expect(opening).not.toContain('MASSIVE_TOOL_OUTPUT_');
      expect(opening).not.toContain('LEAKED_REMINDER_CONTENT');
      for (const invariant of protectedInvariants) {
        expect(opening).toContain(invariant);
      }
      expect(opening).toContain('invariants.md');
      expect(opening).toContain(`Gen ${gen} human round 3`);
      if (gen > 1) {
        // Non-overlapping Tail: previous generation's tail round must NOT reappear in Tail.
        expect(opening).not.toContain(`Gen ${gen - 1} human round 3`);
      }
      if (gen >= SESSION_ROLLOVER_MAX_SPINE_ENTRIES) {
        expect(spine).toHaveLength(SESSION_ROLLOVER_MAX_SPINE_ENTRIES);
      }
      if (gen === 10) {
        expect(opening).toContain('2 earlier nodes omitted');
      }

      previousLastSealedTurnId = lastTurnId;
    }

    // Explicit revocation removes only the named invariant.
    const revoked = parseRolloverSealJson(
      JSON.stringify({
        oneLiner: 'Revoked one old invariant',
        stateCard: {
          goalAndPlan: 'Final phase',
          lockedInvariants: [],
          revokedInvariants: [protectedInvariants[1]!],
          decisionsAndDeadEnds: [],
          workspaceFacts: '',
          openAndNext: 'Ship',
        },
      }),
      stateCard
    );
    expect(revoked?.stateCard.lockedInvariants).toContain(protectedInvariants[0]);
    expect(revoked?.stateCard.lockedInvariants).not.toContain(protectedInvariants[1]);
    expect(revoked?.stateCard.lockedInvariants).toContain(protectedInvariants[2]);
  });
});

describe('SessionRolloverService warm/cold mode, fallback, and crash recovery', () => {
  it('uses warm :seal within TTL and cold Loro plain-text summary (never warm) when stale, GCd, or degraded', async () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'u1',
        role: 'user',
        author: { v: 1, kind: 'human', userId: 'u1' },
        timestamp: '2026-11-27T01:00:00.000Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Design feature X' }],
      },
      {
        id: 'assistant:u1',
        role: 'assistant',
        userTurnId: 'u1',
        timestamp: '2026-11-27T01:00:10.000Z',
        fileDiff: [],
        items: [
          { type: 'thought', text: 'HIDDEN_THOUGHT_BLOB' },
          {
            type: 'tool_call',
            toolCallId: 'tc1',
            kind: 'edit',
            status: 'completed',
            locations: [{ path: 'src/feature-x.ts' }],
            content: [{ type: 'terminal_output', output: 'HUGE_RAW_TOOL_OUTPUT' }],
          },
          { type: 'text', text: 'Implemented feature X in src/feature-x.ts.' },
        ],
      },
    ];

    // Verify cold text stream strips thinking and raw tool output.
    const coldStream = buildColdTextStreamForSeal(sliceRolloverSegmentEntries(history));
    expect(coldStream).toContain('Design feature X');
    expect(coldStream).toContain('Implemented feature X in src/feature-x.ts.');
    expect(coldStream).not.toContain('HIDDEN_THOUGHT_BLOB');
    expect(coldStream).not.toContain('HUGE_RAW_TOOL_OUTPUT');

    // 1. Warm mode within TTL calls runWarmSeal
    let nowMs = 1_000_000;
    const warmStore = createMemorySessionRolloverStore();
    const warmService = new SessionRolloverService({
      store: warmStore,
      logger: noopLogger,
      now: () => nowMs,
      createRunId: () => 'run-warm',
    });
    const runWarmSeal = vi.fn(async () => ({
      status: 'completed' as const,
      text: JSON.stringify({
        oneLiner: 'Warm sealed feature X',
        stateCard: {
          goalAndPlan: 'Finish feature X',
          lockedInvariants: ['Keep existing API signature'],
          decisionsAndDeadEnds: ['Used strategy B'],
          workspaceFacts: 'Edited src/feature-x.ts',
          openAndNext: 'Add tests',
        },
      }),
    }));
    const dividers: SessionRolloverNoticeMeta[] = [];
    const warmResult = await warmService.sealNode({
      sessionId: SESSION_ID,
      meta: makeMeta(),
      reason: 'manual_command',
      history,
      hasLiveSession: true,
      hasLiveProcess: true,
      lastActivityMs: nowMs - 60_000,
      writeDivider: async (_runId, meta) => {
        dividers.push(meta);
      },
      runWarmSeal,
    });
    expect(warmResult).toMatchObject({ outcome: 'sealed', mode: 'warm', quality: 'warm_llm' });
    expect(runWarmSeal).toHaveBeenCalledTimes(1);
    expect(dividers.map((d) => d.status)).toEqual(['sealing', 'sealed']);

    // 2. Degraded by native compact -> MUST NOT call runWarmSeal; uses coldSummarizer
    await warmService.markDegradedByNativeCompact(SESSION_ID);
    const coldSummarizer = vi.fn(async () =>
      JSON.stringify({
        oneLiner: 'Cold summarized from Loro',
        stateCard: {
          goalAndPlan: 'Recovered after mid-turn compact',
          lockedInvariants: [],
          decisionsAndDeadEnds: ['Avoided double-summarization'],
          workspaceFacts: 'src/feature-x.ts',
          openAndNext: 'Continue cleanly',
        },
      })
    );
    const coldService = new SessionRolloverService({
      store: warmStore,
      logger: noopLogger,
      now: () => nowMs + 10_000,
      createRunId: () => 'run-cold',
      coldSummarizer,
    });
    const forbiddenWarmSeal = vi.fn(async () => ({ status: 'completed' as const, text: '{}' }));
    const coldResult = await coldService.sealNode({
      sessionId: SESSION_ID,
      meta: makeMeta(),
      reason: 'post_compact_recovery',
      history,
      hasLiveSession: true,
      hasLiveProcess: true,
      lastActivityMs: nowMs,
      writeDivider: async () => {},
      runWarmSeal: forbiddenWarmSeal,
    });
    expect(coldResult).toMatchObject({ outcome: 'sealed', mode: 'cold', quality: 'cold_llm' });
    expect(forbiddenWarmSeal).not.toHaveBeenCalled();
    expect(coldSummarizer).toHaveBeenCalledTimes(1);
    const savedAfterCold = await warmStore.get(SESSION_ID);
    // Prior lockedInvariant from gen 1 MUST still be preserved!
    expect(savedAfterCold?.stateCard.lockedInvariants).toContain('Keep existing API signature');

    // 3. Cold summarizer throws (and TTL expired) -> degrades to mechanical fallback card without waking old session
    const failingColdService = new SessionRolloverService({
      store: createMemorySessionRolloverStore(),
      logger: noopLogger,
      now: () => nowMs + SESSION_ROLLOVER_WARM_CACHE_TTL_MS + 60_000,
      createRunId: () => 'run-fallback',
      coldSummarizer: async () => {
        throw new Error('summarizer unavailable');
      },
    });
    const fallbackResult = await failingColdService.sealNode({
      sessionId: SESSION_ID,
      meta: makeMeta(),
      reason: 'manual_command',
      history,
      hasLiveSession: true,
      hasLiveProcess: true,
      lastActivityMs: nowMs,
      writeDivider: async () => {},
      runWarmSeal: forbiddenWarmSeal,
    });
    expect(fallbackResult).toMatchObject({ outcome: 'sealed', mode: 'cold', quality: 'fallback' });
    expect(forbiddenWarmSeal).not.toHaveBeenCalled();
  });

  it('preserves pendingSwitch on :renew failure and converges cleanly on crash recovery', async () => {
    const store = createMemorySessionRolloverStore();
    const service = new SessionRolloverService({
      store,
      logger: noopLogger,
      now: () => 2_000_000,
      probeWorkspace: async () => ({ recentFiles: ['src/a.ts'] }),
    });
    await store.set(SESSION_ID, {
      version: 1,
      sessionId: SESSION_ID,
      generation: 0,
      originTurnId: 'u1',
      stateCard: createEmptySessionRolloverStateCard(),
      spine: [],
      pendingSwitch: {
        runId: 'run-1',
        targetGen: 1,
        nodeId: 'n_0001',
        reason: 'manual_command',
        sealedThroughTurnId: 'assistant:u1',
        sealedAtMs: 1_900_000,
        usedBefore: 352_000,
      },
      updatedAt: 1_900_000,
    });

    const sealedHistory: SessionHistoryInput[] = [
      {
        id: 'assistant:u1',
        role: 'assistant',
        userTurnId: 'u1',
        timestamp: '2026-11-27T01:00:10.000Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Sealed endpoint.' }],
      },
    ];

    // 1. Failed :renew MUST preserve pendingSwitch
    const failedOutcome = await service.executeLazyRenew({
      sessionId: SESSION_ID,
      meta: makeMeta({ acpSessionId: 'acp-1' as ACPSessionId }),
      history: sealedHistory,
      writeDivider: async () => {},
      retireOldSession: async () => {},
      runFreshRenewTurn: async () => ({ status: 'failed', reason: 'network-timeout' }),
      clearBoardCompactPending: async () => {},
    });
    expect(failedOutcome).toMatchObject({ switched: false, reason: 'failed' });
    expect((await store.get(SESSION_ID))?.pendingSwitch?.runId).toBe('run-1');

    // 2. Crash recovery: meta.acpSessionId matches preparedAcpSessionId -> converges without re-running :renew!
    await store.update(SESSION_ID, (curr) =>
      curr?.pendingSwitch
        ? {
            ...curr,
            pendingSwitch: { ...curr.pendingSwitch, preparedAcpSessionId: 'acp-fresh-2' },
          }
        : curr
    );
    const runFreshRenewTurn = vi.fn(async () => ({
      status: 'completed' as const,
      newAcpSessionId: 'acp-should-not-run' as ACPSessionId,
    }));
    const clearBoardCompactPending = vi.fn(async () => {});
    const dividers: SessionRolloverNoticeMeta[] = [];
    const recovered = await service.executeLazyRenew({
      sessionId: SESSION_ID,
      meta: makeMeta({
        acpSessionId: 'acp-fresh-2' as ACPSessionId,
        contextWindowUsage: { size: 1_000_000, used: 25_000 },
      }),
      history: sealedHistory,
      writeDivider: async (_runId, meta) => {
        dividers.push(meta);
      },
      retireOldSession: async () => {},
      runFreshRenewTurn,
      clearBoardCompactPending,
    });
    expect(recovered).toMatchObject({
      switched: true,
      recoveredFromCrash: true,
      acpSessionId: 'acp-fresh-2',
      usedAfter: 25_000,
    });
    expect(runFreshRenewTurn).not.toHaveBeenCalled();
    expect(clearBoardCompactPending).toHaveBeenCalledTimes(1);
    expect(dividers.at(-1)).toMatchObject({
      status: 'done',
      usedBefore: 352_000,
      usedAfter: 25_000,
    });
    const committed = await store.get(SESSION_ID);
    expect(committed?.pendingSwitch).toBeUndefined();
    expect(committed?.generation).toBe(1);
    expect(committed?.activeAcpSessionId).toBe('acp-fresh-2');
    expect(committed?.lastSealedTurnId).toBe('assistant:u1');
    expect(committed?.usedAfterLastRollover).toBe(25_000);
  });

  it('invalidates stale pendingSwitch when Edit & Resend removes sealedThroughTurnId or replaces meta.acpSessionId', async () => {
    const store = createMemorySessionRolloverStore();
    const service = new SessionRolloverService({
      store,
      logger: noopLogger,
      now: () => 2_000_000,
    });
    await store.set(SESSION_ID, {
      version: 1,
      sessionId: SESSION_ID,
      generation: 0,
      stateCard: createEmptySessionRolloverStateCard(),
      spine: [
        {
          gen: 1,
          nodeId: 'n_0001',
          window: '11-27 01:00~01:01',
          startTurnId: 'u1',
          endTurnId: 'assistant:u1',
          turnCount: 1,
          oneLiner: 'Pending sealed node',
          quality: 'warm_llm',
        },
      ],
      pendingSwitch: {
        runId: 'run-stale',
        targetGen: 1,
        nodeId: 'n_0001',
        reason: 'manual_command',
        sealedThroughTurnId: 'assistant:u1',
        sealedAtMs: 1_900_000,
        sourceAcpSessionId: 'acp-1',
      },
      updatedAt: 1_900_000,
    });

    const dividers: SessionRolloverNoticeMeta[] = [];
    const prepared = await service.prepareLazyRenew({
      sessionId: SESSION_ID,
      meta: makeMeta({ acpSessionId: 'acp-edited-2' as ACPSessionId }),
      history: [
        {
          id: 'u-edited',
          role: 'user',
          timestamp: '2026-11-27T01:05:00Z',
          fileDiff: [],
          items: [{ type: 'text', text: 'Edited prompt' }],
        },
      ],
      writeDivider: async (_runId, meta) => {
        dividers.push(meta);
      },
      clearBoardCompactPending: async () => {},
    });

    expect(prepared).toEqual({ kind: 'none' });
    const after = await store.get(SESSION_ID);
    expect(after?.pendingSwitch).toBeUndefined();
    expect(after?.spine).toEqual([]);
    expect(dividers).toEqual([
      expect.objectContaining({ status: 'interrupted', reason: 'history-rewritten' }),
    ]);
  });

  it('createIsolatedColdRolloverSummarizer runs in an isolated process with low effort, cleans up temp dir + shuts down on success/error, and returns null on failure', async () => {
    const seenWorkdirs: string[] = [];
    const setConfigCalls: Array<{ id: string; value: unknown }> = [];
    const shutdownCalls: number[] = [];

    const summarizer = createIsolatedColdRolloverSummarizer({
      workspaceDocument: {} as never,
      workspaceId: 'ws-1' as never,
      machineId: 'machine-1' as never,
      logger: noopLogger,
      resolveLaunchConfig: async () => ({ config: undefined, source: 'none' }),
      startAgent: (async (opts: { workdir: string; onUpdateMessage?: (u: unknown) => void }) => {
        seenWorkdirs.push(opts.workdir);
        // Temp dir must exist while running!
        expect((await stat(opts.workdir)).isDirectory()).toBe(true);
        return {
          acpSessionId: 'cold-acp-1',
          agentProcess: {} as never,
          sessionResponse: {
            configOptions: [
              {
                id: 'thought_level',
                name: 'Thinking',
                category: 'thought_level',
                type: 'select',
                currentValue: 'high',
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'high', name: 'High' },
                ],
              },
            ],
          },
          client: {
            setSessionConfigOption: async (_sid: string, id: string, value: unknown) => {
              setConfigCalls.push({ id, value });
            },
            prompt: async () => {
              opts.onUpdateMessage?.({
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: '{"oneLiner":"ok","stateCard":{}}' },
                },
              });
              return { stopReason: 'end_turn' };
            },
            cancel: async () => {},
          },
        } as never;
      }) as never,
      shutdownAgent: async () => {
        shutdownCalls.push(1);
      },
    });

    const result = await summarizer({
      sessionId: SESSION_ID,
      meta: makeMeta(),
      prompt: 'Summarize this cold text stream',
    });
    expect(result).toBe('{"oneLiner":"ok","stateCard":{}}');
    expect(setConfigCalls).toEqual([{ id: 'thought_level', value: 'low' }]);
    expect(shutdownCalls).toHaveLength(1);
    // Temp dir MUST be cleaned up in finally!
    await expect(stat(seenWorkdirs[0]!)).rejects.toThrow();

    // Error path returns null and STILL shuts down and cleans up temp dir.
    const failingSummarizer = createIsolatedColdRolloverSummarizer({
      workspaceDocument: {} as never,
      workspaceId: 'ws-1' as never,
      machineId: 'machine-1' as never,
      logger: noopLogger,
      resolveLaunchConfig: async () => ({ config: undefined, source: 'none' }),
      startAgent: (async (opts: { workdir: string }) => {
        seenWorkdirs.push(opts.workdir);
        return {
          acpSessionId: 'cold-acp-2',
          agentProcess: {} as never,
          sessionResponse: {},
          client: {
            prompt: async () => {
              throw new Error('upstream cold error');
            },
            cancel: async () => {},
          },
        } as never;
      }) as never,
      shutdownAgent: async () => {
        shutdownCalls.push(2);
      },
    });
    const failedResult = await failingSummarizer({
      sessionId: SESSION_ID,
      meta: makeMeta(),
      prompt: 'Summarize failing stream',
    });
    expect(failedResult).toBeNull();
    expect(shutdownCalls).toHaveLength(2);
    await expect(stat(seenWorkdirs[1]!)).rejects.toThrow();
  });
});

describe('createFileSessionRolloverStore', () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists atomically with 0o600 permissions, reloads across instances, and ignores corrupt files', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lody-rollover-store-'));
    tempDirs.push(rootDir);

    const store1 = createFileSessionRolloverStore({ rootDir, logger: noopLogger });
    await store1.set(SESSION_ID, {
      version: 1,
      sessionId: SESSION_ID,
      generation: 2,
      activeAcpSessionId: 'acp-2',
      originTurnId: 'u1',
      lastSealedTurnId: 'assistant:u8',
      usedAfterLastRollover: 27_000,
      stateCard: {
        goalAndPlan: 'Deliver rollover',
        lockedInvariants: ['Invariant A'],
        decisionsAndDeadEnds: ['Decision 1'],
        workspaceFacts: 'Clean tree',
        openAndNext: 'Test store',
      },
      spine: Array.from({ length: 12 }, (_, idx) => ({
        gen: idx + 1,
        nodeId: `n_${String(idx + 1).padStart(4, '0')}`,
        window: '11-27 01:00~01:10',
        startTurnId: `u${idx + 1}`,
        endTurnId: `a${idx + 1}`,
        turnCount: 2,
        oneLiner: `Node ${idx + 1}`,
        quality: 'warm_llm' as const,
      })),
      updatedAt: 123_456,
    });

    const store2 = createFileSessionRolloverStore({ rootDir, logger: noopLogger });
    const reloaded = await store2.get(SESSION_ID);
    expect(reloaded?.generation).toBe(2);
    expect(reloaded?.spine).toHaveLength(SESSION_ROLLOVER_MAX_SPINE_ENTRIES);
    expect(reloaded?.spine[0]?.gen).toBe(5);
    expect(reloaded?.stateCard.lockedInvariants).toEqual(['Invariant A']);

    // Verify 0o600 permissions on stored file (POSIX).
    if (process.platform !== 'win32') {
      const files = await import('node:fs/promises').then((fs) => fs.readdir(rootDir));
      const jsonFile = files.find((f) => f.endsWith('.json'));
      expect(jsonFile).toBeDefined();
      const info = await stat(path.join(rootDir, jsonFile!));
      expect(info.mode & 0o777).toBe(0o600);

      // Corrupt file is safely ignored instead of crashing.
      await writeFile(path.join(rootDir, jsonFile!), '{not valid json', 'utf8');
      const store3 = createFileSessionRolloverStore({ rootDir, logger: noopLogger });
      expect(await store3.get(SESSION_ID)).toBeUndefined();
    }
  });

  it('fails closed on non-ENOENT read errors without invoking updater or overwriting disk state', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lody-rollover-store-err-'));
    tempDirs.push(rootDir);

    const store1 = createFileSessionRolloverStore({ rootDir, logger: noopLogger });
    await store1.set(SESSION_ID, {
      version: 1,
      sessionId: SESSION_ID,
      generation: 3,
      activeAcpSessionId: 'acp-3',
      stateCard: {
        goalAndPlan: 'Preserved across EACCES',
        lockedInvariants: ['DO_NOT_OVERWRITE'],
        decisionsAndDeadEnds: [],
        workspaceFacts: '',
        openAndNext: '',
      },
      spine: [],
      updatedAt: 999,
    });

    const files = await import('node:fs/promises').then((fs) => fs.readdir(rootDir));
    const targetPath = path.join(
      rootDir,
      files.find((f) => f.endsWith('.json'))!
    );
    const originalBytes = await readFile(targetPath, 'utf8');

    // Make the persisted state file unreadable to trigger EACCES on a fresh store instance.
    await chmod(targetPath, 0o000);
    try {
      const store2 = createFileSessionRolloverStore({ rootDir, logger: noopLogger });
      await expect(store2.get(SESSION_ID)).rejects.toBeInstanceOf(SessionRolloverStoreReadError);
      const updater = vi.fn((curr) => curr);
      await expect(store2.update(SESSION_ID, updater)).rejects.toBeInstanceOf(
        SessionRolloverStoreReadError
      );
      expect(updater).not.toHaveBeenCalled();
    } finally {
      await chmod(targetPath, 0o600);
    }

    // Original persisted state on disk MUST remain completely intact!
    expect(await readFile(targetPath, 'utf8')).toBe(originalBytes);
    const store3 = createFileSessionRolloverStore({ rootDir, logger: noopLogger });
    expect((await store3.get(SESSION_ID))?.stateCard.lockedInvariants).toEqual([
      'DO_NOT_OVERWRITE',
    ]);
  });
});
