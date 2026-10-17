import {
  deriveBoardReports,
  isBoardGrandchild,
  type BoardId,
  type BoardMeta,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
  type MachineId,
} from '@lody/shared';
import { Cause, Effect, Exit, Scope } from 'effect';
import type { BoardCoordinatorView } from './board-continuity-workflow';
import type { CoordinatorActivity } from './coordinator-activity';
import type {
  CoordinatorPorts,
  CoordinatorHistory,
  CoordinatorBoardCatalog,
} from './coordinator-ports';
import type { OperationRepository } from './operation-repository';

/** Observes state only. Operation Inbox owns every admission, batch and execution. */
export class BoardReportWorkflow {
  private catalog?: CoordinatorBoardCatalog;
  private catalogDirty = true;
  private seeded = false;
  private metadataSubscription?: Effect.Effect<void>;
  private readonly boards = new Map<BoardId, BoardMeta>();
  private readonly members = new Map<SessionId, SessionMeta>();
  private readonly metadataDirty = new Set<SessionId>();
  private readonly dirty = new Set<SessionId>();
  private readonly watched = new Map<
    SessionId,
    { history: CoordinatorHistory; detach: Effect.Effect<void> }
  >();
  private readonly subscriptions = new Set<Effect.Effect<void>>();
  private wakeQueued = false;
  private membershipDirty = true;
  private retries = 0;

  constructor(
    private readonly options: { workspaceId: WorkspaceId; machineId: MachineId },
    private readonly ports: CoordinatorPorts['Service'],
    private readonly operations: OperationRepository['Service'],
    private readonly activity: CoordinatorActivity['Service'],
    private readonly scope: Scope.Scope
  ) {}

  recoverSubscriptions = () =>
    Effect.forEach([...this.subscriptions], (detach) => detach, { discard: true });

  /** This machine's active coordinators with their observed histories. */
  localCoordinators(): BoardCoordinatorView[] {
    const views: BoardCoordinatorView[] = [];
    for (const board of this.boards.values()) {
      const meta = this.members.get(board.coordinatorSessionId);
      const watched = this.watched.get(board.coordinatorSessionId);
      if (
        !meta ||
        !watched ||
        meta.machineId !== this.options.machineId ||
        meta.isArchived ||
        meta.boardId !== board.id ||
        meta.boardRole !== 'coordinator'
      )
        continue;
      views.push({ board, meta, history: watched.history });
    }
    return views;
  }

  /** A Board's members other than its coordinator, as last observed. */
  threads(board: BoardMeta): SessionMeta[] {
    return [...this.members.values()]
      .filter((meta) => meta.boardId === board.id && meta.id !== board.coordinatorSessionId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private signal = Effect.fnUntraced(
    function* (this: BoardReportWorkflow) {
      if (this.wakeQueued) return;
      this.wakeQueued = true;
      yield* this.activity.signal('board-state');
    }.bind(this)
  );

  private own = Effect.fnUntraced(
    function* (this: BoardReportWorkflow, detach: Effect.Effect<void>) {
      this.subscriptions.add(detach);
      yield* Scope.addFinalizer(this.scope, detach);
    }.bind(this)
  );

  private observe = Effect.fnUntraced(
    function* (this: BoardReportWorkflow) {
      if (this.catalog) return;
      const catalog = yield* this.ports.boardCatalog;
      yield* this.own(
        yield* catalog.observe(
          Effect.sync(() => {
            this.catalogDirty = true;
          }).pipe(Effect.andThen(this.signal()))
        )
      );
      this.catalog = catalog;
    }.bind(this)
  );

  private refresh = Effect.fnUntraced(
    function* (this: BoardReportWorkflow) {
      yield* this.observe();
      const catalog = this.catalog;
      if (!catalog) return;
      if (this.catalogDirty) {
        this.membershipDirty = true;
        this.catalogDirty = false;
        this.boards.clear();
        for (const board of catalog.read()) {
          if (board.archivedAtMs === undefined) this.boards.set(board.id, board);
        }
        for (const id of this.members.keys()) this.dirty.add(id);
      }
      if (this.boards.size && !this.metadataSubscription) {
        this.metadataSubscription = yield* this.ports.observeBoardMetadata((id) =>
          Effect.sync(() => {
            this.metadataDirty.add(id);
          }).pipe(Effect.andThen(this.signal()))
        );
        yield* this.own(this.metadataSubscription);
      } else if (!this.boards.size && this.metadataSubscription) {
        yield* this.metadataSubscription;
        this.subscriptions.delete(this.metadataSubscription);
        this.metadataSubscription = undefined;
        this.seeded = false;
        this.members.clear();
        this.metadataDirty.clear();
      }
      if (!this.seeded && this.boards.size) {
        // One startup snapshot, then doc-metadata events maintain membership.
        for (const meta of yield* this.ports.boardSessionMetas) {
          yield* this.operations.retainBoardReportCursors(meta.id, meta.boardId);
          this.members.set(meta.id, meta);
        }
        this.seeded = true;
        for (const id of this.members.keys()) this.dirty.add(id);
      }
      for (const id of [...this.metadataDirty]) {
        this.metadataDirty.delete(id);
        const previous = this.members.get(id);
        const refreshed = yield* Effect.exit(
          this.ports
            .metadata(id)
            .pipe(
              Effect.tap((record) =>
                record && previous?.boardId !== record.meta.boardId
                  ? this.operations.retainBoardReportCursors(id, record.meta.boardId)
                  : Effect.void
              )
            )
        );
        if (Exit.isFailure(refreshed)) {
          this.metadataDirty.add(id);
          yield* Effect.failCause(refreshed.cause);
          return;
        }
        const record = refreshed.value;
        if (
          previous?.boardId !== record?.meta.boardId ||
          previous?.isArchived !== record?.meta.isArchived ||
          previous?.machineId !== record?.meta.machineId ||
          previous?.boardRole !== record?.meta.boardRole ||
          !previous ||
          !record
        )
          this.membershipDirty = true;
        if (record?.meta) this.members.set(id, { ...record.meta, id });
        else this.members.delete(id);
        this.dirty.add(id);
      }
      if (!this.membershipDirty) return;
      const eligible = new Set<SessionId>();
      for (const board of this.boards.values()) {
        const coordinator = this.members.get(board.coordinatorSessionId);
        if (
          !coordinator ||
          coordinator.machineId !== this.options.machineId ||
          coordinator.isArchived ||
          coordinator.boardId !== board.id ||
          coordinator.boardRole !== 'coordinator'
        )
          continue;
        for (const [id, meta] of this.members) {
          if (meta.boardId !== board.id || meta.isArchived) continue;
          eligible.add(id);
          if (this.watched.has(id)) continue;
          const history = yield* this.ports.session(id);
          const detach = yield* history.observe(
            Effect.sync(() => this.dirty.add(id)).pipe(Effect.andThen(this.signal()))
          );
          yield* this.own(detach);
          this.watched.set(id, { history, detach });
          this.dirty.add(id);
        }
      }
      for (const [id, { detach }] of this.watched) {
        if (eligible.has(id)) continue;
        yield* detach;
        this.subscriptions.delete(detach);
        this.watched.delete(id);
        this.dirty.delete(id);
      }
      this.membershipDirty = false;
    }.bind(this)
  );

  private reportMember = Effect.fnUntraced(
    function* (this: BoardReportWorkflow, id: SessionId) {
      const meta = this.members.get(id);
      const board = meta?.boardId ? this.boards.get(meta.boardId) : undefined;
      if (!meta || !board || id === board.coordinatorSessionId) return;
      const member = this.watched.get(id);
      const coordinator = this.watched.get(board.coordinatorSessionId);
      if (!member || !coordinator) return;
      const state = yield* member.history.readDrivingState;
      if (
        state &&
        (yield* this.operations.inputCancellationReason(
          this.options.workspaceId,
          id,
          state.turn.id
        )) === 'user_stop'
      )
        state.turn = { ...state.turn, status: 'canceled', cancellationReason: 'user_stop' };
      const cursor = yield* this.operations.readBoardReportCursor(board.id, id);
      const derived = deriveBoardReports({
        sessionId: id,
        meta,
        state,
        cursor,
        reportHumanTurns: board.rules.reportHumanTurns,
        grandchild: isBoardGrandchild(meta, board, this.members),
      });
      if (
        state &&
        derived.events.some((event) => event.kind === 'finished' || event.kind === 'failed')
      ) {
        const covered = yield* this.operations.boardCoveredTargets(board.coordinatorSessionId);
        if (covered.has(JSON.stringify([id, state.turn.id])))
          derived.events = derived.events.filter(
            (event) => event.kind !== 'finished' && event.kind !== 'failed'
          );
      }
      if (!derived.events.length && JSON.stringify(derived.cursor) === JSON.stringify(cursor))
        return;
      const coordinatorMeta = this.members.get(board.coordinatorSessionId);
      if (!coordinatorMeta) return;
      const driving = yield* coordinator.history.readDrivingState;
      if (!driving) {
        this.dirty.add(id);
        return;
      }
      if (
        this.catalogDirty ||
        this.metadataDirty.has(id) ||
        this.metadataDirty.has(board.coordinatorSessionId)
      ) {
        this.dirty.add(id);
        return;
      }
      if (!this.ports.active()) return;
      yield* this.operations.acceptBoardReport({
        boardId: board.id,
        sessionId: id,
        requesterSessionId: board.coordinatorSessionId,
        workspaceId: this.options.workspaceId,
        ownerMachineId: this.options.machineId,
        requesterUserId: driving.turn.userId ?? coordinatorMeta.userId,
        frozenContinuationConfig: {
          agentConfigId: coordinatorMeta.agentConfigId,
          inputConfig: driving.turn.inputConfig ?? {},
          sourceTurnId: driving.turn.id,
          // The coordinator assigns work; Board events wait for its next input.
          deliverWithNextInput: true,
        },
        events: derived.events,
        cursor: derived.cursor,
      });
    }.bind(this)
  );

  reconcile = Effect.fnUntraced(
    function* (this: BoardReportWorkflow) {
      this.wakeQueued = false;
      const result = yield* Effect.exit(
        Effect.gen(
          function* (this: BoardReportWorkflow) {
            yield* this.refresh();
            for (const id of [...this.dirty]) {
              this.dirty.delete(id);
              const reported = yield* Effect.exit(this.reportMember(id));
              if (Exit.isFailure(reported)) {
                this.dirty.add(id);
                yield* Effect.failCause(reported.cause);
                return;
              }
            }
            yield* this.projectChainLimits();
          }.bind(this)
        )
      );
      if (Exit.isFailure(result)) {
        if (Cause.hasInterrupts(result.cause)) {
          yield* Effect.failCause(result.cause);
          return;
        }
        yield* this.activity.arm(
          'board-retry',
          Math.min(1000 * 2 ** this.retries, 30000),
          'board-retry'
        );
        this.retries = Math.min(this.retries + 1, 5);
        yield* Effect.failCause(result.cause);
        return;
      }
      this.retries = 0;
      yield* this.activity.cancel('board-retry');
    }.bind(this)
  );

  projectChainLimits = Effect.fnUntraced(
    function* (this: BoardReportWorkflow) {
      const sessions = yield* this.operations.boardDepthLimitedSessions(this.options.workspaceId);
      for (const id of sessions) {
        const watched = this.watched.get(id);
        const meta = this.members.get(id);
        if (
          !watched ||
          meta?.boardRole !== 'coordinator' ||
          !meta.boardId ||
          this.boards.get(meta.boardId)?.coordinatorSessionId !== id
        )
          continue;
        const state = yield* watched.history.readDrivingState;
        if (!state) continue;
        const turnId = `board-chain-limit:${id}:${state.turn.id}`;
        if ((yield* watched.history.readTurn(turnId)).state === 'ready') {
          yield* watched.history.flushLocalWrites;
          continue;
        }
        if (!this.ports.active()) return;
        yield* watched.history.applyHistoryAction({
          kind: 'upsert-turn',
          turn: {
            id: turnId,
            role: 'system',
            fileDiff: [],
            timestamp: new Date(this.ports.now()).toISOString(),
            items: [
              {
                type: 'system_notice',
                name: 'board_chain_limit',
                meta: { boardId: meta.boardId, drivingTurnId: state.turn.id },
              },
            ],
          },
        });
        yield* watched.history.flushLocalWrites;
      }
    }.bind(this)
  );
}
