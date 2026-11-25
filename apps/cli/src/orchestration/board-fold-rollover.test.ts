import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoroDoc } from 'loro-crdt';
import { LoroRepo } from 'loro-repo';
import { describe, expect, it, vi } from 'vitest';
import {
  boardMaintenanceStepId,
  boardMaintenanceTurn,
  createSessionMirror,
  getBoardRoomId,
  getSessionRoomId,
  getWorkspaceFlockDocId,
  makeLodyError,
  normalizeBoardMeta,
  readBoardMaintenance,
  workspaceFlockKeys,
  writeBoardNotes,
  type BoardMeta,
  type MachineId,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type SessionTurnInputConfig,
  type WorkspaceId,
} from '@lody/shared';
import { createLoroSessionData } from '@lody/shared/session-data';
import { BoardLineStore, FOLD_TRIGGER_COUNT } from '@/lib/board-line-store';
import {
  BOARD_NOTES_TIDY_THRESHOLD_BYTES,
  buildBoardNotesTidyInstruction,
  buildSealPrompt,
  buildTidyPrompt,
} from './board-continuity-workflow';
import { LodyOperationCoordinator } from './operation-coordinator';
import { LodyOperationStore } from './operation-store';

const TEST_NOW_MS = Date.parse('2026-11-26T00:00:00.000Z');

type MaintenanceRun = {
  sessionId: SessionId;
  stepTurnId: string;
  prompt: string;
  config: SessionTurnInputConfig;
  userId: string;
  renewBoardInstructions?: boolean;
  freshAgentSession?: boolean;
  agentConfigId?: string;
};

async function createFoldHarness(options?: {
  strategy?: 'compact' | 'fold_rollover';
  agentType?: string;
  acpSessionId?: string | null;
  usedTokens?: number;
}) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'board-fold-rollover-')));
  const lineStore = new BoardLineStore(() => path.join(scratch, 'data'));
  const repo = await LoroRepo.create({});
  const workspaceId = 'ws_fold_test' as WorkspaceId;
  const machineId = 'host-fold' as MachineId;
  const coordinatorId = 'coord-fold' as SessionId;
  const board: BoardMeta = normalizeBoardMeta({
    version: 1,
    id: 'bd_fold',
    name: 'Fold Board',
    purpose: 'Test fold rollover continuity',
    coordinatorSessionId: coordinatorId,
    createdAtMs: TEST_NOW_MS,
    createdByUserId: 'user-1',
    files: { machineId },
    continuity: {
      strategy: options?.strategy ?? 'fold_rollover',
      idleCompaction: true,
      idleMinutes: 10,
      maxTokens: 150_000,
      windowPercent: 40,
    },
  })!;
  const catalog = await repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId));
  catalog.flock.set(workspaceFlockKeys.board(board.id), board);

  let now = TEST_NOW_MS + 1000;
  const storePath = path.join(scratch, 'operations.sqlite');
  let store: LodyOperationStore | undefined;
  const docs = new Map<SessionId, ReturnType<typeof createDoc>>();

  function createDoc(id: SessionId) {
    const loro = new LoroDoc();
    const mirror = createSessionMirror({
      doc: loro,
      initialState: { session: { id }, history: [] },
    });
    const sessionData = createLoroSessionData({
      sessionId: id,
      doc: loro,
      writer: mirror.historyWriter,
    });
    return {
      sessionId: id,
      mirror,
      sessionData,
      loro,
      subscribeAll: (listener: () => void) => mirror.subscribe(listener),
      getMetaState: async () => (await repo.getDocMeta(getSessionRoomId(id)))?.meta as SessionMeta,
      flushLocalWrites: async () => {},
      readHistorySnapshot: () => mirror.getState().history,
      applyHistoryAction: sessionData.commands.applyHistoryAction,
    };
  }

  const addSession = async (id: SessionId, extra: Partial<SessionMeta> = {}) => {
    const doc = createDoc(id);
    docs.set(id, doc);
    await repo.openPersistedDoc(getSessionRoomId(id));
    await repo.upsertDocMeta(getSessionRoomId(id), {
      id,
      workspaceId,
      machineId,
      userId: 'user-1',
      cliType: 'builtin',
      agentType: options?.agentType ?? 'codex',
      title: id,
      boardId: board.id,
      ...extra,
    });
    return doc;
  };

  const append = async (id: SessionId, turn: SessionHistoryInput) => {
    await docs.get(id)!.sessionData.commands.appendTurn({ ...turn, fileDiff: turn.fileDiff ?? [] });
  };

  const addUserExchange = async (turnId: string, userText: string, assistantText: string) => {
    await append(coordinatorId, {
      id: turnId,
      role: 'user',
      timestamp: new Date(now).toISOString(),
      userId: 'user-1',
      inputConfig: {
        cliType: 'builtin',
        agentType: options?.agentType ?? 'codex',
        modelId: 'test-model',
        chainDepth: 0,
        mcpServerIds: [],
      },
      status: 'handled',
      author: { v: 1, kind: 'human', userId: 'user-1' },
      items: [{ type: 'text', text: userText }],
      fileDiff: [],
    });
    now += 1000;
    await append(coordinatorId, {
      id: `${turnId}-answer`,
      role: 'assistant',
      userTurnId: turnId,
      timestamp: new Date(now).toISOString(),
      endedAt: now,
      finished: true,
      items: [
        { type: 'thought', text: 'hidden reasoning' },
        { type: 'text', text: assistantText },
      ],
      fileDiff: [],
    });
    now += 1000;
  };

  await addSession(coordinatorId, {
    boardRole: 'coordinator',
    ...(options?.acpSessionId === null
      ? {}
      : { acpSessionId: options?.acpSessionId ?? 'acp-old-session' }),
    contextWindowUsage: { used: options?.usedTokens ?? 168_000, size: 1_000_000 },
    lastModel: { modelId: 'test-model', name: 'Test Model' },
  });
  await addUserExchange('u-1', 'Let us design fold rollover', 'Agreed, starting with line store.');
  await addUserExchange(
    'u-2',
    'Keep pinned nodes safe',
    'Pinned nodes cap at 8 and stay preserved.'
  );

  const warnings: unknown[] = [];
  const launches: unknown[] = [];
  const maintenance = {
    runs: [] as MaintenanceRun[],
    timeline: [] as string[],
    active: false,
    pendingUser: false,
    support: false as boolean | undefined,
    held: new Set<SessionId>(),
    usageAfterRenew: 13_000,
    refuse: (_request: MaintenanceRun): string | undefined => undefined,
    outcome: (_request: MaintenanceRun): string => 'completed',
    replyText: (request: MaintenanceRun): string => {
      if (request.stepTurnId.endsWith(':seal')) {
        return [
          'Saved to notes.',
          '```json',
          JSON.stringify({
            title: 'Fold rollover architecture',
            tags: ['fold', 'continuity'],
            summary: '我完成了折叠换代架构确认，保留独立 line 存储与 8 个 pin 上限。',
          }),
          '```',
        ].join('\n');
      }
      if (request.stepTurnId.endsWith(':fold')) {
        return [
          '```json',
          JSON.stringify({
            title: 'Merged five segments',
            tags: ['milestone', 'fold'],
            summary: '我将最旧的 5 段折叠为高层历史摘要，保留所有关键决策与线程锚点。',
          }),
          '```',
        ].join('\n');
      }
      return 'Ready.';
    },
    duringStep: async (_request: MaintenanceRun) => {},
    afterStep: (_request: MaintenanceRun) => {},
  };

  const makeCoordinator = () =>
    new LodyOperationCoordinator({
      workspaceId,
      machineId,
      userId: 'user-1',
      now: () => now,
      workerBootId: 'fold-worker',
      boardLineStore: lineStore,
      workspaceDocument: {
        repo,
        getOrCreateSessionDoc: async (id: SessionId) => docs.get(id),
        getAcpCapabilities: async () => undefined,
        onSessionDocReleased: () => () => {},
      } as never,
      executionService: {
        getExecutionSnapshot: () => ({ hasActiveTurn: maintenance.active }),
        hasPendingNativeWork: () => false,
        contextCompactionSupport: () => maintenance.support,
        holdInboxForBoardMaintenance: (id: SessionId, held: boolean) => {
          if (held) maintenance.held.add(id);
          else maintenance.held.delete(id);
        },
        isInboxHeldForBoardMaintenance: (id: SessionId) => maintenance.held.has(id),
        runBoardMaintenanceTurn: async (request: MaintenanceRun) => {
          maintenance.runs.push(request);
          maintenance.timeline.push(`step:${request.stepTurnId.split(':').at(-1)}`);
          const refused = maintenance.refuse(request);
          if (refused) return refused;
          maintenance.active = true;
          try {
            await maintenance.duringStep(request);
            const outcome = maintenance.outcome(request);
            if (outcome === 'completed') {
              await docs.get(request.sessionId)!.sessionData.commands.appendTurn({
                id: `assistant:${request.stepTurnId}`,
                role: 'assistant',
                userTurnId: request.stepTurnId,
                timestamp: new Date(now).toISOString(),
                endedAt: now,
                finished: true,
                items: [{ type: 'text', text: maintenance.replyText(request) }],
                fileDiff: [],
              });
              if (request.freshAgentSession) {
                await repo.upsertDocMeta(getSessionRoomId(request.sessionId), {
                  acpSessionId: `acp-fresh-${maintenance.runs.length}`,
                  contextWindowUsage: { used: maintenance.usageAfterRenew, size: 1_000_000 },
                });
              }
            }
            return outcome;
          } finally {
            maintenance.active = false;
            maintenance.afterStep(request);
          }
        },
        continueSession: async (
          message: { userTurnId: string; sessionId: SessionId },
          dispatch?: { inboxBatch?: import('./inbox/model').InboxBatch }
        ) => {
          launches.push(message);
          maintenance.timeline.push('inbox');
          const batch = dispatch?.inboxBatch;
          if (batch && store) {
            const executionId = `assistant:${message.userTurnId}`;
            store.inbox.begin(batch, executionId);
            store.inbox.fence(batch, executionId);
            store.inbox.settle(batch, 'settled');
            store.inbox.release({ ...batch, executionId, outcome: 'normal' });
          }
        },
      } as never,
      dispatchWatcher: { hasPendingDispatch: () => maintenance.pendingUser } as never,
      logger: {
        debug: () => {},
        info: () => {},
        warn: (...args: unknown[]) => warnings.push(args.join(' ')),
        error: () => {},
      } as never,
      storePath,
      storeFactory: () => {
        store = new LodyOperationStore(storePath, () => now);
        return store;
      },
      operationStoreWatchFactory: () => ({ close: () => {} }),
      confirmTargetReadable: async () => {},
      materializeTarget: async () => {},
    });

  let coordinator = makeCoordinator();

  const records = () =>
    (docs.get(coordinatorId)!.readHistorySnapshot() as SessionHistoryInput[]).flatMap((turn) => {
      const record = readBoardMaintenance(turn);
      return record ? [{ id: turn.id, ...record }] : [];
    });

  const until = (check: () => boolean) =>
    new Promise<void>((resolve) => {
      if (check()) return resolve();
      const off = docs.get(coordinatorId)!.subscribeAll(() => {
        if (!check()) return;
        off();
        resolve();
      });
    });

  const drain = async () => {
    await coordinator.wake('test');
    await coordinator.idle();
    await new Promise((resolve) => setImmediate(resolve));
    await coordinator.idle();
  };

  return {
    scratch,
    workspaceId,
    machineId,
    board,
    coordinatorId,
    lineStore,
    get store() {
      if (!store) throw new Error('store not started');
      return store;
    },
    docs,
    repo,
    maintenance,
    warnings,
    launches,
    get coordinator() {
      return coordinator;
    },
    restartCoordinator: async () => {
      await coordinator.stop();
      maintenance.held.clear();
      coordinator = makeCoordinator();
      coordinator.start();
    },
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    addSession,
    addUserExchange,
    append,
    records,
    until,
    drain,
    steps: () => maintenance.runs.map((r) => r.stepTurnId.split(':').at(-1)),
    close: async () => {
      await coordinator.stop();
      for (const doc of docs.values()) {
        doc.mirror.dispose();
        doc.loro.free();
      }
      store?.close();
      fs.rmSync(scratch, { recursive: true, force: true });
    },
  };
}

describe('Board fold rollover workflow', () => {
  it('runs seal -> segment -> fold -> freshAgentSession opening when >= 8 uncovered segments exist', async () => {
    const h = await createFoldHarness();
    try {
      // Seed 7 existing uncovered segments so the newly sealed segment is #8 -> triggers fold of oldest 5.
      const existingIds: string[] = [];
      for (let i = 1; i <= FOLD_TRIGGER_COUNT - 1; i++) {
        const seg = await h.lineStore.appendSegment(h.workspaceId, h.board.id, {
          coversFrom: `2026-11-${String(i).padStart(2, '0')}T08:00:00.000Z`,
          coversTo: `2026-11-${String(i).padStart(2, '0')}T09:00:00.000Z`,
          title: `Historical segment ${i}`,
          tags: ['hist'],
          summary: `COMPLETE_SUMMARY_MARKER_${i}: detailed record for segment ${i}.`,
          summaryQuality: 'written',
          outcome: 'rolled',
          turnRange: { startTurnId: `old-u-${i}`, endTurnId: `old-a-${i}`, turnCount: 3 },
          createdAt: `2026-11-${String(i).padStart(2, '0')}T09:05:00.000Z`,
        });
        existingIds.push(seg.meta.id);
      }

      h.coordinator.start();
      h.advance(10 * 60_000 + 1);
      await h.drain();
      await h.until(() => h.records().some((r) => r.status === 'done'));
      await h.drain();

      expect(h.steps()).toEqual(['seal', 'fold', 'renew']);
      const [sealRun, foldRun, renewRun] = h.maintenance.runs;
      expect(sealRun!.freshAgentSession).toBeUndefined();
      // Fold prompt must receive the complete summary.md verbatim for the oldest 5 segments.
      for (let i = 1; i <= 5; i++) {
        expect(foldRun!.prompt).toContain(`COMPLETE_SUMMARY_MARKER_${i}`);
        expect(foldRun!.prompt).toContain(existingIds[i - 1]!);
      }
      expect(foldRun!.prompt).not.toContain('COMPLETE_SUMMARY_MARKER_6');

      expect(renewRun).toMatchObject({
        freshAgentSession: true,
        renewBoardInstructions: true,
      });
      expect(renewRun!.prompt).toContain('lody_board_line_expand');
      expect(renewRun!.prompt).toContain('Let us design fold rollover');
      expect(renewRun!.prompt).toContain('Pinned nodes cap at 8 and stay preserved.');
      expect(renewRun!.prompt).not.toContain('hidden reasoning');

      const tree = await h.lineStore.readTree(h.workspaceId, h.board.id);
      expect(tree.segments).toHaveLength(8);
      expect(tree.folds).toHaveLength(1);
      const newSeg = tree.segments.at(-1)!;
      const newFold = tree.folds[0]!;
      expect(newSeg.meta.summaryQuality).toBe('written');
      expect(newSeg.meta.outcome).toBe('rolled');
      expect(newSeg.meta.turnRange).toEqual({
        startTurnId: 'u-1',
        endTurnId: 'u-2-answer',
        turnCount: 2,
      });
      expect(newFold.meta.covers).toEqual(existingIds.slice(0, 5));
      expect(newFold.meta.coveredSegments).toBe(5);
      expect(newFold.meta.coveredTurns).toBe(15);

      expect(h.records()).toEqual([
        expect.objectContaining({
          kind: 'fold_rollover',
          trigger: 'idle',
          status: 'done',
          usedBefore: 168_000,
          usedAfter: 13_000,
          renewed: true,
          nodeId: newSeg.meta.id,
          foldId: newFold.meta.id,
          foldedCount: 5,
        }),
      ]);
      expect(renewRun!.prompt).toContain(newFold.meta.id);
      expect(renewRun!.prompt).toContain(newSeg.meta.id);
    } finally {
      await h.close();
    }
  });

  it('falls back mechanically without blocking rollover when old agent seal fails or outputs invalid JSON', async () => {
    const h = await createFoldHarness();
    try {
      h.maintenance.outcome = (req) => (req.stepTurnId.endsWith(':seal') ? 'failed' : 'completed');
      h.coordinator.start();
      await h.drain();
      await h.append(
        h.coordinatorId,
        boardMaintenanceTurn(
          'manual-fallback',
          { boardId: h.board.id, kind: 'compact', trigger: 'manual', status: 'requested' },
          new Date(h.now()).toISOString()
        )
      );
      await h.drain();
      await h.until(() => h.records().some((r) => r.status === 'done'));
      await h.drain();

      expect(h.steps()).toEqual(['seal', 'renew']);
      const tree = await h.lineStore.readTree(h.workspaceId, h.board.id);
      expect(tree.segments).toHaveLength(1);
      expect(tree.segments[0]!.meta.summaryQuality).toBe('fallback');
      expect(tree.segments[0]!.meta.outcome).toBe('fallback');
      expect(tree.segments[0]!.summary).toContain('Let us design fold rollover');
      expect(h.records()[0]).toMatchObject({
        kind: 'fold_rollover',
        trigger: 'manual',
        status: 'done',
        nodeId: tree.segments[0]!.meta.id,
        renewed: true,
      });
      expect(h.warnings.length).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  });

  it('skips fold with a warning without blocking rollover when fold step fails', async () => {
    const h = await createFoldHarness();
    try {
      for (let i = 1; i <= FOLD_TRIGGER_COUNT - 1; i++) {
        await h.lineStore.appendSegment(h.workspaceId, h.board.id, {
          coversFrom: `2026-11-${String(i).padStart(2, '0')}T08:00:00.000Z`,
          coversTo: `2026-11-${String(i).padStart(2, '0')}T09:00:00.000Z`,
          title: `Seg ${i}`,
          summary: `Summary ${i}`,
          summaryQuality: 'written',
          outcome: 'rolled',
          turnRange: { startTurnId: `old-${i}`, endTurnId: `old-${i}`, turnCount: 1 },
        });
      }
      h.maintenance.replyText = (req) =>
        req.stepTurnId.endsWith(':fold')
          ? 'not valid json at all'
          : '```json\n{"title":"Sealed","tags":["ok"],"summary":"Sealed summary."}\n```';

      h.coordinator.start();
      h.advance(10 * 60_000 + 1);
      await h.drain();
      await h.until(() => h.records().some((r) => r.status === 'done'));
      await h.drain();

      expect(h.steps()).toEqual(['seal', 'fold', 'renew']);
      const tree = await h.lineStore.readTree(h.workspaceId, h.board.id);
      expect(tree.segments).toHaveLength(8);
      expect(tree.folds).toHaveLength(0);
      expect(h.records()[0]).toMatchObject({
        kind: 'fold_rollover',
        status: 'done',
        nodeId: tree.segments.at(-1)!.meta.id,
        renewed: true,
      });
      expect(h.records()[0]!.foldId).toBeUndefined();
      expect(h.warnings.some((w) => String(w).includes('fold output was not parseable'))).toBe(
        true
      );
    } finally {
      await h.close();
    }
  });

  it('holds Inbox results during rollover and delivers them only after the fresh session is ready', async () => {
    const h = await createFoldHarness();
    try {
      h.maintenance.duringStep = async (req) => {
        if (!req.stepTurnId.endsWith(':seal')) return;
        // Enqueue a runnable Inbox completion while rollover holds the Inbox.
        h.store.accept({
          workspaceId: h.workspaceId,
          ownerMachineId: h.machineId,
          requesterSessionId: h.coordinatorId,
          requesterUserId: 'user-1',
          operationId: 'op-held-during-rollover',
          kind: 'session_chat',
          canonicalCommand: {},
          frozenContinuationConfig: { inputConfig: { chainDepth: 0 } },
          initiatorChainDepth: 0,
          createdAt: new Date(h.now()).toISOString(),
          deadlineAt: new Date(h.now() + 60_000).toISOString(),
          items: [],
        });
        h.store.finish(h.coordinatorId, 'op-held-during-rollover', {
          type: 'error',
          error: makeLodyError('COORDINATOR_FAILED', 'report payload', false),
        });
      };

      h.coordinator.start();
      await h.drain();
      await h.append(
        h.coordinatorId,
        boardMaintenanceTurn(
          'hold-test',
          { boardId: h.board.id, kind: 'fold_rollover', trigger: 'manual', status: 'requested' },
          new Date(h.now()).toISOString()
        )
      );
      await h.drain();
      await h.until(() => h.records().some((r) => r.status === 'done'));
      await h.drain();
      await vi.waitFor(() => expect(h.launches).toHaveLength(1));
      expect(h.maintenance.timeline).toEqual(['step:seal', 'step:renew', 'inbox']);
    } finally {
      await h.close();
    }
  });

  it('recovers a pending switch after restart without duplicating the already-sealed segment node', async () => {
    const h = await createFoldHarness();
    try {
      // User preempts right after seal finishes and persists nodeId.
      h.maintenance.afterStep = (req) => {
        if (req.stepTurnId.endsWith(':seal')) h.maintenance.pendingUser = true;
      };
      h.coordinator.start();
      await h.drain();
      await h.append(
        h.coordinatorId,
        boardMaintenanceTurn(
          'restart-recovery',
          { boardId: h.board.id, kind: 'fold_rollover', trigger: 'manual', status: 'requested' },
          new Date(h.now()).toISOString()
        )
      );
      await h.drain();
      await h.until(() =>
        h.records().some((r) => r.status === 'running' && r.nodeId !== undefined)
      );
      await h.drain();

      const beforeRestart = await h.lineStore.readTree(h.workspaceId, h.board.id);
      expect(beforeRestart.segments).toHaveLength(1);
      const sealedId = beforeRestart.segments[0]!.meta.id;
      expect(h.steps()).toEqual(['seal']);

      // Simulate daemon restart while divider is still `running` with `nodeId`.
      h.maintenance.pendingUser = false;
      h.maintenance.afterStep = () => {};
      await h.restartCoordinator();
      await h.drain();
      await h.until(() => h.records().some((r) => r.status === 'done'));
      await h.drain();

      // Resumed directly at `renew` without running `seal` again or creating a duplicate segment.
      expect(h.steps()).toEqual(['seal', 'renew']);
      const afterRestart = await h.lineStore.readTree(h.workspaceId, h.board.id);
      expect(afterRestart.segments).toHaveLength(1);
      expect(afterRestart.segments[0]!.meta.id).toBe(sealedId);
      expect(h.records()).toEqual([
        expect.objectContaining({
          kind: 'fold_rollover',
          status: 'done',
          nodeId: sealedId,
          renewed: true,
        }),
      ]);
    } finally {
      await h.close();
    }
  });

  it('works for agents without native /compact support (such as Kimi) on both idle and manual triggers', async () => {
    const h = await createFoldHarness({ agentType: 'kimi' });
    try {
      h.maintenance.support = false;
      h.coordinator.start();
      h.advance(10 * 60_000 + 1);
      await h.drain();
      await h.until(() => h.records().some((r) => r.status === 'done'));
      await h.drain();

      expect(h.steps()).toEqual(['seal', 'renew']);
      expect(h.records()).toEqual([
        expect.objectContaining({
          kind: 'fold_rollover',
          trigger: 'idle',
          status: 'done',
          renewed: true,
        }),
      ]);
    } finally {
      await h.close();
    }
  });

  it('pre-holds Inbox from pending-switch.json on restart and recovers a divider pushed beyond TAIL_ROWS = 50', async () => {
    const h = await createFoldHarness();
    try {
      h.maintenance.afterStep = (req) => {
        if (req.stepTurnId.endsWith(':seal')) h.maintenance.pendingUser = true;
      };
      h.coordinator.start();
      await h.drain();
      await h.append(
        h.coordinatorId,
        boardMaintenanceTurn(
          'deep-tail-recovery',
          { boardId: h.board.id, kind: 'fold_rollover', trigger: 'manual', status: 'requested' },
          new Date(h.now()).toISOString()
        )
      );
      await h.drain();
      await h.until(() =>
        h.records().some((r) => r.status === 'running' && r.nodeId !== undefined)
      );
      await h.drain();

      const pendingOnDisk = await h.lineStore.readPendingSwitch(h.workspaceId, h.board.id);
      expect(pendingOnDisk).toMatchObject({
        runId: 'deep-tail-recovery',
        sessionId: h.coordinatorId,
      });

      // Append 30 full user+assistant exchanges (= 60 rows) so the divider falls outside TAIL_ROWS = 50.
      for (let i = 1; i <= 30; i++) {
        await h.addUserExchange(`extra-u-${i}`, `Extra ask ${i}`, `Extra answer ${i}`);
      }

      // Enqueue a runnable Inbox completion before restarting; it must stay held until :renew completes.
      h.store.accept({
        workspaceId: h.workspaceId,
        ownerMachineId: h.machineId,
        requesterSessionId: h.coordinatorId,
        requesterUserId: 'user-1',
        operationId: 'op-post-restart-hold',
        kind: 'session_chat',
        canonicalCommand: {},
        frozenContinuationConfig: { inputConfig: { chainDepth: 0 } },
        initiatorChainDepth: 0,
        createdAt: new Date(h.now()).toISOString(),
        deadlineAt: new Date(h.now() + 60_000).toISOString(),
        items: [],
      });
      h.store.finish(h.coordinatorId, 'op-post-restart-hold', {
        type: 'error',
        error: makeLodyError('COORDINATOR_FAILED', 'must wait for fresh session', false),
      });

      h.maintenance.pendingUser = false;
      h.maintenance.afterStep = () => {};
      await h.restartCoordinator();
      // Startup restored the Inbox hold synchronously from pending-switch.json before Inbox ticks.
      expect(h.maintenance.held.has(h.coordinatorId)).toBe(true);
      await h.drain();
      await h.until(() => h.records().some((r) => r.status === 'done'));
      await h.drain();
      await vi.waitFor(() => expect(h.launches).toHaveLength(1));

      expect(h.steps()).toEqual(['seal', 'renew']);
      expect(h.maintenance.timeline).toEqual(['step:seal', 'step:renew', 'inbox']);
      expect(await h.lineStore.readPendingSwitch(h.workspaceId, h.board.id)).toBeNull();
      expect(h.maintenance.held.has(h.coordinatorId)).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('closes crash window #1 (segment saved with maintenanceRunId before divider got nodeId) without duplicating segment', async () => {
    const h = await createFoldHarness();
    try {
      const runId = 'crash-after-segment';
      const existingSeg = await h.lineStore.appendSegment(h.workspaceId, h.board.id, {
        coversFrom: '2026-11-26T00:00:00.000Z',
        coversTo: '2026-11-26T00:00:05.000Z',
        title: 'Already sealed segment',
        summary: 'Persisted right before crash.',
        summaryQuality: 'written',
        outcome: 'rolled',
        turnRange: { startTurnId: 'u-1', endTurnId: 'u-2-answer', turnCount: 2 },
        maintenanceRunId: runId,
      });
      await h.append(
        h.coordinatorId,
        boardMaintenanceTurn(
          runId,
          { boardId: h.board.id, kind: 'fold_rollover', trigger: 'manual', status: 'running' },
          new Date(h.now()).toISOString()
        )
      );

      h.coordinator.start();
      await h.drain();
      await h.until(() => h.records().some((r) => r.status === 'done'));
      await h.drain();

      expect(h.steps()).toEqual(['renew']);
      const tree = await h.lineStore.readTree(h.workspaceId, h.board.id);
      expect(tree.segments).toHaveLength(1);
      expect(tree.segments[0]!.meta.id).toBe(existingSeg.meta.id);
      expect(h.records()[0]).toMatchObject({
        kind: 'fold_rollover',
        status: 'done',
        nodeId: existingSeg.meta.id,
        renewed: true,
      });
      await vi.waitFor(async () => {
        expect(await h.lineStore.readPendingSwitch(h.workspaceId, h.board.id)).toBeNull();
      });
    } finally {
      await h.close();
    }
  });

  it('closes crash window #2 (renew completed before done divider written) without opening a second fresh session', async () => {
    const h = await createFoldHarness();
    try {
      const runId = 'crash-after-renew';
      const seg = await h.lineStore.appendSegment(h.workspaceId, h.board.id, {
        coversFrom: '2026-11-26T00:00:00.000Z',
        coversTo: '2026-11-26T00:00:05.000Z',
        title: 'Sealed before renew',
        summary: 'Summary before renew.',
        summaryQuality: 'written',
        outcome: 'rolled',
        turnRange: { startTurnId: 'u-1', endTurnId: 'u-2-answer', turnCount: 2 },
        maintenanceRunId: runId,
      });
      await h.lineStore.writePendingSwitch(h.workspaceId, h.board.id, {
        runId,
        nodeId: seg.meta.id,
        sessionId: h.coordinatorId,
        updatedAt: new Date(h.now()).toISOString(),
      });
      await h.append(
        h.coordinatorId,
        boardMaintenanceTurn(
          runId,
          {
            boardId: h.board.id,
            kind: 'fold_rollover',
            trigger: 'manual',
            status: 'running',
            nodeId: seg.meta.id,
          },
          new Date(h.now()).toISOString()
        )
      );
      await h.append(h.coordinatorId, {
        id: `assistant:${boardMaintenanceStepId(runId, 'renew')}`,
        role: 'assistant',
        userTurnId: boardMaintenanceStepId(runId, 'renew'),
        timestamp: new Date(h.now()).toISOString(),
        endedAt: h.now(),
        finished: true,
        items: [{ type: 'text', text: 'Ready in fresh session.' }],
        fileDiff: [],
      });

      h.coordinator.start();
      await h.drain();
      await h.until(() => h.records().some((r) => r.status === 'done'));
      await h.drain();

      expect(h.steps()).toEqual([]);
      expect(h.records()[0]).toMatchObject({
        kind: 'fold_rollover',
        status: 'done',
        nodeId: seg.meta.id,
        renewed: true,
      });
      await vi.waitFor(async () => {
        expect(await h.lineStore.readPendingSwitch(h.workspaceId, h.board.id)).toBeNull();
        expect(h.maintenance.held.has(h.coordinatorId)).toBe(false);
      });
    } finally {
      await h.close();
    }
  });

  it('aborts rollover when user cancels the fold step and waits while Inbox is paused on a pending switch', async () => {
    const h = await createFoldHarness();
    try {
      for (let i = 1; i <= FOLD_TRIGGER_COUNT - 1; i++) {
        await h.lineStore.appendSegment(h.workspaceId, h.board.id, {
          coversFrom: `2026-11-${String(i).padStart(2, '0')}T08:00:00.000Z`,
          coversTo: `2026-11-${String(i).padStart(2, '0')}T09:00:00.000Z`,
          title: `Seg ${i}`,
          summary: `Summary ${i}`,
          summaryQuality: 'written',
          outcome: 'rolled',
          turnRange: { startTurnId: `old-${i}`, endTurnId: `old-${i}`, turnCount: 1 },
        });
      }
      h.maintenance.outcome = (req) =>
        req.stepTurnId.endsWith(':fold') ? 'cancelled' : 'completed';

      h.coordinator.start();
      h.advance(10 * 60_000 + 1);
      await h.drain();
      await h.until(() => h.records().some((r) => r.status === 'interrupted'));
      await h.drain();

      expect(h.steps()).toEqual(['seal', 'fold']);
      expect(h.records()[0]).toMatchObject({
        kind: 'fold_rollover',
        status: 'interrupted',
        reason: 'cancelled',
      });
      await vi.waitFor(async () => {
        expect(await h.lineStore.readPendingSwitch(h.workspaceId, h.board.id)).toBeNull();
        expect(h.maintenance.held.has(h.coordinatorId)).toBe(false);
      });

      // Now verify a pending switch respects `inbox.paused` until the user speaks again.
      const pendingRunId = 'paused-switch';
      const seg = (await h.lineStore.readTree(h.workspaceId, h.board.id)).segments.at(-1)!;
      await h.lineStore.writePendingSwitch(h.workspaceId, h.board.id, {
        runId: pendingRunId,
        nodeId: seg.meta.id,
        sessionId: h.coordinatorId,
        updatedAt: new Date(h.now()).toISOString(),
      });
      await h.append(
        h.coordinatorId,
        boardMaintenanceTurn(
          pendingRunId,
          {
            boardId: h.board.id,
            kind: 'fold_rollover',
            trigger: 'manual',
            status: 'running',
            nodeId: seg.meta.id,
          },
          new Date(h.now()).toISOString()
        )
      );
      const stopInput = {
        workspaceId: h.workspaceId,
        sessionId: h.coordinatorId,
        userId: 'user-1',
        inputId: 'stop-me',
        kind: 'task' as const,
      };
      expect(h.store.inbox.accept(stopInput)).toBe(true);
      const activeExec = 'assistant:stop-me';
      expect(h.store.inbox.begin(stopInput, activeExec)).toBe(true);
      expect(h.store.inbox.pause(stopInput, activeExec)).toBe(true);
      h.store.inbox.release({ ...stopInput, executionId: activeExec, outcome: 'user_stop' });
      expect(h.store.inbox.paused(h.workspaceId, h.coordinatorId)).toBe(true);

      h.maintenance.outcome = () => 'completed';
      const runsBefore = h.maintenance.runs.length;
      await h.drain();
      expect(h.maintenance.runs.length).toBe(runsBefore);
      expect(h.records().at(-1)?.status).toBe('running');

      // User speaks again -> clears paused -> pending switch resumes and completes `:renew`.
      const resumeInput = {
        workspaceId: h.workspaceId,
        sessionId: h.coordinatorId,
        userId: 'user-1',
        inputId: 'resume-turn',
        kind: 'task' as const,
      };
      expect(h.store.inbox.accept(resumeInput)).toBe(true);
      expect(h.store.inbox.begin(resumeInput, 'assistant:resume-turn')).toBe(true);
      h.store.inbox.release({
        ...resumeInput,
        executionId: 'assistant:resume-turn',
        outcome: 'normal',
      });
      expect(h.store.inbox.paused(h.workspaceId, h.coordinatorId)).toBe(false);
      await h.drain();
      await h.until(() => h.records().some((r) => r.status === 'done'));
      await h.drain();
      expect(h.steps().at(-1)).toBe('renew');
      await vi.waitFor(async () => {
        expect(await h.lineStore.readPendingSwitch(h.workspaceId, h.board.id)).toBeNull();
      });
    } finally {
      await h.close();
    }
  });

  it('marks line-store-error without spinning when line/ is unreadable', async () => {
    const h = await createFoldHarness();
    try {
      const readSpy = vi
        .spyOn(h.lineStore, 'readTree')
        .mockRejectedValue(new Error('EACCES: line directory unreadable'));

      h.coordinator.start();
      await h.drain();
      await h.append(
        h.coordinatorId,
        boardMaintenanceTurn(
          'unreadable-line',
          { boardId: h.board.id, kind: 'fold_rollover', trigger: 'manual', status: 'requested' },
          new Date(h.now()).toISOString()
        )
      );
      await h.drain();
      await h.until(() => h.records().some((r) => r.status === 'failed'));
      await h.drain();

      expect(h.records()[0]).toMatchObject({
        kind: 'fold_rollover',
        status: 'failed',
        reason: 'line-store-error',
      });
      expect(readSpy).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(h.maintenance.held.has(h.coordinatorId)).toBe(false));

      // When an already-sealed switch hits a transient readTree error, it keeps the Inbox held and backs off without spinning.
      readSpy.mockClear();
      await h.append(
        h.coordinatorId,
        boardMaintenanceTurn(
          'sealed-unreadable-line',
          {
            boardId: h.board.id,
            kind: 'fold_rollover',
            trigger: 'manual',
            status: 'running',
            nodeId: 'seg_00000099',
          },
          new Date(h.now()).toISOString()
        )
      );
      await h.drain();
      await vi.waitFor(() => expect(readSpy).toHaveBeenCalledTimes(1));
      // Allow microtasks/immediates to flush and prove no 0ms spin loop retries `readTree`.
      await new Promise((resolve) => setImmediate(resolve));
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(h.maintenance.held.has(h.coordinatorId)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('skips fold cleanly when a fold candidate is pinned mid-fold and excludes non-human role:user turns', async () => {
    const h = await createFoldHarness();
    try {
      // Append an agent-authored role:user turn that must never leak into fallback or opening context.
      await h.append(h.coordinatorId, {
        id: 'agent-relay-turn',
        role: 'user',
        timestamp: new Date(h.now()).toISOString(),
        status: 'handled',
        inputConfig: {
          cliType: 'builtin',
          agentType: 'codex',
          modelId: 'test-model',
          chainDepth: 1,
          mcpServerIds: [],
        },
        author: {
          v: 1,
          kind: 'agent',
          sessionId: 'worker-sub' as SessionId,
          turnId: 'worker-turn-1',
          name: 'Worker Agent',
        },
        items: [{ type: 'text', text: 'AGENT_INTERNAL_RELAY_DO_NOT_LEAK' }],
        fileDiff: [],
      });

      const seededIds: string[] = [];
      for (let i = 1; i <= FOLD_TRIGGER_COUNT - 1; i++) {
        const seg = await h.lineStore.appendSegment(h.workspaceId, h.board.id, {
          coversFrom: `2026-11-${String(i).padStart(2, '0')}T08:00:00.000Z`,
          coversTo: `2026-11-${String(i).padStart(2, '0')}T09:00:00.000Z`,
          title: `Seed ${i}`,
          summary: `Seed summary ${i}`,
          summaryQuality: 'written',
          outcome: 'rolled',
          turnRange: { startTurnId: `old-${i}`, endTurnId: `old-${i}`, turnCount: 1 },
        });
        seededIds.push(seg.meta.id);
      }

      // Pin the oldest candidate while `:fold` is running; appendFold must reject it without blocking `:renew`.
      h.maintenance.duringStep = async (req) => {
        if (req.stepTurnId.endsWith(':fold')) {
          await h.lineStore.setPinned(h.workspaceId, h.board.id, seededIds[0]!, true);
        }
      };
      // Also exercise fallback summary path by failing `:seal` so we verify non-human turns are excluded from fallback too.
      h.maintenance.outcome = (req) => (req.stepTurnId.endsWith(':seal') ? 'failed' : 'completed');

      h.coordinator.start();
      h.advance(10 * 60_000 + 1);
      await h.drain();
      await h.until(() => h.records().some((r) => r.status === 'done'));
      await h.drain();

      expect(h.steps()).toEqual(['seal', 'fold', 'renew']);
      const tree = await h.lineStore.readTree(h.workspaceId, h.board.id);
      expect(tree.folds).toHaveLength(0);
      expect(tree.pins).toContain(seededIds[0]!);
      expect(tree.segments.at(-1)!.summary).not.toContain('AGENT_INTERNAL_RELAY_DO_NOT_LEAK');
      const renewRun = h.maintenance.runs.find((r) => r.stepTurnId.endsWith(':renew'))!;
      expect(renewRun.prompt).not.toContain('AGENT_INTERNAL_RELAY_DO_NOT_LEAK');
      expect(renewRun.prompt).toContain(`[PINNED] [${seededIds[0]!}`);
      expect(h.warnings.some((w) => String(w).includes('BOARD_LINE_FOLD_PINNED_CONFLICT'))).toBe(
        true
      );
    } finally {
      await h.close();
    }
  });

  it('does not block ordinary compact requests when pending-switch.json cannot be read', async () => {
    const h = await createFoldHarness({ strategy: 'compact' });
    try {
      h.maintenance.support = true;
      // Force readPendingSwitch to reject (simulating unreadable `line/` directory).
      h.lineStore.readPendingSwitch = async () => {
        throw new Error('EACCES: permission denied');
      };
      // Write a manual `compact` request divider.
      await h.append(h.coordinatorId, {
        id: 'board-maintenance:manual-compact-1',
        role: 'system',
        timestamp: new Date(h.now()).toISOString(),
        fileDiff: [],
        items: [
          {
            type: 'system_notice',
            name: 'board_context_maintenance',
            meta: {
              boardId: h.board.id,
              kind: 'compact',
              trigger: 'manual',
              status: 'requested',
            },
          },
        ],
      });

      h.coordinator.start();
      await h.drain();
      await h.until(() => h.maintenance.runs.length > 0);
      await h.drain();

      expect(h.steps()).toContain('memory');
    } finally {
      await h.close();
    }
  });

  it('builds 8 KB threshold-aware Board notes instructions for tidy and seal prompts', () => {
    expect(BOARD_NOTES_TIDY_THRESHOLD_BYTES).toBe(8192);

    // At or below 8192 bytes: lightweight append guidance.
    for (const bytes of [0, 512, 8192]) {
      const instruction = buildBoardNotesTidyInstruction(bytes);
      expect(instruction).toContain('lody_board_notes_append');
      expect(instruction).not.toContain('over the 8 KB limit');
      expect(buildTidyPrompt(bytes)).toContain(instruction);
      expect(buildSealPrompt(bytes)).toContain(instruction);
    }

    // Above 8192 bytes: require get + replace consolidation with exact current size.
    const overBoundary = buildBoardNotesTidyInstruction(8193);
    expect(overBoundary).toContain('8.0 KB (8193 bytes), over the 8 KB limit');
    expect(overBoundary).toContain('lody_board_notes_get');
    expect(overBoundary).toContain('lody_board_notes_replace');
    expect(overBoundary).toContain('Do not keep blindly calling lody_board_notes_append');

    const bigTidy = buildTidyPrompt(12 * 1024);
    expect(bigTidy).toContain('12.0 KB (12288 bytes), over the 8 KB limit');
    expect(bigTidy).toContain('lody_board_notes_replace');
    const bigSeal = buildSealPrompt(12 * 1024);
    expect(bigSeal).toContain('12.0 KB (12288 bytes), over the 8 KB limit');
    expect(bigSeal).toContain('lody_board_notes_replace');

    // Undefined / unreadable fallback: check with get and consolidate if > ~8 KB.
    const fallback = buildBoardNotesTidyInstruction(undefined);
    expect(fallback).toContain('lody_board_notes_get');
    expect(fallback).toContain('8 KB');
    expect(fallback).toContain('lody_board_notes_replace');
    expect(fallback).toContain('lody_board_notes_append');
    expect(buildTidyPrompt(undefined)).toContain(fallback);
    expect(buildSealPrompt(undefined)).toContain(fallback);
  });

  it('injects UTF-8 shared-notes size guidance into fold_rollover :seal (> 8 KB, <= 8 KB, and unreadable fallback)', async () => {
    // 1. Over 8 KB UTF-8 (3,000 CJK chars = 9,000 UTF-8 bytes, while UTF-16 .length is only 3,000).
    const hLarge = await createFoldHarness();
    try {
      const boardHandle = await hLarge.repo.openPersistedDoc(getBoardRoomId(hLarge.board.id));
      const cjkNotes = '笔记'.repeat(1500);
      const expectedBytes = Buffer.byteLength(cjkNotes, 'utf8');
      expect(cjkNotes.length).toBeLessThan(8192);
      expect(expectedBytes).toBe(9000);
      writeBoardNotes(boardHandle.doc as LoroDoc, {
        kind: 'replace',
        text: cjkNotes,
        updatedBy: hLarge.coordinatorId,
        now: hLarge.now(),
      });

      hLarge.coordinator.start();
      hLarge.advance(10 * 60_000 + 1);
      await hLarge.drain();
      await hLarge.until(() => hLarge.records().some((r) => r.status === 'done'));
      await hLarge.drain();

      const sealRun = hLarge.maintenance.runs.find((r) => r.stepTurnId.endsWith(':seal'))!;
      expect(sealRun.prompt).toContain('8.8 KB (9000 bytes), over the 8 KB limit');
      expect(sealRun.prompt).toContain('lody_board_notes_get');
      expect(sealRun.prompt).toContain('lody_board_notes_replace');
    } finally {
      await hLarge.close();
    }

    // 2. Within 8 KB UTF-8: stays lightweight.
    const hSmall = await createFoldHarness();
    try {
      const boardHandle = await hSmall.repo.openPersistedDoc(getBoardRoomId(hSmall.board.id));
      writeBoardNotes(boardHandle.doc as LoroDoc, {
        kind: 'replace',
        text: 'Short current snapshot.',
        updatedBy: hSmall.coordinatorId,
        now: hSmall.now(),
      });

      hSmall.coordinator.start();
      hSmall.advance(10 * 60_000 + 1);
      await hSmall.drain();
      await hSmall.until(() => hSmall.records().some((r) => r.status === 'done'));
      await hSmall.drain();

      const sealRun = hSmall.maintenance.runs.find((r) => r.stepTurnId.endsWith(':seal'))!;
      expect(sealRun.prompt).toContain('lody_board_notes_append');
      expect(sealRun.prompt).not.toContain('over the 8 KB limit');
    } finally {
      await hSmall.close();
    }

    // 3. Unreadable board notes doc: logs warn, uses fallback instruction, does not block rollover.
    const hUnreadable = await createFoldHarness();
    try {
      const boardRoom = getBoardRoomId(hUnreadable.board.id);
      const origOpen = hUnreadable.repo.openPersistedDoc.bind(hUnreadable.repo);
      vi.spyOn(hUnreadable.repo, 'openPersistedDoc').mockImplementation((docId: string) => {
        if (docId === boardRoom)
          return Promise.reject(new Error('board doc temporarily unavailable'));
        return origOpen(docId);
      });

      hUnreadable.coordinator.start();
      hUnreadable.advance(10 * 60_000 + 1);
      await hUnreadable.drain();
      await hUnreadable.until(() => hUnreadable.records().some((r) => r.status === 'done'));
      await hUnreadable.drain();

      expect(hUnreadable.steps()).toEqual(['seal', 'renew']);
      const sealRun = hUnreadable.maintenance.runs.find((r) => r.stepTurnId.endsWith(':seal'))!;
      expect(sealRun.prompt).toContain(buildBoardNotesTidyInstruction(undefined));
      expect(
        hUnreadable.warnings.some((w) => String(w).includes('failed to read shared notes size'))
      ).toBe(true);
    } finally {
      await hUnreadable.close();
    }
  });
});
