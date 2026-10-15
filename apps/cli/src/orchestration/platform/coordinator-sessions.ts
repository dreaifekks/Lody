import { listAliveSessionMetas } from '@/lib/command-runtime';
import {
  getWorkspaceFlockDocId,
  getSessionIdFromRoomId,
  normalizeBoardMeta,
  readLatestDrivingTurn,
  type SessionHistoryInput,
  type SessionTurnInputConfig,
} from '@lody/shared';
import { subscribeSessionChanges } from '@/lib/loro/doc';
import { createSessionBackend } from '@/session/session-backend';
import {
  getServerNow,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { Effect, Layer } from 'effect';
import { CoordinatorPorts, type CoordinatorHistory } from '../coordinator-ports';
import type { OperationInboxLegacy } from '../inbox/legacy';
import type { LodyOperationCoordinatorOptions } from '../operation-coordinator';
import type { LodyOperationStore } from '../operation-store';

/** Named upstream adapter: Session/history/materialization are not yet native dependencies. */
export const coordinatorSessionsLayer = (
  options: LodyOperationCoordinatorOptions,
  store: LodyOperationStore,
  inbox: OperationInboxLegacy,
  active: () => boolean,
  runSignal: (effect: Effect.Effect<void>) => void,
  controllers: Map<string, AbortController>,
  rawWork: Set<Promise<unknown>>,
  claimToken: string
) => {
  const io = <A>(f: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({
      try: (signal) => {
        const raw = f(signal);
        rawWork.add(raw);
        void raw.finally(() => rawWork.delete(raw)).catch(() => undefined);
        return raw;
      },
      catch: (cause) => cause,
    });
  const metadata = (id: SessionId) =>
    io(async () => {
      const record = await options.workspaceDocument.repo.getDocMeta(getSessionRoomId(id));
      return record?.meta && !isLoroRepoDocDeleted(record)
        ? { meta: record.meta as SessionMeta }
        : undefined;
    });
  return Layer.succeed(CoordinatorPorts, {
    boardCatalog: io(async () => {
      const catalog = await options.workspaceDocument.repo.openFlockDoc(
        getWorkspaceFlockDocId(options.workspaceId)
      );
      return {
        read: () =>
          catalog.flock.scan({ prefix: ['board'] }).flatMap((row) => {
            const board = normalizeBoardMeta(row.value);
            return board ? [board] : [];
          }),
        observe: (wake: Effect.Effect<void>) =>
          Effect.sync(() => {
            const detach = catalog.flock.subscribe((batch) => {
              if (batch.events.some((event) => event.key[0] === 'board')) runSignal(wake);
            });
            return Effect.sync(detach);
          }),
      };
    }),
    boardSessionMetas: io(async () =>
      (await listAliveSessionMetas(options.workspaceDocument)).map(({ meta }) => meta)
    ),
    observeBoardMetadata: (onChange) =>
      Effect.sync(() => {
        const watch = options.workspaceDocument.repo.watch(
          (event) => {
            if (event.kind !== 'doc-metadata' && event.kind !== 'doc-existence-changed') return;
            const id = getSessionIdFromRoomId(event.docId);
            if (id) runSignal(onChange(id));
          },
          {
            kinds: ['doc-metadata', 'doc-existence-changed'],
            metadataFields: [
              'boardId',
              'boardRole',
              'boardGeneration',
              'boardJoinedAtMs',
              'isArchived',
              'machineId',
              'awaitingUserSince',
              'agentNotice',
              'lastMessageAt',
              'collaborationStopped',
            ],
          }
        );
        return Effect.sync(() => watch.unsubscribe());
      }),
    active,
    now: options.now ?? getServerNow,
    claimToken,
    metadata,
    execution: (id) => options.executionService.getExecutionSnapshot(id),
    operation: (key) =>
      Effect.sync(() => {
        const controller = controllers.get(key) ?? new AbortController();
        controllers.set(key, controller);
        return { signal: controller.signal };
      }),
    cancelInactive: (keys) =>
      Effect.sync(() => {
        for (const [key, controller] of controllers)
          if (!keys.has(key)) {
            controller.abort();
            controllers.delete(key);
          }
      }),
    receipts: Effect.try({
      try: () => store.inbox.historyReceipts(options.workspaceId),
      catch: (cause) => cause,
    }),
    wakeInbox: io(() => inbox.wake()),
    session: (id) =>
      io(async () => {
        const record = await options.workspaceDocument.repo.getDocMeta(getSessionRoomId(id));
        if (!record?.meta || isLoroRepoDocDeleted(record))
          throw new Error('Session state unavailable');
        const doc = await options.workspaceDocument.getOrCreateSessionDoc(id);
        const backend = await createSessionBackend(doc, record.meta as SessionMeta);
        return {
          meta: record.meta as SessionMeta,
          readDrivingState: io(async () => {
            const count = await backend.readHistoryCount();
            const directory = await backend.readHistoryDirectory(0, count);
            const row = readLatestDrivingTurn(
              directory.flatMap((entry) =>
                entry.scalars
                  ? [
                      {
                        ...entry.scalars,
                        position: entry.position,
                        get inputConfig() {
                          return entry.inputConfig as SessionTurnInputConfig | undefined;
                        },
                      },
                    ]
                  : []
              )
            );
            if (!row) return undefined;
            const driving = await backend.readTurn(row.id);
            if (driving.state !== 'ready') return undefined;
            const following = await backend.history.readRange(row.position + 1, count);
            return {
              turn: driving.turn as SessionHistoryInput,
              following: following.flatMap((entry) =>
                entry.state === 'ready' ? [entry.turn as SessionHistoryInput] : []
              ),
            };
          }),
          readTurn: (turn) => io(() => backend.readTurn(turn)),
          readTurnOutput: (turn) => io(() => backend.readTurnOutput(turn)),
          applyHistoryAction: (action) => io(() => backend.applyHistoryAction(action)),
          flushLocalWrites: io(() => backend.flushLocalWrites()),
          observe: (wake) =>
            Effect.sync(() => {
              const detach = subscribeSessionChanges(doc, () => runSignal(wake), backend);
              let closed = false;
              return Effect.sync(() => {
                if (!closed) {
                  detach();
                  closed = true;
                }
              });
            }),
        } satisfies CoordinatorHistory;
      }),
    confirmReadable: (id, reason) =>
      io(() =>
        options.confirmTargetReadable
          ? options.confirmTargetReadable(getSessionRoomId(id), reason)
          : options.workspaceDocument.syncRemoteDocOrThrow(getSessionRoomId(id), { reason })
      ),
    materialize: (operation, item, index) =>
      io(() => {
        const key = operation.requesterSessionId + '\0' + operation.operationId;
        const controller = controllers.get(key);
        if (!controller) throw new Error('Operation materialization has no resource owner');
        if (!active() || controller.signal.aborted) return Promise.resolve();
        return options.materializeTarget(operation, item, index, controller.signal);
      }),
    warn: (message, cause) =>
      Effect.sync(() =>
        options.logger.warn(`${message}${cause === undefined ? '' : `: ${String(cause)}`}`)
      ),
  });
};
