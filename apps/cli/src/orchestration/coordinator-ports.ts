import type { BoardMeta, BoardDrivingState } from '@lody/shared';
import type {
  LodyOperationItemResult,
  SessionHistoryInput,
  SessionId,
  SessionMeta,
  StoredLodyOperation,
} from '@lody/shared';
import type { HistoryAction, SessionTurnRead } from '@lody/shared/session-data';
import { Context, Effect } from 'effect';
import type { InboxBatch } from './inbox/model';

export type CoordinatorBoardCatalog = {
  read(): BoardMeta[];
  observe(wake: Effect.Effect<void>): Effect.Effect<Effect.Effect<void>, unknown>;
};
export type CoordinatorHistory = {
  readDrivingState: Effect.Effect<BoardDrivingState | undefined, unknown>;
  meta: SessionMeta;
  readTurn(id: string): Effect.Effect<SessionTurnRead, unknown>;
  readTurnOutput(id: string): Effect.Effect<SessionHistoryInput[], unknown>;
  applyHistoryAction(action: HistoryAction): Effect.Effect<unknown, unknown>;
  flushLocalWrites: Effect.Effect<void, unknown>;
  observe(wake: Effect.Effect<void>): Effect.Effect<Effect.Effect<void>, unknown>;
};
export class CoordinatorPorts extends Context.Service<
  CoordinatorPorts,
  {
    boardCatalog: Effect.Effect<CoordinatorBoardCatalog, unknown>;
    boardSessionMetas: Effect.Effect<SessionMeta[], unknown>;
    observeBoardMetadata(
      onChange: (id: SessionId) => Effect.Effect<void>
    ): Effect.Effect<Effect.Effect<void>, unknown>;
    metadata(id: SessionId): Effect.Effect<{ meta: SessionMeta } | undefined, unknown>;
    execution(id: SessionId): { activeTurnId?: string };
    operation(key: string): Effect.Effect<{ signal: { readonly aborted: boolean } }, unknown>;
    cancelInactive(keys: Set<string>): Effect.Effect<void>;
    receipts: Effect.Effect<InboxBatch[], unknown>;
    wakeInbox: Effect.Effect<void, unknown>;
    active(): boolean;
    now(): number;
    claimToken: string;
    session(id: SessionId): Effect.Effect<CoordinatorHistory, unknown>;
    confirmReadable(id: SessionId, reason: string): Effect.Effect<void, unknown>;
    materialize(
      operation: StoredLodyOperation,
      item: Extract<LodyOperationItemResult, { status: 'active' }>,
      index: number
    ): Effect.Effect<void, unknown>;
    warn(message: string, cause?: unknown): Effect.Effect<void>;
  }
>()('lody/orchestration/CoordinatorPorts') {}
