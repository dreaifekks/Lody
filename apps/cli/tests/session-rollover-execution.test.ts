import type { ContentBlock } from '@agentclientprotocol/sdk';
import {
  getSessionRoomId,
  isSilentSessionRollover,
  normalizeBoardMeta,
  readSessionRolloverNotice,
  sessionRolloverTurnId,
  workspaceFlockKeys,
  type ACPSessionId,
  type AcpConfigOptionSummary,
  type AcpConfigOptionValue,
  type BoardId,
  type BoardMeta,
  type MachineId,
  type ProjectRef,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { describe, expect, it, vi } from 'vitest';
import type { LoroDocumentManager, SessionDocument } from '../src/lib/loro/doc';
import {
  BARE_COMPACT_DEFAULT_INSTRUCTIONS,
  EXPLICIT_COMPACT_VISIBLE_FALLBACK_TEXT,
  createMemoryBoardCompactReinjectStore,
} from '../src/session/board-compact-reinject';
import { findNextDispatchableUserTurn } from '../src/session/session-dispatch-logic';
import { SessionDispatchWatcher } from '../src/session/session-dispatch-watcher';
import { SessionExecutionService } from '../src/session/session-execution-service';
import type { SessionManager } from '../src/session/session-manager';
import { createMemorySessionRolloverStore } from '../src/session/session-rollover-store';
import { TURN_BUDGETS } from '../src/session/turn-budgets';
import { withHistoryPort } from './history-port-fixture';
import { createBaseDeps } from './session-execution-service-helpers';

const SESSION_ID = 'session-rollover-int' as SessionId;
const COORD_ID = 'session-board-coord' as SessionId;
const BOARD_ID = 'bd_rollover' as BoardId;
const MACHINE_ID = 'machine-1' as MachineId;
const WORKSPACE_ID = 'workspace-1' as WorkspaceId;

const makeBoard = (): BoardMeta =>
  normalizeBoardMeta({
    version: 1,
    id: BOARD_ID,
    name: 'Lody Lan',
    purpose: 'Personal LAN fork features',
    instructions: 'BOARD_RULE_SENTINEL: always preserve LAN access.',
    coordinatorSessionId: COORD_ID,
    createdAtMs: 1_000,
    createdByUserId: 'owner-user',
    rules: {
      maxRoundsPerThread: 3,
      reportHumanTurns: false,
      executorConstraints: 'THREAD_RULE_SENTINEL: keep reports under files/.',
    },
  })!;

type PromptRecord = {
  acpSessionId: string;
  blocks: ContentBlock[];
  text: string;
};

type ConfigApplyRecord = {
  acpSessionId: string | null;
  configOptionValues?: Record<string, AcpConfigOptionValue>;
  basedOnUserTurnId?: string;
};

function createRolloverExecutionHarness(options: {
  metaPatch?: Partial<SessionMeta>;
  board?: BoardMeta | null;
  initialHistory?: SessionHistoryInput[];
  resumeError?: Error;
  observePromptContentForTurn?: (sessionId: SessionId, turnId: string) => boolean;
  hasPromptEventsForTurn?: (sessionId: SessionId, turnId: string) => boolean;
  nowMs?: () => number;
  initialLastActivityMs?: number;
  configOptions?: AcpConfigOptionSummary[];
  nativeWork?: {
    kind?: 'running' | 'background' | null;
    unsettled?: boolean;
  };
  coldSummarizer?: (args: {
    sessionId: SessionId;
    meta?: SessionMeta;
    prompt: string;
    signal?: AbortSignal;
  }) => Promise<string | null>;
  onPrompt?: (ctx: {
    callIndex: number;
    acpSessionId: string;
    blocks: ContentBlock[];
    text: string;
    signal: AbortSignal;
    setUsage: (used: number, size?: number) => void;
    writeActiveAssistantText: (text: string) => void;
    service: SessionExecutionService;
  }) => Promise<{ stopReason?: string } | void> | { stopReason?: string } | void;
} = {}) {
  const sessionId = SESSION_ID;
  const board = options.board === undefined ? makeBoard() : options.board;
  let currentMeta: SessionMeta = {
    id: sessionId,
    title: 'Rollover Integration Session',
    machineId: MACHINE_ID,
    userId: 'owner-user',
    cliType: 'registry',
    agentType: 'antigravity',
    acpSessionId: 'acp-1' as ACPSessionId,
    boardId: board?.id,
    project: {
      kind: 'github',
      repoFullName: 'dreaifekks/Lody',
      branch: 'feat/session-linear-rollover',
    } satisfies ProjectRef,
    projectRun: {
      name: 'lody-group',
      instructions: 'PROJECT_GROUP_SENTINEL: run pnpm check before commit.',
      members: {
        main: {
          o: 0,
          path: '.',
          access: 'worktree',
          base: 'lan-hub',
          src: { kind: 'github', repoFullName: 'dreaifekks/Lody' },
          placement: { kind: 'root' },
        },
      },
    },
    contextWindowUsage: { size: 1_000_000, used: 352_000 },
    lastModel: { modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' },
    ...options.metaPatch,
  } as SessionMeta;

  const history: SessionHistoryInput[] = [
    ...(options.initialHistory ?? [
      {
        id: 'turn-u1',
        role: 'user',
        author: { v: 1, kind: 'human', userId: 'owner-user' },
        timestamp: '2026-11-27T01:00:00.000Z',
        status: 'handled',
        fileDiff: [],
        items: [{ type: 'text', text: 'ORIGIN_TASK_SENTINEL: implement linear rollover.' }],
      },
      {
        id: 'assistant:turn-u1',
        role: 'assistant',
        userTurnId: 'turn-u1',
        timestamp: '2026-11-27T01:00:10.000Z',
        finished: true,
        fileDiff: [],
        items: [{ type: 'text', text: 'PRE_ROLLOVER_ANSWER_SENTINEL: phase 1 analyzed.' }],
      },
    ]),
  ];

  const prompts: PromptRecord[] = [];
  const configApplies: ConfigApplyRecord[] = [];
  let activeAssistantEntryId: string | null = null;
  let promptCallIndex = 0;
  let createdCount = 0;
  let turnCounter = 0;
  let service!: SessionExecutionService;
  const rolloverStore = createMemorySessionRolloverStore();
  const reinjectStore = createMemoryBoardCompactReinjectStore();

  const setUsage = (used: number, size = 1_000_000) => {
    currentMeta = { ...currentMeta, contextWindowUsage: { used, size } };
  };

  const writeActiveAssistantText = (text: string) => {
    if (!activeAssistantEntryId) return;
    const existing = history.find((e) => e.id === activeAssistantEntryId);
    if (existing) {
      existing.items = [...(existing.items ?? []), { type: 'text', text }];
    } else {
      history.push({
        id: activeAssistantEntryId,
        role: 'assistant',
        timestamp: '2026-11-27T02:00:00.000Z',
        fileDiff: [],
        items: [{ type: 'text', text }],
      });
    }
  };

  let activePromptAbortController: AbortController | undefined;
  let liveNativeWorkKind: 'running' | 'background' | null = options.nativeWork?.kind ?? null;
  let liveNativeWorkUnsettled = options.nativeWork?.unsettled ?? false;
  let livePendingPromptCompletion: Promise<void> | null = null;
  const makeAgent = (acpSessionId: string) => ({
    agentClient: {
      isCreated: () => true,
      currentModel: { modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' },
      supportsContextCompaction: () => true,
      getNativeWork: () => (liveNativeWorkKind ? { kind: liveNativeWorkKind } : null),
      hasUnsettledNativeWork: () => liveNativeWorkUnsettled,
      get pendingPromptCompletion() {
        return livePendingPromptCompletion;
      },
      getConfigOptions: () =>
        options.configOptions ?? [
          {
            id: 'thought_level',
            name: 'Thinking',
            category: 'thought_level',
            type: 'select' as const,
            currentValue: 'xhigh',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'high', name: 'High' },
              { value: 'xhigh', name: 'XHigh' },
            ],
          },
        ],
      prompt: async (id: string, blocks: ContentBlock[], promptOptions?: { signal?: AbortSignal }) => {
        const callIndex = promptCallIndex++;
        const text = blocks
          .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
          .join('\n');
        prompts.push({ acpSessionId: id, blocks, text });
        const controller = new AbortController();
        activePromptAbortController = controller;
        const onExternalAbort = () => controller.abort();
        promptOptions?.signal?.addEventListener('abort', onExternalAbort, { once: true });
        if (promptOptions?.signal?.aborted) controller.abort();
        try {
          const outcome = await options.onPrompt?.({
            callIndex,
            acpSessionId: id,
            blocks,
            text,
            signal: controller.signal,
            setUsage,
            writeActiveAssistantText,
            service,
          });
          return outcome ?? { stopReason: 'end_turn' };
        } finally {
          promptOptions?.signal?.removeEventListener('abort', onExternalAbort);
          if (activePromptAbortController === controller) {
            activePromptAbortController = undefined;
          }
        }
      },
      cancel: vi.fn(async () => {
        activePromptAbortController?.abort();
      }),
    },
    acpSessionId,
    hasLiveAgentProcess: () => true,
    getMemoryBinding: () => null,
    getWorkdir: () => '/tmp',
    getHostWorkdir: () => '/tmp',
    getParentSessionId: () => undefined,
    exec: async () => '',
    updateGitIdentity: () => {},
    applyExecutionPlaneLimits: async () => {},
    terminate: vi.fn(async () => {}),
  });

  let live: ReturnType<typeof makeAgent> | null = makeAgent(currentMeta.acpSessionId ?? 'acp-1');
  const sessionManagerListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const emitSessionManagerEvent = (event: string, ...args: unknown[]) => {
    for (const listener of sessionManagerListeners.get(event) ?? []) {
      listener(...args);
    }
  };
  const retireSpy = vi.fn(async () => {
    live = null;
  });
  const createSessionSpy = vi.fn(
    async (_config: unknown, createOptions?: { resumeSessionId?: string }) => {
      if (createOptions?.resumeSessionId && options.resumeError) {
        throw options.resumeError;
      }
      createdCount += 1;
      const nextId = createOptions?.resumeSessionId ?? `acp-fresh-${createdCount}`;
      live = makeAgent(nextId);
      currentMeta = { ...currentMeta, acpSessionId: nextId as ACPSessionId };
      return live;
    }
  );

  const sessionDoc = withHistoryPort({
    sessionId,
    getMetaState: async () => currentMeta,
    getHistory: () => history,
    setStatus: async () => {},
    setBaseBranch: async () => {},
    setLastMessageAt: async () => {},
    getDocState: async () => ({}),
    updateHistory: async (fn: (items: SessionHistoryInput[]) => SessionHistoryInput[]) => {
      const next = fn(history);
      history.splice(0, history.length, ...next);
    },
  });

  const nowFn = options.nowMs ?? (() => 1_700_000_000_000);
  let lastTouchedActivityMs = options.initialLastActivityMs ?? nowFn() - 30_000;
  const deps = createBaseDeps({
    boardCompactReinjectStore: reinjectStore,
    sessionRolloverStore: rolloverStore,
    sessionRolloverNow: nowFn,
    ...(options.coldSummarizer ? { sessionRolloverColdSummarizer: options.coldSummarizer } : {}),
    sessionRolloverProbeWorkspace: async ({ segmentEntries }) => ({
      cwd: '/tmp/lody-rollover-test',
      gitBranch: 'feat/session-linear-rollover',
      gitHead: '65dec718d',
      recentFiles: segmentEntries.length > 0 ? ['apps/cli/src/session/session-rollover-service.ts'] : [],
    }),
    touchSession: vi.fn(() => {
      // Mirrors real MessageHandler.touchSession refreshing GC activity clock on request arrival.
      lastTouchedActivityMs = nowFn();
    }),
    getSessionLastActivity: () => lastTouchedActivityMs,
    ...(options.observePromptContentForTurn
      ? { observePromptContentForTurn: options.observePromptContentForTurn }
      : {}),
    ...(options.hasPromptEventsForTurn
      ? { hasPromptEventsForTurn: options.hasPromptEventsForTurn }
      : {}),
    beginConversationTurn: vi.fn((_sid, userTurnId) => {
      const id = userTurnId ? `assistant:${userTurnId}` : `assistant:${++turnCounter}`;
      activeAssistantEntryId = id;
      return id;
    }),
    createAssistantEntryForTurn: vi.fn(async (_sid, _doc, turnId, _model, userTurnId) => {
      activeAssistantEntryId = turnId;
      if (!history.some((e) => e.id === turnId)) {
        history.push({
          id: turnId,
          role: 'assistant',
          ...(userTurnId ? { userTurnId } : {}),
          timestamp: '2026-11-27T02:00:00.000Z',
          fileDiff: [],
          items: [],
        });
      }
    }),
    applyAcpModeAndModel: vi.fn(async (target, config, ctx) => {
      configApplies.push({
        acpSessionId: target.acpSessionId,
        configOptionValues: config.configOptionValues
          ? { ...config.configOptionValues }
          : undefined,
        basedOnUserTurnId: ctx.basedOnUserTurnId,
      });
    }),
    sessionManager: {
      getSession: () => live,
      getPendingSession: () => null,
      validateSessionCredentials: vi.fn(async () => undefined),
      retireSessionForReconfiguration: retireSpy,
      terminateSession: vi.fn(async () => {
        live = null;
      }),
      createSession: createSessionSpy,
      resolveLocalProjectRootPath: vi.fn(async () => '/tmp/lody-rollover-test'),
      on: (event: string, listener: (...args: unknown[]) => void) => {
        let listeners = sessionManagerListeners.get(event);
        if (!listeners) {
          listeners = new Set();
          sessionManagerListeners.set(event, listeners);
        }
        listeners.add(listener);
      },
      off: (event: string, listener: (...args: unknown[]) => void) => {
        sessionManagerListeners.get(event)?.delete(listener);
      },
    } as unknown as SessionManager,
    workspaceDocument: {
      syncFlockDocOrThrow: vi.fn(async () => undefined),
      repo: {
        upsertDocMeta: vi.fn(async (roomId: string, patch: Partial<SessionMeta>) => {
          if (roomId === getSessionRoomId(sessionId)) {
            currentMeta = { ...currentMeta, ...patch };
          }
        }),
        getDocMeta: vi.fn(async () => ({ meta: currentMeta })),
        openFlockDoc: vi.fn(async () => ({
          flock: {
            scan: () => [],
            get: (key: unknown) =>
              board && JSON.stringify(key) === JSON.stringify(workspaceFlockKeys.board(board.id))
                ? board
                : undefined,
          },
        })),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      getOrOpenSessionCode: vi.fn(async () => null),
    } as unknown as LoroDocumentManager,
    buildAcpPromptBlocks: async ({ inputBlocks, replayPromptText }) =>
      [
        ...(replayPromptText
          ? [{ type: 'text' as const, text: `${replayPromptText}\n\n=== Current Request ===` }]
          : []),
        ...inputBlocks.map((block) => ({
          type: 'text' as const,
          text: block.type === 'text' ? block.text : `[${block.type}]`,
        })),
      ] as ContentBlock[],
  });

  service = new SessionExecutionService(deps);

  const sendContinue = async (
    prompt: string,
    extra: {
      userTurnId?: string;
      reuseExistingHistoryEntry?: boolean;
      configOptionValues?: Record<string, AcpConfigOptionValue>;
      omitConfigOptionValues?: boolean;
      resume?: ACPSessionId;
      nativeSessionId?: string;
    } = {}
  ) => {
    const userTurnId = extra.userTurnId ?? `user-turn-${++turnCounter}`;
    if (!extra.reuseExistingHistoryEntry || !history.some((e) => e.id === userTurnId)) {
      history.push({
        id: userTurnId,
        role: 'user',
        author: { v: 1, kind: 'human', userId: 'owner-user' },
        timestamp: '2026-11-27T02:00:00.000Z',
        status: 'pending',
        fileDiff: [],
        items: [{ type: 'text', text: prompt }],
      });
    }
    await service.continueSession({
      type: 'session/chat',
      sessionId,
      machineId: MACHINE_ID,
      workspaceId: WORKSPACE_ID,
      project: currentMeta.project,
      userTurnId,
      userId: 'owner-user',
      userName: 'Owner',
      userEmail: 'owner@example.com',
      acpSessionConfig: {
        prompt,
        cliType: currentMeta.cliType ?? 'registry',
        agentType: currentMeta.agentType ?? 'antigravity',
        modelId: 'gemini-4-neon',
        ...(extra.omitConfigOptionValues
          ? {}
          : { configOptionValues: extra.configOptionValues ?? { thought_level: 'xhigh' } }),
        ...(extra.resume ? { resume: extra.resume } : {}),
        ...(extra.nativeSessionId
          ? {
              _lodyAutomation: {
                invocationId: 'inv-pin-1',
                ruleId: 'rule-pin-1',
                ruleRevision: 1,
                eventRef: 'evt-pin-1',
                authorizationUserId: 'owner-user',
                nativeSessionId: extra.nativeSessionId,
              },
            }
          : {}),
      },
    });
    return userTurnId;
  };

  return {
    service,
    deps,
    sessionDoc,
    prompts,
    configApplies,
    history,
    rolloverStore,
    reinjectStore,
    retireSpy,
    createSessionSpy,
    setUsage,
    setMeta: (patch: Partial<SessionMeta>) => {
      currentMeta = { ...currentMeta, ...patch };
    },
    setNativeWork: (next: { kind?: 'running' | 'background' | null; unsettled?: boolean }) => {
      liveNativeWorkKind = next.kind ?? null;
      liveNativeWorkUnsettled = next.unsettled ?? false;
      emitSessionManagerEvent('onNativeWorkChanged', sessionId);
    },
    setPendingPromptCompletion: (next: Promise<void> | null) => {
      livePendingPromptCompletion = next;
    },
    getMeta: () => currentMeta,
    dropLiveAgent: () => {
      live = null;
    },
    replaceLiveAgent: (acpSessionId: ACPSessionId) => {
      live = makeAgent(acpSessionId);
      currentMeta = { ...currentMeta, acpSessionId };
    },
    sendContinue,
  };
}

describe('Session linear rollover end-to-end execution (Form B & hard-trap regressions)', () => {
  it('Form B lazy switch: /rollover seals without creating a new session; next user message retires -> session/new -> :renew (full project/board rules + low effort) -> restores xhigh -> pure user message M -> no false usage_drop (Hard Trap #6)', async () => {
    const h = createRolloverExecutionHarness({
      onPrompt: ({ callIndex, text, setUsage, writeActiveAssistantText, service }) => {
        if (callIndex === 0) {
          // Warm `:seal` on acp-1
          expect(text).toContain('[Lody Internal Handoff Seal');
          expect(text).toContain('keep UI red lines');
          writeActiveAssistantText(
            JSON.stringify({
              oneLiner: 'Sealed node 1 cleanly',
              stateCard: {
                goalAndPlan: 'Ship linear rollover MVP',
                lockedInvariants: ['NEVER alter native /compact placement'],
                decisionsAndDeadEnds: ['Chose Form B lazy renew'],
                workspaceFacts: 'Tests ready',
                openAndNext: 'Finish UI divider',
              },
            })
          );
        } else if (callIndex === 1) {
          // Lazy `:renew` on fresh acp-fresh-1
          writeActiveAssistantText('Ready.');
          setUsage(26_000);
        } else if (callIndex === 2) {
          // Pure user message M on acp-fresh-1 reporting post-rollover low usage
          service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 26_000 });
          setUsage(26_000);
          writeActiveAssistantText('Done with M.');
        }
      },
    });

    // Arm board compact reinject pending BEFORE rollover to verify `:renew` clears it.
    await h.reinjectStore.mark(SESSION_ID);

    // 1. User runs `/rollover keep UI red lines` -> seals on warm acp-1, does NOT open new ACP session!
    await h.sendContinue('/rollover keep UI red lines');
    expect(h.createSessionSpy).not.toHaveBeenCalled();
    expect(h.retireSpy).not.toHaveBeenCalled();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]!.acpSessionId).toBe('acp-1');
    // `/rollover` text itself was NEVER sent raw to ACP.
    expect(h.prompts[0]!.text).not.toBe('/rollover keep UI red lines');

    const sealedState = await h.rolloverStore.get(SESSION_ID);
    expect(sealedState?.pendingSwitch).toBeDefined();
    const runId = sealedState!.pendingSwitch!.runId;
    const dividerAfterSeal = h.history.find((e) => e.id === sessionRolloverTurnId(runId));
    expect(readSessionRolloverNotice(dividerAfterSeal!)).toMatchObject({
      status: 'sealed',
      trigger: 'manual',
      generation: 1,
      usedBefore: 352_000,
    });

    // 2. User sends normal message M -> triggers lazy `:renew`, then runs pure M!
    await h.sendContinue('Implement the rollover divider component', {
      configOptionValues: { thought_level: 'xhigh' },
    });

    expect(h.retireSpy).toHaveBeenCalledTimes(1);
    expect(h.createSessionSpy).toHaveBeenCalledTimes(1);
    expect(h.createSessionSpy.mock.calls[0]?.[1]?.resumeSessionId).toBeUndefined();
    expect(h.prompts).toHaveLength(3);

    // Prompt 1: silent `:renew` on fresh ACP session carrying full project/group/board context + locked invariant
    const renewPrompt = h.prompts[1]!;
    expect(renewPrompt.acpSessionId).toBe('acp-fresh-1');
    expect(renewPrompt.text).toContain('NEVER alter native /compact placement');
    expect(renewPrompt.text).toContain('PROJECT_GROUP_SENTINEL');
    expect(renewPrompt.text).toContain('BOARD_RULE_SENTINEL');
    expect(renewPrompt.text).toContain('THREAD_RULE_SENTINEL');
    expect(renewPrompt.text).toContain('lody_session_history');

    // Thought level lowered to `low` for `:renew`, then restored to `xhigh` for user message M!
    expect(h.configApplies).toHaveLength(2);
    expect(h.configApplies[0]).toMatchObject({
      acpSessionId: 'acp-fresh-1',
      configOptionValues: { thought_level: 'low' },
      basedOnUserTurnId: undefined,
    });
    expect(h.configApplies[1]).toMatchObject({
      acpSessionId: 'acp-fresh-1',
      configOptionValues: { thought_level: 'xhigh' },
    });

    // Prompt 2: user's message M is 100% pure (zero rollover handoff / zero board reminder)!
    const userPrompt = h.prompts[2]!;
    expect(userPrompt.acpSessionId).toBe('acp-fresh-1');
    expect(userPrompt.text).toBe('Implement the rollover divider component');
    expect(userPrompt.text).not.toContain('<board_context_reminder>');
    expect(userPrompt.text).not.toContain('Lody Session Node Handoff');

    // State committed & divider updated to `done` with `352K -> 26K`, reinject pending cleared!
    const committed = await h.rolloverStore.get(SESSION_ID);
    expect(committed?.pendingSwitch).toBeUndefined();
    expect(committed?.generation).toBe(1);
    expect(committed?.activeAcpSessionId).toBe('acp-fresh-1');
    expect(committed?.usedAfterLastRollover).toBe(26_000);
    expect(await h.reinjectStore.has(SESSION_ID)).toBe(false);

    const dividerAfterDone = h.history.find((e) => e.id === sessionRolloverTurnId(runId));
    expect(readSessionRolloverNotice(dividerAfterDone!)).toMatchObject({
      status: 'done',
      generation: 1,
      usedBefore: 352_000,
      usedAfter: 26_000,
    });
    expect(dividerAfterDone?.finished).toBe(true);

    // Hard Trap #6: the legal 352k -> 26k transition MUST NOT arm boardCompactReinject for the next turn!
    await h.sendContinue('Follow-up turn on node 2');
    expect(h.prompts[3]!.text).toBe('Follow-up turn on node 2');
    expect(h.prompts[3]!.text).not.toContain('<board_context_reminder>');
  });

  it('Hard Trap #1: SessionDispatchWatcher discards stale queued inputConfig.resume after rollover while preserving pinned _lodyAutomation.nativeSessionId', async () => {
    const rolloverStore = createMemorySessionRolloverStore();
    await rolloverStore.set(SESSION_ID, {
      version: 1,
      sessionId: SESSION_ID,
      generation: 1,
      activeAcpSessionId: 'acp-fresh-2',
      lastSealedTurnId: 'assistant:turn-u1',
      stateCard: {
        goalAndPlan: 'G',
        lockedInvariants: [],
        decisionsAndDeadEnds: [],
        workspaceFacts: '',
        openAndNext: '',
      },
      spine: [],
      updatedAt: 1_000,
    });

    const watcher = new SessionDispatchWatcher({
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
      machineId: MACHINE_ID,
      workspaceId: WORKSPACE_ID,
      workspaceDocument: {} as never,
      executionService: {
        getSessionRolloverState: (sid: SessionId) => rolloverStore.get(sid),
      } as never,
      userResolver: {
        resolve: async () => ({ id: 'owner-user', name: 'Owner', email: 'owner@example.com' }),
        clear: () => {},
      },
      canUseMachine: async () => ({ outcome: 'allowed' }),
    });

    const meta = {
      id: SESSION_ID,
      machineId: MACHINE_ID,
      userId: 'owner-user',
      cliType: 'registry',
      agentType: 'antigravity',
      acpSessionId: 'acp-fresh-2' as ACPSessionId,
    } as SessionMeta;

    // Queued normal user turn carrying stale resume='acp-1' MUST switch to current 'acp-fresh-2'.
    const normalReq = await (
      watcher as unknown as {
        buildChatRequestFromHistoryEntry: (...args: unknown[]) => Promise<{
          acpSessionConfig: { resume?: string };
        }>;
      }
    ).buildChatRequestFromHistoryEntry(
      meta,
      {
        id: 'queued-u2',
        role: 'user',
        timestamp: '2026-11-27T02:00:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'queued follow-up' }],
        inputConfig: { prompt: 'queued follow-up', resume: 'acp-1' as ACPSessionId },
      },
      undefined,
      { name: 'Owner', email: 'owner@example.com' }
    );
    expect(normalReq.acpSessionConfig.resume).toBe('acp-fresh-2');

    // Automation turn explicitly pinned via `_lodyAutomation.nativeSessionId` keeps its exact binding.
    const pinnedReq = await (
      watcher as unknown as {
        buildChatRequestFromHistoryEntry: (...args: unknown[]) => Promise<{
          acpSessionConfig: { resume?: string };
        }>;
      }
    ).buildChatRequestFromHistoryEntry(
      meta,
      {
        id: 'auto-u3',
        role: 'user',
        timestamp: '2026-11-27T02:00:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'automation check' }],
        inputConfig: {
          prompt: 'automation check',
          resume: 'acp-1' as ACPSessionId,
          _lodyAutomation: {
            invocationId: 'inv-1',
            ruleId: 'rule-1',
            ruleRevision: 1,
            eventRef: 'evt-1',
            authorizationUserId: 'owner-user',
            nativeSessionId: 'acp-1',
          },
        },
      },
      undefined,
      { name: 'Owner', email: 'owner@example.com' }
    );
    expect(pinnedReq.acpSessionConfig.resume).toBe('acp-1');
  });

  it('Hard Trap #2: ACP_RESUME_FAILED after rollover replays ONLY bounded node opening + post-rollover turns (zero pre-rollover backwash)', async () => {
    const h = createRolloverExecutionHarness({
      resumeError: new Error('[ACP_RESUME_FAILED] remote transcript gone'),
      initialHistory: [
        {
          id: 'turn-old-1',
          role: 'user',
          author: { v: 1, kind: 'human', userId: 'owner-user' },
          timestamp: '2026-11-27T01:00:00.000Z',
          fileDiff: [],
          items: [{ type: 'text', text: 'Origin task' }],
        },
        {
          id: 'assistant:turn-old-1',
          role: 'assistant',
          userTurnId: 'turn-old-1',
          timestamp: '2026-11-27T01:00:05.000Z',
          fileDiff: [],
          items: [{ type: 'text', text: 'ANCIENT_PRE_ROLLOVER_BLOAT_SENTINEL_100K' }],
        },
        {
          id: 'turn-old-2',
          role: 'user',
          author: { v: 1, kind: 'human', userId: 'owner-user' },
          timestamp: '2026-11-27T01:01:00.000Z',
          fileDiff: [],
          items: [{ type: 'text', text: 'Closing round of node 1' }],
        },
        {
          id: 'assistant:turn-old-2',
          role: 'assistant',
          userTurnId: 'turn-old-2',
          timestamp: '2026-11-27T01:01:05.000Z',
          fileDiff: [],
          items: [{ type: 'text', text: 'Node 1 closed.' }],
        },
        {
          id: 'turn-node2-1',
          role: 'user',
          author: { v: 1, kind: 'human', userId: 'owner-user' },
          timestamp: '2026-11-27T02:00:00.000Z',
          fileDiff: [],
          items: [{ type: 'text', text: 'POST_ROLLOVER_TURN_SENTINEL' }],
        },
        {
          id: 'assistant:turn-node2-1',
          role: 'assistant',
          userTurnId: 'turn-node2-1',
          timestamp: '2026-11-27T02:00:05.000Z',
          fileDiff: [],
          items: [{ type: 'text', text: 'POST_ROLLOVER_REPLY_SENTINEL' }],
        },
      ],
    });

    await h.rolloverStore.set(SESSION_ID, {
      version: 1,
      sessionId: SESSION_ID,
      generation: 2,
      activeAcpSessionId: 'acp-node-2',
      originTurnId: 'turn-old-1',
      lastSealedTurnId: 'assistant:turn-old-2',
      usedAfterLastRollover: 26_000,
      stateCard: {
        goalAndPlan: 'NODE2_STATE_CARD_SENTINEL',
        lockedInvariants: ['LOCKED_INVARIANT_RECOVERY_SENTINEL'],
        decisionsAndDeadEnds: [],
        workspaceFacts: '',
        openAndNext: 'Continue node 2',
      },
      spine: [
        {
          gen: 1,
          nodeId: 'n_0001',
          window: '11-27 01:00~01:00',
          startTurnId: 'turn-old-1',
          endTurnId: 'assistant:turn-old-1',
          turnCount: 1,
          oneLiner: 'Node 1',
          quality: 'warm_llm',
        },
        {
          gen: 2,
          nodeId: 'n_0002',
          window: '11-27 01:01~01:01',
          startTurnId: 'turn-old-2',
          endTurnId: 'assistant:turn-old-2',
          turnCount: 1,
          oneLiner: 'Node 2',
          quality: 'warm_llm',
        },
      ],
      updatedAt: 2_000,
    });

    // Drop in-memory agent so continueSession tries resumeSessionId='acp-1', fails with ACP_RESUME_FAILED,
    // and falls back to buildHistoryReplay!
    h.dropLiveAgent();
    await h.sendContinue('Resume node 2 after crash');

    expect(h.prompts).toHaveLength(1);
    const replaySent = h.prompts[0]!.text;
    expect(replaySent).toContain('NODE2_STATE_CARD_SENTINEL');
    expect(replaySent).toContain('LOCKED_INVARIANT_RECOVERY_SENTINEL');
    expect(replaySent).toContain('POST_ROLLOVER_TURN_SENTINEL');
    expect(replaySent).toContain('POST_ROLLOVER_REPLY_SENTINEL');
    expect(replaySent).not.toContain('ANCIENT_PRE_ROLLOVER_BLOAT_SENTINEL_100K');
  });

  it('Hard Trap #4: failed :renew keeps pendingSwitch intact, marks M visibly failed without watcher spin, restores source ACP, and same-ID retry smoothly transitions divider failed -> switching -> done without duplicates', async () => {
    let failFirstRenew = true;
    const h = createRolloverExecutionHarness({
      onPrompt: ({ text, writeActiveAssistantText, setUsage }) => {
        if (text.includes('[Lody Internal Handoff Seal')) {
          writeActiveAssistantText(
            JSON.stringify({
              oneLiner: 'Sealed before network error',
              stateCard: {
                goalAndPlan: 'Retry resilience',
                lockedInvariants: ['Preserve pendingSwitch on failure'],
                decisionsAndDeadEnds: [],
                workspaceFacts: '',
                openAndNext: 'Retry',
              },
            })
          );
          return;
        }
        if (text.includes('[Lody Session Node Handoff')) {
          if (failFirstRenew) {
            failFirstRenew = false;
            throw new Error('ECONNRESET during renew');
          }
          writeActiveAssistantText('Ready.');
          setUsage(24_000);
          return;
        }
        writeActiveAssistantText('Answered after retry.');
      },
    });

    await h.sendContinue('/rollover');
    const pendingBefore = (await h.rolloverStore.get(SESSION_ID))?.pendingSwitch;
    expect(pendingBefore).toBeDefined();

    // First attempt of user message M fails during `:renew` -> pendingSwitch preserved,
    // source ACP restored, M marked visibly failed (no watcher spin), divider status = 'failed'.
    const messageId = await h.sendContinue('My important message M', {
      userTurnId: 'user-m-retry',
    });
    expect(messageId).toBe('user-m-retry');
    const pendingAfterFailure = (await h.rolloverStore.get(SESSION_ID))?.pendingSwitch;
    expect(pendingAfterFailure?.runId).toBe(pendingBefore!.runId);
    expect((await h.rolloverStore.get(SESSION_ID))?.generation).toBe(0);
    expect(h.getMeta().acpSessionId).toBe('acp-1');
    expect(h.getMeta().lastHandledUserMsgId).toBe('user-m-retry');
    expect(h.getMeta().lastFailedUserMsgId).toBe('user-m-retry');
    const failedEntry = h.history.find((e) => e.id === 'user-m-retry');
    expect(failedEntry?.status).toBe('failed');
    // Watcher must NOT spin on the failed user turn!
    expect(findNextDispatchableUserTurn(h.history, h.getMeta())).toBeNull();
    // Divider shows failed on the same single divider entry.
    const dividersAfterFail = h.history.filter(
      (e) => e.role === 'system' && e.id.startsWith('session-rollover:')
    );
    expect(dividersAfterFail).toHaveLength(1);
    expect(readSessionRolloverNotice(dividersAfterFail[0]!)).toMatchObject({
      status: 'failed',
      generation: 1,
    });
    // M was NOT sent to the broken fresh session.
    expect(h.prompts.some((p) => p.text === 'My important message M')).toBe(false);

    // Retry using the EXACT SAME userTurnId: divider transitions failed -> switching -> done
    // in place (zero duplicates!), lastFailedUserMsgId clears, and pure M is delivered!
    await h.sendContinue('My important message M', {
      userTurnId: 'user-m-retry',
      reuseExistingHistoryEntry: true,
    });
    const afterRetry = await h.rolloverStore.get(SESSION_ID);
    expect(afterRetry?.pendingSwitch).toBeUndefined();
    expect(afterRetry?.generation).toBe(1);
    expect(h.prompts.at(-1)?.text).toBe('My important message M');
    expect(h.history.find((e) => e.id === 'user-m-retry')?.status).toBe('handled');
    expect(h.getMeta().lastFailedUserMsgId).toBeUndefined();
    const dividersAfterRetry = h.history.filter(
      (e) => e.role === 'system' && e.id.startsWith('session-rollover:')
    );
    expect(dividersAfterRetry).toHaveLength(1);
    expect(readSessionRolloverNotice(dividersAfterRetry[0]!)).toMatchObject({
      status: 'done',
      generation: 1,
      usedAfter: 24_000,
    });
  });

  it('Phase 0: bare /compact appends preservation instructions and writes visible status confirmation on zero-output completion without breaking ordinary silent turn failure', async () => {
    const h = createRolloverExecutionHarness({
      observePromptContentForTurn: (_sid, turnId) =>
        turnId !== 'assistant:turn-bare-compact' && turnId !== 'assistant:turn-silent-normal',
    });

    // 1. Bare `/compact` returning cleanly with zero visible output -> enriched prompt + visible confirmation (NOT agent_no_output failure)
    await h.sendContinue('/compact', { userTurnId: 'turn-bare-compact' });
    expect(h.prompts[0]!.text).toBe(`/compact ${BARE_COMPACT_DEFAULT_INSTRUCTIONS}`);
    const compactAssistant = h.history.find((e) => e.id === 'assistant:turn-bare-compact');
    expect(compactAssistant?.items).toEqual([
      { type: 'text', text: EXPLICIT_COMPACT_VISIBLE_FALLBACK_TEXT },
    ]);
    expect(h.deps.recordChatFailure).not.toHaveBeenCalled();

    // 2. Ordinary non-`/compact` turn with zero visible output STILL records `agent_no_output` silent turn failure!
    await h.sendContinue('Normal question that returns silence', {
      userTurnId: 'turn-silent-normal',
    });
    expect(h.deps.recordChatFailure).toHaveBeenCalledWith(
      expect.anything(),
      'agent_no_output',
      expect.any(String)
    );
  });

  it('Phase 2 + Hard Trap #3: mid-turn native auto-compact (90k -> 520k -> 30k -> 60k) on an ordinary non-Board session automatically triggers cold post_compact_recovery seal without waking degraded acp-1', async () => {
    const coldCalls: string[] = [];
    const h = createRolloverExecutionHarness({
      board: null,
      metaPatch: {
        boardId: undefined,
        boardRole: undefined,
        contextWindowUsage: { size: 1_000_000, used: 90_000 },
      },
      coldSummarizer: async ({ prompt }) => {
        coldCalls.push(prompt);
        return JSON.stringify({
          oneLiner: 'Cold Loro recovery after mid-turn native compact',
          stateCard: {
            goalAndPlan: 'Recover cleanly from Loro plain text',
            lockedInvariants: ['COLD_PATH_INVARIANT_SENTINEL'],
            decisionsAndDeadEnds: ['Avoided querying degraded ACP session'],
            workspaceFacts: 'Verified from Loro',
            openAndNext: 'Continue on fresh node',
          },
        });
      },
      onPrompt: ({ callIndex, service, setUsage, writeActiveAssistantText }) => {
        if (callIndex === 0) {
          // Simulate long autonomous turn hitting native 512k auto-compact mid-turn,
          // then regrowing to 60k before finishing.
          service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 520_000 });
          service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 30_000 });
          service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 60_000 });
          setUsage(60_000);
          writeActiveAssistantText('Finished long refactor after mid-turn compact.');
        }
      },
    });

    // Turn 1 triggers mid-turn usage drop (90k -> 520k -> 30k -> 60k) -> automatically
    // triggers `post_compact_recovery` cold Loro seal right at turn end!
    await h.sendContinue('Run the huge multi-file refactor');
    // Still only 1 ACP prompt (the original user turn) — ZERO warm `:seal` sent to degraded acp-1!
    expect(h.prompts).toHaveLength(1);
    expect(coldCalls).toHaveLength(1);
    expect(coldCalls[0]).toContain('Run the huge multi-file refactor');
    expect(coldCalls[0]).toContain('Finished long refactor after mid-turn compact.');
    // Non-Board session must NEVER arm Board compact reinject store.
    expect(await h.reinjectStore.has(SESSION_ID)).toBe(false);

    const sealed = await h.rolloverStore.get(SESSION_ID);
    expect(sealed?.degradedByNativeCompact).toBe(true);
    expect(sealed?.pendingSwitch).toMatchObject({
      reason: 'post_compact_recovery',
      targetGen: 1,
    });
    expect(sealed?.stateCard.lockedInvariants).toEqual([]);
    expect(sealed?.spine).toEqual([]);
    expect(sealed?.pendingSwitch?.candidateStateCard?.lockedInvariants).toContain(
      'COLD_PATH_INVARIANT_SENTINEL'
    );
    expect(sealed?.pendingSwitch?.candidateSpineItem?.quality).toBe('cold_llm');
    const divider = h.history.find(
      (e) => e.id === sessionRolloverTurnId(sealed!.pendingSwitch!.runId)
    );
    expect(readSessionRolloverNotice(divider!)).toMatchObject({
      trigger: 'recovery',
      status: 'sealed',
      generation: 1,
    });
  });

  it('Phase 2 + Hard Trap #6: end-of-turn auto warm :seal triggers at >= 350k, lazily switches on next turn, and suppresses false usage_drop even when low usage arrives deferred on turn N+1', async () => {
    const h = createRolloverExecutionHarness({
      metaPatch: {
        contextWindowUsage: { size: 1_000_000, used: 200_000 },
      },
      onPrompt: ({ callIndex, text, service, setUsage, writeActiveAssistantText }) => {
        if (callIndex === 0) {
          // Turn 1 crosses 350k threshold (360k >= 350k, delta = 360k >= 80k)
          service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 360_000 });
          setUsage(360_000);
          writeActiveAssistantText('Completed heavy turn at 360k.');
        } else if (callIndex === 1) {
          // Automatic warm `:seal` right at end of Turn 1
          expect(text).toContain('[Lody Internal Handoff Seal');
          writeActiveAssistantText(
            JSON.stringify({
              oneLiner: 'Auto-sealed at 360k',
              stateCard: {
                goalAndPlan: 'Proactive handoff',
                lockedInvariants: ['AUTO_SEAL_INVARIANT'],
                decisionsAndDeadEnds: [],
                workspaceFacts: '',
                openAndNext: 'Next user task',
              },
            })
          );
        } else if (callIndex === 2) {
          // Lazy `:renew` on Turn 2 — deliberately do NOT update usage yet (deferred usage_update!)
          writeActiveAssistantText('Ready.');
        } else if (callIndex === 3) {
          // Pure user message M on Turn 2 — still deferred (meta still shows 360k)
          writeActiveAssistantText('Answered M on fresh node.');
        } else if (callIndex === 4) {
          // Turn 3 (immediately following turn after rollover): provider FINALLY reports 26k!
          // Hard Trap #6: MUST NOT misclassify legal 360k -> 26k as native auto-compact!
          service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 26_000 });
          setUsage(26_000);
          writeActiveAssistantText('Answered follow-up cleanly.');
        }
      },
    });

    // 1. Ordinary turn finishes at 360k -> automatic warm `:seal` fires immediately while hot.
    await h.sendContinue('Do heavy investigation');
    expect(h.prompts).toHaveLength(2);
    expect(h.createSessionSpy).not.toHaveBeenCalled();
    const afterAutoSeal = await h.rolloverStore.get(SESSION_ID);
    expect(afterAutoSeal?.pendingSwitch).toMatchObject({
      reason: 'proactive_threshold',
      targetGen: 1,
      usedBefore: 360_000,
    });
    const autoDivider = h.history.find(
      (e) => e.id === sessionRolloverTurnId(afterAutoSeal!.pendingSwitch!.runId)
    );
    expect(readSessionRolloverNotice(autoDivider!)).toMatchObject({
      trigger: 'auto',
      status: 'sealed',
      generation: 1,
      usedBefore: 360_000,
    });

    // 2. Next normal user message triggers lazy `:renew` (with deferred usage), then pure M.
    await h.sendContinue('Now apply the fix');
    expect(h.prompts).toHaveLength(4);
    expect(h.prompts[3]!.text).toBe('Now apply the fix');
    const afterRenew = await h.rolloverStore.get(SESSION_ID);
    expect(afterRenew?.pendingSwitch).toBeUndefined();
    expect(afterRenew?.generation).toBe(1);
    expect(afterRenew?.degradedByNativeCompact).toBe(false);

    // 3. Follow-up turn receives deferred 360k -> 26k usage_update: MUST NOT mark degraded or arm Board reinject!
    await h.sendContinue('Verify the fix');
    expect(h.prompts).toHaveLength(5);
    const afterFollowUp = await h.rolloverStore.get(SESSION_ID);
    expect(afterFollowUp?.degradedByNativeCompact).toBe(false);
    expect(afterFollowUp?.usedAfterLastRollover).toBe(26_000);
    expect(await h.reinjectStore.has(SESSION_ID)).toBe(false);
    expect(h.prompts[4]!.text).not.toContain('<board_context_reminder>');
  });

  it('Phase 2 safety gates: skips auto :seal for coordinator, active /goal, pinned automation nativeSessionId, pending native work, queued user messages, and delta < 80k', async () => {
    const cases: Array<{
      name: string;
      metaPatch?: Partial<SessionMeta>;
      extraHistory?: SessionHistoryInput[];
      priorUsedAfterRollover?: number;
      nativeSessionId?: string;
      pendingNativeWork?: boolean;
    }> = [
      {
        name: 'coordinator',
        metaPatch: { boardRole: 'coordinator' },
      },
      {
        name: 'active goal',
        extraHistory: [
          {
            id: 'goal-turn-1',
            role: 'system',
            timestamp: '2026-11-27T01:30:00.000Z',
            fileDiff: [],
            items: [
              {
                type: 'goal',
                threadId: 'goal-1',
                status: 'active',
                objective: 'Finish migration',
              } as never,
            ],
          },
        ],
      },
      {
        name: 'pinned automation nativeSessionId',
        nativeSessionId: 'acp-1',
      },
      {
        name: 'pending native work',
        pendingNativeWork: true,
      },
      {
        name: 'queued user messages',
        metaPatch: { messageQueueUpdatedAt: 200, messageQueueCheckedAt: 100 },
      },
      {
        name: 'delta < 80k since last rollover',
        priorUsedAfterRollover: 300_000,
      },
    ];

    for (const tc of cases) {
      const h = createRolloverExecutionHarness({
        metaPatch: {
          contextWindowUsage: { size: 1_000_000, used: 360_000 },
          ...tc.metaPatch,
        },
        ...(tc.extraHistory
          ? {
              initialHistory: [
                {
                  id: 'turn-u1',
                  role: 'user',
                  author: { v: 1, kind: 'human', userId: 'owner-user' },
                  timestamp: '2026-11-27T01:00:00.000Z',
                  status: 'handled',
                  fileDiff: [],
                  items: [{ type: 'text', text: 'Origin' }],
                },
                ...tc.extraHistory,
              ],
            }
          : {}),
        onPrompt: ({ setUsage, writeActiveAssistantText }) => {
          setUsage(360_000);
          writeActiveAssistantText(`Done (${tc.name}).`);
        },
      });
      if (tc.nativeSessionId) {
        h.service.setAutomationAdmission(
          async () => true,
          () => true
        );
        vi.spyOn(h.service, 'acceptAutomationInput').mockResolvedValue(true);
      }
      if (tc.pendingNativeWork) {
        vi.spyOn(h.service, 'hasPendingNativeWork').mockReturnValue(true);
      }
      if (tc.priorUsedAfterRollover !== undefined) {
        await h.rolloverStore.set(SESSION_ID, {
          version: 1,
          sessionId: SESSION_ID,
          generation: 1,
          activeAcpSessionId: 'acp-1',
          lastSealedTurnId: 'turn-u1',
          usedAfterLastRollover: tc.priorUsedAfterRollover,
          stateCard: {
            goalAndPlan: 'G',
            lockedInvariants: [],
            decisionsAndDeadEnds: [],
            workspaceFacts: '',
            openAndNext: '',
          },
          spine: [],
          updatedAt: 1_000,
        });
      }

      await h.sendContinue(`Trigger check for ${tc.name}`, {
        ...(tc.nativeSessionId ? { nativeSessionId: tc.nativeSessionId } : {}),
      });
      // Only the user turn prompt ran — ZERO automatic `:seal` prompt!
      expect(h.prompts, `case: ${tc.name}`).toHaveLength(1);
      expect((await h.rolloverStore.get(SESSION_ID))?.pendingSwitch, `case: ${tc.name}`).toBeUndefined();
    }
  });

  it('Phase 2 Stop preemption: cancelling during auto :seal writes silent auto+interrupted divider and leaves pendingSwitch unarmed', async () => {
    let sealStartedResolve!: () => void;
    const sealStarted = new Promise<void>((resolve) => {
      sealStartedResolve = resolve;
    });

    const h = createRolloverExecutionHarness({
      metaPatch: {
        contextWindowUsage: { size: 1_000_000, used: 200_000 },
      },
      onPrompt: async ({ callIndex, signal, setUsage, writeActiveAssistantText }) => {
        if (callIndex === 0) {
          setUsage(370_000);
          writeActiveAssistantText('Main answer finished.');
          return;
        }
        // In-flight auto `:seal` waits until Stop cancels it.
        sealStartedResolve();
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            reject(new Error('cancelled'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      },
    });

    const turnPromise = h.sendContinue('Heavy turn before Stop');
    await sealStarted;

    const cancelRes = await h.service.cancelSession({
      type: 'session/cancel',
      sessionId: SESSION_ID,
      machineId: MACHINE_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(cancelRes).toEqual({ success: true });
    await turnPromise;

    expect((await h.rolloverStore.get(SESSION_ID))?.pendingSwitch).toBeUndefined();
    const divider = h.history.find((e) => e.role === 'system' && e.id.startsWith('session-rollover:'));
    expect(divider).toBeDefined();
    const notice = readSessionRolloverNotice(divider!);
    expect(notice).toMatchObject({
      trigger: 'auto',
      status: 'interrupted',
    });
    expect(isSilentSessionRollover(notice!)).toBe(true);
  });

  it('Round 1 #1: :renew returning cancelled, refusal, or empty visible output keeps pendingSwitch intact and never commits node', async () => {
    const cases: Array<{
      name: string;
      renewOutcome: { stopReason?: string; text?: string };
      expectedDividerStatus: 'failed' | 'interrupted';
    }> = [
      {
        name: 'stopReason=cancelled',
        renewOutcome: { stopReason: 'cancelled', text: 'Ready.' },
        expectedDividerStatus: 'interrupted',
      },
      {
        name: 'stopReason=refusal',
        renewOutcome: { stopReason: 'refusal', text: 'Cannot comply.' },
        expectedDividerStatus: 'failed',
      },
      {
        name: 'empty visible output',
        renewOutcome: { stopReason: 'end_turn', text: '' },
        expectedDividerStatus: 'failed',
      },
    ];

    for (const tc of cases) {
      const h = createRolloverExecutionHarness({
        onPrompt: ({ text, writeActiveAssistantText }) => {
          if (text.includes('[Lody Internal Handoff Seal')) {
            writeActiveAssistantText(
              JSON.stringify({
                oneLiner: 'Sealed',
                stateCard: {
                  goalAndPlan: 'G',
                  lockedInvariants: [],
                  decisionsAndDeadEnds: [],
                  workspaceFacts: '',
                  openAndNext: 'Next',
                },
              })
            );
            return { stopReason: 'end_turn' };
          }
          if (text.includes('[Lody Session Node Handoff')) {
            if (tc.renewOutcome.text) writeActiveAssistantText(tc.renewOutcome.text);
            return { stopReason: tc.renewOutcome.stopReason };
          }
          writeActiveAssistantText('Unexpected user turn delivery');
          return { stopReason: 'end_turn' };
        },
      });

      await h.sendContinue('/rollover');
      const runId = (await h.rolloverStore.get(SESSION_ID))?.pendingSwitch?.runId;
      expect(runId, tc.name).toBeDefined();

      await h.sendContinue('Deliver me only after valid renew');
      const state = await h.rolloverStore.get(SESSION_ID);
      expect(state?.pendingSwitch?.runId, tc.name).toBe(runId);
      expect(state?.generation, tc.name).toBe(0);
      expect(
        h.prompts.some((p) => p.text === 'Deliver me only after valid renew'),
        tc.name
      ).toBe(false);
      const divider = h.history.find((e) => e.id === sessionRolloverTurnId(runId!));
      expect(readSessionRolloverNotice(divider!)?.status, tc.name).toBe(tc.expectedDividerStatus);
    }
  });

  it('Round 1 #3: Edit & Resend after seal invalidates stale pendingSwitch without retiring the edited ACP session', async () => {
    const h = createRolloverExecutionHarness({
      metaPatch: { contextWindowUsage: { size: 1_000_000, used: 120_000 } },
      onPrompt: ({ text, writeActiveAssistantText }) => {
        if (text.includes('[Lody Internal Handoff Seal')) {
          writeActiveAssistantText(
            JSON.stringify({
              oneLiner: 'Sealed before edit-and-resend',
              stateCard: {
                goalAndPlan: 'G',
                lockedInvariants: [],
                decisionsAndDeadEnds: [],
                workspaceFacts: '',
                openAndNext: '',
              },
            })
          );
          return;
        }
        writeActiveAssistantText('Answered edited message directly.');
      },
    });

    await h.sendContinue('/rollover');
    const sealedState = await h.rolloverStore.get(SESSION_ID);
    const staleRunId = sealedState?.pendingSwitch?.runId;
    expect(staleRunId).toBeDefined();

    // Simulate Edit & Resend rewriting history (removing `assistant:turn-u1`) and replacing ACP session.
    const idx = h.history.findIndex((e) => e.id === 'assistant:turn-u1');
    expect(idx).toBeGreaterThanOrEqual(0);
    h.history.splice(idx, 1);
    h.replaceLiveAgent('acp-edited-fork' as ACPSessionId);

    await h.sendContinue('Edited replacement message');
    // Stale pendingSwitch invalidated; edited ACP was NEVER retired or replaced by `:renew`!
    expect(h.retireSpy).not.toHaveBeenCalled();
    expect(h.createSessionSpy).not.toHaveBeenCalled();
    expect((await h.rolloverStore.get(SESSION_ID))?.pendingSwitch).toBeUndefined();
    const staleDivider = h.history.find((e) => e.id === sessionRolloverTurnId(staleRunId!));
    expect(readSessionRolloverNotice(staleDivider!)).toMatchObject({
      status: 'interrupted',
      reason: 'history-rewritten',
    });
    expect(h.prompts.at(-1)).toMatchObject({
      acpSessionId: 'acp-edited-fork',
      text: 'Edited replacement message',
    });
  });

  it('Round 1 #4: first message M after :renew experiencing stale-ACP disconnect retries on NEW acpSessionId, never old acp-1', async () => {
    let failFirstUserPrompt = true;
    const h = createRolloverExecutionHarness({
      hasPromptEventsForTurn: () => false,
      onPrompt: ({ text, writeActiveAssistantText, setUsage }) => {
        if (text.includes('[Lody Internal Handoff Seal')) {
          writeActiveAssistantText(
            JSON.stringify({
              oneLiner: 'Sealed before disconnect test',
              stateCard: {
                goalAndPlan: 'G',
                lockedInvariants: [],
                decisionsAndDeadEnds: [],
                workspaceFacts: '',
                openAndNext: '',
              },
            })
          );
          return;
        }
        if (text.includes('[Lody Session Node Handoff')) {
          writeActiveAssistantText('Ready.');
          setUsage(25_000);
          return;
        }
        if (failFirstUserPrompt) {
          failFirstUserPrompt = false;
          throw Object.assign(new Error('Session not found'), { code: -32603 });
        }
        writeActiveAssistantText('Recovered on new node.');
      },
    });

    await h.sendContinue('/rollover');
    // Carry explicit pre-rollover `resume: 'acp-1'` to prove rollover updates effectiveResumeSessionId!
    await h.sendContinue('Message M hitting disconnect', { resume: 'acp-1' as ACPSessionId });

    // createSession call 0: fresh node (`resumeSessionId: undefined` -> `acp-fresh-1`).
    // createSession call 1: stale-ACP disconnect recovery -> MUST resume `acp-fresh-1`, NOT `acp-1`!
    expect(h.createSessionSpy).toHaveBeenCalledTimes(2);
    expect(h.createSessionSpy.mock.calls[1]?.[1]).toMatchObject({
      resumeSessionId: 'acp-fresh-1',
    });
    expect(h.prompts.at(-1)).toMatchObject({
      acpSessionId: 'acp-fresh-1',
      text: 'Message M hitting disconnect',
    });
  });

  it('Round 1 #5: implicit default thought_level (xhigh) lowers to low for :renew and explicitly restores xhigh for user message M', async () => {
    const h = createRolloverExecutionHarness({
      onPrompt: ({ text, writeActiveAssistantText, setUsage }) => {
        if (text.includes('[Lody Internal Handoff Seal')) {
          writeActiveAssistantText(
            JSON.stringify({
              oneLiner: 'Sealed',
              stateCard: {
                goalAndPlan: 'G',
                lockedInvariants: [],
                decisionsAndDeadEnds: [],
                workspaceFacts: '',
                openAndNext: '',
              },
            })
          );
          return;
        }
        if (text.includes('[Lody Session Node Handoff')) {
          writeActiveAssistantText('Ready.');
          setUsage(22_000);
          return;
        }
        writeActiveAssistantText('Answered M at restored xhigh.');
      },
    });

    await h.sendContinue('/rollover');
    // Omit configOptionValues to simulate implicit default `thought_level: 'xhigh'` advertised by ACP.
    await h.sendContinue('User message with implicit default thinking', {
      omitConfigOptionValues: true,
    });

    expect(h.configApplies).toHaveLength(2);
    expect(h.configApplies[0]).toMatchObject({
      acpSessionId: 'acp-fresh-1',
      configOptionValues: { thought_level: 'low' },
    });
    expect(h.configApplies[1]).toMatchObject({
      acpSessionId: 'acp-fresh-1',
      configOptionValues: { thought_level: 'xhigh' },
    });
  });

  it('Round 1 #6 + Round 2 #4: live native background work blocks auto :seal and lazy :renew retirement, invalidates stale pendingSwitch when M1 runs on old ACP, and re-seals including M1 once background work clears', async () => {
    const h = createRolloverExecutionHarness({
      metaPatch: { contextWindowUsage: { size: 1_000_000, used: 370_000 } },
      nativeWork: { kind: 'background' },
      onPrompt: ({ text, setUsage, writeActiveAssistantText }) => {
        if (text.includes('[Lody Internal Handoff Seal')) {
          writeActiveAssistantText(
            JSON.stringify({
              oneLiner: 'Sealed node including latest turns',
              stateCard: {
                goalAndPlan: 'G',
                lockedInvariants: [],
                decisionsAndDeadEnds: [],
                workspaceFacts: '',
                openAndNext: '',
              },
            })
          );
          return;
        }
        if (text.includes('[Lody Session Node Handoff')) {
          writeActiveAssistantText('Ready.');
          setUsage(24_000);
          return;
        }
        setUsage(370_000);
        writeActiveAssistantText('ANSWER_FOR_M1_WHILE_BG_ACTIVE.');
      },
    });

    // 1. Live `getNativeWork() -> { kind: 'background' }` blocks end-of-turn auto `:seal`.
    await h.sendContinue('Kick off background work');
    expect(h.prompts).toHaveLength(1);
    expect((await h.rolloverStore.get(SESSION_ID))?.pendingSwitch).toBeUndefined();

    // 2. Manual `/rollover` arms `pendingSwitch`, then ordinary M1 runs on old `acp-1`
    // because background work is still live -> old `acp-1` is NOT retired AND the stale
    // `pendingSwitch` MUST be invalidated so M1 is not silently dropped later!
    await h.sendContinue('/rollover');
    const staleRunId = (await h.rolloverStore.get(SESSION_ID))?.pendingSwitch?.runId;
    expect(staleRunId).toBeDefined();

    await h.sendContinue('M1_DURING_BACKGROUND_WORK');
    expect(h.retireSpy).not.toHaveBeenCalled();
    expect(h.createSessionSpy).not.toHaveBeenCalled();
    expect(h.prompts.at(-1)).toMatchObject({
      acpSessionId: 'acp-1',
      text: 'M1_DURING_BACKGROUND_WORK',
    });
    expect((await h.rolloverStore.get(SESSION_ID))?.pendingSwitch).toBeUndefined();
    const staleDivider = h.history.find((e) => e.id === sessionRolloverTurnId(staleRunId!));
    expect(readSessionRolloverNotice(staleDivider!)).toMatchObject({
      status: 'interrupted',
      reason: 'superseded-by-live-turn',
    });

    // 3. Once background work clears, a fresh `/rollover` + M2 `:renew` MUST include M1!
    h.setNativeWork({ kind: null });
    // Flush microtasks so `watchNativeWork`'s `onNativeWorkChanged` settlement unregisters.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await h.sendContinue('/rollover');
    expect((await h.rolloverStore.get(SESSION_ID))?.pendingSwitch).toBeDefined();

    await h.sendContinue('M2_AFTER_BG_DONE');
    const renewPrompt = h.prompts.find((p) => p.text.includes('[Lody Session Node Handoff'));
    expect(renewPrompt).toBeDefined();
    expect(renewPrompt!.text).toContain('M1_DURING_BACKGROUND_WORK');
    expect(renewPrompt!.text).toContain('ANSWER_FOR_M1_WHILE_BG_ACTIVE.');
    expect(h.prompts.at(-1)).toMatchObject({
      acpSessionId: 'acp-fresh-1',
      text: 'M2_AFTER_BG_DONE',
    });
  });

  it('Round 1 #7: SessionDispatchWatcher preempts in-flight auto :seal on incoming user activation and writes silent auto+interrupted without pendingSwitch', async () => {
    let sealStartedResolve!: () => void;
    const sealStarted = new Promise<void>((resolve) => {
      sealStartedResolve = resolve;
    });

    const h = createRolloverExecutionHarness({
      metaPatch: {
        contextWindowUsage: { size: 1_000_000, used: 200_000 },
      },
      onPrompt: async ({ callIndex, signal, setUsage, writeActiveAssistantText }) => {
        if (callIndex === 0) {
          setUsage(370_000);
          writeActiveAssistantText('Turn 1 complete.');
          return;
        }
        sealStartedResolve();
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new Error('cancelled'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      },
    });

    const turn1 = h.sendContinue('Heavy turn triggering auto seal');
    await sealStarted;

    // Simulate a new user turn activation arriving at SessionDispatchWatcher while auto `:seal` owns the slot.
    h.setMeta({ latestUserMsgId: 'u-incoming-new', lastHandledUserMsgId: 'turn-u1' });
    const enqueueSpy = vi.fn(async () => {});
    const watcher = new SessionDispatchWatcher({
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
      machineId: MACHINE_ID,
      workspaceId: WORKSPACE_ID,
      workspaceDocument: h.deps.workspaceDocument,
      executionService: h.service,
      userResolver: {
        resolve: async () => ({ id: 'owner-user', name: 'Owner', email: 'owner@example.com' }),
        clear: () => {},
      },
      canUseMachine: async () => ({ outcome: 'allowed' }),
    });
    (watcher as unknown as { enqueueSessionCheck: typeof enqueueSpy }).enqueueSessionCheck =
      enqueueSpy;

    await (
      watcher as unknown as { maybeHandleSession: (sid: SessionId) => Promise<void> }
    ).maybeHandleSession(SESSION_ID);

    await turn1;
    // Wait a microtask tick for `sealRelease.then(() => enqueueSessionCheck)` to fire.
    await Promise.resolve();
    await Promise.resolve();

    expect((await h.rolloverStore.get(SESSION_ID))?.pendingSwitch).toBeUndefined();
    const divider = h.history.find((e) => e.role === 'system' && e.id.startsWith('session-rollover:'));
    expect(isSilentSessionRollover(readSessionRolloverNotice(divider!)!)).toBe(true);
    expect(enqueueSpy).toHaveBeenCalledWith(SESSION_ID);
  });

  it('Round 1 #8: watcher-dispatched _lodyAutomation.nativeSessionId blocks BOTH auto :seal and lazy :renew (never throws AUTOMATION_NATIVE_SESSION_CHANGED)', async () => {
    const h = createRolloverExecutionHarness({
      metaPatch: { contextWindowUsage: { size: 1_000_000, used: 370_000 } },
      onPrompt: ({ text, setUsage, writeActiveAssistantText }) => {
        if (text.includes('[Lody Internal Handoff Seal')) {
          writeActiveAssistantText(
            JSON.stringify({
              oneLiner: 'Manual seal before pinned automation turn',
              stateCard: {
                goalAndPlan: 'G',
                lockedInvariants: [],
                decisionsAndDeadEnds: [],
                workspaceFacts: '',
                openAndNext: '',
              },
            })
          );
          return;
        }
        setUsage(370_000);
        writeActiveAssistantText('Pinned automation check done.');
      },
    });
    h.service.setAutomationAdmission(
      async () => true,
      () => true
    );
    vi.spyOn(h.service, 'acceptAutomationInput').mockResolvedValue(true);

    // Arm a pendingSwitch via `/rollover`, then dispatch a pinned automation turn via
    // `dispatchPreparedSessionTurn` carrying `_lodyAutomation.nativeSessionId` on `invocation.inputConfig`
    // (and verify `buildChatRequestFromHistoryEntry` also propagates `_lodyAutomation`).
    await h.sendContinue('/rollover');
    expect((await h.rolloverStore.get(SESSION_ID))?.pendingSwitch).toBeDefined();

    const pinnedAutomation = {
      invocationId: 'inv-pinned-watcher',
      ruleId: 'rule-pinned-watcher',
      ruleRevision: 1,
      eventRef: 'evt-pinned-watcher',
      authorizationUserId: 'owner-user',
      nativeSessionId: 'acp-1',
    };
    const watcher = new SessionDispatchWatcher({
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
      machineId: MACHINE_ID,
      workspaceId: WORKSPACE_ID,
      workspaceDocument: h.deps.workspaceDocument,
      executionService: h.service,
      userResolver: {
        resolve: async () => ({ id: 'owner-user', name: 'Owner', email: 'owner@example.com' }),
        clear: () => {},
      },
      canUseMachine: async () => ({ outcome: 'allowed' }),
    });
    const pinnedEntry: SessionHistoryInput = {
      id: 'user-pinned-auto',
      role: 'user',
      timestamp: '2026-11-27T02:10:00.000Z',
      status: 'pending',
      fileDiff: [],
      items: [{ type: 'text', text: 'Run pinned automation check' }],
      inputConfig: {
        prompt: 'Run pinned automation check',
        cliType: 'registry',
        agentType: 'antigravity',
        modelId: 'gemini-4-neon',
        resume: 'acp-1' as ACPSessionId,
        _lodyAutomation: pinnedAutomation,
      },
    };
    h.history.push(pinnedEntry);
    const builtChatReq = await (
      watcher as unknown as {
        buildChatRequestFromHistoryEntry: (...args: unknown[]) => Promise<Record<string, unknown>>;
      }
    ).buildChatRequestFromHistoryEntry(h.getMeta(), pinnedEntry, undefined, {
      id: 'owner-user',
      name: 'Owner',
      email: 'owner@example.com',
    });
    expect(
      (builtChatReq.acpSessionConfig as { _lodyAutomation?: unknown })._lodyAutomation
    ).toEqual(pinnedAutomation);

    await h.service.dispatchPreparedSessionTurn({
      sessionId: SESSION_ID,
      sessionDoc: h.sessionDoc as unknown as SessionDocument,
      userTurnId: 'user-pinned-auto',
      invocation: {
        sourceTurnId: 'user-pinned-auto',
        requesterUserId: 'owner-user',
        inputConfig: pinnedEntry.inputConfig!,
      },
      dispatchSource: 'crdt',
      accessPromise: Promise.resolve({ outcome: 'allowed' }),
      requestPromise: Promise.resolve({ mode: 'continue', request: builtChatReq as never }),
      onAccessAllowed: async () => {},
      onAccessDenied: async () => {},
      onAccessIndeterminate: async () => {},
    });

    // Must stay on `acp-1`, preserve `pendingSwitch`, and NOT throw AUTOMATION_NATIVE_SESSION_CHANGED!
    expect(h.retireSpy).not.toHaveBeenCalled();
    expect(h.createSessionSpy).not.toHaveBeenCalled();
    expect(h.prompts.at(-1)).toMatchObject({
      acpSessionId: 'acp-1',
      text: 'Run pinned automation check',
    });
    expect((await h.rolloverStore.get(SESSION_ID))?.pendingSwitch).toBeDefined();
    expect(h.deps.recordChatFailure).not.toHaveBeenCalled();
  });

  it('Round 1 #9 deferred recovery: when a safety gate blocks post_compact_recovery on turn 1, degradedByNativeCompact persists and auto-recovers on the next safe turn', async () => {
    const coldCalls: string[] = [];
    const h = createRolloverExecutionHarness({
      board: null,
      metaPatch: {
        boardId: undefined,
        boardRole: undefined,
        contextWindowUsage: { size: 1_000_000, used: 90_000 },
        // Queued user message blocks recovery on turn 1
        messageQueueUpdatedAt: 200,
        messageQueueCheckedAt: 100,
      },
      coldSummarizer: async ({ prompt }) => {
        coldCalls.push(prompt);
        return JSON.stringify({
          oneLiner: 'Deferred cold recovery succeeded',
          stateCard: {
            goalAndPlan: 'Recovered on next safe boundary',
            lockedInvariants: ['DEFERRED_RECOVERY_INVARIANT'],
            decisionsAndDeadEnds: [],
            workspaceFacts: '',
            openAndNext: '',
          },
        });
      },
      onPrompt: ({ callIndex, service, setUsage, writeActiveAssistantText }) => {
        if (callIndex === 0) {
          service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 520_000 });
          service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 40_000 });
          setUsage(40_000);
          writeActiveAssistantText('Turn 1 done with mid-turn compact.');
        } else {
          writeActiveAssistantText('Turn 2 done on safe boundary.');
        }
      },
    });

    await h.sendContinue('Turn 1 with queued work pending');
    expect(coldCalls).toHaveLength(0);
    const afterTurn1 = await h.rolloverStore.get(SESSION_ID);
    expect(afterTurn1?.degradedByNativeCompact).toBe(true);
    expect(afterTurn1?.pendingSwitch).toBeUndefined();

    // Queue drains -> Turn 2 completes on a safe boundary -> automatic cold post_compact_recovery fires!
    h.setMeta({ messageQueueCheckedAt: 200 });
    await h.sendContinue('Turn 2 after queue drained');
    expect(coldCalls).toHaveLength(1);
    const afterTurn2 = await h.rolloverStore.get(SESSION_ID);
    expect(afterTurn2?.pendingSwitch?.reason).toBe('post_compact_recovery');
    expect(afterTurn2?.pendingSwitch?.candidateStateCard?.lockedInvariants).toContain(
      'DEFERRED_RECOVERY_INVARIANT'
    );
  });

  it('Round 1 #10: manual /rollover on a session idle > 8 min captures pre-touch activity and takes cold path without waking old ACP', async () => {
    const now = 1_700_000_000_000;
    const coldCalls: string[] = [];
    const h = createRolloverExecutionHarness({
      nowMs: () => now,
      // Idle 15 minutes (> 8 min warm TTL); `touchSession` in harness refreshes `lastTouchedActivityMs = now`!
      initialLastActivityMs: now - 15 * 60_000,
      coldSummarizer: async ({ prompt }) => {
        coldCalls.push(prompt);
        return JSON.stringify({
          oneLiner: 'Cold sealed after 15m idle',
          stateCard: {
            goalAndPlan: 'Cold path verified',
            lockedInvariants: [],
            decisionsAndDeadEnds: [],
            workspaceFacts: '',
            openAndNext: '',
          },
        });
      },
    });

    await h.sendContinue('/rollover');
    // ZERO prompts sent to the cold live ACP process!
    expect(h.prompts).toHaveLength(0);
    expect(coldCalls).toHaveLength(1);
    const sealed = await h.rolloverStore.get(SESSION_ID);
    expect(sealed?.pendingSwitch).toBeDefined();
    expect(sealed?.pendingSwitch?.candidateSpineItem?.quality).toBe('cold_llm');
  });

  it('Round 1 #14: zero-output /compact confirmation requires agy bare end_turn OR compaction evidence; silent non-agy /compact without evidence fails as agent_no_output', async () => {
    // 1. Codex `/compact` with zero output and NO compaction marker / NO usage drop -> agent_no_output!
    const codexSilent = createRolloverExecutionHarness({
      metaPatch: {
        cliType: 'builtin',
        agentType: 'codex',
        contextWindowUsage: { size: 400_000, used: 120_000 },
      },
      observePromptContentForTurn: () => false,
    });
    await codexSilent.sendContinue('/compact', { userTurnId: 'codex-silent-compact' });
    expect(codexSilent.deps.recordChatFailure).toHaveBeenCalledWith(
      expect.anything(),
      'agent_no_output',
      expect.any(String)
    );
    const codexSilentEntry = codexSilent.history.find(
      (e) => e.id === 'assistant:codex-silent-compact'
    );
    expect(codexSilentEntry?.items ?? []).toEqual([]);

    // 2. Codex `/compact` with zero output WITH real usage drop (120k -> 18k) -> writes visible confirmation!
    const codexDropped = createRolloverExecutionHarness({
      metaPatch: {
        cliType: 'builtin',
        agentType: 'codex',
        contextWindowUsage: { size: 400_000, used: 120_000 },
      },
      observePromptContentForTurn: () => false,
      onPrompt: ({ service, setUsage }) => {
        service.noteContextWindowUsageUpdate(SESSION_ID, { size: 400_000, used: 18_000 });
        setUsage(18_000);
        return { stopReason: 'end_turn' };
      },
    });
    await codexDropped.sendContinue('/compact', { userTurnId: 'codex-dropped-compact' });
    expect(codexDropped.deps.recordChatFailure).not.toHaveBeenCalled();
    expect(
      codexDropped.history.find((e) => e.id === 'assistant:codex-dropped-compact')?.items
    ).toEqual([{ type: 'text', text: EXPLICIT_COMPACT_VISIBLE_FALLBACK_TEXT }]);

    // 3. Antigravity bare `/compact` returning `stopReason: 'refusal'` with zero output and no evidence -> agent_no_output!
    const agyRefused = createRolloverExecutionHarness({
      observePromptContentForTurn: () => false,
      onPrompt: () => ({ stopReason: 'refusal' }),
    });
    await agyRefused.sendContinue('/compact', { userTurnId: 'agy-refused-compact' });
    expect(agyRefused.deps.recordChatFailure).toHaveBeenCalledWith(
      expect.anything(),
      'agent_no_output',
      expect.any(String)
    );
  });

  it('Round 2 #2: explicit user /compact NEVER marks degradedByNativeCompact or triggers post_compact_recovery (agy bare, codex drop, or silent failure)', async () => {
    const coldCalls: string[] = [];
    // Case A: agy bare /compact succeeding cleanly
    const agyHarness = createRolloverExecutionHarness({
      metaPatch: { contextWindowUsage: { size: 1_000_000, used: 180_000 } },
      coldSummarizer: async ({ prompt }) => {
        coldCalls.push(prompt);
        return '{}';
      },
      onPrompt: ({ callIndex, service, setUsage, writeActiveAssistantText }) => {
        if (callIndex === 0) {
          service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 22_000 });
          setUsage(22_000);
          writeActiveAssistantText('Compacted cleanly.');
        } else {
          writeActiveAssistantText('Ordinary follow-up stays on acp-1.');
        }
      },
    });
    await agyHarness.sendContinue('/compact');
    expect((await agyHarness.rolloverStore.get(SESSION_ID))?.degradedByNativeCompact).not.toBe(
      true
    );
    await agyHarness.sendContinue('Keep using native compact control arm');
    expect(coldCalls).toHaveLength(0);
    expect((await agyHarness.rolloverStore.get(SESSION_ID))?.pendingSwitch).toBeUndefined();
    expect(agyHarness.prompts.at(-1)?.acpSessionId).toBe('acp-1');

    // Case B: codex explicit /compact with silent zero output failing as agent_no_output
    const codexFail = createRolloverExecutionHarness({
      metaPatch: {
        cliType: 'builtin',
        agentType: 'codex',
        contextWindowUsage: { size: 400_000, used: 120_000 },
      },
      observePromptContentForTurn: () => false,
    });
    await codexFail.sendContinue('/compact');
    expect((await codexFail.rolloverStore.get(SESSION_ID))?.degradedByNativeCompact).not.toBe(true);

    // Case C: codex explicit /compact with usage drop (120k -> 18k) + marker
    const codexDrop = createRolloverExecutionHarness({
      metaPatch: {
        cliType: 'builtin',
        agentType: 'codex',
        contextWindowUsage: { size: 400_000, used: 120_000 },
      },
      onPrompt: ({ service, setUsage, writeActiveAssistantText }) => {
        service.noteContextWindowUsageUpdate(SESSION_ID, { size: 400_000, used: 18_000 });
        setUsage(18_000);
        writeActiveAssistantText('Done.');
      },
    });
    await codexDrop.sendContinue('/compact');
    expect((await codexDrop.rolloverStore.get(SESSION_ID))?.degradedByNativeCompact).not.toBe(true);
  });

  it('Round 2 #3: staged candidate stateCard/spineItem discarded on Edit & Resend never pollutes subsequent seal or committed state', async () => {
    let sealNum = 0;
    const h = createRolloverExecutionHarness({
      metaPatch: { contextWindowUsage: { size: 1_000_000, used: 120_000 } },
      onPrompt: ({ text, setUsage, writeActiveAssistantText }) => {
        if (text.includes('[Lody Internal Handoff Seal')) {
          sealNum += 1;
          writeActiveAssistantText(
            JSON.stringify({
              oneLiner: `Seal #${sealNum}`,
              stateCard: {
                goalAndPlan: `Plan #${sealNum}`,
                lockedInvariants:
                  sealNum === 1
                    ? ['COMMITTED_GEN1_INVARIANT']
                    : sealNum === 2
                      ? ['RETRACTED_EDITED_OUT_INVARIANT']
                      : ['POST_EDIT_VALID_INVARIANT'],
                decisionsAndDeadEnds: [],
                workspaceFacts: '',
                openAndNext: '',
              },
            })
          );
          return;
        }
        if (text.includes('[Lody Session Node Handoff')) {
          writeActiveAssistantText('Ready.');
          setUsage(25_000);
          return;
        }
        writeActiveAssistantText('Normal response.');
      },
    });

    // Gen 1 seal + commit
    await h.sendContinue('/rollover');
    await h.sendContinue('Commit gen 1');
    const afterGen1 = await h.rolloverStore.get(SESSION_ID);
    expect(afterGen1?.stateCard.lockedInvariants).toEqual(['COMMITTED_GEN1_INVARIANT']);
    expect(afterGen1?.spine).toHaveLength(1);

    // Gen 2 seal stages RETRACTED_EDITED_OUT_INVARIANT inside pendingSwitch ONLY
    await h.sendContinue('Bad direction to be edited away', { userTurnId: 'u-retracted' });
    await h.sendContinue('/rollover');
    const stagedGen2 = await h.rolloverStore.get(SESSION_ID);
    expect(stagedGen2?.stateCard.lockedInvariants).toEqual(['COMMITTED_GEN1_INVARIANT']);
    expect(stagedGen2?.spine).toHaveLength(1);
    expect(stagedGen2?.pendingSwitch?.candidateStateCard?.lockedInvariants).toContain(
      'RETRACTED_EDITED_OUT_INVARIANT'
    );

    // Edit & Resend deletes `assistant:u-retracted` and switches ACP session
    const delIdx = h.history.findIndex((e) => e.id === 'assistant:u-retracted');
    expect(delIdx).toBeGreaterThanOrEqual(0);
    h.history.splice(delIdx, 1);
    h.replaceLiveAgent('acp-edited-clean' as ACPSessionId);

    await h.sendContinue('Edited clean direction');
    const afterInvalidation = await h.rolloverStore.get(SESSION_ID);
    expect(afterInvalidation?.pendingSwitch).toBeUndefined();
    expect(afterInvalidation?.stateCard.lockedInvariants).toEqual(['COMMITTED_GEN1_INVARIANT']);
    expect(afterInvalidation?.spine).toHaveLength(1);

    // Next seal + renew MUST NOT inherit RETRACTED_EDITED_OUT_INVARIANT!
    await h.sendContinue('/rollover');
    await h.sendContinue('Continue on clean gen 2');
    const afterCleanGen2 = await h.rolloverStore.get(SESSION_ID);
    expect(afterCleanGen2?.stateCard.lockedInvariants).toContain('COMMITTED_GEN1_INVARIANT');
    expect(afterCleanGen2?.stateCard.lockedInvariants).toContain('POST_EDIT_VALID_INVARIANT');
    expect(afterCleanGen2?.stateCard.lockedInvariants).not.toContain(
      'RETRACTED_EDITED_OUT_INVARIANT'
    );
  });

  it('Round 2 #5A: SessionDispatchWatcher preempts in-flight auto :seal BEFORE sessionCheckChains when an earlier turn still occupies the chain', async () => {
    let sealStartedResolve!: () => void;
    const sealStarted = new Promise<void>((resolve) => {
      sealStartedResolve = resolve;
    });

    const h = createRolloverExecutionHarness({
      metaPatch: {
        contextWindowUsage: { size: 1_000_000, used: 200_000 },
      },
      onPrompt: async ({ callIndex, signal, setUsage, writeActiveAssistantText }) => {
        if (callIndex === 0) {
          setUsage(370_000);
          writeActiveAssistantText('Turn 1 finished.');
          return;
        }
        sealStartedResolve();
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new Error('cancelled'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      },
    });

    const watcher = new SessionDispatchWatcher({
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
      machineId: MACHINE_ID,
      workspaceId: WORKSPACE_ID,
      workspaceDocument: h.deps.workspaceDocument,
      executionService: h.service,
      userResolver: {
        resolve: async () => ({ id: 'owner-user', name: 'Owner', email: 'owner@example.com' }),
        clear: () => {},
      },
      canUseMachine: async () => ({ outcome: 'allowed' }),
    });
    // Mark watcher started and occupy `sessionCheckChains` with the in-flight Turn 1 promise
    // (mirroring real watcher dispatch where Turn 1's check holds the chain while auto `:seal` runs).
    (watcher as unknown as { started: boolean; lifecycleGeneration: number }).started = true;
    (watcher as unknown as { lifecycleGeneration: number }).lifecycleGeneration = 1;
    (
      watcher as unknown as { watchedSessions: Map<SessionId, { unsubscribe: () => void }> }
    ).watchedSessions.set(SESSION_ID, { unsubscribe: () => {} });

    const turn1 = h.sendContinue('Turn 1 triggering auto seal');
    (
      watcher as unknown as { sessionCheckChains: Map<SessionId, Promise<void>> }
    ).sessionCheckChains.set(SESSION_ID, turn1.then(() => undefined));
    await sealStarted;
    expect(h.service.isAutoRolloverSealing(SESSION_ID)).toBe(true);

    // Incoming user turn updates meta and triggers `reconcileSessionWatch`: MUST preempt
    // BEFORE queuing behind the blocked `sessionCheckChains` entry (zero deadlock!).
    h.setMeta({ latestUserMsgId: 'u-preempt-while-chain-busy', lastHandledUserMsgId: 'turn-u1' });
    const enqueueSpy = vi.fn(async () => {});
    (watcher as unknown as { enqueueSessionCheck: typeof enqueueSpy }).enqueueSessionCheck =
      enqueueSpy;

    await (
      watcher as unknown as {
        reconcileSessionWatch: (sid: SessionId, trigger: string) => Promise<void>;
      }
    ).reconcileSessionWatch(SESSION_ID, 'metadata');

    // `turn1` MUST now resolve because auto `:seal` was preempted immediately!
    await turn1;
    expect(h.service.isAutoRolloverSealing(SESSION_ID)).toBe(false);
    expect((await h.rolloverStore.get(SESSION_ID))?.pendingSwitch).toBeUndefined();
    const divider = h.history.find((e) => e.role === 'system' && e.id.startsWith('session-rollover:'));
    expect(isSilentSessionRollover(readSessionRolloverNotice(divider!)!)).toBe(true);
    expect(enqueueSpy).toHaveBeenCalledWith(SESSION_ID, { lifecycleGeneration: 1 });
  });

  it('Round 2 #5B: cancelled warm :seal waits for raw pendingPromptCompletion to drain, or retires ACP session if drain exceeds cancelDrainMs', async () => {
    // Case 1: raw ACP prompt drains cleanly before timeout -> session reused (NOT retired).
    let sealStartedResolve!: () => void;
    const sealStarted = new Promise<void>((resolve) => {
      sealStartedResolve = resolve;
    });
    let resolveRawDrain!: () => void;
    const rawDrainPromise = new Promise<void>((resolve) => {
      resolveRawDrain = resolve;
    });

    const cleanDrain = createRolloverExecutionHarness({
      metaPatch: { contextWindowUsage: { size: 1_000_000, used: 200_000 } },
      onPrompt: async ({ callIndex, signal, setUsage, writeActiveAssistantText }) => {
        if (callIndex === 0) {
          setUsage(370_000);
          writeActiveAssistantText('Turn 1 finished.');
          return;
        }
        cleanDrain.setPendingPromptCompletion(rawDrainPromise);
        sealStartedResolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Agent prompt aborted')), {
            once: true,
          });
        });
      },
    });

    const turnClean = cleanDrain.sendContinue('Turn before clean drain');
    await sealStarted;
    let turnCleanSettled = false;
    void turnClean.then(() => {
      turnCleanSettled = true;
    });
    cleanDrain.service.preemptAutoRolloverSealIfActive(SESSION_ID);
    await Promise.resolve();
    await Promise.resolve();
    // Still waiting for raw ACP drain before releasing!
    expect(turnCleanSettled).toBe(false);

    cleanDrain.setPendingPromptCompletion(null);
    resolveRawDrain();
    await turnClean;
    expect(cleanDrain.retireSpy).not.toHaveBeenCalled();

    // Case 2: raw ACP prompt stays stuck past `TURN_BUDGETS.cancelDrainMs` -> retires ACP!
    vi.useFakeTimers();
    try {
      let stuckSealResolve!: () => void;
      const stuckSealStarted = new Promise<void>((resolve) => {
        stuckSealResolve = resolve;
      });
      const neverSettlingRaw = new Promise<void>(() => {});
      const stuckDrain = createRolloverExecutionHarness({
        metaPatch: { contextWindowUsage: { size: 1_000_000, used: 200_000 } },
        onPrompt: async ({ callIndex, signal, setUsage, writeActiveAssistantText }) => {
          if (callIndex === 0) {
            setUsage(370_000);
            writeActiveAssistantText('Turn 1 finished.');
            return;
          }
          stuckDrain.setPendingPromptCompletion(neverSettlingRaw);
          stuckSealResolve();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('Agent prompt aborted')), {
              once: true,
            });
          });
        },
      });

      const turnStuck = stuckDrain.sendContinue('Turn before stuck drain');
      await stuckSealStarted;
      stuckDrain.service.preemptAutoRolloverSealIfActive(SESSION_ID);
      await vi.advanceTimersByTimeAsync(TURN_BUDGETS.cancelDrainMs + 50);
      await turnStuck;
      expect(stuckDrain.retireSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Round 2 #6: strict :renew validation rejects max_tokens, missing stopReason, runaway output, and refusal text without clearing pendingSwitch', async () => {
    const cases: Array<{ name: string; stopReason?: string; text: string }> = [
      { name: 'max_tokens', stopReason: 'max_tokens', text: 'Ready.' },
      { name: 'missing stopReason', stopReason: undefined, text: 'Ready.' },
      { name: 'runaway >300 chars', stopReason: 'end_turn', text: 'R'.repeat(320) },
      { name: 'refusal text', stopReason: 'end_turn', text: 'I cannot comply with this prompt.' },
    ];

    for (const tc of cases) {
      const h = createRolloverExecutionHarness({
        onPrompt: ({ text, writeActiveAssistantText }) => {
          if (text.includes('[Lody Internal Handoff Seal')) {
            writeActiveAssistantText(
              JSON.stringify({
                oneLiner: 'Sealed',
                stateCard: {
                  goalAndPlan: 'G',
                  lockedInvariants: [],
                  decisionsAndDeadEnds: [],
                  workspaceFacts: '',
                  openAndNext: '',
                },
              })
            );
            return { stopReason: 'end_turn' };
          }
          if (text.includes('[Lody Session Node Handoff')) {
            writeActiveAssistantText(tc.text);
            return { stopReason: tc.stopReason };
          }
          writeActiveAssistantText('Unexpected user delivery');
          return { stopReason: 'end_turn' };
        },
      });

      await h.sendContinue('/rollover');
      const runId = (await h.rolloverStore.get(SESSION_ID))?.pendingSwitch?.runId;
      await h.sendContinue('Blocked until valid renew');

      const state = await h.rolloverStore.get(SESSION_ID);
      expect(state?.pendingSwitch?.runId, tc.name).toBe(runId);
      expect(state?.generation, tc.name).toBe(0);
      expect(
        h.prompts.some((p) => p.text === 'Blocked until valid renew'),
        tc.name
      ).toBe(false);
      const divider = h.history.find((e) => e.id === sessionRolloverTurnId(runId!));
      expect(readSessionRolloverNotice(divider!)?.status, tc.name).toBe('failed');
    }
  });

  it('Round 2 #8: standard Lody Resend flow (cancel failed M1, send new M2) completes :renew on single divider and clears stale lastFailedUserMsgId', async () => {
    let failFirstRenew = true;
    const h = createRolloverExecutionHarness({
      onPrompt: ({ text, setUsage, writeActiveAssistantText }) => {
        if (text.includes('[Lody Internal Handoff Seal')) {
          writeActiveAssistantText(
            JSON.stringify({
              oneLiner: 'Sealed before Resend test',
              stateCard: {
                goalAndPlan: 'G',
                lockedInvariants: ['RESEND_INVARIANT'],
                decisionsAndDeadEnds: [],
                workspaceFacts: '',
                openAndNext: '',
              },
            })
          );
          return;
        }
        if (text.includes('[Lody Session Node Handoff')) {
          if (failFirstRenew) {
            failFirstRenew = false;
            throw new Error('transient renew transport failure');
          }
          writeActiveAssistantText('Ready.');
          setUsage(24_000);
          return;
        }
        writeActiveAssistantText('Delivered Resend M2 cleanly.');
      },
    });

    await h.sendContinue('/rollover');
    await h.sendContinue('Original message M1', { userTurnId: 'user-m1-failed' });
    expect(h.history.find((e) => e.id === 'user-m1-failed')?.status).toBe('failed');
    expect(h.getMeta().lastFailedUserMsgId).toBe('user-m1-failed');
    expect((await h.rolloverStore.get(SESSION_ID))?.pendingSwitch).toBeDefined();

    // Standard UI Resend contract: mark old failed M1 canceled and submit a NEW user message M2!
    const failedEntry = h.history.find((e) => e.id === 'user-m1-failed');
    expect(failedEntry).toBeDefined();
    failedEntry!.status = 'canceled';

    await h.sendContinue('Original message M1', { userTurnId: 'user-m2-resend' });
    expect(h.getMeta().lastHandledUserMsgId).toBe('user-m2-resend');
    expect(h.getMeta().lastFailedUserMsgId).toBeUndefined();
    expect(h.history.find((e) => e.id === 'user-m2-resend')?.status).toBe('handled');
    expect((await h.rolloverStore.get(SESSION_ID))?.pendingSwitch).toBeUndefined();
    expect((await h.rolloverStore.get(SESSION_ID))?.generation).toBe(1);
    expect(h.prompts.at(-1)?.text).toBe('Original message M1');

    // Still exactly ONE divider entry (failed -> switching -> done in place)!
    const dividers = h.history.filter(
      (e) => e.role === 'system' && e.id.startsWith('session-rollover:')
    );
    expect(dividers).toHaveLength(1);
    expect(readSessionRolloverNotice(dividers[0]!)).toMatchObject({
      status: 'done',
      generation: 1,
      usedAfter: 24_000,
    });
  });
});
