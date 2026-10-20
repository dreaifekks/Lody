import {
  boardMaintenanceStepId,
  boardMaintenanceTurn,
  compactsInBackground,
  decideBoardIdleCompaction,
  isBoardMaintenanceTurnId,
  readBoardMaintenance,
  type BoardMaintenanceKind,
  type BoardMaintenanceMeta,
  type BoardMeta,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type SessionTurnInputConfig,
} from '@lody/shared';
import type { SessionDirectoryScalars } from '@lody/shared/session-data';
import { Cause, Effect, Exit, Scope } from 'effect';
import { randomUUID } from 'node:crypto';
import type { CoordinatorActivity } from './coordinator-activity';
import type {
  CoordinatorBoardMaintenance,
  CoordinatorHistory,
  CoordinatorPorts,
} from './coordinator-ports';

/** Rows read from the end of a coordinator's history per reconcile. */
const TAIL_ROWS = 50;
/** Re-check a coordinator that was busy when its idle time came. */
const BUSY_RECHECK_MS = 30_000;
/** Without a completed compaction marker, a drop this large still proves the context shrank. */
const USAGE_DROP_PROOF = 0.8;

export type BoardCoordinatorView = {
  board: BoardMeta;
  meta: SessionMeta;
  history: CoordinatorHistory;
};

const TIDY_PROMPT = `Lody maintenance. The user does not see this turn. Your context will be compacted next, so record now what later turns must not lose: decisions and their reasons, each thread's latest conclusion, questions waiting for the user, and the user's recent corrections and preferences. Append them to the shared notes with lody_board_notes_append, and keep short Markdown files in the Board memory with MEMORY.md as their index, one line per file. Write only what is not recorded yet. Do not open sessions, do not message anyone and do not address the user; end with one short line.`;

/** Instructions for the agent's own summary; Codex ignores them, the tidy turn covers it. */
const COMPACT_PROMPT = `/compact Keep: the Board goal and rules; every thread's session id, state and latest conclusion; questions waiting for the user; the user's recent corrections and preferences; decisions and their reasons; results not handled yet. Drop: the process of finished threads, raw report JSON and tool output.`;

const RENEW_PROMPT = `Lody maintenance. The user does not see this turn. Your context was just compacted. The current Board instructions follow and replace any earlier version. If your summary lacks something you need, read the Board memory index MEMORY.md. Reply with one short line.`;

const handoffPrompt = (file: string) =>
  `Lody maintenance. The user does not see this turn. The user is starting a new agent conversation for this Board, and you will not see this context again. Write a handoff for your successor into the Board memory as ${file}: the goal and current plan, each thread's session id, state and latest conclusion, decisions and their reasons, questions waiting for the user, the user's preferences, and what to do next. Add a line for it to MEMORY.md. Do not open sessions, do not message anyone and do not address the user; end with one short line.`;

const newConversationPrompt = (input: {
  sessionId: SessionId;
  file: string | undefined;
  threads: readonly SessionMeta[];
  usage: SessionMeta['contextWindowUsage'];
}) => {
  const threads = input.threads
    .slice(0, 50)
    .map(
      (meta) =>
        `- ${meta.title?.trim() || '(untitled)'} — ${meta.id}${meta.isArchived ? ' (archived)' : ''}`
    );
  return [
    'Lody started a new agent conversation for this Board coordinator at the user’s request. The user does not see this turn.',
    `The Lody conversation continues: its earlier turns stay readable with lody_session_history on session ${input.sessionId}.`,
    input.file
      ? `Your predecessor wrote its handoff into the Board memory as ${input.file}. Read MEMORY.md and that file before you act.`
      : 'Read the Board memory index MEMORY.md before you act.',
    input.usage
      ? `The previous agent conversation had used ${input.usage.used} of ${input.usage.size} context tokens.`
      : '',
    threads.length
      ? `Threads of this Board (lody_board_overview has their live status):\n${threads.join('\n')}${input.threads.length > threads.length ? `\n- … ${input.threads.length - threads.length} more` : ''}`
      : 'This Board has no threads yet.',
    'Do not open sessions or message anyone in this turn. Reply with one short line saying you are ready.',
  ]
    .filter(Boolean)
    .join('\n');
};

type TailRow = SessionDirectoryScalars & { position: number };

/**
 * Step outcomes that prove the turn never started: another turn or a rewrite
 * held the Session, or this Worker is stopping. Retrying later is safe.
 */
const CONTENDED = new Set([
  'yielded',
  'inactive',
  'duplicate',
  'rewrite-barrier',
  'claim-contended',
]);

/**
 * After a renewal attempt: renewed, still pending when it never started, or given
 * up with a reason when the turn itself failed, so a failing agent is not retried
 * on every wake.
 */
const renewalRecord = (record: BoardMaintenanceMeta, step: string): BoardMaintenanceMeta =>
  step === 'completed'
    ? { ...record, renewed: true }
    : CONTENDED.has(step)
      ? { ...record, renewed: false }
      : { ...record, renewed: false, reason: `renewal-${step}` };

/** A new conversation whose old agent handed over and whose new agent has not started. */
const isPendingSwitch = (record: BoardMaintenanceMeta): boolean =>
  record.kind === 'new_conversation' && record.status === 'running' && record.handoff !== undefined;

/**
 * Keeps a Board coordinator one continuous conversation. When the coordinator
 * sits idle with a large context it records what matters, has the agent
 * compact its own context, then gives it the current Board instructions again;
 * on the user's request it starts a fresh agent conversation in the same
 * Session. The Session id never changes, so the Inbox, report cursors, notes
 * permission and thread ownership are untouched. Runs are system turns outside
 * the Inbox; this workflow wakes it after each one.
 */
export class BoardContinuityWorkflow {
  private readonly running = new Set<SessionId>();
  private readonly logged = new Set<string>();

  constructor(
    private readonly ports: CoordinatorPorts['Service'],
    private readonly activity: CoordinatorActivity['Service'],
    private readonly scope: Scope.Scope,
    private readonly coordinators: () => readonly BoardCoordinatorView[],
    private readonly threads: (board: BoardMeta) => readonly SessionMeta[]
  ) {}

  /** Whether a maintenance run currently holds this coordinator. */
  isRunning(id: SessionId): boolean {
    return this.running.has(id);
  }

  reconcile = Effect.fnUntraced(
    function* (this: BoardContinuityWorkflow) {
      const maintenance = this.ports.boardMaintenance;
      if (!maintenance) return;
      for (const view of this.coordinators()) {
        if (this.running.has(view.meta.id)) continue;
        const exit = yield* Effect.exit(this.reconcileCoordinator(maintenance, view));
        if (Exit.isFailure(exit)) {
          if (Cause.hasInterrupts(exit.cause)) {
            yield* Effect.failCause(exit.cause);
            return;
          }
          yield* this.ports.warn('[board-continuity] reconcile failed', Cause.squash(exit.cause));
          yield* this.activity.arm(this.key(view.meta.id), BUSY_RECHECK_MS, 'board-continuity');
        }
      }
    }.bind(this)
  );

  private key = (id: SessionId) => `board-continuity:${id}`;

  private logOnce(id: SessionId, reason: string, message: string) {
    const key = `${id}\0${reason}`;
    if (this.logged.has(key)) return Effect.void;
    this.logged.add(key);
    return this.ports.warn(`[board-continuity] ${id}: ${message}`);
  }

  private reconcileCoordinator = Effect.fnUntraced(
    function* (
      this: BoardContinuityWorkflow,
      maintenance: CoordinatorBoardMaintenance,
      { board, history }: BoardCoordinatorView
    ) {
      const fresh = yield* this.ports.metadata(history.meta.id);
      const meta = fresh?.meta ? { ...fresh.meta, id: history.meta.id } : undefined;
      if (!meta || meta.isArchived || meta.boardId !== board.id) return;
      const id = meta.id;
      const rows = yield* history.readTail(TAIL_ROWS);
      const dividers: { row: TailRow; record: BoardMaintenanceMeta }[] = [];
      for (const row of rows) {
        if (row.role !== 'system' || !isBoardMaintenanceTurnId(row.id)) continue;
        const read = yield* history.readTurn(row.id);
        const record =
          read.state === 'ready'
            ? readBoardMaintenance(read.turn as SessionHistoryInput)
            : undefined;
        if (record) dividers.push({ row, record });
      }
      const requests = dividers.filter(({ record }) => record.status === 'requested');
      const request = requests.at(-1);
      const last = dividers.at(-1);
      let activity: TailRow | undefined;
      for (let index = rows.length - 1; index >= 0 && !activity; index--) {
        const row = rows[index]!;
        if (
          !isBoardMaintenanceTurnId(row.id) &&
          !(row.role === 'assistant' && isBoardMaintenanceTurnId(row.userTurnId))
        )
          activity = row;
      }
      const activitySinceMaintenance = !last || (activity?.position ?? -1) > last.row.position;
      // Once the old agent handed over, queued results wait for the new one.
      let switching: (typeof dividers)[number] | undefined;
      for (const divider of dividers) if (isPendingSwitch(divider.record)) switching = divider;

      if (maintenance.busy(id) || (!switching && maintenance.inbox(id).runnable)) {
        // Releasing a turn need not change history: look again shortly.
        if (request || activitySinceMaintenance || last?.record.status === 'running')
          yield* this.activity.arm(this.key(id), BUSY_RECHECK_MS, 'board-continuity');
        return;
      }
      // The coordinator is free and this Worker runs nothing for it: a run left
      // `running` was cut short by a restart, unless it only waits to switch.
      for (const { row, record } of dividers)
        if (record.status === 'running' && record !== switching?.record)
          yield* this.writeDivider(history, row.id, { ...record, status: 'interrupted' }, row);
      if (switching) {
        if (meta.collaborationStopped === true) return;
        yield* this.start(maintenance, board, meta, history, {
          runId: switching.row.id.slice('board-maintenance:'.length),
          kind: 'new_conversation',
          trigger: switching.record.trigger,
          row: switching.row,
          record: switching.record,
        });
        return;
      }
      for (const stale of requests.slice(0, -1))
        yield* this.writeDivider(
          history,
          stale.row.id,
          { ...stale.record, status: 'interrupted', reason: 'superseded' },
          stale.row
        );
      const held = maintenance.inbox(id).paused || meta.collaborationStopped === true;
      if (request) {
        // Stop and a stopped tree hold the request until the user speaks again.
        if (held) return;
        yield* this.start(maintenance, board, meta, history, {
          runId: request.row.id.slice('board-maintenance:'.length),
          kind: request.record.kind,
          trigger: 'manual',
          row: request.row,
        });
        return;
      }
      if (
        last &&
        last.record.kind === 'compact' &&
        last.record.status === 'done' &&
        last.record.renewed === false &&
        last.record.reason === undefined &&
        !held
      ) {
        yield* this.startRenewal(maintenance, board, meta, history, last.row, last.record);
        return;
      }
      if (!activitySinceMaintenance || held || !activity) return;
      const decision = decideBoardIdleCompaction({
        settings: board.continuity,
        usage: meta.contextWindowUsage,
        // Passive reports pile up while the coordinator is idle and arrive with the next input.
        pendingTokens: maintenance.pendingTokens(id, meta.userId),
        idleSinceMs:
          activity.role === 'assistant' && typeof activity.endedAt === 'number'
            ? activity.endedAt
            : Date.parse(activity.timestamp),
        nowMs: this.ports.now(),
      });
      if (decision.kind === 'none') {
        yield* this.activity.cancel(this.key(id));
        return;
      }
      if (decision.kind === 'wait') {
        yield* this.activity.arm(this.key(id), decision.delayMs, 'board-idle');
        return;
      }
      if (compactsInBackground(meta.agentType)) {
        yield* this.logOnce(
          id,
          `background:${meta.agentType}`,
          'the coordinator agent compacts in the background, where Lody cannot confirm it; idle compaction skipped'
        );
        return;
      }
      const support = yield* maintenance.compactionSupport(id, meta);
      if (support !== true) {
        yield* this.logOnce(
          id,
          `support:${String(support)}:${meta.acpSessionId ?? ''}`,
          support === false
            ? 'the coordinator agent does not compact its context; idle compaction skipped'
            : 'no running agent reports context compaction; idle compaction skipped'
        );
        return;
      }
      yield* this.start(maintenance, board, meta, history, {
        runId: randomUUID(),
        kind: 'compact',
        trigger: 'idle',
      });
    }.bind(this)
  );

  private writeDivider = Effect.fnUntraced(
    function* (
      this: BoardContinuityWorkflow,
      history: CoordinatorHistory,
      turnId: string,
      record: BoardMaintenanceMeta,
      at?: Pick<TailRow, 'timestamp'>
    ) {
      if (!this.ports.active()) return;
      const runId = turnId.slice('board-maintenance:'.length);
      const turn = boardMaintenanceTurn(
        runId,
        record,
        at?.timestamp ?? new Date(this.ports.now()).toISOString()
      );
      yield* history.applyHistoryAction({ kind: 'upsert-turn', turn });
      yield* history.flushLocalWrites;
    }.bind(this)
  );

  private fork(id: SessionId, run: Effect.Effect<void, unknown>) {
    this.running.add(id);
    return run.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.void
          : this.ports.warn('[board-continuity] maintenance failed', Cause.squash(cause))
      ),
      Effect.ensuring(
        Effect.sync(() => this.running.delete(id)).pipe(
          Effect.andThen(this.activity.signal('board-continuity'))
        )
      ),
      Effect.forkIn(this.scope),
      Effect.asVoid
    );
  }

  private start(
    maintenance: CoordinatorBoardMaintenance,
    board: BoardMeta,
    meta: SessionMeta,
    history: CoordinatorHistory,
    run: {
      runId: string;
      kind: BoardMaintenanceKind;
      trigger: 'idle' | 'manual';
      row?: Pick<TailRow, 'timestamp'>;
      /** A pending switch resumes from its stored record. */
      record?: BoardMaintenanceMeta;
    }
  ) {
    return this.fork(
      meta.id,
      run.kind === 'compact'
        ? this.compact(maintenance, board, meta, history, run)
        : this.newConversation(maintenance, board, meta, history, run)
    );
  }

  private startRenewal(
    maintenance: CoordinatorBoardMaintenance,
    board: BoardMeta,
    meta: SessionMeta,
    history: CoordinatorHistory,
    row: TailRow,
    record: BoardMaintenanceMeta
  ) {
    const runId = row.id.slice('board-maintenance:'.length);
    return this.fork(
      meta.id,
      Effect.gen({ self: this }, function* () {
        const step = yield* this.step(maintenance, meta, history, runId, 'renew', RENEW_PROMPT, {
          renewBoardInstructions: true,
        });
        yield* this.writeDivider(history, row.id, renewalRecord(record, step), row);
      })
    );
  }

  /** One maintenance turn with the coordinator's own run configuration. */
  private step = Effect.fnUntraced(
    function* (
      this: BoardContinuityWorkflow,
      maintenance: CoordinatorBoardMaintenance,
      meta: SessionMeta,
      history: CoordinatorHistory,
      runId: string,
      name: 'memory' | 'compact' | 'renew' | 'handoff',
      prompt: string,
      options: {
        renewBoardInstructions?: boolean;
        freshAgentSession?: boolean;
        /** False once the old agent handed over: results then go to the new one. */
        yieldToInbox?: boolean;
      } = {}
    ) {
      // The user's next turn and Inbox results go first; the next idle period retries.
      if (
        maintenance.busy(meta.id) ||
        (options.yieldToInbox !== false && maintenance.inbox(meta.id).runnable)
      )
        return 'yielded';
      if (!this.ports.active()) return 'inactive';
      const driving = yield* history.readDrivingState;
      const config: SessionTurnInputConfig = driving?.turn.inputConfig ?? {};
      return yield* maintenance.runTurn({
        sessionId: meta.id,
        stepTurnId: boardMaintenanceStepId(runId, name),
        prompt,
        config,
        userId: driving?.turn.userId ?? meta.userId,
        ...(options.renewBoardInstructions ? { renewBoardInstructions: true } : {}),
        ...(options.freshAgentSession ? { freshAgentSession: true } : {}),
      });
    }.bind(this)
  );

  private compact(
    maintenance: CoordinatorBoardMaintenance,
    board: BoardMeta,
    meta: SessionMeta,
    history: CoordinatorHistory,
    run: { runId: string; trigger: 'idle' | 'manual'; row?: Pick<TailRow, 'timestamp'> }
  ) {
    return Effect.gen({ self: this }, function* () {
      const turnId = `board-maintenance:${run.runId}`;
      const before = meta.contextWindowUsage?.used;
      const record: BoardMaintenanceMeta = {
        boardId: board.id,
        kind: 'compact',
        trigger: run.trigger,
        status: 'running',
        ...(before !== undefined ? { usedBefore: before } : {}),
      };
      const write = (next: BoardMaintenanceMeta) =>
        this.writeDivider(history, turnId, next, run.row);
      // An agent known not to compact, or whose compaction Lody cannot confirm,
      // is told before any turn runs.
      if (
        compactsInBackground(meta.agentType) ||
        (yield* maintenance.compactionSupport(meta.id, meta)) === false
      ) {
        yield* write({ ...record, status: 'unsupported' });
        return;
      }
      yield* write(record);
      const tidy = yield* this.step(maintenance, meta, history, run.runId, 'memory', TIDY_PROMPT);
      if (tidy !== 'completed') {
        yield* write({ ...record, status: 'interrupted', reason: tidy });
        return;
      }
      // The tidy turn started the agent, so its capability is now known.
      if ((yield* maintenance.compactionSupport(meta.id, meta)) !== true) {
        yield* write({ ...record, status: 'unsupported' });
        return;
      }
      const compacted = yield* this.step(
        maintenance,
        meta,
        history,
        run.runId,
        'compact',
        COMPACT_PROMPT
      );
      if (compacted !== 'completed') {
        yield* write({ ...record, status: 'interrupted', reason: compacted });
        return;
      }
      const marker = yield* this.compactionOutcome(
        history,
        `assistant:${boardMaintenanceStepId(run.runId, 'compact')}`
      );
      const after = (yield* this.ports.metadata(meta.id))?.meta.contextWindowUsage?.used;
      const shrank =
        before !== undefined && after !== undefined && after < before * USAGE_DROP_PROOF;
      if (marker !== 'completed' && !shrank) {
        yield* write({
          ...record,
          status: 'failed',
          reason: marker === 'failed' ? 'compaction-failed' : 'compaction-unconfirmed',
        });
        return;
      }
      // A reading the agent has not refreshed yet would show "X → X": leave it out.
      const done: BoardMaintenanceMeta = {
        ...record,
        status: 'done',
        ...(after !== undefined && (before === undefined || after < before)
          ? { usedAfter: after }
          : {}),
        renewed: false,
      };
      yield* write(done);
      const renewed = yield* this.step(
        maintenance,
        meta,
        history,
        run.runId,
        'renew',
        RENEW_PROMPT,
        { renewBoardInstructions: true }
      );
      // Not renewed yet: the next reconcile retries once the coordinator is free.
      yield* write(renewalRecord(done, renewed));
    });
  }

  private newConversation(
    maintenance: CoordinatorBoardMaintenance,
    board: BoardMeta,
    meta: SessionMeta,
    history: CoordinatorHistory,
    run: {
      runId: string;
      trigger: 'idle' | 'manual';
      row?: Pick<TailRow, 'timestamp'>;
      record?: BoardMaintenanceMeta;
    }
  ) {
    const turnId = `board-maintenance:${run.runId}`;
    const usage = meta.contextWindowUsage;
    // From the handoff until the new agent's first turn, results wait for the new agent.
    let pending = false;
    return Effect.gen({ self: this }, function* () {
      const write = (next: BoardMaintenanceMeta) =>
        this.writeDivider(history, turnId, next, run.row);
      let record: BoardMaintenanceMeta = run.record ?? {
        boardId: board.id,
        kind: 'new_conversation',
        trigger: run.trigger,
        status: 'running',
        ...(usage ? { usedBefore: usage.used } : {}),
      };
      maintenance.holdInbox(meta.id, true);
      if (record.handoff === undefined) {
        yield* write(record);
        // Only an agent that has a conversation can hand it over.
        if (meta.acpSessionId) {
          const stamp = new Date(this.ports.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-');
          const file = `handoff-${stamp}.md`;
          const handoff = yield* this.step(
            maintenance,
            meta,
            history,
            run.runId,
            'handoff',
            handoffPrompt(file)
          );
          if (handoff !== 'completed') {
            yield* write({ ...record, status: 'interrupted', reason: handoff });
            return;
          }
          record = { ...record, handoff: file };
        } else record = { ...record, handoff: 'none' };
        yield* write(record);
      }
      const started = yield* this.step(
        maintenance,
        meta,
        history,
        run.runId,
        'renew',
        newConversationPrompt({
          sessionId: meta.id,
          file: record.handoff === 'none' ? undefined : record.handoff,
          threads: this.threads(board),
          usage,
        }),
        { renewBoardInstructions: true, freshAgentSession: true, yieldToInbox: false }
      );
      if (CONTENDED.has(started)) {
        // The user's turn went first; the switch resumes when the coordinator is free.
        pending = true;
        return;
      }
      if (started !== 'completed') {
        yield* write({
          ...record,
          status: started === 'cancelled' ? 'interrupted' : 'failed',
          reason: started,
        });
        return;
      }
      const after = (yield* this.ports.metadata(meta.id))?.meta.contextWindowUsage?.used;
      yield* write({
        ...record,
        status: 'done',
        renewed: true,
        ...(after !== undefined ? { usedAfter: after } : {}),
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (!pending) maintenance.holdInbox(meta.id, false);
        })
      )
    );
  }

  /** The compaction marker the adapter left on the compact step's assistant entry. */
  private compactionOutcome = Effect.fnUntraced(function* (
    history: CoordinatorHistory,
    entryId: string
  ) {
    const read = yield* history.readTurn(entryId);
    if (read.state !== 'ready') return 'missing' as const;
    const items = (read.turn as SessionHistoryInput).items ?? [];
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      if (item?.type === 'tool_call' && item.activityKind === 'context_compaction')
        return item.status === 'completed' ? ('completed' as const) : ('failed' as const);
    }
    return 'missing' as const;
  });
}
