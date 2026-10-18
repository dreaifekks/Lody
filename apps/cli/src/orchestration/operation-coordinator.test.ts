import { Cause, Effect, Exit } from 'effect';
import { CoordinatorWorkflow } from './coordinator-workflow';
import type { CoordinatorActivity } from './coordinator-activity';
import type { CoordinatorPorts } from './coordinator-ports';
import { OperationRepository } from './operation-repository';
import { operationRepositoryLayer } from './platform/operations';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withHistoryPort } from '../../tests/history-port-fixture';

import { LoroDoc } from 'loro-crdt';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  boardMaintenanceTurn,
  getAgentConfigRoomId,
  getSessionRoomId,
  readBoardMaintenance,
  machineFlockKeys,
  type AgentConfigMeta,
  type MachineId,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';

import { LodyOperationCoordinator } from './operation-coordinator';
import { LodyOperationStore } from './operation-store';

const queuedResults = (store: LodyOperationStore, workspaceId: WorkspaceId) =>
  (store as unknown as { db: Database.Database }).db
    .prepare(
      'SELECT session_id AS requesterSessionId,operation_id AS operationId,consumed FROM inbox_results WHERE workspace_id=? AND consumed=0 ORDER BY sequence'
    )
    .all(workspaceId);

const roots = new Set<string>();
const TEST_NOW_MS = Date.parse('2026-07-20T00:00:00Z');

const makeHarness = async (options?: {
  deadlineAt?: string;
  requesterArchived?: boolean;
  pendingUser?: boolean;
  busy?: boolean;
  activeTurnId?: string;
  agentConfigId?: string;
  configurationSyncSucceeds?: boolean;
  configurationSync?: () => Promise<boolean>;
  beforeTurnClaim?: () => Promise<void>;
  afterTurnComplete?: () => void;
  beforeTargetMetaRead?: () => Promise<void>;
  now?: () => number;
  machineAgentConfig?: AgentConfigMeta;
  legacyAgentConfig?: AgentConfigMeta;
  resolveUserFails?: boolean;
  targetInputDurable?: boolean;
  acceptedInputDurable?: boolean;
  materializationFailuresBeforeSuccess?: number;
  materializationWritesBeforeFailure?: boolean;
  materializationWritesDocBeforeFailure?: boolean;
  historyFailuresBeforeSuccess?: number;
  beforeRequesterHistoryWrite?: () => Promise<void>;
  materializeTargetOverride?: () => Promise<void>;
  confirmTargetReadable?: (docId: string, reason: string) => Promise<void>;
  operationKind?: 'session_create' | 'session_create_many' | 'session_chat';
  failProgressHistoryWrites?: boolean;
  progressHistoryFailures?: number;
  failProgressFlush?: boolean;
  targetDocSync?: () => Promise<{
    history?: SessionHistoryInput[];
    meta?: SessionMeta;
  } | void>;
  workerBootId?: string;
}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lody-operation-coordinator-'));
  roots.add(root);
  const storePath = path.join(root, 'operations.sqlite3');
  const workspaceId = 'workspace-1' as WorkspaceId;
  const machineId = 'machine-1' as MachineId;
  const requesterSessionId = 'requester-1' as SessionId;
  const targetSessionId = 'target-1' as SessionId;
  const targetInputDurable = options?.targetInputDurable ?? true;
  const histories = new Map<SessionId, SessionHistoryInput[]>([
    [requesterSessionId, []],
    [
      targetSessionId,
      targetInputDurable
        ? [
            {
              id: 'turn-1',
              role: 'user',
              timestamp: '2026-07-20T00:00:00.000Z',
              items: [{ type: 'text', text: 'work' }],
              fileDiff: [],
              status: 'pending',
            },
          ]
        : [],
    ],
  ]);
  const targetMeta = {
    id: targetSessionId,
    workspaceId,
    machineId,
    userId: 'user-1',
    cliType: 'builtin',
    agentType: 'codex',
    ...(targetInputDurable ? { latestUserMsgId: 'turn-1' } : {}),
  } as SessionMeta;
  const metas = new Map<SessionId, SessionMeta>([
    [
      requesterSessionId,
      {
        id: requesterSessionId,
        workspaceId,
        machineId,
        userId: 'user-1',
        cliType: 'builtin',
        agentType: 'codex',
        isArchived: options?.requesterArchived ?? false,
      } as SessionMeta,
    ],
    ...(targetInputDurable ? ([[targetSessionId, targetMeta]] as const) : []),
  ]);
  const subscribers = new Map<SessionId, Set<() => void>>();
  let historyUpdateAttempt = 0;
  let remainingProgressHistoryFailures = options?.progressHistoryFailures ?? 0;
  const flushRepo = async () => {
    if (options?.failProgressFlush) throw new Error('flush unavailable');
  };
  const sessionDoc = (sessionId: SessionId) =>
    withHistoryPort({
      mirror: {
        subscribe: (callback: () => void) => {
          const set = subscribers.get(sessionId) ?? new Set();
          set.add(callback);
          subscribers.set(sessionId, set);
          return () => set.delete(callback);
        },
      },
      // `subscribeSessionChanges` needs the session-data surface; the fake drives
      // change notification through its own `mirror.subscribe` set above.
      sessionData: {
        history: {
          count: async () => 0,
          readAt: async () => ({ state: 'missing' as const }),
          readTurn: async (turnId: string) => {
            const turn = (histories.get(sessionId) ?? []).find((entry) => entry.id === turnId);
            return turn ? { state: 'ready' as const, turn } : { state: 'missing' as const };
          },
          readRange: async () => [],
          readDirectory: async () => [],
          observe: (listener: () => void) => {
            const set = subscribers.get(sessionId) ?? new Set();
            set.add(listener);
            subscribers.set(sessionId, set);
            return { initial: Promise.resolve([]), unsubscribe: () => set.delete(listener) };
          },
        },
        commands: {},
        durability: { waitDurable: async () => {} },
      },
      getHistory: () => histories.get(sessionId) ?? [],
      updateHistory: async (update: (history: SessionHistoryInput[]) => SessionHistoryInput[]) => {
        const current = histories.get(sessionId) ?? [];
        const next = update(current);
        if (sessionId === requesterSessionId) {
          await options?.beforeRequesterHistoryWrite?.();
          historyUpdateAttempt += 1;
          if (historyUpdateAttempt <= (options?.historyFailuresBeforeSuccess ?? 0)) {
            throw new Error('transient history write failure');
          }
        }
        const progressItems = (history: SessionHistoryInput[]) =>
          history.flatMap(
            (entry) => entry.items?.filter((item) => item.type === 'operation_progress') ?? []
          );
        if (
          sessionId === requesterSessionId &&
          JSON.stringify(progressItems(next)) !== JSON.stringify(progressItems(current)) &&
          (options?.failProgressHistoryWrites === true || remainingProgressHistoryFailures > 0)
        ) {
          remainingProgressHistoryFailures = Math.max(0, remainingProgressHistoryFailures - 1);
          throw new Error('progress history unavailable');
        }
        histories.set(sessionId, next);
      },
      ...(targetInputDurable || options?.failProgressFlush === true
        ? { flushLocalWrites: flushRepo }
        : {}),
    });
  const flockRows = options?.machineAgentConfig
    ? [
        {
          key: machineFlockKeys.agentConfig(options.machineAgentConfig.id),
          value: options.machineAgentConfig,
        },
      ]
    : [];
  const flockScan = vi.fn((scanOptions?: { prefix?: readonly unknown[] }) => {
    const prefix = scanOptions?.prefix;
    return prefix
      ? flockRows.filter((row) => prefix.every((part, index) => row.key[index] === part))
      : flockRows;
  });
  const openFlockDoc = vi.fn(async () => ({
    flock: { scan: flockScan, subscribe: () => () => {} },
  }));
  const getRepoMeta = vi.fn(() => {
    throw new Error('Inbox configuration lookup must not enumerate repo meta');
  });
  const getDocMeta = vi.fn(async (roomId: string) => {
    if (
      options?.legacyAgentConfig &&
      getAgentConfigRoomId(options.legacyAgentConfig.id) === roomId
    ) {
      return { meta: options.legacyAgentConfig };
    }
    if (roomId === getSessionRoomId(targetSessionId)) await options?.beforeTargetMetaRead?.();
    const sessionId = [...metas.keys()].find((candidate) => getSessionRoomId(candidate) === roomId);
    if (!sessionId) return undefined;
    const meta = metas.get(sessionId);
    return meta ? { meta } : undefined;
  });
  const repo = {
    flush: flushRepo,
    watch: () => ({ unsubscribe: vi.fn() }),
    getDocMeta,
    getMeta: getRepoMeta,
    openFlockDoc,
  };
  let pendingUser = options?.pendingUser ?? false;
  let busy = options?.busy ?? false;
  const continueSession = vi.fn(
    async (message: unknown, dispatch?: { inboxBatch?: import('./inbox/model').InboxBatch }) => {
      const typedMessage = message as { sessionId: SessionId; userTurnId: string };
      await options?.beforeTurnClaim?.();
      const assistantTurnId = `assistant:${typedMessage.userTurnId}`;
      const batch = dispatch?.inboxBatch;
      const executionStore = batch
        ? new LodyOperationStore(storePath, () => TEST_NOW_MS)
        : undefined;
      if (batch && executionStore) {
        expect(executionStore.inbox.begin(batch, assistantTurnId)).toBe(true);
        expect(executionStore.inbox.fence(batch, assistantTurnId)).toBe(true);
      }
      histories.set(typedMessage.sessionId, [
        ...(histories.get(typedMessage.sessionId) ?? []),
        {
          id: assistantTurnId,
          role: 'assistant',
          userTurnId: typedMessage.userTurnId,
          timestamp: '2026-07-20T00:00:01.000Z',
          items: [{ type: 'text', text: 'continued' }],
          fileDiff: [],
          finished: true,
        },
      ]);
      if (batch && executionStore) {
        executionStore.inbox.settle(batch, 'settled');
        executionStore.inbox.release({ ...batch, executionId: assistantTurnId, outcome: 'normal' });
        executionStore.close();
      }
      options?.afterTurnComplete?.();
    }
  );
  const logger = { warn: vi.fn(), debug: vi.fn() };
  const syncMachineFlockDoc = vi.fn(
    async () =>
      await (options?.configurationSync?.() ??
        Promise.resolve(options?.configurationSyncSucceeds ?? true))
  );
  const syncRemoteDocOrThrow = vi.fn(async (docId: string) => {
    if (docId !== getSessionRoomId(targetSessionId)) return;
    const synced = await options?.targetDocSync?.();
    if (synced?.history) histories.set(targetSessionId, synced.history);
    if (synced?.meta) metas.set(targetSessionId, synced.meta);
  });
  const storeLifecycle = { opened: 0, closed: 0 };
  const storeFactory = () => {
    storeLifecycle.opened += 1;
    const factoryStore = new LodyOperationStore(storePath, options?.now ?? (() => TEST_NOW_MS));
    const close = factoryStore.close.bind(factoryStore);
    factoryStore.close = () => {
      storeLifecycle.closed += 1;
      close();
    };
    return factoryStore;
  };
  const resolveUser = vi.fn(async (userId: string) => {
    if (options?.resolveUserFails) {
      throw new Error('convex unreachable');
    }
    return { id: userId, name: 'Ada Lovelace', email: 'ada@example.com' };
  });
  let operationStoreWake: ((filename: string | Buffer | null) => void) | undefined;
  let materializationAttempt = 0;
  const materializeTarget = vi.fn(async () => {
    if (options?.materializeTargetOverride) {
      await options.materializeTargetOverride();
      return;
    }
    if (targetInputDurable) {
      throw new Error('target should already be durable');
    }
    materializationAttempt += 1;
    const shouldFail =
      materializationAttempt <= (options?.materializationFailuresBeforeSuccess ?? 0);
    if (
      !shouldFail ||
      options?.materializationWritesBeforeFailure === true ||
      options?.materializationWritesDocBeforeFailure === true
    ) {
      metas.set(targetSessionId, {
        ...targetMeta,
        ...(!shouldFail || options?.materializationWritesBeforeFailure === true
          ? { latestUserMsgId: 'turn-1' }
          : {}),
      });
      histories.set(targetSessionId, [
        {
          id: 'turn-1',
          role: 'user',
          timestamp: '2026-07-20T00:00:00.000Z',
          items: [{ type: 'text', text: 'work' }],
          fileDiff: [],
          status: 'pending',
        },
      ]);
    }
    if (shouldFail) throw new Error('transient Streams failure');
  });
  const coordinatorOptions = {
    workspaceId,
    machineId,
    userId: 'user-1',
    userResolver: { resolve: resolveUser },
    workspaceDocument: {
      repo,
      getOrCreateSessionDoc: async (sessionId: SessionId) => sessionDoc(sessionId),
      syncRemoteDocOrThrow,
      syncMachineFlockDoc,
    } as never,
    executionService: {
      getExecutionSnapshot: () => ({
        hasActiveTurn: busy,
        ...(busy && options?.activeTurnId ? { activeTurnId: options.activeTurnId } : {}),
      }),
      continueSession,
    } as never,
    dispatchWatcher: { hasPendingDispatch: () => pendingUser } as never,
    logger: logger as never,
    storeFactory,
    storePath,
    now: options?.now ?? (() => TEST_NOW_MS),
    ...(options?.workerBootId ? { workerBootId: options.workerBootId } : {}),
    operationStoreWatchFactory: (_directory, onChange) => {
      operationStoreWake = onChange;
      return { close: vi.fn() };
    },
    materializeTarget,
    confirmTargetReadable: options?.confirmTargetReadable,
  } satisfies ConstructorParameters<typeof LodyOperationCoordinator>[0];
  const coordinator = new LodyOperationCoordinator(coordinatorOptions);
  const store = new LodyOperationStore(storePath, () => TEST_NOW_MS);
  store.accept({
    workspaceId,
    ownerMachineId: machineId,
    requesterSessionId,
    requesterUserId: 'user-1',
    operationId: 'review-round-1',
    kind: options?.operationKind ?? 'session_chat',
    canonicalCommand: { sessionId: targetSessionId, prompt: 'work' },
    frozenContinuationConfig: {
      ...(options?.agentConfigId ? { agentConfigId: options.agentConfigId } : {}),
      inputConfig: { cliType: 'builtin', agentType: 'codex', chainDepth: 0 },
    },
    initiatorChainDepth: 0,
    createdAt: '2026-07-19T00:00:00.000Z',
    deadlineAt: options?.deadlineAt ?? '2026-07-21T00:00:00.000Z',
    items: [
      {
        status: 'active',
        target: { sessionId: targetSessionId, userTurnId: 'turn-1' },
        inputDurable: options?.acceptedInputDurable ?? targetInputDurable,
      },
    ],
  });
  store.close();
  return {
    coordinator,
    coordinatorOptions,
    continueSession,
    resolveUser,
    histories,
    metas,
    requesterSessionId,
    targetSessionId,
    storePath,
    storeLifecycle,
    syncMachineFlockDoc,
    syncRemoteDocOrThrow,
    flockScan,
    getDocMeta,
    getRepoMeta,
    openFlockDoc,
    logger,
    materializeTarget,
    notifyTargetHistory: () => {
      for (const callback of subscribers.get(targetSessionId) ?? []) callback();
    },
    setProgressWriteFailures: (count: number) => {
      remainingProgressHistoryFailures = count;
    },
    triggerOperationStoreWake: () => operationStoreWake?.(path.basename(storePath)),
    setPendingUser: (value: boolean) => {
      pendingUser = value;
    },
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
};

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe('LodyOperationCoordinator', () => {
  it('recovers local creation using daemon authority even when remote Streams is unavailable', async () => {
    const harness = await makeHarness({
      targetInputDurable: false,
      operationKind: 'session_create',
      targetDocSync: async () => {
        throw new Error('No remote Streams in OSS');
      },
      confirmTargetReadable: async () => {},
    });
    harness.coordinator.start();
    try {
      await harness.coordinator.idle();
      expect(
        harness.histories.get(harness.targetSessionId)?.filter((turn) => turn.id === 'turn-1')
      ).toHaveLength(1);
      await harness.coordinator.wake('retry');
      expect(
        harness.histories.get(harness.targetSessionId)?.filter((turn) => turn.id === 'turn-1')
      ).toHaveLength(1);
      expect(harness.syncRemoteDocOrThrow).not.toHaveBeenCalled();
      const history = harness.histories.get(harness.targetSessionId);
      if (!history?.[0]) throw new Error('Missing materialized target');
      history[0] = { ...history[0], status: 'handled' };
      history.push({
        id: 'assistant:turn-1',
        role: 'assistant',
        userTurnId: 'turn-1',
        timestamp: '2026-07-20T00:00:00.500Z',
        items: [{ type: 'text', text: 'local result' }],
        fileDiff: [],
        finished: true,
      });
      await harness.coordinator.wake('local-target-finished');
      await harness.coordinator.wake('duplicate-finish');
      const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
      try {
        expect(store.get(harness.requesterSessionId, 'review-round-1')).toMatchObject({
          state: 'finished',
          completion: {
            type: 'result',
            value: { items: [{ status: 'succeeded', output: { text: 'local result' } }] },
          },
        });
        expect(queuedResults(store, 'workspace-1' as WorkspaceId)).toHaveLength(1);
        expect(
          harness.histories
            .get(harness.requesterSessionId)
            ?.filter((turn) => turn.role === 'assistant')
        ).toHaveLength(0);
      } finally {
        store.close();
      }
    } finally {
      await harness.coordinator.stop();
    }
  });

  it('retries transient target materialization on its own bounded timer', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const harness = await makeHarness({
      targetInputDurable: false,
      materializationFailuresBeforeSuccess: 2,
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    expect(harness.materializeTarget).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    harness.triggerOperationStoreWake();
    await vi.advanceTimersByTimeAsync(10);
    await harness.coordinator.idle();
    expect(harness.materializeTarget).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(489);
    await harness.coordinator.wake('session-meta');
    await harness.coordinator.idle();
    expect(harness.materializeTarget).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await harness.coordinator.idle();
    expect(harness.materializeTarget).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_999);
    await harness.coordinator.idle();
    expect(harness.materializeTarget).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    await harness.coordinator.idle();
    expect(harness.materializeTarget).toHaveBeenCalledTimes(3);

    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1').items[0]).toMatchObject({
        status: 'active',
        inputDurable: true,
        target: { sessionId: harness.targetSessionId, userTurnId: 'turn-1' },
      });
    } finally {
      store.close();
      await harness.coordinator.stop();
    }
  });

  it('recognizes an ambiguous successful write before retrying materialization', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const harness = await makeHarness({
      targetInputDurable: false,
      materializationFailuresBeforeSuccess: 1,
      materializationWritesBeforeFailure: true,
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    expect(harness.materializeTarget).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await harness.coordinator.idle();
    expect(harness.materializeTarget).toHaveBeenCalledTimes(1);

    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1').items[0]).toMatchObject({
        status: 'active',
        inputDurable: true,
        target: { sessionId: harness.targetSessionId, userTurnId: 'turn-1' },
      });
    } finally {
      store.close();
      await harness.coordinator.stop();
    }
  });

  it('waits for cross-replica target catch-up before replaying a fixed turn', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const fixedTurn: SessionHistoryInput = {
      id: 'turn-1',
      role: 'user',
      timestamp: '2026-07-20T00:00:00.000Z',
      items: [{ type: 'text', text: 'work' }],
      fileDiff: [],
      status: 'pending',
    };
    const acceptorReplica = new LoroDoc();
    acceptorReplica.getList('history').insert(0, fixedTurn);
    acceptorReplica.commit();
    const daemonReplica = new LoroDoc();
    let syncAttempt = 0;
    const readDaemonHistory = (): SessionHistoryInput[] => {
      const fixedCount = daemonReplica
        .getList('history')
        .toJSON()
        .filter(
          (entry: unknown) =>
            typeof entry === 'object' &&
            entry !== null &&
            'id' in entry &&
            entry.id === fixedTurn.id
        ).length;
      return fixedCount > 0 ? [fixedTurn] : [];
    };
    const harness = await makeHarness({
      targetInputDurable: false,
      targetDocSync: async () => {
        syncAttempt += 1;
        if (syncAttempt === 1) {
          throw new Error('target bootstrap unavailable');
        }
        daemonReplica.import(acceptorReplica.export({ mode: 'update' }));
        return {
          history: readDaemonHistory(),
          meta: {
            id: 'target-1' as SessionId,
            workspaceId: 'workspace-1' as WorkspaceId,
            machineId: 'machine-1' as MachineId,
            userId: 'user-1',
            cliType: 'builtin',
            agentType: 'codex',
            latestUserMsgId: fixedTurn.id,
          },
        };
      },
      materializeTargetOverride: async () => {
        daemonReplica.getList('history').insert(0, fixedTurn);
        daemonReplica.commit();
      },
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    expect(harness.syncRemoteDocOrThrow).toHaveBeenCalledTimes(1);
    expect(harness.materializeTarget).not.toHaveBeenCalled();
    let store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    expect(store.get(harness.requesterSessionId, 'review-round-1').items[0]).toMatchObject({
      status: 'active',
      inputDurable: false,
    });
    store.close();

    await vi.advanceTimersByTimeAsync(1_000);
    await harness.coordinator.idle();

    expect(harness.syncRemoteDocOrThrow).toHaveBeenCalledTimes(2);
    expect(harness.materializeTarget).not.toHaveBeenCalled();
    expect(
      daemonReplica
        .getList('history')
        .toJSON()
        .filter(
          (entry: unknown) =>
            typeof entry === 'object' &&
            entry !== null &&
            'id' in entry &&
            entry.id === fixedTurn.id
        )
    ).toHaveLength(1);
    store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1').items[0]).toMatchObject({
        status: 'active',
        inputDurable: true,
      });
    } finally {
      store.close();
      await harness.coordinator.stop();
    }
  });

  it('replays when the fixed turn exists but its dispatch pointer was not written', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const harness = await makeHarness({
      targetInputDurable: false,
      materializationFailuresBeforeSuccess: 1,
      materializationWritesDocBeforeFailure: true,
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    expect(harness.materializeTarget).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await harness.coordinator.idle();
    expect(harness.materializeTarget).toHaveBeenCalledTimes(2);

    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1').items[0]).toMatchObject({
        status: 'active',
        inputDurable: true,
        target: { sessionId: harness.targetSessionId, userTurnId: 'turn-1' },
      });
    } finally {
      store.close();
      await harness.coordinator.stop();
    }
  });

  it('does not replay a handled fixed turn after the latest pointer advances', async () => {
    const harness = await makeHarness({
      targetInputDurable: true,
      acceptedInputDurable: false,
    });
    harness.metas.set(harness.targetSessionId, {
      ...harness.metas.get(harness.targetSessionId)!,
      latestUserMsgId: 'turn-2',
      lastHandledUserMsgId: 'turn-1',
    });

    harness.coordinator.start();
    await harness.coordinator.idle();

    expect(harness.materializeTarget).not.toHaveBeenCalled();
    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1').items[0]).toMatchObject({
        status: 'active',
        inputDurable: true,
      });
    } finally {
      store.close();
      await harness.coordinator.stop();
    }
  });

  it('does not start materialization after the deadline passes during an evidence read', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const deadlineMs = TEST_NOW_MS + 1;
    let nowMs = TEST_NOW_MS;
    let releaseMetaReadSignal!: () => void;
    let markMetaReadStarted!: () => void;
    const metaReadStarted = new Promise<void>((resolve) => {
      markMetaReadStarted = resolve;
    });
    const releaseMetaRead = new Promise<void>((resolve) => {
      releaseMetaReadSignal = resolve;
    });
    let firstTargetMetaRead = true;
    const harness = await makeHarness({
      targetInputDurable: false,
      deadlineAt: new Date(deadlineMs).toISOString(),
      now: () => nowMs,
      beforeTargetMetaRead: async () => {
        if (!firstTargetMetaRead) return;
        firstTargetMetaRead = false;
        markMetaReadStarted();
        await releaseMetaRead;
      },
    });

    harness.coordinator.start();
    await metaReadStarted;
    nowMs = deadlineMs;
    releaseMetaReadSignal();
    await harness.coordinator.idle();

    expect(harness.materializeTarget).not.toHaveBeenCalled();
    const store = new LodyOperationStore(harness.storePath, () => nowMs);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1').items[0]).toMatchObject({
        status: 'failed',
        error: { code: 'TARGET_TIMEOUT' },
      });
    } finally {
      store.close();
      await harness.coordinator.stop();
    }
  });

  it('does not start materialization after the deadline passes during target catch-up', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const deadlineMs = TEST_NOW_MS + 1;
    let nowMs = TEST_NOW_MS;
    let releaseTargetSync!: () => void;
    let markTargetSyncStarted!: () => void;
    const targetSyncStarted = new Promise<void>((resolve) => {
      markTargetSyncStarted = resolve;
    });
    const targetSyncRelease = new Promise<void>((resolve) => {
      releaseTargetSync = resolve;
    });
    const harness = await makeHarness({
      targetInputDurable: false,
      deadlineAt: new Date(deadlineMs).toISOString(),
      now: () => nowMs,
      targetDocSync: async () => {
        markTargetSyncStarted();
        await targetSyncRelease;
      },
    });

    harness.coordinator.start();
    await targetSyncStarted;
    nowMs = deadlineMs;
    releaseTargetSync();
    await harness.coordinator.idle();

    expect(harness.materializeTarget).not.toHaveBeenCalled();
    const store = new LodyOperationStore(harness.storePath, () => nowMs);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1').items[0]).toMatchObject({
        status: 'failed',
        error: { code: 'TARGET_TIMEOUT' },
      });
    } finally {
      store.close();
      await harness.coordinator.stop();
    }
  });

  it('turns an unterminal target into TARGET_TIMEOUT without cancelling it', async () => {
    const harness = await makeHarness({ deadlineAt: '2026-07-19T23:59:59.000Z' });
    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.stop();

    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'finished',
        completion: {
          type: 'result',
          value: { items: [{ status: 'failed', error: { code: 'TARGET_TIMEOUT' } }] },
        },
      });
    } finally {
      store.close();
    }
  });

  it.each([
    {
      status: 'failed' as const,
      expected: { status: 'failed', error: { code: 'TARGET_FAILED' } },
    },
    {
      status: 'canceled' as const,
      expected: { status: 'cancelled' },
    },
    {
      status: 'canceled' as const,
      cancellationReason: 'user_stop' as const,
      expected: { status: 'cancelled', cancellationReason: 'user_stop' },
    },
  ])(
    'keeps $status ahead of terminal assistant partial output',
    async ({ status, expected, ...source }) => {
      const harness = await makeHarness();
      const targetHistory = harness.histories.get(harness.targetSessionId)!;
      targetHistory[0] = { ...targetHistory[0]!, status, ...source };
      targetHistory.push({
        id: 'assistant:turn-1',
        role: 'assistant',
        userTurnId: 'turn-1',
        timestamp: '2026-07-20T00:00:00.500Z',
        items: [{ type: 'text', text: 'partial output' }],
        fileDiff: [],
        finished: true,
      });

      harness.coordinator.start();
      await harness.coordinator.idle();
      await harness.coordinator.stop();

      const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
      try {
        expect(store.get(harness.requesterSessionId, 'review-round-1')).toMatchObject({
          state: 'finished',
          completion: { type: 'result', value: { items: [expected] } },
        });
        if ('cancellationReason' in source) {
          expect(queuedResults(store, harness.coordinatorOptions.workspaceId)).toEqual([]);
          expect(
            harness.histories
              .get(harness.requesterSessionId)
              ?.some((turn) => turn.role === 'assistant')
          ).toBe(false);
        }
      } finally {
        store.close();
      }
    }
  );

  it('uses durable local Stop before stale partial output or an expired deadline can return a receipt', async () => {
    const harness = await makeHarness({ deadlineAt: '2026-07-19T00:00:00Z' });
    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      const input = {
        workspaceId: harness.coordinatorOptions.workspaceId,
        sessionId: harness.targetSessionId,
        userId: 'user-1',
        inputId: 'turn-1',
        kind: 'task' as const,
        config: {},
      };
      store.inbox.activate(input.workspaceId, 'target-owner');
      store.inbox.accept(input);
      store.inbox.begin(input, 'target-execution');
      expect(store.inbox.pause(input, 'target-execution', [], 'manual-stop')).toBe(true);
      // The cancellation projection has not arrived. The requester sees only partial terminal output.
      harness.histories.get(harness.targetSessionId)?.push({
        id: 'partial',
        role: 'assistant',
        userTurnId: 'turn-1',
        timestamp: '2026-07-20T00:00:00Z',
        items: [{ type: 'text', text: 'partial' }],
        finished: true,
        fileDiff: [],
      });
      harness.coordinator.start();
      await harness.coordinator.idle();
      await harness.coordinator.stop();
      expect(store.get(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'finished',
        completion: {
          type: 'result',
          value: { items: [{ status: 'cancelled', cancellationReason: 'user_stop' }] },
        },
      });
      expect(queuedResults(store, input.workspaceId)).toEqual([]);
      expect(
        harness.histories.get(harness.requesterSessionId)?.some((turn) => turn.role === 'assistant')
      ).toBe(false);
    } finally {
      await harness.coordinator.stop();
      store.close();
    }
  });

  it('holds one store connection for its lifetime instead of churning WAL sidecars', async () => {
    // Regression: per-reconcile open/close deletes and recreates the SQLite
    // WAL/SHM files, which the store directory watcher observes as fresh
    // events — a self-sustaining wake loop that starves the event loop.
    const harness = await makeHarness();

    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.wake('hint-1');
    await harness.coordinator.idle();
    await harness.coordinator.wake('hint-2');
    await harness.coordinator.idle();
    expect(harness.storeLifecycle).toEqual({ opened: 1, closed: 0 });

    await harness.coordinator.stop();
    expect(harness.storeLifecycle).toEqual({ opened: 1, closed: 1 });
  });

  it('keeps durable create targets queued until exact target execution evidence is present', async () => {
    const harness = await makeHarness({
      operationKind: 'session_create',
      targetInputDurable: true,
      acceptedInputDurable: true,
      busy: true,
      activeTurnId: 'assistant:unrelated-turn',
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.stop();

    const progress = harness.histories
      .get(harness.requesterSessionId)
      ?.find((entry) => entry.id === 'operation-progress:requester-1:review-round-1');
    expect(progress?.items).toEqual([
      {
        type: 'operation_progress',
        operationId: 'review-round-1',
        operationKind: 'session_create',
        items: [{ target: { sessionId: 'target-1', userTurnId: 'turn-1' }, status: 'created' }],
      },
    ]);
  });

  it('marks create progress running only for the exact target turn', async () => {
    const harness = await makeHarness({
      operationKind: 'session_create',
      targetInputDurable: true,
      acceptedInputDurable: true,
      busy: true,
      activeTurnId: 'assistant:turn-1',
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.stop();

    const progress = harness.histories
      .get(harness.requesterSessionId)
      ?.find((entry) => entry.id === 'operation-progress:requester-1:review-round-1');
    expect(progress?.items).toEqual([
      {
        type: 'operation_progress',
        operationId: 'review-round-1',
        operationKind: 'session_create',
        items: [{ target: { sessionId: 'target-1', userTurnId: 'turn-1' }, status: 'running' }],
      },
    ]);
  });

  it.each(
    (['deadline', 'cancelled', 'error'] as const).flatMap((reason) =>
      (['succeeded', 'failed', 'cancelled'] as const).map((terminal) => ({ reason, terminal }))
    )
  )(
    'reconciles target $terminal after root $reason, delivery and daemon restart without another continuation',
    async ({ reason, terminal }) => {
      const completed = Promise.withResolvers<void>();
      const harness = await makeHarness({
        afterTurnComplete: () => completed.resolve(),
        operationKind: 'session_create',
        deadlineAt: reason === 'deadline' ? '2026-07-19T23:59:59.000Z' : '2026-07-21T00:00:00.000Z',
      });
      if (reason !== 'deadline') {
        const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
        try {
          if (reason === 'cancelled') store.cancel(harness.requesterSessionId, 'review-round-1');
          else
            store.finish(harness.requesterSessionId, 'review-round-1', {
              type: 'error',
              error: {
                code: 'COORDINATOR_FAILED',
                message: 'synthetic root error',
                retryable: false,
              },
            });
        } finally {
          store.close();
        }
      }
      const targetHistory = harness.histories.get(harness.targetSessionId);
      const targetTurn = targetHistory?.[0];
      if (!targetHistory || !targetTurn) throw new Error('missing target fixture');
      targetHistory[0] = { ...targetTurn, status: 'processing' };
      const read = () => {
        const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
        try {
          return {
            pending: store.listPendingProgress(
              'workspace-1' as WorkspaceId,
              'machine-1' as MachineId
            ),
            deliveries: queuedResults(store, 'workspace-1' as WorkspaceId),
            completion: store.get(harness.requesterSessionId, 'review-round-1').completion,
          };
        } finally {
          store.close();
        }
      };
      const status = () =>
        harness.histories
          .get(harness.requesterSessionId)
          ?.flatMap((row) => row.items ?? [])
          .find((item) => item.type === 'operation_progress')?.items[0]?.status;
      harness.coordinator.start();
      await harness.coordinator.idle();
      expect(status()).toBe('running');
      expect(read().pending).toHaveLength(1);
      expect(read().deliveries).toHaveLength(1);
      const meta = harness.metas.get(harness.targetSessionId);
      if (!meta) throw new Error('missing target metadata fixture');
      harness.metas.delete(harness.targetSessionId);
      harness.notifyTargetHistory();
      await harness.coordinator.idle();
      expect(status()).toBe('running');
      expect(read().pending).toHaveLength(1);
      harness.metas.set(harness.targetSessionId, meta);
      await completed.promise;
      const rootResult = read().completion;
      const requesterBefore = harness.histories.get(harness.requesterSessionId) ?? [];
      const continuationIds = requesterBefore
        .filter((row) => row.role === 'assistant')
        .map((row) => row.id);
      expect(continuationIds).toHaveLength(1);
      await harness.coordinator.stop();
      // Opening the same SQLite store must restore observation even with no active Operation or runnable intent.
      harness.coordinator.start();
      await harness.coordinator.idle();
      expect(status()).toBe('running');
      targetHistory[0] = {
        ...targetTurn,
        status:
          terminal === 'succeeded' ? 'handled' : terminal === 'failed' ? 'failed' : 'canceled',
      };
      if (terminal === 'succeeded')
        targetHistory.push({
          id: 'late-answer',
          role: 'assistant',
          userTurnId: 'turn-1',
          timestamp: '2026-07-20T00:01:00.000Z',
          items: [{ type: 'text', text: 'late success' }],
          fileDiff: [],
          finished: true,
        });
      harness.notifyTargetHistory();
      await harness.coordinator.idle();
      expect(status()).toBe(terminal);
      expect(read().pending).toEqual([]);
      expect(read().completion).toEqual(rootResult);
      expect(
        harness.histories
          .get(harness.requesterSessionId)
          ?.filter((row) => row.role === 'assistant')
          .map((row) => row.id)
      ).toEqual(continuationIds);
      await harness.coordinator.stop();
    }
  );

  it('does not let an in-flight progress read write after the owning worker stops', async () => {
    let signalRead: () => void = () => {};
    let releaseRead: () => void = () => {};
    const readStarted = new Promise<void>((resolve) => {
      signalRead = resolve;
    });
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const harness = await makeHarness({
      operationKind: 'session_create',
      beforeTargetMetaRead: async () => {
        signalRead();
        await readGate;
      },
    });
    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      store.cancel(harness.requesterSessionId, 'review-round-1');
    } finally {
      store.close();
    }
    harness.coordinator.start();
    const wake = harness.coordinator.wake('observe-owner-stop');
    await readStarted;
    const closing = harness.coordinator.stop();
    expect(() => harness.coordinator.start()).toThrow('shutdown is not complete');
    releaseRead();
    await closing;
    await wake;
    expect(harness.histories.get(harness.requesterSessionId)).toEqual([]);
  });

  it('keeps progress pending until the terminal Loro write is flushed', async () => {
    const options = { operationKind: 'session_create' as const, failProgressFlush: true };
    const harness = await makeHarness(options);
    const targetHistory = harness.histories.get(harness.targetSessionId);
    if (!targetHistory) throw new Error('missing target fixture');
    targetHistory.push({
      id: 'answer',
      role: 'assistant',
      userTurnId: 'turn-1',
      timestamp: '2026-07-20T00:01:00.000Z',
      items: [{ type: 'text', text: 'done' }],
      fileDiff: [],
      finished: true,
    });
    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.stop();
    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(queuedResults(store, 'workspace-1' as WorkspaceId)).toHaveLength(1);
      expect(
        store.listPendingProgress('workspace-1' as WorkspaceId, 'machine-1' as MachineId)
      ).toHaveLength(1);
    } finally {
      store.close();
    }
    options.failProgressFlush = false;
    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.stop();
    const recovered = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(
        recovered.listPendingProgress('workspace-1' as WorkspaceId, 'machine-1' as MachineId)
      ).toEqual([]);
    } finally {
      recovered.close();
    }
  });

  it('retries failed terminal progress writes after delivery without needing another history event', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const harness = await makeHarness({
      operationKind: 'session_create',
      deadlineAt: '2026-07-19T23:59:59.000Z',
    });
    const targetHistory = harness.histories.get(harness.targetSessionId);
    const targetTurn = targetHistory?.[0];
    if (!targetHistory || !targetTurn) throw new Error('missing target fixture');
    targetHistory[0] = { ...targetTurn, status: 'processing' };
    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.setProgressWriteFailures(1);
    targetHistory[0] = { ...targetTurn, status: 'failed' };
    harness.notifyTargetHistory();
    await harness.coordinator.idle();
    const status = () =>
      harness.histories
        .get(harness.requesterSessionId)
        ?.flatMap((row) => row.items ?? [])
        .find((item) => item.type === 'operation_progress')?.items[0]?.status;
    expect(status()).toBe('running');
    await vi.advanceTimersByTimeAsync(5_000);
    await harness.coordinator.idle();
    expect(status()).toBe('failed');
    await harness.coordinator.stop();
  });
});

it('reprojects a crashed submitting batch as unknown without starting model work', async () => {
  const h = await makeHarness();
  const store = new LodyOperationStore(h.storePath, () => TEST_NOW_MS);
  const input = {
    workspaceId: h.coordinatorOptions.workspaceId,
    sessionId: h.requesterSessionId,
    userId: 'user-1',
    inputId: 'human',
    kind: 'human' as const,
    config: { prompt: 'request' },
  };
  store.inbox.activate(input.workspaceId, 'old');
  store.finish(h.requesterSessionId, 'review-round-1', { type: 'result', value: { items: [] } });
  store.inbox.accept(input);
  store.inbox.begin(input, 'old-exec', 'old');
  const batch = store.inbox.prepare(input, 'old')!;
  store.inbox.fence(batch, 'old-exec');
  h.histories.set(h.requesterSessionId, [
    {
      id: `operation-batch:${batch.batchId}`,
      role: 'system',
      timestamp: '2026-07-20T00:00:00Z',
      items: [
        {
          type: 'operation_completion_batch',
          batchId: batch.batchId,
          memberCount: 1,
          members: [],
          deliveryStatus: 'prepared',
        },
      ],
      fileDiff: [],
      finished: true,
    },
  ]);
  store.close();
  h.coordinator.start();
  try {
    await h.coordinator.idle();
    expect(h.histories.get(h.requesterSessionId)?.[0]?.items?.[0]).toMatchObject({
      deliveryStatus: 'unknown',
    });
    expect(h.histories.get(h.requesterSessionId)).toHaveLength(1);
    expect(h.continueSession).not.toHaveBeenCalled();
    await h.coordinator.wake('duplicate');
    expect(h.histories.get(h.requesterSessionId)).toHaveLength(1);
  } finally {
    await h.coordinator.stop();
  }
});

it('recovers failed native close through the coordinator without resubmitting transport', async () => {
  const harness = await makeHarness();
  harness.coordinator.start();
  await harness.coordinator.idle();
  const bridge = (
    harness.coordinator as unknown as {
      inbox: import('./inbox/legacy').OperationInboxLegacy;
    }
  ).inbox;
  const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
  const input = {
    workspaceId: 'workspace-1',
    sessionId: harness.requesterSessionId,
    userId: 'user-1',
    inputId: 'fresh-human',
    kind: 'human' as const,
    config: { prompt: 'request' },
  };
  store.finish(harness.requesterSessionId, 'review-round-1', {
    type: 'result',
    value: { items: [] },
  });
  await bridge.accept(input);
  const owner = await bridge.openExecution(input, 'execution');
  const batch = owner.batch!;
  expect(batch.memberCount).toBe(1);
  const received: string[] = [];
  await owner.submit(() => received.push(batch.batchId));
  const db = new Database(harness.storePath);
  db.exec(
    "CREATE TRIGGER review_settle_outage BEFORE UPDATE OF state ON inbox_batches WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'settlement outage'); END;"
  );
  await owner.finish('normal');
  await expect(harness.coordinator.stop()).rejects.toThrow('Inbox Scope release failed');
  db.exec('DROP TRIGGER review_settle_outage');
  await harness.coordinator.recoverStop();
  expect(db.prepare('SELECT state FROM inbox_batches WHERE batch_id=?').get(batch.batchId)).toEqual(
    { state: 'settled' }
  );
  expect(received).toEqual([batch.batchId]);
  expect(await bridge.close()).toBeUndefined();
  harness.coordinator.start();
  await harness.coordinator.idle();
  await harness.coordinator.stop();
  db.close();
  store.close();
});

describe('native coordinator failure boundaries', () => {
  it.each([
    'retry',
    'deadline',
    'deadline-interrupt',
    'deadline-mixed-interrupt',
    'progress',
    'progress-interrupt',
    'progress-mixed-interrupt',
  ] as const)(
    'preserves Cause and durable Operation state at the %s boundary',
    async (scenario) => {
      const store = new LodyOperationStore(':memory:', () => TEST_NOW_MS);
      const interrupted = scenario.endsWith('interrupt');
      const cause = interrupted
        ? scenario.includes('mixed')
          ? Cause.combine(Cause.fail(new Error('cleanup failure')), Cause.interrupt(99))
          : Cause.interrupt(99)
        : Cause.combine(
            Cause.fail(new Error('storage failure')),
            Cause.die(new Error('adapter defect'))
          );
      const warnings: unknown[] = [];
      const operation = store.accept({
        workspaceId: 'workspace-1' as WorkspaceId,
        ownerMachineId: 'machine-1' as MachineId,
        requesterSessionId: 'requester-1' as SessionId,
        requesterUserId: 'user-1',
        operationId: 'cause-boundary',
        kind: scenario.startsWith('progress') ? 'session_create' : 'session_chat',
        canonicalCommand: { scenario },
        frozenContinuationConfig: { inputConfig: {} },
        initiatorChainDepth: 0,
        createdAt: new Date(TEST_NOW_MS).toISOString(),
        deadlineAt: new Date(
          TEST_NOW_MS + (scenario.startsWith('deadline') ? 0 : 60000)
        ).toISOString(),
        items: [
          {
            status: 'active',
            target: { sessionId: 'target-1' as SessionId, userTurnId: 'input-1' },
            inputDurable: true,
          },
        ],
      }).operation;
      const activity: CoordinatorActivity['Service'] = {
        wake: () => Effect.void,
        signal: () => Effect.void,
        arm: () => Effect.void,
        cancel: () => Effect.void,
        cancelWhere: () => Effect.void,
        has: () => false,
        drain: Effect.void,
      };
      const ports: CoordinatorPorts['Service'] = {
        active: () => true,
        now: () => TEST_NOW_MS,
        claimToken: 'claim',
        boardCatalog: Effect.succeed({
          read: () => [],
          observe: () => Effect.succeed(Effect.void),
        }),
        boardSessionMetas: Effect.succeed([]),
        observeBoardMetadata: () => Effect.succeed(Effect.void),
        metadata: () => Effect.failCause(cause),
        session: () => Effect.fail(new Error('unexpected history access')),
        execution: () => ({}),
        operation: () => Effect.succeed({ signal: { aborted: false } }),
        cancelInactive: () => Effect.void,
        receipts: Effect.succeed([]),
        wakeInbox: Effect.void,
        confirmReadable: () => Effect.void,
        materialize: () => Effect.void,
        warn: (_message, detail) =>
          Effect.sync(() => {
            warnings.push(detail);
          }),
      };
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const repository = yield* OperationRepository;
              const scope = yield* Effect.scope;
              const core = new CoordinatorWorkflow(
                { workspaceId: operation.workspaceId, machineId: operation.ownerMachineId },
                ports,
                repository,
                activity,
                scope
              );
              const exit = yield* Effect.exit(
                scenario.startsWith('progress')
                  ? core.writeOperationProgress(operation)
                  : core.reconcileOperation(operation)
              );
              const persisted = yield* repository.get(
                operation.requesterSessionId,
                operation.operationId
              );
              if (scenario === 'deadline') {
                expect(Exit.isSuccess(exit)).toBe(true);
                expect(persisted).toMatchObject({
                  state: 'finished',
                  completion: { type: 'error', error: { code: 'COORDINATOR_FAILED' } },
                });
              } else {
                expect(persisted.state).toBe('active');
                if (scenario === 'progress') {
                  expect(Exit.isSuccess(exit)).toBe(true);
                  expect(warnings).toEqual([cause]);
                } else {
                  expect(Exit.isFailure(exit) && exit.cause).toEqual(cause);
                  expect(warnings).toEqual([]);
                }
              }
            }).pipe(Effect.provide(operationRepositoryLayer(store)))
          )
        );
      } finally {
        store.close();
      }
    }
  );
});

it('keeps long completion reports and preserves their conclusion when the Inbox preview is bounded', async () => {
  const conclusion = '结论'.repeat(4_000);
  for (const text of ['结'.repeat(5_000), `${'过程'.repeat(20_000)}${conclusion}`]) {
    const harness = await makeHarness();
    const history = harness.histories.get(harness.targetSessionId)!;
    history[0] = { ...history[0]!, status: 'handled' };
    history.push({
      id: 'assistant:turn-1',
      role: 'assistant',
      userTurnId: 'turn-1',
      timestamp: '2026-07-20T00:00:00.500Z',
      items: [{ type: 'text', text }],
      fileDiff: [],
      finished: true,
    });
    harness.coordinator.start();
    try {
      await harness.coordinator.idle();
      const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
      try {
        const completion = store.get(harness.requesterSessionId, 'review-round-1').completion;
        if (completion?.type !== 'result') throw new Error('expected result');
        const item = completion.value.items[0];
        if (item?.status !== 'succeeded' || !item.output) throw new Error('expected output');
        if (Buffer.byteLength(text, 'utf8') < 32 * 1024) expect(item.output).toEqual({ text });
        else {
          expect(item.output.truncated).toBe(true);
          expect(item.output.text.endsWith(conclusion)).toBe(true);
          expect(Buffer.byteLength(item.output.text, 'utf8')).toBeLessThanOrEqual(32 * 1024);
        }
        expect(queuedResults(store, 'workspace-1' as WorkspaceId)).toHaveLength(1);
      } finally {
        store.close();
      }
    } finally {
      await harness.coordinator.stop();
    }
  }
});

type MaintenanceTurnRequest = {
  sessionId: SessionId;
  stepTurnId: string;
  prompt: string;
  config: { mcpServerIds?: readonly string[] };
  renewBoardInstructions?: boolean;
  freshAgentSession?: boolean;
};

const boardHarness = async () => {
  const { LoroRepo } = await import('loro-repo');
  const { createSessionMirror, normalizeBoardMeta, getWorkspaceFlockDocId, workspaceFlockKeys } =
    await import('@lody/shared');
  const { createLoroSessionData } = await import('@lody/shared/session-data');
  const repo = await LoroRepo.create({});
  const workspaceId = 'board-workspace' as WorkspaceId;
  const machineId = 'board-host' as MachineId;
  const coordinatorId = 'board-coordinator' as SessionId;
  const board = normalizeBoardMeta({
    version: 1,
    id: 'bd_reports',
    name: 'Reports',
    purpose: 'Ship a feature',
    coordinatorSessionId: coordinatorId,
    createdAtMs: TEST_NOW_MS,
    createdByUserId: 'user-1',
  })!;
  const catalog = await repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId));
  catalog.flock.set(workspaceFlockKeys.board(board.id), board);
  let now = TEST_NOW_MS + 1000;
  const store = new LodyOperationStore(':memory:', () => now);
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
  const add = async (name: string, extra: Partial<SessionMeta> = {}) => {
    const id = name as SessionId;
    const doc = createDoc(id);
    docs.set(id, doc);
    await repo.openPersistedDoc(getSessionRoomId(id));
    await repo.upsertDocMeta(getSessionRoomId(id), {
      id,
      workspaceId,
      machineId,
      userId: 'user-1',
      cliType: 'builtin',
      agentType: 'codex',
      title: name,
      boardId: board.id,
      ...extra,
    });
    return doc;
  };
  const input = (
    id: string,
    options: {
      role?: 'user' | 'system';
      depth?: number;
      human?: boolean;
      status?: SessionHistoryInput['status'];
    } = {}
  ): SessionHistoryInput => ({
    id,
    role: options.role ?? 'user',
    timestamp: new Date(now).toISOString(),
    userId: 'user-1',
    inputConfig: {
      cliType: 'builtin',
      agentType: 'codex',
      modelId: 'test-model',
      chainDepth: options.depth ?? 1,
      mcpServerIds: [],
    },
    status: options.status ?? 'handled',
    author: options.human
      ? { v: 1, kind: 'human', userId: 'user-1' }
      : options.role === 'system'
        ? { v: 1, kind: 'system' }
        : {
            v: 1,
            kind: 'agent',
            name: 'Coordinator',
            sessionId: coordinatorId,
            turnId: 'coordinator-input',
          },
    items: [{ type: 'text', text: 'Synthetic task' }],
    fileDiff: [],
  });
  const append = async (id: string, turn: SessionHistoryInput) => {
    await docs
      .get(id as SessionId)!
      .sessionData.commands.appendTurn({ ...turn, fileDiff: turn.fileDiff ?? [] });
  };
  const finish = async (id: string, turnId: string, text = 'Synthetic conclusion') =>
    append(id, {
      id: `${turnId}-answer`,
      role: 'assistant',
      userTurnId: turnId,
      timestamp: new Date(now + 1).toISOString(),
      endedAt: now + 1,
      finished: true,
      items: [{ type: 'text', text }],
      fileDiff: [],
    });
  await add(coordinatorId, { boardRole: 'coordinator' });
  await append(coordinatorId, input('coordinator-input', { depth: 0, human: true }));
  const launches: import('./inbox/model').InboxBatch[] = [];
  const warnings: unknown[] = [];
  let hold = true;
  // Board maintenance: an agent that compacts, a step that holds the Session while it runs.
  const maintenance = {
    runs: [] as MaintenanceTurnRequest[],
    support: true as boolean | undefined,
    compactStatus: 'completed' as 'completed' | 'failed' | 'none',
    usageAfterCompact: 24_000,
    pendingUser: false,
    duringStep: async (_request: MaintenanceTurnRequest) => {},
    afterStep: (_request: MaintenanceTurnRequest) => {},
    outcome: (_request: MaintenanceTurnRequest): string => 'completed',
    active: false,
    held: new Set<SessionId>(),
    /** Maintenance steps and Inbox launches in the order they reached the Session. */
    timeline: [] as string[],
  };
  const coordinator = new LodyOperationCoordinator({
    workspaceId,
    machineId,
    userId: 'user-1',
    now: () => now,
    workerBootId: 'board-worker',
    workspaceDocument: {
      repo,
      getOrCreateSessionDoc: async (id: SessionId) => docs.get(id),
    } as never,
    executionService: {
      getExecutionSnapshot: () => ({ hasActiveTurn: hold || maintenance.active }),
      contextCompactionSupport: () => maintenance.support,
      holdInboxForBoardMaintenance: (id: SessionId, held: boolean) => {
        if (held) maintenance.held.add(id);
        else maintenance.held.delete(id);
      },
      isInboxHeldForBoardMaintenance: (id: SessionId) => maintenance.held.has(id),
      runBoardMaintenanceTurn: async (request: MaintenanceTurnRequest) => {
        maintenance.runs.push(request);
        maintenance.timeline.push(`step:${request.stepTurnId.split(':').at(-1)}`);
        maintenance.active = true;
        try {
          await maintenance.duringStep(request);
          const compact = request.prompt.startsWith('/compact');
          await docs.get(request.sessionId)!.sessionData.commands.appendTurn({
            id: `assistant:${request.stepTurnId}`,
            role: 'assistant',
            userTurnId: request.stepTurnId,
            timestamp: new Date(now).toISOString(),
            endedAt: now,
            finished: true,
            items:
              compact && maintenance.compactStatus !== 'none'
                ? [
                    {
                      type: 'tool_call',
                      toolCallId: `${request.stepTurnId}:marker`,
                      title: 'Compact context',
                      status: maintenance.compactStatus,
                      activityKind: 'context_compaction',
                    },
                  ]
                : [{ type: 'text', text: 'Recorded.' }],
            fileDiff: [],
          });
          if (compact && maintenance.compactStatus === 'completed')
            await repo.upsertDocMeta(getSessionRoomId(request.sessionId), {
              contextWindowUsage: { used: maintenance.usageAfterCompact, size: 1_000_000 },
            });
          await repo.flush();
          return maintenance.outcome(request);
        } finally {
          maintenance.active = false;
          maintenance.afterStep(request);
        }
      },
      continueSession: async (
        _message: unknown,
        options: { inboxBatch: import('./inbox/model').InboxBatch }
      ) => {
        const batch = options.inboxBatch;
        launches.push(batch);
        maintenance.timeline.push('inbox');
        const executionId = `execution:${batch.batchId}`;
        expect(store.inbox.begin(batch, executionId, batch.owner)).toBe(true);
        expect(store.inbox.fence(batch, executionId)).toBe(true);
        store.inbox.settle(batch, 'settled');
        store.inbox.release({ ...batch, executionId, outcome: 'normal' });
      },
    } as never,
    dispatchWatcher: { hasPendingDispatch: () => maintenance.pendingUser } as never,
    storeFactory: () => store,
    storePath: '/unused/board.sqlite3',
    operationStoreWatchFactory: () => ({ close: () => {} }),
    materializeTarget: async () => {},
    logger: { warn: (message: unknown) => warnings.push(message), debug: () => {} } as never,
  });
  const drain = async () => {
    // Repo/Mirror notifications are microtasks; the public barrier joins each owned reconcile.
    await repo.flush();
    await coordinator.wake('test-barrier');
    await coordinator.idle();
  };
  const reports = () =>
    store
      .listForRequester(
        { workspaceId, requesterSessionId: coordinatorId, requesterUserId: 'user-1' },
        { limit: 100 }
      )
      .items.filter((row) => row.kind === 'board_report');
  return {
    repo,
    store,
    coordinator,
    coordinatorId,
    workspaceId,
    machineId,
    board,
    catalog,
    docs,
    input,
    append,
    finish,
    add,
    drain,
    reports,
    launches,
    warnings,
    maintenance,
    advance: (ms: number) => {
      now += ms;
    },
    release: () => {
      hold = false;
    },
    close: async () => {
      await coordinator.stop();
      for (const doc of docs.values()) doc.mirror.dispose();
      await repo.destroy();
    },
  };
};

describe('Board reports through Operation Inbox', () => {
  it.each([false, true])(
    'persists scheduled input provenance and passively reports it (grandchild=%s)',
    async (grandchild) => {
      const h = await boardHarness();
      try {
        await h.add('parent');
        await h.add(
          'scheduled-thread',
          grandchild ? { openedBySessionId: 'parent' as SessionId } : {}
        );
        const turn = h.input('scheduled-work', { human: true });
        turn.inputConfig = { ...turn.inputConfig, _lodyScheduleId: 'schedule-1' };
        await h.append('scheduled-thread', turn);
        h.coordinator.start();
        await h.drain();
        await h.finish('scheduled-thread', 'scheduled-work', 'Scheduled conclusion');
        await h.drain();
        expect(h.reports()).toHaveLength(1);
        const report = h.store.get(h.coordinatorId, h.reports()[0]!.operationId);
        expect(report).toMatchObject({
          frozenContinuationConfig: { deliverWithNextInput: true },
          completion: {
            value: {
              boardReport: {
                events: [
                  {
                    origin: 'schedule',
                    kind: 'finished',
                    output: { text: 'Scheduled conclusion' },
                  },
                ],
              },
            },
          },
        });
        expect(h.launches).toEqual([]);
        await h.drain();
        expect(h.reports()).toHaveLength(1);
        h.advance(10);
        await h.append('scheduled-thread', {
          ...h.input('scheduled-continuation', { role: 'system' }),
          inputConfig: { ...turn.inputConfig, chainDepth: 2 },
        });
        await h.finish('scheduled-thread', 'scheduled-continuation', 'Final scheduled conclusion');
        await h.drain();
        expect(h.reports()).toHaveLength(2);
        expect(
          h
            .reports()
            .map(
              (entry) =>
                h.store.get(h.coordinatorId, entry.operationId).completion?.value.boardReport
                  ?.events[0]?.origin
            )
        ).toEqual(['schedule', 'schedule']);
        expect(h.launches).toEqual([]);
        h.advance(10);
        await h.append('scheduled-thread', h.input('human-followup', { human: true }));
        await h.finish('scheduled-thread', 'human-followup');
        await h.drain();
        expect(h.reports()).toHaveLength(2);
      } finally {
        await h.close();
      }
    }
  );

  it('cleans departed membership cursors while preserving archived members and queued reports', async () => {
    const h = await boardHarness();
    try {
      await h.add('member');
      await h.append('member', h.input('work'));
      await h.finish('member', 'work');
      h.coordinator.start();
      await h.drain();
      expect(h.store.readBoardReportCursor(h.board.id, 'member' as SessionId)).toEqual({
        lastTurnId: 'work',
      });
      await h.repo.upsertDocMeta(getSessionRoomId('member' as SessionId), { isArchived: true });
      await h.drain();
      expect(h.store.readBoardReportCursor(h.board.id, 'member' as SessionId)).toEqual({
        lastTurnId: 'work',
      });
      await h.repo.upsertDocMeta(getSessionRoomId('member' as SessionId), { boardId: undefined });
      await h.drain();
      expect(h.store.readBoardReportCursor(h.board.id, 'member' as SessionId)).toEqual({});
      expect(h.reports()).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('does not report a reviewer completion; reports its parent after system continuation', async () => {
    const h = await boardHarness();
    try {
      await h.add('parent');
      await h.add('reviewer', { parentSessionId: 'parent' as SessionId });
      await h.append('reviewer', h.input('review'));
      h.coordinator.start();
      await h.drain();
      await h.finish('reviewer', 'review', 'Keep the change narrow.');
      await h.drain();
      expect(h.reports()).toEqual([]);
      h.advance(10);
      await h.append('parent', h.input('review-batch', { role: 'system', depth: 4 }));
      await h.finish('parent', 'review-batch', 'Keep the change narrow.');
      await h.drain();
      expect(h.reports()).toHaveLength(1);
      const operation = h.store.get(h.coordinatorId, h.reports()[0]!.operationId);
      expect(operation).toMatchObject({
        kind: 'board_report',
        state: 'finished',
        initiatorChainDepth: 0,
        completion: {
          value: {
            boardReport: {
              events: [
                {
                  sessionId: 'parent',
                  kind: 'finished',
                  output: { text: 'Keep the change narrow.' },
                },
              ],
            },
          },
        },
      });
      expect(h.warnings).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('reports a grandchild waiting once per driving turn, and notices regardless of origin', async () => {
    const h = await boardHarness();
    try {
      await h.add('parent');
      await h.add('reviewer', { parentSessionId: 'parent' as SessionId });
      await h.append('reviewer', h.input('review', { human: true }));
      h.coordinator.start();
      await h.drain();
      await h.repo.upsertDocMeta(getSessionRoomId('reviewer' as SessionId), {
        awaitingUserSince: TEST_NOW_MS + 1002,
      });
      await h.drain();
      expect(h.reports()).toHaveLength(1);
      await h.repo.upsertDocMeta(getSessionRoomId('reviewer' as SessionId), {
        awaitingUserSince: TEST_NOW_MS + 1003,
        agentNotice: { id: 'notice', body: 'Need a choice', at: TEST_NOW_MS + 1003 },
      });
      await h.drain();
      expect(h.reports()).toHaveLength(2);
      expect(
        h.store.readBoardReportCursor(h.board.id, 'reviewer' as SessionId).lastAwaitingSince
      ).toBe(TEST_NOW_MS + 1002);
    } finally {
      await h.close();
    }
  });
});

describe('Board subscription and filtering boundaries', () => {
  it('advances human cursors while disabled; enabling the rule only reports later input', async () => {
    const h = await boardHarness();
    try {
      await h.add('member');
      await h.append('member', h.input('human', { human: true }));
      await h.finish('member', 'human');
      h.coordinator.start();
      await h.drain();
      expect(h.reports()).toEqual([]);
      expect(h.store.readBoardReportCursor(h.board.id, 'member' as SessionId).lastTurnId).toBe(
        'human'
      );
      h.catalog.flock.set(['board', h.board.id], {
        ...h.board,
        rules: { ...h.board.rules, reportHumanTurns: true },
      });
      await h.drain();
      expect(h.reports()).toEqual([]);
      h.advance(10);
      await h.append('member', h.input('new-human', { human: true }));
      await h.finish('member', 'new-human');
      await h.drain();
      expect(h.reports()).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('skips archived members and pre-join states, then observes newly joined members via repo.watch', async () => {
    const h = await boardHarness();
    try {
      await h.add('archived', { isArchived: true });
      await h.append('archived', h.input('archived-turn'));
      await h.finish('archived', 'archived-turn');
      await h.add('old', { boardId: undefined });
      await h.append('old', h.input('old-turn'));
      await h.finish('old', 'old-turn');
      h.coordinator.start();
      await h.drain();
      h.advance(20);
      await h.repo.upsertDocMeta(getSessionRoomId('old' as SessionId), {
        boardId: h.board.id,
        boardJoinedAtMs: TEST_NOW_MS + 1020,
        agentNotice: { id: 'old-notice', body: 'Old information', at: TEST_NOW_MS },
        awaitingUserSince: TEST_NOW_MS + 1002,
      });
      await h.drain();
      expect(h.reports()).toEqual([]);
      await h.append('old', h.input('new-turn'));
      await h.finish('old', 'new-turn');
      await h.drain();
      expect(h.reports()).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it.each(['history', 'local-receipt'] as const)(
    'never turns user Stop into a report (%s evidence)',
    async (evidence) => {
      const h = await boardHarness();
      try {
        await h.add('stopped');
        await h.append(
          'stopped',
          h.input('stopped-turn', { status: evidence === 'history' ? 'canceled' : 'handled' })
        );
        await h.finish('stopped', 'stopped-turn');
        if (evidence === 'local-receipt') {
          const input = {
            workspaceId: h.workspaceId,
            sessionId: 'stopped',
            userId: 'user-1',
            inputId: 'stopped-turn',
            kind: 'task' as const,
            config: {},
          };
          expect(h.store.inbox.accept(input)).toBe(true);
          expect(h.store.inbox.begin(input, 'stopped-execution')).toBe(true);
          expect(h.store.inbox.pause(input, 'stopped-execution')).toBe(true);
          h.store.inbox.release({
            ...input,
            executionId: 'stopped-execution',
            outcome: 'user_stop',
          });
        }
        h.coordinator.start();
        await h.drain();
        expect(h.reports()).toEqual([]);
        expect(h.store.readBoardReportCursor(h.board.id, 'stopped' as SessionId).lastTurnId).toBe(
          'stopped-turn'
        );
      } finally {
        await h.close();
      }
    }
  );

  it('records failures even on human turns and grandchild sessions', async () => {
    const h = await boardHarness();
    try {
      await h.add('parent');
      await h.add('reviewer', { parentSessionId: 'parent' as SessionId });
      await h.append('reviewer', h.input('failed-review', { human: true, status: 'failed' }));
      h.coordinator.start();
      await h.drain();
      expect(h.reports()).toHaveLength(1);
      expect(h.store.get(h.coordinatorId, h.reports()[0]!.operationId).completion).toMatchObject({
        value: { boardReport: { events: [{ kind: 'failed' }] } },
      });
    } finally {
      await h.close();
    }
  });

  it('coalesces streaming Mirror notifications without rereading unrelated members or scanning the repo', async () => {
    const h = await boardHarness();
    const remote = new LoroDoc();
    let remoteMirror: import('@lody/shared').SessionMirror | undefined;
    try {
      const active = await h.add('active');
      const quiet = await h.add('quiet');
      await h.append('active', h.input('stream'));
      await h.append('quiet', h.input('quiet-turn'));
      h.coordinator.start();
      await h.drain();
      const { createSessionMirror } = await import('@lody/shared');
      remote.import(active.loro.export({ mode: 'snapshot' }));
      remoteMirror = createSessionMirror({ doc: remote, initialState: {} });
      const scan = vi.spyOn(h.repo.getMeta(), 'scan');
      const quietRead = vi.spyOn(quiet.sessionData.history, 'readDirectory');
      const activeRead = vi.spyOn(active.sessionData.history, 'readDirectory');
      const coverageRead = vi.spyOn(h.store, 'boardCoveredTargets');
      for (let i = 0; i < 30; i++) {
        remoteMirror.setState((draft) => {
          const last = draft.history.at(-1);
          if (last?.role === 'assistant') last.items = [{ type: 'text', text: `stream ${i}` }];
          else
            draft.history.push({
              id: 'stream-answer',
              role: 'assistant',
              userTurnId: 'stream',
              timestamp: new Date(TEST_NOW_MS + 1001).toISOString(),
              items: [{ type: 'text', text: `stream ${i}` }],
              finished: false,
            });
        });
        active.loro.import(remote.export({ mode: 'update', from: active.loro.version() }));
      }
      await h.drain();
      expect(h.reports()).toEqual([]);
      expect(scan).not.toHaveBeenCalled();
      expect(quietRead).not.toHaveBeenCalled();
      expect(activeRead.mock.calls.length).toBeLessThanOrEqual(2);
      expect(coverageRead).not.toHaveBeenCalled();
      activeRead.mockClear();
      await h.repo.upsertDocMeta(getSessionRoomId(h.coordinatorId), {
        lastMessageAt: TEST_NOW_MS + 1050,
      });
      await h.drain();
      expect(activeRead).not.toHaveBeenCalled();
      expect(quietRead).not.toHaveBeenCalled();
      expect(h.reports()).toEqual([]);
      remoteMirror.setState((draft) => {
        const last = draft.history.at(-1)!;
        last.finished = true;
        last.endedAt = TEST_NOW_MS + 1100;
      });
      active.loro.import(remote.export({ mode: 'update', from: active.loro.version() }));
      await h.drain();
      expect(h.reports()).toHaveLength(1);
    } finally {
      remoteMirror?.dispose();
      remote.free();
      await h.close();
    }
  });
});

describe('Board coordinator admission', () => {
  it('queues Board reports without waking the coordinator, also after a stopped tree resumes', async () => {
    const h = await boardHarness();
    try {
      await h.add('member');
      await h.append('member', h.input('work'));
      await h.finish('member', 'work');
      await h.repo.upsertDocMeta(getSessionRoomId(h.coordinatorId), { collaborationStopped: true });
      h.release();
      h.coordinator.start();
      await h.drain();
      expect(h.reports()).toHaveLength(1);
      expect(h.launches).toEqual([]);
      await h.repo.upsertDocMeta(getSessionRoomId(h.coordinatorId), {
        collaborationStopped: false,
      });
      await h.drain();
      // The coordinator only assigns work: the report waits for the user's next message.
      expect(h.launches).toEqual([]);
      expect(h.store.inbox.hasRunnableWork(h.workspaceId, h.coordinatorId)).toBe(false);
      const human = {
        workspaceId: h.workspaceId,
        sessionId: h.coordinatorId,
        userId: 'user-1',
        kind: 'human' as const,
        inputId: 'next-human',
        config: { chainDepth: 0 },
      };
      h.store.inbox.accept(human);
      expect(h.store.inbox.prepare(human, 'board-worker')).toMatchObject({
        chainDepth: 0,
        memberCount: 1,
      });
    } finally {
      await h.close();
    }
  });

  it('never reaches the chain limit on reports: they wait at depth 15 for a human batch', async () => {
    const h = await boardHarness();
    try {
      await h.append(h.coordinatorId, h.input('last-autonomous', { role: 'system', depth: 15 }));
      await h.add('member');
      await h.append('member', h.input('work'));
      await h.finish('member', 'work');
      h.coordinator.start();
      await h.drain();
      await h.drain();
      expect(h.reports()).toHaveLength(1);
      expect(h.store.inbox.depthLimitedSessions(h.workspaceId)).toEqual([]);
      const notices = h.docs
        .get(h.coordinatorId)!
        .mirror.getState()
        .history.flatMap((turn) => turn.items ?? [])
        .filter((item) => item.type === 'system_notice' && item.name === 'board_chain_limit');
      expect(notices).toEqual([]);
      expect(h.launches).toEqual([]);
      const human = {
        workspaceId: h.workspaceId,
        sessionId: h.coordinatorId,
        userId: 'user-1',
        kind: 'human' as const,
        inputId: 'continue-human',
        config: { chainDepth: 0 },
      };
      h.store.inbox.accept(human);
      const pending = h.store.inbox.prepare(human, 'board-worker');
      expect(pending).toMatchObject({ chainDepth: 0, memberCount: 1 });
    } finally {
      await h.close();
    }
  });

  it('only observes boards whose fixed coordinator belongs to this worker machine', async () => {
    const h = await boardHarness();
    try {
      await h.repo.upsertDocMeta(getSessionRoomId(h.coordinatorId), {
        machineId: 'another-machine',
      });
      await h.add('member');
      await h.append('member', h.input('work'));
      await h.finish('member', 'work');
      h.coordinator.start();
      await h.drain();
      expect(h.reports()).toEqual([]);
    } finally {
      await h.close();
    }
  });
});

it('reconciles the coordinator receipt before Board deduplication and retains that coverage', async () => {
  const h = await boardHarness();
  try {
    await h.add('member');
    await h.append('member', h.input('delegated'));
    await h.finish('member', 'delegated');
    h.store.accept({
      workspaceId: h.workspaceId,
      ownerMachineId: h.machineId,
      requesterSessionId: h.coordinatorId,
      requesterUserId: 'user-1',
      operationId: 'direct-chat',
      kind: 'session_chat',
      canonicalCommand: {},
      frozenContinuationConfig: {
        inputConfig: { chainDepth: 0 },
        sourceTurnId: 'coordinator-input',
      },
      initiatorChainDepth: 0,
      createdAt: new Date(TEST_NOW_MS).toISOString(),
      deadlineAt: new Date(TEST_NOW_MS + 60000).toISOString(),
      items: [
        {
          status: 'active',
          inputDurable: true,
          target: { sessionId: 'member' as SessionId, userTurnId: 'delegated' },
        },
      ],
    });
    h.coordinator.start();
    await h.drain();
    expect(h.store.get(h.coordinatorId, 'direct-chat')).toMatchObject({
      state: 'finished',
      items: [{ status: 'succeeded' }],
    });
    expect(h.reports()).toEqual([]);
    expect(h.store.readBoardReportCursor(h.board.id, 'member' as SessionId).lastTurnId).toBe(
      'delegated'
    );
    await h.drain();
    expect(h.reports()).toEqual([]);
  } finally {
    await h.close();
  }
});

it.each(['cancelled', 'timeout'] as const)(
  'reports a late target after its original Operation was %s',
  async (state) => {
    const h = await boardHarness();
    try {
      await h.add('member');
      await h.append('member', h.input('delegated'));
      const target = { sessionId: 'member' as SessionId, userTurnId: 'delegated' };
      h.store.accept({
        workspaceId: h.workspaceId,
        ownerMachineId: h.machineId,
        requesterSessionId: h.coordinatorId,
        requesterUserId: 'user-1',
        operationId: 'expired-chat',
        kind: 'session_chat',
        canonicalCommand: {},
        frozenContinuationConfig: { inputConfig: {} },
        initiatorChainDepth: 0,
        createdAt: new Date(TEST_NOW_MS).toISOString(),
        deadlineAt: new Date(TEST_NOW_MS + 60000).toISOString(),
        items: [{ status: 'active', inputDurable: true, target }],
      });
      if (state === 'cancelled') h.store.cancel(h.coordinatorId, 'expired-chat');
      else {
        const item = {
          status: 'failed' as const,
          target,
          error: { code: 'TARGET_TIMEOUT', message: 'Timed out', retryable: false },
        };
        h.store.updateItems(h.coordinatorId, 'expired-chat', [item]);
        h.store.finish(h.coordinatorId, 'expired-chat', {
          type: 'result',
          value: { items: [item] },
        });
      }
      h.coordinator.start();
      await h.drain();
      expect(h.reports()).toEqual([]);
      await h.finish('member', 'delegated');
      await h.drain();
      expect(h.reports()).toHaveLength(1);
    } finally {
      await h.close();
    }
  }
);

it('retries a rolled-back Board report on the owned backoff without another metadata event', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const h = await boardHarness();
  try {
    await h.add('member');
    await h.append('member', h.input('work'));
    await h.finish('member', 'work');
    const db = (h.store as unknown as { db: Database.Database }).db;
    db.exec(
      "CREATE TRIGGER reject_board_cursor BEFORE INSERT ON board_report_cursors BEGIN SELECT RAISE(ABORT,'retry cursor'); END;"
    );
    h.coordinator.start();
    await h.drain();
    expect(h.reports()).toEqual([]);
    expect(h.store.readBoardReportCursor(h.board.id, 'member' as SessionId)).toEqual({});
    db.exec('DROP TRIGGER reject_board_cursor');
    await vi.advanceTimersByTimeAsync(1000);
    await h.coordinator.idle();
    expect(h.reports()).toHaveLength(1);
    expect(h.store.readBoardReportCursor(h.board.id, 'member' as SessionId).lastTurnId).toBe(
      'work'
    );
  } finally {
    await h.close();
    vi.useRealTimers();
  }
});

describe('Board coordinator continuity', () => {
  type Harness = Awaited<ReturnType<typeof boardHarness>>;
  const records = (h: Harness) =>
    (h.docs.get(h.coordinatorId)!.readHistorySnapshot() as SessionHistoryInput[]).flatMap(
      (turn) => {
        const record = readBoardMaintenance(turn);
        return record ? [{ id: turn.id, ...record }] : [];
      }
    );
  /** Resolves on the history change that satisfies `check`: an explicit signal, not a poll. */
  const until = (h: Harness, check: () => boolean) =>
    new Promise<void>((resolve) => {
      if (check()) return resolve();
      const off = h.docs.get(h.coordinatorId)!.subscribeAll(() => {
        if (!check()) return;
        off();
        resolve();
      });
    });
  const settled = (h: Harness, status: string, field?: (record: object) => boolean) =>
    until(h, () =>
      records(h).some((record) => record.status === status && (!field || field(record)))
    );
  /** A coordinator that finished a human turn with a large context, idle from now on. */
  const largeIdleCoordinator = async (used = 160_000) => {
    const h = await boardHarness();
    h.release();
    await h.finish(h.coordinatorId, 'coordinator-input');
    await h.repo.upsertDocMeta(getSessionRoomId(h.coordinatorId), {
      contextWindowUsage: { used, size: 1_000_000 },
    });
    return h;
  };
  const steps = (h: Harness) => h.maintenance.runs.map((run) => run.stepTurnId.split(':').at(-1));

  it('waits out the idle period, then records, compacts and renews the Board instructions', async () => {
    const h = await largeIdleCoordinator();
    try {
      h.coordinator.start();
      await h.drain();
      h.advance(9 * 60_000);
      await h.drain();
      expect(h.maintenance.runs).toEqual([]);
      h.advance(60_000 + 1);
      await h.drain();
      await settled(h, 'done', (record) => 'renewed' in record && record.renewed === true);
      await h.drain();
      expect(steps(h)).toEqual(['memory', 'compact', 'renew']);
      expect(h.maintenance.runs[1]!.prompt.startsWith('/compact ')).toBe(true);
      expect(h.maintenance.runs[2]).toMatchObject({ renewBoardInstructions: true });
      expect(h.maintenance.runs[2]!.freshAgentSession).toBeUndefined();
      expect(records(h)).toEqual([
        expect.objectContaining({
          kind: 'compact',
          trigger: 'idle',
          status: 'done',
          usedBefore: 160_000,
          usedAfter: 24_000,
          renewed: true,
        }),
      ]);
      // Nothing happened since: another idle period does not compact again.
      h.advance(60 * 60_000);
      await h.drain();
      expect(h.maintenance.runs).toHaveLength(3);
    } finally {
      await h.close();
    }
  });

  it('leaves a context below the threshold alone', async () => {
    const h = await largeIdleCoordinator(100_000);
    try {
      h.coordinator.start();
      h.advance(60 * 60_000);
      await h.drain();
      expect(h.maintenance.runs).toEqual([]);
      expect(records(h)).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('skips an agent that cannot compact with a log, and never claims success', async () => {
    const h = await largeIdleCoordinator();
    try {
      h.maintenance.support = false;
      h.coordinator.start();
      h.advance(10 * 60_000 + 1);
      await h.drain();
      await h.drain();
      expect(h.maintenance.runs).toEqual([]);
      expect(records(h)).toEqual([]);
      expect(h.warnings).toEqual([
        expect.stringContaining('does not compact its context; idle compaction skipped'),
      ]);
      // Asked for by hand, the same agent gets an honest divider instead.
      await h.append(
        h.coordinatorId,
        boardMaintenanceTurn(
          'manual-1',
          { boardId: h.board.id, kind: 'compact', trigger: 'manual', status: 'requested' },
          new Date(TEST_NOW_MS).toISOString()
        )
      );
      await h.drain();
      await settled(h, 'unsupported');
      expect(h.maintenance.runs).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('skips an agent that compacts in the background, where Lody cannot confirm it', async () => {
    const h = await largeIdleCoordinator();
    try {
      // Kimi advertises compaction, but its `/compact` ends the turn before compacting.
      await h.repo.upsertDocMeta(getSessionRoomId(h.coordinatorId), { agentType: 'kimi' });
      h.coordinator.start();
      h.advance(10 * 60_000 + 1);
      await h.drain();
      await h.drain();
      expect(h.maintenance.runs).toEqual([]);
      expect(records(h)).toEqual([]);
      expect(h.warnings).toEqual([
        expect.stringContaining('compacts in the background, where Lody cannot confirm it'),
      ]);
      // Asked for by hand, it gets the same divider as an agent that cannot compact.
      await h.append(
        h.coordinatorId,
        boardMaintenanceTurn(
          'manual-1',
          { boardId: h.board.id, kind: 'compact', trigger: 'manual', status: 'requested' },
          new Date(TEST_NOW_MS).toISOString()
        )
      );
      await h.drain();
      await settled(h, 'unsupported');
      expect(h.maintenance.runs).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('reports a compaction the agent did not confirm as failed', async () => {
    const h = await largeIdleCoordinator();
    try {
      h.maintenance.compactStatus = 'none';
      h.coordinator.start();
      h.advance(10 * 60_000 + 1);
      await h.drain();
      await settled(h, 'failed');
      expect(steps(h)).toEqual(['memory', 'compact']);
      expect(records(h)).toEqual([
        expect.objectContaining({ status: 'failed', reason: 'compaction-unconfirmed' }),
      ]);
    } finally {
      await h.close();
    }
  });

  it('yields to the user, then renews once the coordinator is free again', async () => {
    const h = await largeIdleCoordinator();
    try {
      // The user speaks while the agent compacts: the renewal waits for their turn.
      h.maintenance.afterStep = (request) => {
        if (request.stepTurnId.endsWith(':compact')) h.maintenance.pendingUser = true;
      };
      h.coordinator.start();
      h.advance(10 * 60_000 + 1);
      await h.drain();
      await settled(h, 'done');
      await h.drain();
      expect(steps(h)).toEqual(['memory', 'compact']);
      expect(records(h)).toEqual([expect.objectContaining({ status: 'done', renewed: false })]);
      h.maintenance.pendingUser = false;
      await h.drain();
      await settled(h, 'done', (record) => 'renewed' in record && record.renewed === true);
      expect(steps(h)).toEqual(['memory', 'compact', 'renew']);
    } finally {
      await h.close();
    }
  });

  it('gives up renewing when the renewal turn itself fails, instead of retrying on every wake', async () => {
    const h = await largeIdleCoordinator();
    try {
      h.maintenance.outcome = (request) =>
        request.stepTurnId.endsWith(':renew') ? 'unhandled-error-recorded' : 'completed';
      h.coordinator.start();
      h.advance(10 * 60_000 + 1);
      await h.drain();
      await settled(h, 'done', (record) => 'reason' in record);
      await h.drain();
      await h.drain();
      expect(steps(h)).toEqual(['memory', 'compact', 'renew']);
      expect(records(h)).toEqual([
        expect.objectContaining({
          status: 'done',
          renewed: false,
          reason: 'renewal-unhandled-error-recorded',
        }),
      ]);
    } finally {
      await h.close();
    }
  });

  it('keeps a renewal pending when another turn takes the Session first', async () => {
    const h = await largeIdleCoordinator();
    try {
      let contended = true;
      h.maintenance.outcome = (request) => {
        if (!request.stepTurnId.endsWith(':renew') || !contended) return 'completed';
        contended = false;
        return 'duplicate';
      };
      h.coordinator.start();
      h.advance(10 * 60_000 + 1);
      await h.drain();
      await settled(h, 'done', (record) => 'renewed' in record && record.renewed === true);
      expect(steps(h)).toEqual(['memory', 'compact', 'renew', 'renew']);
      expect(records(h)).toEqual([expect.not.objectContaining({ reason: expect.anything() })]);
    } finally {
      await h.close();
    }
  });

  it('keeps results from the old agent between the handoff and the new agent', async () => {
    const h = await largeIdleCoordinator(40_000);
    try {
      await h.repo.upsertDocMeta(getSessionRoomId(h.coordinatorId), {
        acpSessionId: 'previous-agent-session',
      });
      // A wakeable result (one accepted before coordinators stopped waking) lands
      // during the handoff, and the user speaks right after it.
      h.maintenance.duringStep = async (request) => {
        if (!request.stepTurnId.endsWith(':handoff')) return;
        h.store.accept({
          workspaceId: h.workspaceId,
          ownerMachineId: h.machineId,
          requesterSessionId: h.coordinatorId,
          requesterUserId: 'user-1',
          operationId: 'legacy-chat',
          kind: 'session_chat',
          canonicalCommand: {},
          frozenContinuationConfig: { inputConfig: { chainDepth: 0 } },
          initiatorChainDepth: 0,
          createdAt: new Date(TEST_NOW_MS).toISOString(),
          deadlineAt: new Date(TEST_NOW_MS + 60000).toISOString(),
          items: [],
        });
        h.store.finish(h.coordinatorId, 'legacy-chat', { type: 'result', value: { items: [] } });
        await h.drain();
      };
      h.maintenance.afterStep = (request) => {
        if (request.stepTurnId.endsWith(':handoff')) h.maintenance.pendingUser = true;
      };
      h.coordinator.start();
      await h.drain();
      await h.append(
        h.coordinatorId,
        boardMaintenanceTurn(
          'switch-1',
          { boardId: h.board.id, kind: 'new_conversation', trigger: 'manual', status: 'requested' },
          new Date(TEST_NOW_MS).toISOString()
        )
      );
      await h.drain();
      await settled(h, 'running', (record) => 'handoff' in record);
      await h.drain();
      // The switch waits for the user; the queued result waits for the switch.
      expect(steps(h)).toEqual(['handoff']);
      expect(h.launches).toEqual([]);
      h.maintenance.pendingUser = false;
      await h.drain();
      await settled(h, 'done');
      await h.drain();
      expect(h.maintenance.timeline).toEqual(['step:handoff', 'step:renew', 'inbox']);
      expect(h.maintenance.runs[1]).toMatchObject({ freshAgentSession: true });
    } finally {
      await h.close();
    }
  });

  it('runs every step, the new agent conversation included, with the recorded MCP selection', async () => {
    const h = await boardHarness();
    try {
      h.release();
      // The user chose a server; a later Inbox turn records no selection of its own.
      await h.append(h.coordinatorId, {
        ...h.input('chosen', { depth: 0, human: true }),
        inputConfig: { cliType: 'builtin', agentType: 'codex', mcpServerIds: ['mcp-board'] },
      });
      await h.finish(h.coordinatorId, 'chosen');
      await h.append(h.coordinatorId, {
        ...h.input('inbox-batch', { role: 'system', depth: 1 }),
        inputConfig: { cliType: 'builtin', agentType: 'codex', chainDepth: 1 },
      });
      await h.finish(h.coordinatorId, 'inbox-batch');
      await h.repo.upsertDocMeta(getSessionRoomId(h.coordinatorId), {
        acpSessionId: 'previous-agent-session',
      });
      h.coordinator.start();
      await h.drain();
      await h.append(
        h.coordinatorId,
        boardMaintenanceTurn(
          'fresh-mcp',
          { boardId: h.board.id, kind: 'new_conversation', trigger: 'manual', status: 'requested' },
          new Date(TEST_NOW_MS).toISOString()
        )
      );
      await h.drain();
      await settled(h, 'done');
      expect(steps(h)).toEqual(['handoff', 'renew']);
      expect(h.maintenance.runs.map((run) => run.config.mcpServerIds)).toEqual([
        ['mcp-board'],
        ['mcp-board'],
      ]);
    } finally {
      await h.close();
    }
  });

  it('starts a new agent conversation in the same Session; reports wait for the user there', async () => {
    const h = await largeIdleCoordinator(40_000);
    try {
      await h.repo.upsertDocMeta(getSessionRoomId(h.coordinatorId), {
        acpSessionId: 'previous-agent-session',
      });
      await h.add('member');
      await h.append('member', h.input('work'));
      // A member finishes while the old agent writes its handoff.
      h.maintenance.duringStep = async (request) => {
        if (!request.stepTurnId.endsWith(':handoff')) return;
        await h.finish('member', 'work', 'Member conclusion');
        await h.drain();
      };
      h.coordinator.start();
      await h.drain();
      await h.append(
        h.coordinatorId,
        boardMaintenanceTurn(
          'fresh-1',
          { boardId: h.board.id, kind: 'new_conversation', trigger: 'manual', status: 'requested' },
          new Date(TEST_NOW_MS).toISOString()
        )
      );
      await h.drain();
      await settled(h, 'done');
      await h.drain();
      expect(steps(h)).toEqual(['handoff', 'renew']);
      expect(h.maintenance.runs[0]!.prompt).toContain('handoff-');
      expect(h.maintenance.runs[1]).toMatchObject({
        sessionId: h.coordinatorId,
        renewBoardInstructions: true,
        freshAgentSession: true,
      });
      expect(h.maintenance.runs[1]!.prompt).toContain('member');
      expect(records(h)).toEqual([
        expect.objectContaining({ kind: 'new_conversation', status: 'done', renewed: true }),
      ]);
      // The Board still names the same coordinator; its report went to that Session
      // and waits for the user's next message instead of waking the new agent.
      expect(h.reports()).toHaveLength(1);
      expect(
        h.store.get(h.coordinatorId, h.reports()[0]!.operationId).frozenContinuationConfig
      ).toMatchObject({ deliverWithNextInput: true });
      expect(h.launches).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
