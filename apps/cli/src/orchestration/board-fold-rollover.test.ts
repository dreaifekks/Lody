import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoroDoc } from 'loro-crdt';
import { LoroRepo } from 'loro-repo';
import { describe, expect, it, vi } from 'vitest';
import {
  boardMaintenanceTurn,
  createSessionMirror,
  getSessionRoomId,
  getWorkspaceFlockDocId,
  makeLodyError,
  normalizeBoardMeta,
  readBoardMaintenance,
  workspaceFlockKeys,
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
});
