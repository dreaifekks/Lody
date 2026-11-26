import type { ContentBlock } from '@agentclientprotocol/sdk';
import {
  normalizeBoardMeta,
  parseSessionNotification,
  workspaceFlockKeys,
  type ACPSessionId,
  type BoardId,
  type BoardMeta,
  type MachineId,
  type SessionHistoryInput,
  type SessionId,
  type SessionInputBlock,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoalPromptControl } from '../src/agent/goal-control';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import {
  createFileBoardCompactReinjectStore,
  type BoardCompactReinjectStore,
} from '../src/session/board-compact-reinject';
import { SessionExecutionService } from '../src/session/session-execution-service';
import type { SessionManager } from '../src/session/session-manager';
import { withHistoryPort } from './history-port-fixture';
import { createBaseDeps } from './session-execution-service-helpers';

const SESSION_ID = 'session-board-thread' as SessionId;
const COORD_ID = 'session-board-coord' as SessionId;
const BOARD_ID = 'bd_reinject' as BoardId;
const MACHINE_ID = 'machine-1' as MachineId;
const WORKSPACE_ID = 'workspace-1' as WorkspaceId;

const makeBoard = (overrides: Partial<BoardMeta> = {}): BoardMeta =>
  normalizeBoardMeta({
    version: 1,
    id: BOARD_ID,
    name: 'Lody Lan',
    purpose: 'Personal LAN fork features',
    instructions: 'Initial board instructions.',
    coordinatorSessionId: COORD_ID,
    createdAtMs: 1_000,
    createdByUserId: 'owner-user',
    rules: {
      maxRoundsPerThread: 3,
      reportHumanTurns: false,
      executorConstraints: 'Keep reports in files/<topic>/.',
    },
    ...overrides,
  })!;

type PromptCapture = {
  acpSessionId: string;
  blocks: ContentBlock[];
  text: string;
};

function createBoardExecutionHarness(options: {
  sessionId?: SessionId;
  metaPatch?: Partial<SessionMeta>;
  board?: BoardMeta | null;
  liveAgent?: boolean;
  initialHistory?: SessionHistoryInput[];
  resumeError?: Error;
  store?: BoardCompactReinjectStore;
  syncFlockDocOrThrow?: () => Promise<void>;
  observePromptContentForTurn?: (
    sessionId: SessionId,
    turnId: string
  ) => Promise<boolean> | boolean;
  getMetaStateOverride?: (
    readCount: number,
    defaultMeta: SessionMeta
  ) => Promise<SessionMeta> | SessionMeta;
  enableSteer?: boolean;
  onPrompt?: (ctx: {
    callIndex: number;
    acpSessionId: string;
    blocks: ContentBlock[];
    signal?: AbortSignal;
    service: SessionExecutionService;
    setUsage: (used: number, size?: number) => void;
    pushHistory: (entry: SessionHistoryInput) => void;
  }) => Promise<void> | void;
  validateSessionCredentials?: () => Promise<void>;
}) {
  const sessionId = options.sessionId ?? SESSION_ID;
  let board: BoardMeta | null = options.board === undefined ? makeBoard() : options.board;
  let currentMeta: SessionMeta = {
    id: sessionId,
    title: 'Board Thread',
    machineId: MACHINE_ID,
    userId: 'owner-user',
    cliType: 'registry',
    agentType: 'antigravity',
    acpSessionId: 'acp-1' as ACPSessionId,
    boardId: BOARD_ID,
    contextWindowUsage: { size: 1_000_000, used: 120_000 },
    lastModel: { modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' },
    ...options.metaPatch,
  } as SessionMeta;

  const history: SessionHistoryInput[] = [
    ...(options.initialHistory ?? [
      {
        id: 'turn-earlier-user',
        role: 'user',
        timestamp: '2026-11-25T00:00:00.000Z',
        status: 'handled',
        items: [{ type: 'text', text: 'earlier task context' }],
      } as SessionHistoryInput,
      {
        id: 'turn-earlier-assistant',
        role: 'assistant',
        timestamp: '2026-11-25T00:00:05.000Z',
        items: [{ type: 'text', text: 'acknowledged earlier task' }],
      } as SessionHistoryInput,
    ]),
  ];

  const prompts: PromptCapture[] = [];
  let promptCallIndex = 0;
  let turnCounter = 0;
  let metaReadCount = 0;
  let service!: SessionExecutionService;
  const syncFlockDocOrThrow = vi.fn(options.syncFlockDocOrThrow ?? (async () => undefined));
  let activeSteerCompletion: (() => void) | undefined;
  let activePromptAbortController: AbortController | undefined;

  const setUsage = (used: number, size = 1_000_000) => {
    currentMeta = { ...currentMeta, contextWindowUsage: { used, size } };
  };

  const makeAgent = (acpSessionId: string, modelId = 'gemini-4-neon') => ({
    agentClient: {
      isCreated: () => true,
      currentModel: { modelId, name: modelId },
      supportsContextCompaction: () => true,
      ...(options.enableSteer
        ? {
            getAcknowledgedSteerCapability: () => ({
              provider: 'codex' as const,
              appliedNotificationMethod: 'codex/steerApplied',
              upstreamTurn: 'same' as const,
              configPolicy: 'active' as const,
            }),
            findSteerConfigMismatch: () => null,
            steerPrompt: () => {
              const previousComplete = activeSteerCompletion;
              let resolveCurrent!: () => void;
              const completion = new Promise<void>((resolve) => {
                resolveCurrent = resolve;
              });
              activeSteerCompletion = resolveCurrent;
              previousComplete?.();
              return {
                outcome: Promise.resolve({
                  outcome: 'applied' as const,
                  application: { release: () => {} },
                }),
                completion,
              };
            },
          }
        : {}),
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
            signal: controller.signal,
            service,
            setUsage,
            pushHistory: (entry) => history.push(entry),
          });
        } finally {
          if (activePromptAbortController === controller) {
            activePromptAbortController = undefined;
          }
        }
      },
      cancel: async () => {
        activePromptAbortController?.abort();
      },
    },
    acpSessionId,
    getMemoryBinding: () => null,
    getWorkdir: () => '/tmp',
    getHostWorkdir: () => '/tmp',
    getParentSessionId: () => undefined,
    exec: async () => '',
    updateGitIdentity: () => {},
    applyExecutionPlaneLimits: async () => {},
    terminate: async () => {},
  });

  let live: ReturnType<typeof makeAgent> | null =
    options.liveAgent === false ? null : makeAgent(currentMeta.acpSessionId ?? 'acp-1');
  let createdCount = 0;

  const sessionDoc = withHistoryPort({
    sessionId,
    getMetaState: async () => {
      metaReadCount += 1;
      if (options.getMetaStateOverride) {
        return await options.getMetaStateOverride(metaReadCount, currentMeta);
      }
      return currentMeta;
    },
    getHistory: () => history,
    setStatus: async () => {},
    setLastMessageAt: async () => {},
    getDocState: async () => ({}),
    updateHistory: async () => {},
  });

  const deps = createBaseDeps({
    boardCompactReinjectStore: options.store,
    // Isolate Board compact re-injection contract tests from automatic linear
    // `post_compact_recovery` rollover (which opens a fresh ACP node and clears pending).
    sessionRolloverAutoEnabled: false,
    ...(options.observePromptContentForTurn
      ? { observePromptContentForTurn: options.observePromptContentForTurn }
      : {}),
    beginConversationTurn: vi.fn((_sid, userTurnId) =>
      userTurnId ? `assistant:${userTurnId}` : `assistant:${++turnCounter}`
    ),
    sessionManager: {
      getSession: () => live,
      getPendingSession: () => null,
      validateSessionCredentials:
        options.validateSessionCredentials ?? vi.fn(async () => undefined),
      retireSessionForReconfiguration: vi.fn(async () => {
        live = null;
      }),
      terminateSession: vi.fn(async () => {
        live = null;
      }),
      createSession: vi.fn(
        async (_config: unknown, createOptions?: { resumeSessionId?: string }) => {
          if (createOptions?.resumeSessionId && options.resumeError) {
            throw options.resumeError;
          }
          createdCount += 1;
          const nextId = createOptions?.resumeSessionId ?? `acp-replayed-${createdCount}`;
          live = makeAgent(nextId);
          currentMeta = { ...currentMeta, acpSessionId: nextId as ACPSessionId };
          return live;
        }
      ),
    } as unknown as SessionManager,
    workspaceDocument: {
      syncFlockDocOrThrow,
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
      modelId?: string;
      inputBlocks?: SessionInputBlock[];
      dispatchSource?: 'rpc' | 'crdt' | 'queue' | 'inbox' | 'goal';
      goalControl?: GoalPromptControl;
    } = {}
  ) => {
    const userTurnId = extra.userTurnId ?? `user-turn-${++turnCounter}`;
    await service.continueSession(
      {
        type: 'session/chat',
        sessionId,
        machineId: MACHINE_ID,
        workspaceId: WORKSPACE_ID,
        userTurnId,
        userId: 'owner-user',
        userName: 'Owner',
        userEmail: 'owner@example.com',
        acpSessionConfig: {
          prompt,
          ...(extra.inputBlocks ? { inputBlocks: extra.inputBlocks } : {}),
          cliType: 'registry',
          agentType: 'antigravity',
          ...(extra.modelId ? { modelId: extra.modelId } : {}),
        },
      },
      extra.dispatchSource || extra.goalControl
        ? {
            ...(extra.dispatchSource ? { dispatchSource: extra.dispatchSource } : {}),
            ...(extra.goalControl ? { goalControl: extra.goalControl } : {}),
          }
        : undefined
    );
    return userTurnId;
  };

  const sendStart = async (prompt: string, extra: { userTurnId?: string } = {}) => {
    const userTurnId = extra.userTurnId ?? `user-start-${++turnCounter}`;
    await service.startSession({
      type: 'session/create',
      sessionId,
      machineId: MACHINE_ID,
      workspaceId: WORKSPACE_ID,
      userTurnId,
      userId: 'owner-user',
      userName: 'Owner',
      userEmail: 'owner@example.com',
      acpSessionConfig: {
        prompt,
        cliType: 'registry',
        agentType: 'antigravity',
      },
    });
    return userTurnId;
  };

  return {
    service,
    deps,
    prompts,
    history,
    syncFlockDocOrThrow,
    sendContinue,
    sendStart,
    setUsage,
    finishSteerTail: () => activeSteerCompletion?.(),
    setBoard: (next: BoardMeta | null) => {
      board = next;
    },
    setLiveAgent: (next: ReturnType<typeof makeAgent> | null) => {
      live = next;
    },
    getMeta: () => currentMeta,
  };
}

describe('Board compact re-injection integration', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('re-injects once after bare /compact without marker or immediate usage drop (agy), without double-injecting on deferred usage drop', async () => {
    const h = createBoardExecutionHarness({
      onPrompt: ({ callIndex, service, setUsage }) => {
        // Turn 0 is bare `/compact`: agy emits neither compaction marker nor usage drop yet.
        // Turn 1 is the next normal message: agy finally reports the post-compact usage drop.
        if (callIndex === 1) {
          service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 24_000 });
          setUsage(24_000);
        }
      },
    });

    await h.sendContinue('/compact');
    expect(h.prompts[0]!.text).toMatch(/^\/compact\s+\S+/);
    expect(h.prompts[0]!.text).not.toContain('<board_context_reminder>');

    // Next normal turn gets the reminder inline (never written into Loro history).
    await h.sendContinue('Continue the task');
    expect(h.prompts[1]!.blocks).toHaveLength(2);
    expect(h.prompts[1]!.text).toContain('Continue the task');
    expect(h.prompts[1]!.text).toContain('<board_context_reminder>');
    expect(h.prompts[1]!.text).toContain('Role: thread of Board "Lody Lan".');
    expect(h.prompts[1]!.text).toContain('Initial board instructions.');
    expect(h.prompts[1]!.text).toContain('Keep reports in files/<topic>/.');
    expect(JSON.stringify(h.history)).not.toContain('<board_context_reminder>');

    // Subsequent normal turn must NOT receive a second reminder, even though turn 1 saw 120k -> 24k.
    await h.sendContinue('Follow-up question');
    expect(h.prompts[2]!.blocks).toHaveLength(1);
    expect(h.prompts[2]!.text).not.toContain('<board_context_reminder>');
  });

  it('re-injects on the next normal turn after a completed ACP context_compaction marker (Claude/Codex)', async () => {
    const h = createBoardExecutionHarness({
      onPrompt: ({ callIndex, pushHistory }) => {
        if (callIndex === 0) {
          pushHistory({
            id: 'assistant:user-turn-compact-marker',
            role: 'assistant',
            timestamp: '2026-11-26T00:00:00.000Z',
            items: [
              {
                type: 'tool_call',
                toolCallId: 'compact-1',
                title: 'Compacting context',
                status: 'completed',
                activityKind: 'context_compaction',
              },
              { type: 'text', text: 'Done.' },
            ],
          } as unknown as SessionHistoryInput);
        }
        if (callIndex === 2) {
          // A failed compaction marker must NOT trigger reinjection.
          pushHistory({
            id: 'assistant:user-turn-failed-marker',
            role: 'assistant',
            timestamp: '2026-11-26T00:02:00.000Z',
            items: [
              {
                type: 'tool_call',
                toolCallId: 'compact-2',
                title: 'Compacting context',
                status: 'failed',
                activityKind: 'context_compaction',
              },
              { type: 'text', text: 'Continued.' },
            ],
          } as unknown as SessionHistoryInput);
        }
      },
    });

    await h.sendContinue('Do long work', { userTurnId: 'user-turn-compact-marker' });
    expect(h.prompts[0]!.text).not.toContain('<board_context_reminder>');

    await h.sendContinue('Next step after auto-compact');
    expect(h.prompts[1]!.text).toContain('<board_context_reminder>');

    await h.sendContinue('Turn with failed compaction marker', {
      userTurnId: 'user-turn-failed-marker',
    });
    expect(h.prompts[2]!.text).not.toContain('<board_context_reminder>');

    await h.sendContinue('After failed compaction marker');
    expect(h.prompts[3]!.text).not.toContain('<board_context_reminder>');
  });

  it('re-injects after mid-turn context usage peak followed by a sharp drop (agy long-turn auto-compact)', async () => {
    const h = createBoardExecutionHarness({
      metaPatch: {
        // Start below 40k threshold to prove peak tracking catches mid-turn growth + drop.
        contextWindowUsage: { size: 1_000_000, used: 25_000 },
      },
      onPrompt: ({ callIndex, service, setUsage }) => {
        if (callIndex === 0) {
          service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 70_000 });
          service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 115_000 });
          service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 22_000 });
          setUsage(22_000);
        }
      },
    });

    await h.sendContinue('Run multi-tool analysis');
    expect(h.prompts[0]!.text).not.toContain('<board_context_reminder>');

    await h.sendContinue('Summarize next action');
    expect(h.prompts[1]!.text).toContain('<board_context_reminder>');
  });

  it('does not falsely trigger usage-drop reinjection when switching models', async () => {
    const h = createBoardExecutionHarness({
      metaPatch: {
        contextWindowUsage: { size: 1_000_000, used: 120_000 },
        lastModel: { modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' },
      },
      onPrompt: ({ callIndex, setUsage }) => {
        if (callIndex === 0) {
          setUsage(20_000);
        }
      },
    });

    await h.sendContinue('Switch model and continue', { modelId: 'claude-opus-5' });
    await h.sendContinue('Next message');
    expect(h.prompts[1]!.text).not.toContain('<board_context_reminder>');
  });

  it('skips injection on subsequent slash commands while retaining the pending marker until the next normal message', async () => {
    const h = createBoardExecutionHarness({});

    await h.sendContinue('/compact');
    await h.sendContinue('/status');
    await h.sendContinue('/compact keep decisions');
    await h.sendContinue('Proceed with implementation');

    expect(h.prompts[0]!.text).toMatch(/^\/compact\s+\S+/);
    expect(h.prompts[1]!.text).toBe('/status');
    expect(h.prompts[2]!.text).toBe('/compact keep decisions');
    expect(h.prompts[1]!.text).not.toContain('<board_context_reminder>');
    expect(h.prompts[2]!.text).not.toContain('<board_context_reminder>');
    expect(h.prompts[3]!.text).toContain('<board_context_reminder>');
  });

  it('does not double-inject after BoardContinuityWorkflow :compact and :renew maintenance turns', async () => {
    const h = createBoardExecutionHarness({
      sessionId: COORD_ID,
      metaPatch: {
        id: COORD_ID,
        boardRole: 'coordinator',
        contextWindowUsage: { size: 1_000_000, used: 180_000 },
      },
      onPrompt: ({ callIndex, pushHistory, setUsage }) => {
        // Call 0: ordinary auto-compact turn sets pending.
        if (callIndex === 0) {
          setUsage(180_000);
        }
        // Call 1: maintenance `:compact` produces marker AND drops usage.
        if (callIndex === 1) {
          pushHistory({
            id: 'assistant:board-maintenance:run-1:compact',
            role: 'assistant',
            timestamp: '2026-11-26T00:00:00.000Z',
            items: [
              {
                type: 'tool_call',
                toolCallId: 'maint-compact',
                title: 'Compacting context',
                status: 'completed',
                activityKind: 'context_compaction',
              },
            ],
          } as unknown as SessionHistoryInput);
          setUsage(20_000);
        }
      },
    });

    // Arm pending via manual `/compact` first, then run maintenance `:compact` + `:renew`.
    await h.sendContinue('/compact');

    const compactOutcome = await h.service.runBoardMaintenanceTurn({
      sessionId: COORD_ID,
      stepTurnId: 'board-maintenance:run-1:compact',
      prompt: '/compact Keep board state.',
      config: {},
      userId: 'owner-user',
      userName: 'Owner',
      userEmail: 'owner@example.com',
    });
    expect(compactOutcome).toBe('completed');
    expect(h.prompts[1]!.text).not.toContain('<board_context_reminder>');

    const renewOutcome = await h.service.runBoardMaintenanceTurn({
      sessionId: COORD_ID,
      stepTurnId: 'board-maintenance:run-1:renew',
      prompt: 'Lody maintenance renew.',
      config: {},
      userId: 'owner-user',
      userName: 'Owner',
      userEmail: 'owner@example.com',
      renewBoardInstructions: true,
    });
    expect(renewOutcome).toBe('completed');
    expect(h.prompts[2]!.text).toContain('You are the main session of Board "Lody Lan"');
    expect(h.prompts[2]!.text).not.toContain('<board_context_reminder>');

    // Next normal coordinator message must NOT receive a duplicate compact reminder.
    await h.sendContinue('Check thread progress');
    expect(h.prompts[3]!.text).toBe('Check thread progress');
    expect(h.prompts[3]!.text).not.toContain('<board_context_reminder>');
  });

  it('injects the compact reminder immediately when a Board session recovers via History Replay', async () => {
    const h = createBoardExecutionHarness({
      liveAgent: false,
      resumeError: new Error('ACP_RESUME_FAILED: native session missing'),
    });

    await h.sendContinue('Pick up where we left off');

    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]!.text).toContain('=== Current Request ===');
    expect(h.prompts[0]!.text).toContain('Pick up where we left off');
    expect(h.prompts[0]!.text).toContain('<board_context_reminder>');
    expect(h.prompts[0]!.text).toContain('Role: thread of Board "Lody Lan".');

    // Following normal turn on the recovered session does not repeat the reminder.
    await h.sendContinue('One more check');
    expect(h.prompts[1]!.text).toBe('One more check');
    expect(h.prompts[1]!.text).not.toContain('<board_context_reminder>');
  });

  it('leaves ordinary non-Board sessions completely unaffected across compaction and History Replay', async () => {
    const h = createBoardExecutionHarness({
      metaPatch: { boardId: undefined, boardRole: undefined },
      onPrompt: ({ callIndex, pushHistory, setUsage }) => {
        if (callIndex === 0) {
          pushHistory({
            id: 'assistant:non-board-compact',
            role: 'assistant',
            timestamp: '2026-11-26T00:00:00.000Z',
            items: [
              {
                type: 'tool_call',
                toolCallId: 'c1',
                title: 'Compacting context',
                status: 'completed',
                activityKind: 'context_compaction',
              },
            ],
          } as unknown as SessionHistoryInput);
          setUsage(15_000);
        }
      },
    });

    await h.sendContinue('/compact', { userTurnId: 'non-board-compact' });
    await h.sendContinue('Ordinary follow-up');
    expect(h.prompts[0]!.text).not.toContain('<board_context_reminder>');
    expect(h.prompts[1]!.text).not.toContain('<board_context_reminder>');

    // Also verify History Replay on a non-Board session adds no Board reminder.
    const replayHarness = createBoardExecutionHarness({
      metaPatch: { boardId: undefined, boardRole: undefined },
      liveAgent: false,
      resumeError: new Error('ACP_RESUME_FAILED: missing'),
    });
    await replayHarness.sendContinue('Resume ordinary session');
    expect(replayHarness.prompts[0]!.text).toContain('=== Current Request ===');
    expect(replayHarness.prompts[0]!.text).not.toContain('<board_context_reminder>');
  });

  it('reads updated Board row live, degrades gracefully when Board is deleted, preserves marker across pre-prompt failure and restarts, and never duplicates on stale ACP retry', async () => {
    // 1. Cross-restart persistence + live Board row reload + pre-prompt failure retention.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lody-board-reinject-int-'));
    tempDirs.push(rootDir);

    const h1 = createBoardExecutionHarness({
      store: createFileBoardCompactReinjectStore({ rootDir }),
    });
    await h1.sendContinue('/compact');

    // Simulate daemon restart with a pre-prompt credential failure on turn 1.
    let failCredentials = true;
    const h2 = createBoardExecutionHarness({
      store: createFileBoardCompactReinjectStore({ rootDir }),
      board: makeBoard({ instructions: 'Updated instructions after compaction!' }),
      validateSessionCredentials: async () => {
        if (failCredentials) {
          throw new Error('temporary credential validation error');
        }
      },
    });

    await h2.sendContinue('Attempt before creds ready');
    expect(h2.prompts).toHaveLength(0);

    // Retry after creds succeed: pending marker survived both restart and pre-prompt failure.
    failCredentials = false;
    await h2.sendContinue('Succeeded after retry');
    expect(h2.prompts).toHaveLength(1);
    expect(h2.prompts[0]!.text).toContain('<board_context_reminder>');
    expect(h2.prompts[0]!.text).toContain('Updated instructions after compaction!');

    // 1b. Queued/scheduled dispatch also receives pending reminder after compaction.
    const hQueued = createBoardExecutionHarness({});
    await hQueued.sendContinue('/compact');
    await hQueued.sendContinue('Scheduled follow-up task', {
      dispatchSource: 'queue',
    });
    expect(hQueued.prompts[1]!.text).toContain('<board_context_reminder>');
    await hQueued.sendContinue('Subsequent turn after queued reminder');
    expect(hQueued.prompts[2]!.text).not.toContain('<board_context_reminder>');

    // 2. Stale ACP connection recovery retries without duplicating `<board_context_reminder>`
    //    both when resume succeeds and when recovery falls back to History Replay.
    let staleOnce = true;
    const hStale = createBoardExecutionHarness({
      onPrompt: ({ callIndex }) => {
        if (callIndex === 1 && staleOnce) {
          staleOnce = false;
          throw Object.assign(new Error('ACP connection closed'), { code: -32603 });
        }
      },
    });
    hStale.deps.hasPromptEventsForTurn = vi.fn(() => false);

    await hStale.sendContinue('/compact');
    await hStale.sendContinue('Trigger stale recovery');
    expect(hStale.prompts).toHaveLength(3); // /compact, failed stale attempt, recovered retry
    expect(hStale.prompts[2]!.text.match(/<board_context_reminder>/g) ?? []).toHaveLength(1);

    let staleReplayOnce = true;
    const hStaleReplay = createBoardExecutionHarness({
      resumeError: new Error('ACP_RESUME_FAILED: expired'),
      onPrompt: ({ callIndex }) => {
        if (callIndex === 1 && staleReplayOnce) {
          staleReplayOnce = false;
          throw Object.assign(new Error('ACP connection closed'), { code: -32603 });
        }
      },
    });
    hStaleReplay.deps.hasPromptEventsForTurn = vi.fn(() => false);

    await hStaleReplay.sendContinue('/compact');
    await hStaleReplay.sendContinue('Trigger stale recovery with replay');
    expect(hStaleReplay.prompts).toHaveLength(3);
    expect(hStaleReplay.prompts[2]!.text).toContain('=== Current Request ===');
    expect(hStaleReplay.prompts[2]!.text.match(/<board_context_reminder>/g) ?? []).toHaveLength(1);

    // 3. Deleted Board degrades gracefully and never blocks normal conversation.
    const hDeleted = createBoardExecutionHarness({ board: makeBoard() });
    await hDeleted.sendContinue('/compact');
    hDeleted.setBoard(null);
    await hDeleted.sendContinue('Still works after Board deleted');
    expect(hDeleted.prompts[1]!.text).toBe('Still works after Board deleted');
    expect(hDeleted.prompts[1]!.text).not.toContain('<board_context_reminder>');
  });

  it('syncs the workspace Flock doc before reinject, falls back on sync failure, and preserves pending on unsynced BOARD_NOT_FOUND', async () => {
    let syncFails = false;
    let remoteBoardUpdated = false;
    const h = createBoardExecutionHarness({
      board: makeBoard({ instructions: 'Stale local board instructions.' }),
      syncFlockDocOrThrow: async () => {
        if (syncFails) throw new Error('LAN peer unreachable');
        if (remoteBoardUpdated) {
          h.setBoard(makeBoard({ instructions: 'Fresh instructions synced from peer.' }));
        }
      },
    });

    // 1. Clean sync fetches latest instructions from peer before building reminder.
    await h.sendContinue('/compact');
    remoteBoardUpdated = true;
    await h.sendContinue('Use latest instructions');
    expect(h.syncFlockDocOrThrow).toHaveBeenCalledTimes(1);
    expect(h.prompts[1]!.text).toContain('Fresh instructions synced from peer.');

    // 2. Sync failure falls back to local replica and still injects.
    await h.sendContinue('/compact');
    syncFails = true;
    await h.sendContinue('Offline fallback turn');
    expect(h.syncFlockDocOrThrow).toHaveBeenCalledTimes(2);
    expect(h.prompts[3]!.text).toContain('<board_context_reminder>');
    expect(h.prompts[3]!.text).toContain('Fresh instructions synced from peer.');

    // 3. Sync failure + missing local Board row MUST keep pending until sync recovers.
    await h.sendContinue('/compact');
    h.setBoard(null);
    await h.sendContinue('Unsynced missing board turn');
    expect(h.prompts[5]!.text).toBe('Unsynced missing board turn');
    expect(h.prompts[5]!.text).not.toContain('<board_context_reminder>');

    // Once sync recovers and populates the Board row, pending fires immediately.
    syncFails = false;
    await h.sendContinue('After sync recovers');
    expect(h.prompts[6]!.text).toContain('<board_context_reminder>');
    expect(h.prompts[6]!.text).toContain('Fresh instructions synced from peer.');

    // 4. Even when syncFlockDocOrThrow resolves without throwing (e.g. partial LAN sync),
    // a missing local Board row MUST keep pending instead of clearing it prematurely.
    await h.sendContinue('/compact');
    remoteBoardUpdated = false;
    h.setBoard(null);
    await h.sendContinue('Partial sync missing board turn');
    expect(h.prompts[8]!.text).not.toContain('<board_context_reminder>');

    // Once the Board row arrives on a later sync, the preserved pending reminder still fires.
    h.setBoard(makeBoard({ instructions: 'Synced after partial failure' }));
    await h.sendContinue('Retry after Board row syncs');
    expect(h.prompts[9]!.text).toContain('<board_context_reminder>');
    expect(h.prompts[9]!.text).toContain('Synced after partial failure');
  });

  it('persists pending on History Replay so slash commands skip safely and pre-prompt failures retry on the next normal turn', async () => {
    // 1. History Replay + slash command skips injection and carries pending to the next normal turn.
    const hSlash = createBoardExecutionHarness({
      liveAgent: false,
      resumeError: new Error('ACP_RESUME_FAILED: missing'),
    });
    await hSlash.sendContinue('/status');
    expect(hSlash.prompts[0]!.text).toContain('/status');
    expect(hSlash.prompts[0]!.text).not.toContain('<board_context_reminder>');

    await hSlash.sendContinue('Now run normal work');
    expect(hSlash.prompts[1]!.text).toContain('<board_context_reminder>');

    await hSlash.sendContinue('Already consumed');
    expect(hSlash.prompts[2]!.text).not.toContain('<board_context_reminder>');

    // 2. History Replay + pre-prompt credential failure retains pending for retry.
    let failCreds = true;
    const hRetry = createBoardExecutionHarness({
      liveAgent: false,
      resumeError: new Error('ACP_RESUME_FAILED: missing'),
      validateSessionCredentials: async () => {
        if (failCreds) throw new Error('credentials temporarily unavailable');
      },
    });
    await hRetry.sendContinue('First attempt fails before prompt');
    expect(hRetry.prompts).toHaveLength(0);

    failCreds = false;
    await hRetry.sendContinue('Second attempt receives reminder');
    expect(hRetry.prompts).toHaveLength(1);
    expect(hRetry.prompts[0]!.text).toContain('<board_context_reminder>');
  });

  it('captures auto-compaction on first turns (startSession), mid-turn drop-then-regrowth (115k -> 22k -> 80k), and silent bare /compact', async () => {
    // 1. First turn (startSession) mid-turn auto-compaction (20k -> 115k -> 22k -> 80k).
    const hStart = createBoardExecutionHarness({
      liveAgent: false,
      metaPatch: { acpSessionId: undefined, contextWindowUsage: undefined },
      onPrompt: ({ callIndex, service, setUsage }) => {
        if (callIndex === 0) {
          service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 20_000 });
          service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 115_000 });
          service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 22_000 });
          service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 80_000 });
          setUsage(80_000);
        }
      },
    });
    await hStart.sendStart('Initial long Board thread task');
    expect(hStart.prompts[0]!.text).toContain('This session is a thread of Board "Lody Lan".');

    await hStart.sendContinue('Follow-up after first-turn compaction');
    expect(hStart.prompts[1]!.text).toContain('<board_context_reminder>');

    // 2. Continue turn mid-turn drop-then-regrowth (115k -> 22k -> 80k).
    const hRegrowth = createBoardExecutionHarness({
      metaPatch: { contextWindowUsage: { size: 1_000_000, used: 115_000 } },
      onPrompt: ({ callIndex, service, setUsage }) => {
        if (callIndex === 0) {
          service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 22_000 });
          service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 80_000 });
          setUsage(80_000);
        }
      },
    });
    await hRegrowth.sendContinue('Long multi-tool turn');
    await hRegrowth.sendContinue('Next turn after mid-turn regrowth');
    expect(hRegrowth.prompts[1]!.text).toContain('<board_context_reminder>');

    // 3. Silent bare `/compact` returning cleanly with zero visible output still arms pending.
    const hSilent = createBoardExecutionHarness({
      observePromptContentForTurn: (_sid, turnId) => turnId !== 'assistant:silent-compact',
    });
    await hSilent.sendContinue('/compact', { userTurnId: 'silent-compact' });
    await hSilent.sendContinue('Next turn after silent bare compact');
    expect(hSilent.prompts[1]!.text).toContain('<board_context_reminder>');
  });

  it('preserves confirmed compaction across Stop cancellation, multi-steer intermediate entries, and spontaneous idle compaction', async () => {
    // 1. Stop/cancel after mid-turn usage drop preserves pending for the next turn.
    let resolvePromptEntered!: () => void;
    const promptEntered = new Promise<void>((resolve) => {
      resolvePromptEntered = resolve;
    });
    const hStop = createBoardExecutionHarness({
      metaPatch: { contextWindowUsage: { size: 1_000_000, used: 120_000 } },
      onPrompt: async ({ callIndex, signal, service, setUsage }) => {
        if (callIndex === 0) {
          service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 20_000 });
          setUsage(20_000);
          resolvePromptEntered();
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }
      },
    });
    const turnPromise = hStop.sendContinue('Long task cancelled after compaction', {
      userTurnId: 'cancel-after-compact',
    });
    await promptEntered;
    await hStop.service.cancelSession({
      type: 'session/cancel',
      sessionId: SESSION_ID,
      turnId: 'assistant:cancel-after-compact',
      machineId: MACHINE_ID,
      workspaceId: WORKSPACE_ID,
    });
    await turnPromise;

    await hStop.sendContinue('Next message after Stop');
    expect(hStop.prompts[1]!.text).toContain('<board_context_reminder>');

    // 2. Multi-steer handoff (`turn-1 -> turn-2 -> turn-3`) with compaction marker on intermediate `turn-2`.
    let resolveSteerTurnStarted!: () => void;
    const steerTurnStarted = new Promise<void>((resolve) => {
      resolveSteerTurnStarted = resolve;
    });
    let resolveInitialPrompt!: () => void;
    const initialPromptGate = new Promise<void>((resolve) => {
      resolveInitialPrompt = resolve;
    });
    const hSteer = createBoardExecutionHarness({
      enableSteer: true,
      onPrompt: async ({ callIndex }) => {
        if (callIndex === 0) {
          resolveSteerTurnStarted();
          await initialPromptGate;
        }
      },
    });
    const steerRun = hSteer.sendContinue('Turn 1 initial prompt', { userTurnId: 'u-steer-1' });
    await steerTurnStarted;

    // First steer hands off to `assistant:u-steer-2`, which records a completed compaction marker.
    const steer1 = await hSteer.service.steerSession({
      sessionId: SESSION_ID,
      expectedTurnId: 'assistant:u-steer-1',
      userTurnId: 'u-steer-2',
      userId: 'owner-user',
      timestamp: '2026-11-26T00:01:00.000Z',
      inputConfig: { prompt: 'Steer 1', cliType: 'registry', agentType: 'antigravity' },
    });
    expect(steer1.applied).toBe(true);
    hSteer.history.push({
      id: 'assistant:u-steer-2',
      role: 'assistant',
      timestamp: '2026-11-26T00:01:05.000Z',
      items: [
        {
          type: 'tool_call',
          toolCallId: 'mid-steer-compact',
          title: 'Compacting context',
          status: 'completed',
          activityKind: 'context_compaction',
        },
      ],
    } as unknown as SessionHistoryInput);

    // Second steer hands off to `assistant:u-steer-3` (no compaction marker on final entry).
    const steer2 = await hSteer.service.steerSession({
      sessionId: SESSION_ID,
      expectedTurnId: 'assistant:u-steer-2',
      userTurnId: 'u-steer-3',
      userId: 'owner-user',
      timestamp: '2026-11-26T00:01:10.000Z',
      inputConfig: { prompt: 'Steer 2', cliType: 'registry', agentType: 'antigravity' },
    });
    expect(steer2.applied).toBe(true);
    resolveInitialPrompt();
    hSteer.finishSteerTail();
    await steerRun;

    await hSteer.sendContinue('Turn after multi-steer compaction');
    expect(hSteer.prompts[1]!.text).toContain('<board_context_reminder>');

    // 3. Spontaneous idle compaction via `noteLiveAcpUpdate` arms pending for Board sessions only.
    const hIdle = createBoardExecutionHarness({});
    hIdle.service.noteLiveAcpUpdate(
      SESSION_ID,
      parseSessionNotification({
        sessionId: 'acp-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'idle-compact-integration',
          title: 'Compacting context',
          status: 'in_progress',
          _meta: { lody: { activity: { kind: 'context_compaction' } } },
        },
      })
    );
    hIdle.service.noteLiveAcpUpdate(
      SESSION_ID,
      parseSessionNotification({
        sessionId: 'acp-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'idle-compact-integration',
          status: 'completed',
        },
      })
    );
    await hIdle.sendContinue('First turn after idle compaction');
    expect(hIdle.prompts[0]!.text).toContain('<board_context_reminder>');
  });

  it('skips goal turns and namespaced slash commands without consuming pending, and ignores /compact with non-text attachments', async () => {
    const h = createBoardExecutionHarness({});

    // Image + `/compact` must NOT mark pending.
    await h.sendContinue('/compact', {
      inputBlocks: [
        {
          type: 'image',
          imageId: 'img-1',
          mimeType: 'image/png',
          sizeBytes: 1024,
        },
        { type: 'text', text: '/compact' },
      ],
    });
    await h.sendContinue('After image plus compact');
    expect(h.prompts[1]!.text).not.toContain('<board_context_reminder>');

    // Arm pending via pure-text `/compact`.
    await h.sendContinue('/compact');

    // Goal control turn skips injection and preserves pending.
    await h.sendContinue('Continue goal iteration', {
      dispatchSource: 'goal',
      goalControl: { action: 'start', prompt: 'Continue goal iteration' } as GoalPromptControl,
    });
    expect(h.prompts[3]!.text).not.toContain('<board_context_reminder>');

    // Namespaced slash command skips injection and preserves pending.
    await h.sendContinue('/mcp:github:prompt repo=lody');
    expect(h.prompts[4]!.text).not.toContain('<board_context_reminder>');

    // Next normal message finally receives the preserved reminder.
    await h.sendContinue('Normal follow-up message');
    expect(h.prompts[5]!.text).toContain('<board_context_reminder>');

    // When pending IS armed, image + `/compact` is treated by providers (e.g. Codex) as a normal
    // prompt (image block first), so it MUST receive the reminder rather than deferring as a slash cmd.
    await h.sendContinue('/compact');
    await h.sendContinue('/compact', {
      inputBlocks: [
        {
          type: 'image',
          imageId: 'img-2',
          mimeType: 'image/png',
          sizeBytes: 1024,
        },
        { type: 'text', text: '/compact' },
      ],
    });
    expect(h.prompts[7]!.text).toContain('<board_context_reminder>');
  });

  it('preserves mid-turn usage drop (115k -> 22k -> 80k) when the provider throws after compaction', async () => {
    const h = createBoardExecutionHarness({
      metaPatch: { contextWindowUsage: { size: 1_000_000, used: 70_000 } },
      onPrompt: ({ callIndex, setUsage }) => {
        if (callIndex === 0) {
          h.service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 115_000 });
          h.service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 22_000 });
          h.service.noteContextWindowUsageUpdate(SESSION_ID, { size: 1_000_000, used: 80_000 });
          setUsage(80_000);
          throw new Error('provider network error after compaction');
        }
      },
    });

    await h.sendContinue('Long turn that compacts then throws');
    await h.sendContinue('Follow-up after provider error');
    expect(h.prompts[1]!.text).toContain('<board_context_reminder>');
  });

  it('arms pending when coordinator maintenance :compact confirms compaction so a user turn preempting :renew receives the reminder', async () => {
    const h = createBoardExecutionHarness({
      sessionId: COORD_ID,
      metaPatch: {
        id: COORD_ID,
        boardRole: 'coordinator',
        contextWindowUsage: { size: 1_000_000, used: 180_000 },
      },
      onPrompt: ({ callIndex, setUsage }) => {
        if (callIndex === 0) {
          // Maintenance `:compact` shrinks context below 0.8x baseline (180k -> 30k).
          setUsage(30_000);
        }
      },
    });

    const compactOutcome = await h.service.runBoardMaintenanceTurn({
      sessionId: COORD_ID,
      stepTurnId: 'board-maintenance:run-preempt:compact',
      prompt: '/compact Keep board state.',
      config: {},
      userId: 'owner-user',
      userName: 'Owner',
      userEmail: 'owner@example.com',
    });
    expect(compactOutcome).toBe('completed');

    // Simulate a user turn preempting `:renew` (which causes `:renew` to yield).
    await h.sendContinue('Urgent user message before renew');
    expect(h.prompts[1]!.text).toContain('<board_context_reminder>');
    expect(h.prompts[1]!.text).toContain('Role: main session (coordinator) of Board "Lody Lan".');
  });

  it('contains post-turn compaction bookkeeping errors so turn settlement and processMessageQueue still finish cleanly', async () => {
    let failPostTurnMetaRead = false;
    const h = createBoardExecutionHarness({
      getMetaStateOverride: (_readCount, defaultMeta) => {
        if (failPostTurnMetaRead) {
          throw new Error('transient meta read failure during bookkeeping');
        }
        return defaultMeta;
      },
      onPrompt: () => {
        failPostTurnMetaRead = true;
      },
    });

    await expect(h.sendContinue('/compact')).resolves.toBeTypeOf('string');
    expect(h.deps.processMessageQueue).toHaveBeenCalledWith(SESSION_ID);

    // Even though `readFreshMeta` threw, pre-turn meta fallback still armed pending for `/compact`.
    failPostTurnMetaRead = false;
    await h.sendContinue('Turn after contained bookkeeping failure');
    expect(h.prompts[1]!.text).toContain('<board_context_reminder>');
  });
});
