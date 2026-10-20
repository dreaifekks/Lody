import type { BoardMeta, BoardDrivingState } from '@lody/shared';
import type {
  LodyOperationItemResult,
  SessionHistoryInput,
  SessionId,
  SessionMeta,
  SessionTurnInputConfig,
  StoredLodyOperation,
} from '@lody/shared';
import type {
  HistoryAction,
  SessionDirectoryScalars,
  SessionTurnRead,
} from '@lody/shared/session-data';
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
  /** The last `limit` rows' scalars, oldest first, with their positions. */
  readTail(
    limit: number
  ): Effect.Effect<Array<SessionDirectoryScalars & { position: number }>, unknown>;
  applyHistoryAction(action: HistoryAction): Effect.Effect<unknown, unknown>;
  flushLocalWrites: Effect.Effect<void, unknown>;
  observe(wake: Effect.Effect<void>): Effect.Effect<Effect.Effect<void>, unknown>;
};
/** What Board maintenance needs from the Session runtime on the coordinator's machine. */
export type CoordinatorBoardMaintenance = {
  /** A running turn or a user turn waiting to start: maintenance yields to both. */
  busy(id: SessionId): boolean;
  /** `runnable`: the Inbox holds work to run; `paused`: the user pressed Stop. */
  inbox(id: SessionId): { runnable: boolean; paused: boolean };
  /** Estimated tokens of the waiting Inbox results the user's next input will carry. */
  pendingTokens(id: SessionId, userId: string): number;
  /**
   * Whether the coordinator's agent compacts on `/compact`: the running agent's
   * capability, else its cached commands; undefined when neither says.
   */
  compactionSupport(id: SessionId, meta: SessionMeta): Effect.Effect<boolean | undefined, unknown>;
  /** Keep Inbox batches away while the coordinator switches to a new agent. */
  holdInbox(id: SessionId, held: boolean): void;
  runTurn(request: {
    sessionId: SessionId;
    stepTurnId: string;
    prompt: string;
    config: SessionTurnInputConfig;
    userId: string;
    renewBoardInstructions?: boolean;
    freshAgentSession?: boolean;
  }): Effect.Effect<string, unknown>;
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
    /** Absent where no Session runtime executes turns. */
    boardMaintenance?: CoordinatorBoardMaintenance;
  }
>()('lody/orchestration/CoordinatorPorts') {}
