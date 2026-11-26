import type { ContentBlock } from '@agentclientprotocol/sdk';
import {
  LODY_MAX_CHAIN_DEPTH,
  resolveSessionExecutionInputBlocks,
  type ACPSessionId,
  type AcpSessionNotification,
  type BoardMeta,
  type SessionContextWindowUsage,
  type SessionHistoryInput,
  type SessionId,
  type SessionInputBlock,
  type SessionMeta,
  type SessionTurnInputConfig,
} from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@/utils/logger';
import { buildBoardScopeInstructions } from './session-execution-helpers';

/** Minimum baseline context usage (tokens) before a drop counts as auto-compaction. */
export const BOARD_COMPACT_USAGE_DROP_MIN_BASELINE = 40_000;
/** Post-turn usage must fall to at most this fraction of the turn baseline. */
export const BOARD_COMPACT_USAGE_DROP_MAX_AFTER_RATIO = 0.65;
/** Minimum absolute token drop required to treat a usage decrease as compaction. */
export const BOARD_COMPACT_USAGE_DROP_MIN_DELTA = 20_000;
/** Same shrinkage ratio `BoardContinuityWorkflow` accepts as proof of `:compact`. */
const MAINTENANCE_COMPACT_USAGE_DROP_RATIO = 0.8;

const EXPLICIT_COMPACT_COMMAND_RE = /^\/compact(?:\s|$)/;
const BARE_COMPACT_COMMAND_RE = /^\/compact$/;
/**
 * Default preservation focus appended only when forwarding a pure bare `/compact`
 * (no trailing instructions, no non-text attachments) to ACP so runtimes like
 * Antigravity (`agy`) run synchronous compaction with a brief confirmation instead
 * of appearing hung with zero visible output.
 */
export const BARE_COMPACT_DEFAULT_INSTRUCTIONS =
  'Keep: hard constraints, confirmed invariants/baselines that must not regress, role boundaries, key decisions, and current next steps. Reply with one short confirmation line once compaction completes.';
/** Brief visible status line written when an explicit `/compact` finishes cleanly with zero visible text. */
export const EXPLICIT_COMPACT_VISIBLE_FALLBACK_TEXT = 'Context compaction completed.';
/**
 * Matches slash commands including namespaced commands like `/mcp:github:prompt`
 * or `/plugin.cmd`, while rejecting multi-segment filesystem paths like `/home/user/file`.
 */
const SLASH_COMMAND_INPUT_RE = /^\/[a-zA-Z0-9_.:-]+(?:\s|$)/;
/** Fixed first line emitted by `buildBoardCompactReminder`, used to identify Lody-generated blocks. */
export const BOARD_CONTEXT_REMINDER_HEADER =
  'Context was recently compacted or reconstructed. The current Board role, boundaries, and rules below are authoritative and override any earlier summary.';
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BOARD_CONTEXT_REMINDER_BLOCK_RE = new RegExp(
  `(?:\\r?\\n)*[ \\t]*<board_context_reminder>\\r?\\n${escapeRegExp(BOARD_CONTEXT_REMINDER_HEADER)}[\\s\\S]*?<\\/board_context_reminder>[ \\t]*(?:\\r?\\n)*`,
  'g'
);
const MARKER_FILE_VERSION = 1;
const MAX_OPEN_COMPACTION_IDS_PER_SESSION = 16;

export type BoardCompactPromptContext = {
  board: BoardMeta;
  role?: SessionMeta['boardRole'];
  /** The Board directory, when this machine keeps it. */
  directory?: string;
};

export type BoardCompactContextLoadResult = {
  context?: BoardCompactPromptContext;
};

export type BoardCompactReinjectStore = {
  has(sessionId: SessionId): Promise<boolean>;
  mark(sessionId: SessionId): Promise<void>;
  clear(sessionId: SessionId): Promise<void>;
};

export type BoardCompactionReason = 'explicit_compact' | 'acp_marker' | 'usage_drop';

export type BoardTurnUsageSnapshot = {
  turnId: string;
  peakUsed?: number;
  lastObservedUsed?: number;
  detectedUsageDrop: boolean;
  detectedCompactionMarker: boolean;
};

type ActiveTurnUsageObservation = BoardTurnUsageSnapshot;

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isFiniteNonNegative = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const hasCompactionToolMeta = (meta: unknown): boolean => {
  const record = asRecord(meta);
  if (!record) return false;
  if (record.contextCompaction === true || asRecord(record.contextCompaction) !== undefined) {
    return true;
  }
  const lody = asRecord(record.lody);
  if (lody) {
    const activity = asRecord(lody.activity);
    if (activity?.kind === 'context_compaction') return true;
    if (lody.activityKind === 'context_compaction') return true;
  }
  const jetbrains = asRecord(record.jetbrains);
  const air = asRecord(jetbrains?.air);
  if (asRecord(air?.contextCompaction) !== undefined) return true;
  return false;
};

/**
 * Strip Lody's inline `<board_context_reminder>...</board_context_reminder>`
 * block (and its separating blank lines) from replayed native user prompts so
 * catch-up deduplication matches the user's authored message and never writes
 * internal reminders into Loro user history.
 */
export function stripBoardCompactReminder(text: string): string {
  if (!text.includes('<board_context_reminder>')) {
    return text;
  }
  return text
    .replace(BOARD_CONTEXT_REMINDER_BLOCK_RE, (match, offset: number, source: string) => {
      const atStart = offset === 0;
      const atEnd = offset + match.length === source.length;
      if (atStart || atEnd) return '';
      return '\n\n';
    })
    .trim();
}

/**
 * Extract the primary text of a turn from normalized input blocks, falling back
 * to the raw prompt string when no non-empty text block is present.
 */
export function extractTurnPromptText(
  inputBlocks: readonly SessionInputBlock[] | undefined,
  fallbackPrompt?: string
): string {
  if (inputBlocks) {
    for (const block of inputBlocks) {
      if (block.type === 'text') {
        const trimmed = block.text.trim();
        if (trimmed.length > 0) return trimmed;
      }
    }
  }
  return fallbackPrompt?.trim() ?? '';
}

/** Whether input blocks include any non-text attachment or structured reference. */
export function hasNonTextInputBlocks(
  inputBlocks: readonly SessionInputBlock[] | undefined
): boolean {
  return Boolean(inputBlocks?.some((block) => block.type !== 'text'));
}

/** Whether trimmed user input invokes `/compact` (bare or with trailing instructions). */
export function isExplicitCompactCommand(text: string): boolean {
  return EXPLICIT_COMPACT_COMMAND_RE.test(text.trim());
}

/**
 * Whether a turn's input is a pure-text explicit `/compact` command (no image,
 * file, local attachment, or structured reference blocks that cause providers
 * such as Codex to treat the turn as an ordinary prompt instead of `/compact`).
 */
export function isExplicitCompactTurnInput(
  inputBlocks: readonly SessionInputBlock[] | undefined,
  fallbackPrompt?: string
): boolean {
  if (hasNonTextInputBlocks(inputBlocks)) return false;
  return isExplicitCompactCommand(extractTurnPromptText(inputBlocks, fallbackPrompt));
}

/**
 * Whether a turn's input is a bare pure-text `/compact` with no trailing
 * instructions and no non-text attachments.
 */
export function isBareExplicitCompactTurnInput(
  inputBlocks: readonly SessionInputBlock[] | undefined,
  fallbackPrompt?: string
): boolean {
  if (hasNonTextInputBlocks(inputBlocks)) return false;
  return BARE_COMPACT_COMMAND_RE.test(extractTurnPromptText(inputBlocks, fallbackPrompt));
}

/**
 * Whether trimmed user input starts with a slash command (`/cmd`, `/mcp:srv:cmd`,
 * `/plugin.cmd`, etc.). Multi-segment paths like `/home/user/file.ts` do not match
 * because `/` follows the first segment.
 */
export function isSlashCommandInput(text: string): boolean {
  return SLASH_COMMAND_INPUT_RE.test(text.trim());
}

/** Whether a finalized assistant history entry records a completed ACP context compaction. */
export function hasCompletedCompactionMarker(
  entry: Pick<SessionHistoryInput, 'role' | 'items'> | null | undefined
): boolean {
  if (!entry || entry.role !== 'assistant' || !Array.isArray(entry.items)) {
    return false;
  }
  for (const item of entry.items) {
    if (
      item?.type === 'tool_call' &&
      item.activityKind === 'context_compaction' &&
      item.status === 'completed'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Fallback auto-compaction detector based on context-window usage drops (primarily
 * for providers such as Antigravity that do not emit `context_compaction` markers).
 */
export function detectContextUsageDropCompaction(input: {
  startUsed?: number;
  peakUsed?: number;
  afterUsed?: number;
  ineligible?: boolean;
}): boolean {
  if (input.ineligible) return false;
  if (!isFiniteNonNegative(input.afterUsed)) return false;

  const start = isFiniteNonNegative(input.startUsed) ? input.startUsed : 0;
  const peak = isFiniteNonNegative(input.peakUsed) ? input.peakUsed : 0;
  const baseline = Math.max(start, peak);

  if (baseline < BOARD_COMPACT_USAGE_DROP_MIN_BASELINE) return false;
  if (input.afterUsed > baseline * BOARD_COMPACT_USAGE_DROP_MAX_AFTER_RATIO) return false;
  return baseline - input.afterUsed >= BOARD_COMPACT_USAGE_DROP_MIN_DELTA;
}

/**
 * Build the compact Board context reminder appended inline to the next normal
 * prompt after compaction or history replay. Always rendered from the current
 * Board row and omits first-turn one-off boilerplate.
 */
export function buildBoardCompactReminder(context: BoardCompactPromptContext): string {
  const { board, role, directory } = context;
  const isCoordinator = role === 'coordinator';
  const goal = board.purpose.trim() ? ` Goal: ${board.purpose.trim()}.` : '';

  const header = BOARD_CONTEXT_REMINDER_HEADER;

  const identity = isCoordinator
    ? `Role: main session (coordinator) of Board "${board.name}".${goal}
Assign work only; do not implement tasks yourself and do not summarize results. Dispatch each task to a thread via lody_session_create with a complete brief (for recurring work, schedule a thread with boardId="${board.id}"). Threads deliver results directly to the user; use lody_board_overview and lody_session_history when asked for status. Do not ask threads to forward results or chat back to you (REVERSE_CHAT_FORBIDDEN). Delegation chain cap: ${LODY_MAX_CHAIN_DEPTH} (on CHAIN_DEPTH_EXCEEDED, stop and report to the user).`
    : `Role: thread of Board "${board.name}".${goal}
Own this task end to end and report directly to the user. Open child sessions under your thread with lody_session_create when needed, and quote reviewer conclusions verbatim with what you changed. Do not forward results or chat back to the main session ${board.coordinatorSessionId} (REVERSE_CHAT_FORBIDDEN). Delegation chain cap: ${LODY_MAX_CHAIN_DEPTH} (on CHAIN_DEPTH_EXCEEDED, stop delegating and report remaining work to the user).`;

  const notes = isCoordinator
    ? 'Shared notes: use lody_board_notes_get / lody_board_notes_append (you may reorganize with lody_board_notes_replace).'
    : 'Shared notes: use lody_board_notes_get / lody_board_notes_append (only the main session may replace notes).';

  const memoryOwner = isCoordinator
    ? 'You maintain MEMORY.md.'
    : 'The main session maintains MEMORY.md.';
  const files = directory
    ? `Board directory: ${directory} (shared files in ${directory}/files; agent memory in ${directory}/memory, indexed by memory/MEMORY.md). ${memoryOwner}`
    : `Board directory is on another machine: use lody_board_files_list / lody_board_files_read / lody_board_files_write (area "files" for shared files, area "memory" for agent memory indexed by MEMORY.md). ${memoryOwner}`;

  const helpReminder =
    'Lody MCP tools: after compaction or context loss, call lody_help({command: TOOL_NAME}) again to read full help before executing any Lody command (never in parallel with it).';

  const scope = buildBoardScopeInstructions(board).trim();
  const rules = board.rules.executorConstraints.trim()
    ? `Thread rules from the Board settings:\n${board.rules.executorConstraints.trim()}`
    : '';
  const instructions = board.instructions.trim()
    ? `Board instructions (written by the user; every member follows them):\n${board.instructions.trim()}`
    : '';

  const sections = [
    header,
    identity,
    notes,
    files,
    helpReminder,
    scope,
    rules,
    instructions,
  ].filter(Boolean);

  return `<board_context_reminder>\n${sections.join('\n\n')}\n</board_context_reminder>`;
}

export function createMemoryBoardCompactReinjectStore(): BoardCompactReinjectStore {
  const pending = new Set<SessionId>();
  return {
    async has(sessionId) {
      return pending.has(sessionId);
    },
    async mark(sessionId) {
      pending.add(sessionId);
    },
    async clear(sessionId) {
      pending.delete(sessionId);
    },
  };
}

/**
 * Machine-local per-session pending marker store under `<lodyDataDir>/board-compact-reinject/`.
 *
 * Kept outside `SessionMeta` so turn execution adds no synced Loro meta writes
 * and never introduces schema/sync compatibility risk across LAN peers, while
 * surviving daemon restarts and idle ACP process garbage collection.
 */
export function createFileBoardCompactReinjectStore(options?: {
  rootDir?: string;
  logger?: Logger;
}): BoardCompactReinjectStore {
  const resolveRootDir = () =>
    options?.rootDir ?? path.join(getLodyDataDir(), 'board-compact-reinject');
  const markerPathFor = (sessionId: SessionId): string => {
    const hash = createHash('sha256').update(sessionId).digest('hex');
    return path.join(resolveRootDir(), `${hash}.json`);
  };

  const cache = new Map<SessionId, boolean>();
  const queues = new Map<SessionId, Promise<unknown>>();

  const enqueue = <T>(sessionId: SessionId, fn: () => Promise<T>): Promise<T> => {
    const previous = queues.get(sessionId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    queues.set(sessionId, tail);
    return run.finally(() => {
      if (queues.get(sessionId) === tail) {
        queues.delete(sessionId);
      }
    });
  };

  const readMarkerFromDisk = async (
    sessionId: SessionId
  ): Promise<{ pending: boolean; cacheable: boolean }> => {
    let content: string;
    try {
      content = await readFile(markerPathFor(sessionId), 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
      if (code === 'ENOENT') {
        return { pending: false, cacheable: true };
      }
      // Do not poison the cache on transient I/O errors (EMFILE, EACCES, etc.);
      // retry from disk on the next call.
      options?.logger?.warn(
        `[${sessionId}] Failed to read Board compact reinject marker; will retry next turn: ${formatError(error)}`
      );
      return { pending: false, cacheable: false };
    }
    try {
      const parsed = JSON.parse(content) as { version?: unknown; sessionId?: unknown } | null;
      return {
        pending: parsed?.version === MARKER_FILE_VERSION && parsed?.sessionId === sessionId,
        cacheable: true,
      };
    } catch {
      return { pending: false, cacheable: true };
    }
  };

  return {
    has(sessionId) {
      return enqueue(sessionId, async () => {
        const cached = cache.get(sessionId);
        if (cached !== undefined) return cached;
        const { pending, cacheable } = await readMarkerFromDisk(sessionId);
        if (cacheable) {
          cache.set(sessionId, pending);
        }
        return pending;
      });
    },

    mark(sessionId) {
      return enqueue(sessionId, async () => {
        cache.set(sessionId, true);
        const markerPath = markerPathFor(sessionId);
        const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
          await writeFile(
            temporaryPath,
            `${JSON.stringify({ version: MARKER_FILE_VERSION, sessionId, markedAt: Date.now() })}\n`,
            { encoding: 'utf8', mode: 0o600 }
          );
          await rename(temporaryPath, markerPath);
        } catch (error) {
          await rm(temporaryPath, { force: true }).catch(() => undefined);
          options?.logger?.warn(
            `[${sessionId}] Failed to persist Board compact reinject marker: ${formatError(error)}`
          );
        }
      });
    },

    clear(sessionId) {
      return enqueue(sessionId, async () => {
        cache.set(sessionId, false);
        try {
          await rm(markerPathFor(sessionId), { force: true });
        } catch (error) {
          options?.logger?.debug(
            `[${sessionId}] Failed to remove Board compact reinject marker: ${formatError(error)}`
          );
        }
      });
    },
  };
}

export class BoardCompactReinjectTracker {
  private readonly activeTurns = new Map<SessionId, ActiveTurnUsageObservation>();
  private readonly openCompactionToolCallIds = new Map<SessionId, Set<string>>();
  private readonly inFlightIdleMarks = new Map<SessionId, Promise<void>>();

  constructor(
    private readonly store: BoardCompactReinjectStore,
    private readonly logger: Logger
  ) {}

  beginTurn(
    sessionId: SessionId,
    turnId: string,
    options?: {
      /**
       * Optional pre-turn token count to seed `peakUsed` so a mid-turn drop that
       * later climbs back up (`115k -> 22k -> 80k`) is latched immediately.
       * Omitted on first turns and turns that already carry a reinjected reminder
       * (protecting against providers like agy that defer usage_update after bare `/compact`).
       */
      seedBaselineUsed?: number;
    }
  ): void {
    const seed = isFiniteNonNegative(options?.seedBaselineUsed)
      ? options.seedBaselineUsed
      : undefined;
    this.activeTurns.set(sessionId, {
      turnId,
      peakUsed: seed,
      detectedUsageDrop: false,
      detectedCompactionMarker: false,
    });
  }

  noteContextWindowUsageUpdate(sessionId: SessionId, usage: SessionContextWindowUsage): void {
    if (!isFiniteNonNegative(usage.used)) return;
    const active = this.activeTurns.get(sessionId);
    if (!active) return;
    if (
      active.peakUsed !== undefined &&
      detectContextUsageDropCompaction({
        peakUsed: active.peakUsed,
        afterUsed: usage.used,
      })
    ) {
      active.detectedUsageDrop = true;
    }
    active.peakUsed =
      active.peakUsed === undefined ? usage.used : Math.max(active.peakUsed, usage.used);
    active.lastObservedUsed = usage.used;
  }

  /**
   * Observe live (post-replay-suppression) ACP updates for explicit completed
   * context compaction signals — covering both in-turn markers and spontaneous
   * idle compaction (such as Claude Code's `IdleCompaction`).
   */
  noteLiveAcpUpdate(
    sessionId: SessionId,
    notification: AcpSessionNotification,
    options: {
      isMaintenance: boolean;
      readSessionMeta: () => Promise<SessionMeta | undefined>;
      onIdleCompaction?: (
        sessionId: SessionId,
        meta: SessionMeta | undefined
      ) => Promise<void> | void;
    }
  ): void {
    if (!this.observeCompletedCompactionNotification(sessionId, notification)) {
      return;
    }
    const active = this.activeTurns.get(sessionId);
    if (active) {
      active.detectedCompactionMarker = true;
      return;
    }
    if (options.isMaintenance) {
      return;
    }
    const previous = this.inFlightIdleMarks.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          const meta = await options.readSessionMeta();
          if (meta?.boardId) {
            await this.store.mark(sessionId);
          }
          if (options.onIdleCompaction) {
            try {
              await options.onIdleCompaction(sessionId, meta);
            } catch (error) {
              this.logger.warn(
                `[${sessionId}] Failed to run idle compaction observer callback: ${formatError(error)}`
              );
            }
          }
        } catch (error) {
          this.logger.warn(
            `[${sessionId}] Failed to record idle compaction signal: ${formatError(error)}`
          );
        }
      });
    this.inFlightIdleMarks.set(sessionId, next);
    void next.finally(() => {
      if (this.inFlightIdleMarks.get(sessionId) === next) {
        this.inFlightIdleMarks.delete(sessionId);
      }
    });
  }

  peekActiveTurnObservation(
    sessionId: SessionId,
    turnId: string
  ): BoardTurnUsageSnapshot | undefined {
    const active = this.activeTurns.get(sessionId);
    return active?.turnId === turnId ? { ...active } : undefined;
  }

  endTurn(sessionId: SessionId, turnId: string): BoardTurnUsageSnapshot | undefined {
    const active = this.activeTurns.get(sessionId);
    if (active?.turnId === turnId) {
      this.activeTurns.delete(sessionId);
      return active;
    }
    return undefined;
  }

  private async awaitIdleMarks(sessionId: SessionId): Promise<void> {
    const pending = this.inFlightIdleMarks.get(sessionId);
    if (pending) {
      await pending.catch(() => undefined);
    }
  }

  private observeCompletedCompactionNotification(
    sessionId: SessionId,
    notification: AcpSessionNotification
  ): boolean {
    const update = asRecord(notification.update);
    if (!update) return false;
    const sessionUpdate = update.sessionUpdate;
    const status = update.status;

    if (sessionUpdate === 'compaction_update') {
      return status === 'completed';
    }

    if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') {
      return false;
    }

    const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
    const trackedIds = this.openCompactionToolCallIds.get(sessionId);
    const isCompaction =
      hasCompactionToolMeta(update._meta) ||
      (toolCallId !== undefined && trackedIds?.has(toolCallId) === true);
    if (!isCompaction) {
      return false;
    }

    if (status === 'completed') {
      if (toolCallId && trackedIds) {
        trackedIds.delete(toolCallId);
        if (trackedIds.size === 0) this.openCompactionToolCallIds.delete(sessionId);
      }
      return true;
    }

    if (status === 'failed' || status === 'cancelled') {
      if (toolCallId && trackedIds) {
        trackedIds.delete(toolCallId);
        if (trackedIds.size === 0) this.openCompactionToolCallIds.delete(sessionId);
      }
      return false;
    }

    if (toolCallId) {
      let ids = trackedIds;
      if (!ids) {
        ids = new Set();
        this.openCompactionToolCallIds.set(sessionId, ids);
      }
      if (ids.size >= MAX_OPEN_COMPACTION_IDS_PER_SESSION) {
        const oldest = ids.values().next().value;
        if (oldest !== undefined) ids.delete(oldest);
      }
      ids.add(toolCallId);
    }
    return false;
  }

  async hasPending(sessionId: SessionId): Promise<boolean> {
    try {
      await this.awaitIdleMarks(sessionId);
      return await this.store.has(sessionId);
    } catch (error) {
      this.logger.warn(
        `[${sessionId}] Failed to read pending Board compact reinject state: ${formatError(error)}`
      );
      return false;
    }
  }

  async markPending(sessionId: SessionId): Promise<void> {
    try {
      await this.awaitIdleMarks(sessionId);
      await this.store.mark(sessionId);
    } catch (error) {
      this.logger.warn(
        `[${sessionId}] Failed to mark pending Board compact reinject state: ${formatError(error)}`
      );
    }
  }

  async clearPending(sessionId: SessionId): Promise<void> {
    try {
      await this.awaitIdleMarks(sessionId);
      await this.store.clear(sessionId);
    } catch (error) {
      this.logger.warn(
        `[${sessionId}] Failed to clear pending Board compact reinject state: ${formatError(error)}`
      );
    }
  }

  /**
   * Append a compact `<board_context_reminder>` text block to `promptBlocks` when
   * this eligible Board member turn has a pending refresh. Maintenance turns,
   * goal control turns (which slash-compat rewrites to `/goal ...`), and slash
   * commands skip injection while retaining any pending marker for the next
   * normal message.
   */
  async maybeAppendReminderToPromptBlocks(args: {
    sessionId: SessionId;
    meta: SessionMeta | null | undefined;
    dispatchSource?: string;
    hasGoalControl?: boolean;
    hasNonTextInput?: boolean;
    turnInputText: string;
    promptBlocks: ContentBlock[];
    loadBoardContext: () => Promise<BoardCompactContextLoadResult>;
  }): Promise<{ promptBlocks: ContentBlock[]; injected: boolean }> {
    const {
      sessionId,
      meta,
      dispatchSource,
      hasGoalControl,
      hasNonTextInput,
      turnInputText,
      promptBlocks,
      loadBoardContext,
    } = args;

    if (
      dispatchSource === 'maintenance' ||
      dispatchSource === 'rollover' ||
      dispatchSource === 'goal' ||
      hasGoalControl ||
      !meta?.boardId
    ) {
      return { promptBlocks, injected: false };
    }

    try {
      await this.awaitIdleMarks(sessionId);
      const pending = await this.store.has(sessionId);
      if (!pending || (!hasNonTextInput && isSlashCommandInput(turnInputText))) {
        return { promptBlocks, injected: false };
      }

      let loaded: BoardCompactContextLoadResult;
      try {
        loaded = await loadBoardContext();
      } catch (error) {
        this.logger.warn(`[${sessionId}] Skipping Board compact reminder: ${formatError(error)}`);
        return { promptBlocks, injected: false };
      }

      if (!loaded.context) {
        return { promptBlocks, injected: false };
      }

      const reminderText = buildBoardCompactReminder(loaded.context);
      return {
        promptBlocks: [...promptBlocks, { type: 'text', text: reminderText }],
        injected: true,
      };
    } catch (error) {
      this.logger.warn(
        `[${sessionId}] Skipping Board compact reminder after unexpected error: ${formatError(error)}`
      );
      return { promptBlocks, injected: false };
    }
  }

  private async hasCompletedMarkerInEntries(
    sessionId: SessionId,
    entryIds: readonly string[],
    readAssistantTurn: (entryId: string) => Promise<SessionHistoryInput | undefined>
  ): Promise<boolean> {
    const uniqueIds = [...new Set(entryIds.filter((id) => id.length > 0))];
    for (const entryId of uniqueIds) {
      try {
        const entry = await readAssistantTurn(entryId);
        if (hasCompletedCompactionMarker(entry)) {
          return true;
        }
      } catch (error) {
        this.logger.debug(
          `[${sessionId}] Failed to inspect assistant turn ${entryId} for compaction marker: ${formatError(error)}`
        );
      }
    }
    return false;
  }

  /**
   * Consume a delivered reminder and evaluate three-layer compaction signals
   * after turn finalization (`finalizeACPState` + `persistTurnDiffsAndFlushUsage`).
   * Fully error-contained: never throws to the caller.
   */
  async completeTurn(args: {
    sessionId: SessionId;
    turnId: string;
    assistantTurnIds: readonly string[];
    meta: SessionMeta | null | undefined;
    dispatchSource?: string;
    hasGoalControl?: boolean;
    promptFailed: boolean;
    /** Whether `agentClient.prompt()` itself returned cleanly (even if visible output was empty). */
    promptCompletedNormally: boolean;
    producedOutput: boolean;
    injectedBoardReminder: boolean;
    explicitCompactTriggered: boolean;
    turnStartUsed?: number;
    ineligibleForUsageDrop: boolean;
    observationSnapshot?: BoardTurnUsageSnapshot;
    readAssistantTurn: (entryId: string) => Promise<SessionHistoryInput | undefined>;
  }): Promise<{ compacted: boolean; reason?: BoardCompactionReason }> {
    const {
      sessionId,
      turnId,
      assistantTurnIds,
      meta,
      dispatchSource,
      hasGoalControl,
      promptFailed,
      promptCompletedNormally,
      producedOutput,
      injectedBoardReminder,
      explicitCompactTriggered,
      turnStartUsed,
      ineligibleForUsageDrop,
      observationSnapshot,
      readAssistantTurn,
    } = args;

    try {
      const active = this.activeTurns.get(sessionId);
      const observation =
        active?.turnId === turnId
          ? active
          : observationSnapshot?.turnId === turnId
            ? observationSnapshot
            : undefined;
      const observedPeakUsed = observation?.peakUsed;
      const lastObservedUsed = observation?.lastObservedUsed;
      const observedUsageDrop = observation?.detectedUsageDrop ?? false;
      const observedMarker = observation?.detectedCompactionMarker ?? false;

      if (dispatchSource === 'maintenance' || dispatchSource === 'rollover') {
        return { compacted: false };
      }

      // Generalize three-layer compaction detection to all ordinary sessions so
      // linear rollover can detect mid-turn native auto-compact (Hard Trap #3),
      // while keeping `<board_context_reminder>` store mutations strictly gated
      // to Board members (`meta?.boardId`).
      const isBoardMember = Boolean(meta?.boardId);

      const turnSucceeded = !promptFailed && producedOutput;
      // Consume the previous pending flag BEFORE checking whether this turn itself
      // compacted, so a turn that both received a reminder and compacted again
      // leaves the pending marker armed for the following turn.
      if (isBoardMember && injectedBoardReminder && turnSucceeded) {
        await this.clearPending(sessionId);
      }

      // Layer 1: pure-text explicit `/compact` command returned cleanly from ACP
      // (covers bare `/compact` on providers like Antigravity that may emit zero
      // visible output, no compaction marker, and no immediate usage_update).
      if (
        dispatchSource !== 'goal' &&
        !hasGoalControl &&
        promptCompletedNormally &&
        explicitCompactTriggered
      ) {
        if (isBoardMember) {
          await this.markPending(sessionId);
        }
        return { compacted: true, reason: 'explicit_compact' };
      }

      // Layer 2: explicit ACP `context_compaction` completed marker observed live
      // or persisted across any assistant entry in the turn/steer-handoff chain.
      if (
        observedMarker ||
        (await this.hasCompletedMarkerInEntries(sessionId, assistantTurnIds, readAssistantTurn))
      ) {
        if (isBoardMember) {
          await this.markPending(sessionId);
        }
        return { compacted: true, reason: 'acp_marker' };
      }

      // Layer 3: context window usage drop fallback (auto-compaction without marker).
      // Latched `observedUsageDrop` catches mid-turn drop-then-regrowth (`115k -> 22k -> 80k`).
      // When this turn already carried a reinjected reminder, ignore stale pre-turn
      // `turnStartUsed` so deferred `usage_update` from bare `/compact` never re-triggers.
      const afterUsed = meta?.contextWindowUsage?.used ?? lastObservedUsed;
      const effectiveStartUsed = injectedBoardReminder ? undefined : turnStartUsed;
      if (
        !ineligibleForUsageDrop &&
        (observedUsageDrop ||
          detectContextUsageDropCompaction({
            startUsed: effectiveStartUsed,
            peakUsed: observedPeakUsed,
            afterUsed,
          }))
      ) {
        if (isBoardMember) {
          await this.markPending(sessionId);
        }
        return { compacted: true, reason: 'usage_drop' };
      }

      return { compacted: false };
    } catch (error) {
      this.logger.warn(
        `[${sessionId}] Failed to finalize Board compact reinject bookkeeping: ${formatError(error)}`
      );
      return { compacted: false };
    }
  }

  /**
   * Thin adapter for `SessionExecutionService` turn completion (both first turns
   * and continuation turns). Fully error-contained: never throws.
   */
  async completeSessionTurn(args: {
    sessionId: SessionId;
    turnId: string;
    assistantTurnIds: readonly string[];
    preTurnMeta: SessionMeta;
    readFreshMeta: () => Promise<SessionMeta | undefined>;
    dispatchSource?: string;
    hasGoalControl?: boolean;
    promptFailed: boolean;
    promptCompletedNormally: boolean;
    producedOutput: boolean;
    injectedBoardReminder: boolean;
    isStartTurn: boolean;
    initialInputBlocks?: readonly SessionInputBlock[];
    initialFallbackPrompt?: string;
    finalInputConfig?: SessionTurnInputConfig;
    turnStartUsed?: number;
    turnStartAcpSessionId?: ACPSessionId;
    turnStartModelId?: string;
    activeAcpSessionId?: ACPSessionId | null;
    activeModelId?: string;
    requestedModelId?: string;
    freshAgentSession: boolean;
    usedHistoryReplay: boolean;
    /** Explicit usage-drop suppression (e.g. post-rollover first follow-up turn, Hard Trap #6). */
    ineligibleForUsageDrop?: boolean;
    observationSnapshot?: BoardTurnUsageSnapshot;
    readAssistantTurn: (entryId: string) => Promise<SessionHistoryInput | undefined>;
  }): Promise<{ compacted: boolean; reason?: BoardCompactionReason }> {
    try {
      let freshMeta: SessionMeta | undefined;
      try {
        freshMeta = await args.readFreshMeta();
      } catch (error) {
        this.logger.warn(
          `[${args.sessionId}] Failed to refresh SessionMeta for Board compact bookkeeping; using pre-turn meta: ${formatError(error)}`
        );
      }
      const meta = freshMeta ?? args.preTurnMeta;

      const explicitCompactTriggered =
        !args.isStartTurn &&
        (isExplicitCompactTurnInput(args.initialInputBlocks, args.initialFallbackPrompt) ||
          (args.finalInputConfig !== undefined &&
            isExplicitCompactTurnInput(
              resolveSessionExecutionInputBlocks(args.finalInputConfig),
              args.finalInputConfig.prompt
            )));

      const replacedAcpSession = args.isStartTurn
        ? false
        : args.freshAgentSession ||
          args.usedHistoryReplay ||
          !args.turnStartAcpSessionId ||
          args.activeAcpSessionId !== args.turnStartAcpSessionId;

      const requestedModelId = args.finalInputConfig?.modelId ?? args.requestedModelId;
      const afterModelId = args.activeModelId ?? requestedModelId ?? meta?.lastModel?.modelId;
      const modelChanged = Boolean(
        args.turnStartModelId &&
        ((requestedModelId && requestedModelId !== args.turnStartModelId) ||
          (afterModelId && afterModelId !== args.turnStartModelId))
      );

      return await this.completeTurn({
        sessionId: args.sessionId,
        turnId: args.turnId,
        assistantTurnIds: args.assistantTurnIds,
        meta,
        dispatchSource: args.dispatchSource,
        hasGoalControl: args.hasGoalControl,
        promptFailed: args.promptFailed,
        promptCompletedNormally: args.promptCompletedNormally,
        producedOutput: args.producedOutput,
        injectedBoardReminder: args.injectedBoardReminder,
        explicitCompactTriggered,
        turnStartUsed: args.isStartTurn ? undefined : args.turnStartUsed,
        ineligibleForUsageDrop:
          Boolean(args.ineligibleForUsageDrop) || replacedAcpSession || modelChanged,
        observationSnapshot: args.observationSnapshot,
        readAssistantTurn: args.readAssistantTurn,
      });
    } catch (error) {
      this.logger.warn(
        `[${args.sessionId}] Failed to evaluate Board compaction after turn: ${formatError(error)}`
      );
      return { compacted: false };
    }
  }

  /**
   * Preserve confirmed compaction evidence (ACP marker or eligible usage drop)
   * when a turn is cancelled via Stop or terminates on error after prompt start.
   * Never consumes pending reminders and never throws.
   */
  async recordConfirmedCompactionOnInterruption(args: {
    sessionId: SessionId;
    turnId: string;
    assistantTurnIds: readonly string[];
    preTurnMeta: SessionMeta;
    readFreshMeta: () => Promise<SessionMeta | undefined>;
    dispatchSource?: string;
    isStartTurn: boolean;
    injectedBoardReminder: boolean;
    turnStartUsed?: number;
    turnStartAcpSessionId?: ACPSessionId;
    turnStartModelId?: string;
    activeAcpSessionId?: ACPSessionId | null;
    activeModelId?: string;
    requestedModelId?: string;
    finalInputConfig?: SessionTurnInputConfig;
    freshAgentSession: boolean;
    usedHistoryReplay: boolean;
    /** Explicit usage-drop suppression (e.g. post-rollover first follow-up turn, Hard Trap #6). */
    ineligibleForUsageDrop?: boolean;
    observationSnapshot?: BoardTurnUsageSnapshot;
    readAssistantTurn: (entryId: string) => Promise<SessionHistoryInput | undefined>;
  }): Promise<{ compacted: boolean; reason?: BoardCompactionReason }> {
    return await this.completeSessionTurn({
      ...args,
      promptFailed: true,
      promptCompletedNormally: false,
      producedOutput: false,
      initialInputBlocks: undefined,
      initialFallbackPrompt: undefined,
    });
  }

  /**
   * Mark pending when a coordinator maintenance `:compact` turn confirms
   * compaction (marker or `< 0.8` shrinkage), before `:renew` runs. If `:renew`
   * runs immediately and succeeds, `:renew` clears pending (no double-inject);
   * if a user/Inbox turn preempts `:renew` (`yielded`), it immediately gets the
   * compact reminder. Never throws.
   */
  async completeMaintenanceCompactTurn(args: {
    sessionId: SessionId;
    preTurnMeta: SessionMeta;
    readFreshMeta: () => Promise<SessionMeta | undefined>;
    assistantTurnIds: readonly string[];
    usedBefore?: number;
    readAssistantTurn: (entryId: string) => Promise<SessionHistoryInput | undefined>;
  }): Promise<boolean> {
    try {
      if (!args.preTurnMeta.boardId) return false;
      const markerHit = await this.hasCompletedMarkerInEntries(
        args.sessionId,
        args.assistantTurnIds,
        args.readAssistantTurn
      );
      let shrank = false;
      if (!markerHit && isFiniteNonNegative(args.usedBefore)) {
        let freshMeta: SessionMeta | undefined;
        try {
          freshMeta = await args.readFreshMeta();
        } catch (error) {
          this.logger.warn(
            `[${args.sessionId}] Failed to refresh SessionMeta after maintenance compact: ${formatError(error)}`
          );
        }
        const after = freshMeta?.contextWindowUsage?.used;
        shrank =
          isFiniteNonNegative(after) &&
          after < args.usedBefore * MAINTENANCE_COMPACT_USAGE_DROP_RATIO;
      }
      if (markerHit || shrank) {
        await this.markPending(args.sessionId);
        return true;
      }
      return false;
    } catch (error) {
      this.logger.warn(
        `[${args.sessionId}] Failed to record Board maintenance compaction state: ${formatError(error)}`
      );
      return false;
    }
  }
}
