import type { ContentBlock } from '@agentclientprotocol/sdk';
import {
  isSilentSessionRollover,
  normalizeBoardMeta,
  readSessionRolloverNotice,
  sessionRolloverTurnId,
  workspaceFlockKeys,
  type ACPSessionId,
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
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import {
  BARE_COMPACT_DEFAULT_INSTRUCTIONS,
  EXPLICIT_COMPACT_VISIBLE_FALLBACK_TEXT,
  createMemoryBoardCompactReinjectStore,
} from '../src/session/board-compact-reinject';
import { SessionDispatchWatcher } from '../src/session/session-dispatch-watcher';
import { SessionExecutionService } from '../src/session/session-execution-service';
import type { SessionManager } from '../src/session/session-manager';
import { createMemorySessionRolloverStore } from '../src/session/session-rollover-store';
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
  nowMs?: () => number;
  coldSummarizer?: (args: { sessionId: SessionId; prompt: string; signal?: AbortSignal }) => Promise<string | null>;
  onPrompt?: (ctx: {
    callIndex: number;
    acpSessionId: string;
    blocks: ContentBlock[];
    text: string;
    signal: AbortSignal;
    setUsage: (used: number, size?: number) => void;
    writeActiveAssistantText: (text: string) => void;
    service: SessionExecutionService;
  }) => Promise<void> | void;
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
        author: { v: 1, kind: 'human', userId: 'owner-user', name: 'Owner' },
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
  const makeAgent = (acpSessionId: string) => ({
    agentClient: {
      isCreated: () => true,
      currentModel: { modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' },
      supportsContextCompaction: () => true,
      getConfigOptions: () => [
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
      prompt: async (id: string, blocks: ContentBlock[]) => {
        const callIndex = promptCallIndex++;
        const text = blocks
          .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
          .join('\n');
        prompts.push({ acpSessionId: id, blocks, text });
        const controller = new AbortController();
        activePromptAbortController = controller;
        try {
          await options.onPrompt?.({
            callIndex,
            acpSessionId: id,
            blocks,
            text,
            signal: controller.signal,
            setUsage,
            writeActiveAssistantText,
            service,
          });
        } finally {
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
    getSessionLastActivity: () => nowFn() - 30_000,
    ...(options.observePromptContentForTurn
      ? { observePromptContentForTurn: options.observePromptContentForTurn }
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
    } as unknown as SessionManager,
    workspaceDocument: {
      syncFlockDocOrThrow: vi.fn(async () => undefined),
      repo: {
        upsertDocMeta: vi.fn(async () => {}),
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
      configOptionValues?: Record<string, AcpConfigOptionValue>;
      resume?: ACPSessionId;
      nativeSessionId?: string;
    } = {}
  ) => {
    const userTurnId = extra.userTurnId ?? `user-turn-${++turnCounter}`;
    history.push({
      id: userTurnId,
      role: 'user',
      author: { v: 1, kind: 'human', userId: 'owner-user', name: 'Owner' },
      timestamp: '2026-11-27T02:00:00.000Z',
      status: 'pending',
      fileDiff: [],
      items: [{ type: 'text', text: prompt }],
    });
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
        cliType: 'registry',
        agentType: 'antigravity',
        modelId: 'gemini-4-neon',
        configOptionValues: extra.configOptionValues ?? { thought_level: 'xhigh' },
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
    prompts,
    configApplies,
    history,
    rolloverStore,
    reinjectStore,
    retireSpy,
    createSessionSpy,
    setUsage,
    getMeta: () => currentMeta,
    dropLiveAgent: () => {
      live = null;
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
      userResolver: { resolve: async () => ({ name: 'Owner', email: 'owner@example.com' }), clear: () => {} },
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
          author: { v: 1, kind: 'human', userId: 'owner-user', name: 'Owner' },
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
          author: { v: 1, kind: 'human', userId: 'owner-user', name: 'Owner' },
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
          author: { v: 1, kind: 'human', userId: 'owner-user', name: 'Owner' },
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

  it('Hard Trap #4: failed :renew keeps pendingSwitch intact and lets retry complete cleanly without duplicating nodes', async () => {
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

    // First attempt of user message M fails during `:renew` -> pendingSwitch MUST remain intact!
    await h.sendContinue('My important message M');
    const pendingAfterFailure = (await h.rolloverStore.get(SESSION_ID))?.pendingSwitch;
    expect(pendingAfterFailure?.runId).toBe(pendingBefore!.runId);
    expect((await h.rolloverStore.get(SESSION_ID))?.generation).toBe(0);
    // M was NOT sent to the broken fresh session.
    expect(h.prompts.some((p) => p.text === 'My important message M')).toBe(false);

    // Retry of M succeeds cleanly: single committed node #1, pure M delivered!
    await h.sendContinue('My important message M');
    const afterRetry = await h.rolloverStore.get(SESSION_ID);
    expect(afterRetry?.pendingSwitch).toBeUndefined();
    expect(afterRetry?.generation).toBe(1);
    expect(h.prompts.at(-1)?.text).toBe('My important message M');
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

  it('Phase 2 + Hard Trap #3: mid-turn native auto-compact (90k -> 520k -> 30k -> 60k) on an ordinary non-Board session marks degradedByNativeCompact, skips Board reminder, and forces cold Loro path on subsequent /rollover', async () => {
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

    // Turn 1 triggers mid-turn usage drop (90k -> 520k -> 30k -> 60k).
    await h.sendContinue('Run the huge multi-file refactor');
    expect(h.prompts).toHaveLength(1);
    const degradedState = await h.rolloverStore.get(SESSION_ID);
    expect(degradedState?.degradedByNativeCompact).toBe(true);
    expect(degradedState?.pendingSwitch).toBeUndefined();
    // Non-Board session must NEVER arm Board compact reinject store.
    expect(await h.reinjectStore.has(SESSION_ID)).toBe(false);

    // Subsequent `/rollover` MUST skip warm `:seal` on degraded acp-1 and use cold Loro summarizer!
    await h.sendContinue('/rollover');
    // Still only 1 ACP prompt (the original user turn) — ZERO warm `:seal` sent to acp-1!
    expect(h.prompts).toHaveLength(1);
    expect(coldCalls).toHaveLength(1);
    expect(coldCalls[0]).toContain('Run the huge multi-file refactor');
    expect(coldCalls[0]).toContain('Finished long refactor after mid-turn compact.');

    const sealed = await h.rolloverStore.get(SESSION_ID);
    expect(sealed?.pendingSwitch).toBeDefined();
    expect(sealed?.stateCard.lockedInvariants).toContain('COLD_PATH_INVARIANT_SENTINEL');
    expect(sealed?.spine.at(-1)?.quality).toBe('cold_llm');
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
                  author: { v: 1, kind: 'human', userId: 'owner-user', name: 'Owner' },
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
});
