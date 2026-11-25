import type { ContentBlock } from '@agentclientprotocol/sdk';
import {
  LODY_MAX_CHAIN_DEPTH,
  resolveSessionExecutionInputBlocks,
  type ACPSessionId,
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

const EXPLICIT_COMPACT_COMMAND_RE = /^\/compact(?:\s|$)/;
const SLASH_COMMAND_INPUT_RE = /^\/[a-zA-Z0-9_-]+(?:\s|$)/;
const MARKER_FILE_VERSION = 1;

export type BoardCompactPromptContext = {
  board: BoardMeta;
  role?: SessionMeta['boardRole'];
  /** The Board directory, when this machine keeps it. */
  directory?: string;
};

export type BoardCompactReinjectStore = {
  has(sessionId: SessionId): Promise<boolean>;
  mark(sessionId: SessionId): Promise<void>;
  clear(sessionId: SessionId): Promise<void>;
};

export type BoardCompactionReason = 'explicit_compact' | 'acp_marker' | 'usage_drop';

type ActiveTurnUsageObservation = {
  turnId: string;
  peakUsed?: number;
  lastObservedUsed?: number;
};

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isFiniteNonNegative = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

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

/** Whether trimmed user input invokes `/compact` (bare or with trailing instructions). */
export function isExplicitCompactCommand(text: string): boolean {
  return EXPLICIT_COMPACT_COMMAND_RE.test(text.trim());
}

/**
 * Whether trimmed user input starts with a slash command (`/cmd` or `/cmd ...`).
 * Paths like `/home/user/file.ts` do not match because `/` follows the first segment.
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

  const header =
    'Context was recently compacted or reconstructed. The current Board role, boundaries, and rules below are authoritative and override any earlier summary.';

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

  const readMarkerFromDisk = async (sessionId: SessionId): Promise<boolean> => {
    try {
      const content = await readFile(markerPathFor(sessionId), 'utf8');
      const parsed = JSON.parse(content) as { version?: unknown; sessionId?: unknown } | null;
      return parsed?.version === MARKER_FILE_VERSION && parsed?.sessionId === sessionId;
    } catch {
      return false;
    }
  };

  return {
    has(sessionId) {
      return enqueue(sessionId, async () => {
        const cached = cache.get(sessionId);
        if (cached !== undefined) return cached;
        const onDisk = await readMarkerFromDisk(sessionId);
        cache.set(sessionId, onDisk);
        return onDisk;
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

  constructor(
    private readonly store: BoardCompactReinjectStore,
    private readonly logger: Logger
  ) {}

  beginTurn(sessionId: SessionId, turnId: string): void {
    this.activeTurns.set(sessionId, { turnId });
  }

  noteContextWindowUsageUpdate(sessionId: SessionId, usage: SessionContextWindowUsage): void {
    if (!isFiniteNonNegative(usage.used)) return;
    const active = this.activeTurns.get(sessionId);
    if (!active) return;
    active.peakUsed =
      active.peakUsed === undefined ? usage.used : Math.max(active.peakUsed, usage.used);
    active.lastObservedUsed = usage.used;
  }

  endTurn(sessionId: SessionId, turnId: string): void {
    if (this.activeTurns.get(sessionId)?.turnId === turnId) {
      this.activeTurns.delete(sessionId);
    }
  }

  async hasPending(sessionId: SessionId): Promise<boolean> {
    return await this.store.has(sessionId);
  }

  async clearPending(sessionId: SessionId): Promise<void> {
    await this.store.clear(sessionId);
  }

  /**
   * Append a compact `<board_context_reminder>` text block to `promptBlocks` when
   * this non-maintenance Board member turn follows a compaction or runs on a
   * history-replayed ACP session. Slash commands skip injection and retain any
   * pending marker for the next normal message.
   */
  async maybeAppendReminderToPromptBlocks(args: {
    sessionId: SessionId;
    meta: SessionMeta | null | undefined;
    dispatchSource?: string;
    usedHistoryReplay: boolean;
    turnInputText: string;
    promptBlocks: ContentBlock[];
    loadBoardContext: () => Promise<BoardCompactPromptContext | undefined>;
  }): Promise<{ promptBlocks: ContentBlock[]; injected: boolean }> {
    const {
      sessionId,
      meta,
      dispatchSource,
      usedHistoryReplay,
      turnInputText,
      promptBlocks,
      loadBoardContext,
    } = args;

    if (dispatchSource === 'maintenance' || !meta?.boardId) {
      return { promptBlocks, injected: false };
    }

    const pending = await this.store.has(sessionId);
    const shouldInject = usedHistoryReplay || (pending && !isSlashCommandInput(turnInputText));
    if (!shouldInject) {
      return { promptBlocks, injected: false };
    }

    let context: BoardCompactPromptContext | undefined;
    try {
      context = await loadBoardContext();
    } catch (error) {
      const message = formatError(error);
      this.logger.warn(`[${sessionId}] Skipping Board compact reminder: ${message}`);
      if (message === 'BOARD_NOT_FOUND') {
        await this.store.clear(sessionId);
      }
      return { promptBlocks, injected: false };
    }

    if (!context) {
      return { promptBlocks, injected: false };
    }

    const reminderText = buildBoardCompactReminder(context);
    return {
      promptBlocks: [...promptBlocks, { type: 'text', text: reminderText }],
      injected: true,
    };
  }

  /**
   * Consume a delivered reminder and evaluate three-layer compaction signals
   * after turn finalization (`finalizeACPState` + `persistTurnDiffsAndFlushUsage`).
   */
  async completeTurn(args: {
    sessionId: SessionId;
    turnId: string;
    completedTurnId: string;
    meta: SessionMeta | null | undefined;
    dispatchSource?: string;
    promptFailed: boolean;
    producedOutput: boolean;
    injectedBoardReminder: boolean;
    turnInputTexts: readonly string[];
    turnStartUsed?: number;
    ineligibleForUsageDrop: boolean;
    readAssistantTurn: (entryId: string) => Promise<SessionHistoryInput | undefined>;
  }): Promise<{ compacted: boolean; reason?: BoardCompactionReason }> {
    const {
      sessionId,
      turnId,
      completedTurnId,
      meta,
      dispatchSource,
      promptFailed,
      producedOutput,
      injectedBoardReminder,
      turnInputTexts,
      turnStartUsed,
      ineligibleForUsageDrop,
      readAssistantTurn,
    } = args;

    const active = this.activeTurns.get(sessionId);
    const observedPeakUsed = active?.turnId === turnId ? active.peakUsed : undefined;
    const lastObservedUsed = active?.turnId === turnId ? active.lastObservedUsed : undefined;

    if (dispatchSource === 'maintenance' || !meta?.boardId) {
      return { compacted: false };
    }

    const turnSucceeded = !promptFailed && producedOutput;
    // Consume the previous pending flag BEFORE checking whether this turn itself
    // compacted, so a turn that both received a reminder and compacted again
    // leaves the pending marker armed for the following turn.
    if (injectedBoardReminder && turnSucceeded) {
      await this.store.clear(sessionId);
    }

    // Layer 1: explicit `/compact` command completed cleanly (covers bare `/compact`
    // on providers like Antigravity that emit neither a compaction marker nor an
    // immediate usage_update).
    if (turnSucceeded && turnInputTexts.some(isExplicitCompactCommand)) {
      await this.store.mark(sessionId);
      return { compacted: true, reason: 'explicit_compact' };
    }

    // Layer 2: explicit ACP `context_compaction` completed marker persisted in
    // the finalized assistant entry (Claude Code / Codex manual & auto-compact).
    const entryIds = completedTurnId === turnId ? [completedTurnId] : [completedTurnId, turnId];
    for (const entryId of entryIds) {
      try {
        const entry = await readAssistantTurn(entryId);
        if (hasCompletedCompactionMarker(entry)) {
          await this.store.mark(sessionId);
          return { compacted: true, reason: 'acp_marker' };
        }
      } catch (error) {
        this.logger.debug(
          `[${sessionId}] Failed to inspect assistant turn ${entryId} for compaction marker: ${formatError(error)}`
        );
      }
    }

    // Layer 3: context window usage drop fallback (auto-compaction without marker).
    // When this turn already carried a reinjected reminder, `turnStartUsed` may
    // hold a stale pre-compact reading from a provider that defers usage_update
    // across a bare `/compact`; rely on live in-turn `observedPeakUsed` only so
    // the deferred usage refresh does not trigger a second reinjection.
    const afterUsed = meta.contextWindowUsage?.used ?? lastObservedUsed;
    const effectiveStartUsed = injectedBoardReminder ? undefined : turnStartUsed;
    if (
      detectContextUsageDropCompaction({
        startUsed: effectiveStartUsed,
        peakUsed: observedPeakUsed,
        afterUsed,
        ineligible: ineligibleForUsageDrop,
      })
    ) {
      await this.store.mark(sessionId);
      return { compacted: true, reason: 'usage_drop' };
    }

    return { compacted: false };
  }

  /**
   * Thin adapter for `SessionExecutionService.prepareContinueSessionTurn` so the
   * execution service only passes raw turn context and keeps compaction logic
   * encapsulated in this module.
   */
  async completeContinueTurn(args: {
    sessionId: SessionId;
    turnId: string;
    completedTurnId: string;
    preTurnMeta: SessionMeta;
    readFreshMeta: () => Promise<SessionMeta | undefined>;
    dispatchSource?: string;
    promptFailed: boolean;
    producedOutput: boolean;
    injectedBoardReminder: boolean;
    initialInputText: string;
    finalInputConfig?: SessionTurnInputConfig;
    turnStartUsed?: number;
    turnStartAcpSessionId?: ACPSessionId;
    turnStartModelId?: string;
    activeAcpSessionId?: ACPSessionId | null;
    activeModelId?: string;
    requestedModelId?: string;
    freshAgentSession: boolean;
    usedHistoryReplay: boolean;
    readAssistantTurn: (entryId: string) => Promise<SessionHistoryInput | undefined>;
  }): Promise<{ compacted: boolean; reason?: BoardCompactionReason }> {
    const freshMeta = (await args.readFreshMeta()) ?? args.preTurnMeta;
    const finalInputText = args.finalInputConfig
      ? extractTurnPromptText(
          resolveSessionExecutionInputBlocks(args.finalInputConfig),
          args.finalInputConfig.prompt
        )
      : '';
    const turnInputTexts =
      finalInputText && finalInputText !== args.initialInputText
        ? [args.initialInputText, finalInputText]
        : [args.initialInputText];
    const replacedAcpSession =
      args.freshAgentSession ||
      args.usedHistoryReplay ||
      !args.turnStartAcpSessionId ||
      args.activeAcpSessionId !== args.turnStartAcpSessionId;
    const requestedModelId = args.finalInputConfig?.modelId ?? args.requestedModelId;
    const afterModelId = args.activeModelId ?? requestedModelId ?? freshMeta?.lastModel?.modelId;
    const modelChanged = Boolean(
      args.turnStartModelId &&
      ((requestedModelId && requestedModelId !== args.turnStartModelId) ||
        (afterModelId && afterModelId !== args.turnStartModelId))
    );
    return await this.completeTurn({
      sessionId: args.sessionId,
      turnId: args.turnId,
      completedTurnId: args.completedTurnId,
      meta: freshMeta,
      dispatchSource: args.dispatchSource,
      promptFailed: args.promptFailed,
      producedOutput: args.producedOutput,
      injectedBoardReminder: args.injectedBoardReminder,
      turnInputTexts,
      turnStartUsed: args.turnStartUsed,
      ineligibleForUsageDrop: replacedAcpSession || modelChanged,
      readAssistantTurn: args.readAssistantTurn,
    });
  }
}
