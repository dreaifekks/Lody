import type * as acp from '@agentclientprotocol/sdk';
import type { AgentConfigCliType } from '@lody/shared';

export const ANTIGRAVITY_ACP_SERVER_NAME = 'Antigravity ACP Server';

export interface AntigravityServerIdentityInput {
  agentConfig?: {
    cliType: AgentConfigCliType;
    agentType?: string;
  } | null;
  agentInfo?: {
    name?: string | null;
  } | null;
}

/**
 * Identify builtin or custom Antigravity ACP v1 servers while excluding legacy `antigravity-acp`.
 */
export function isAntigravityServer({
  agentConfig,
  agentInfo,
}: AntigravityServerIdentityInput): boolean {
  if (agentConfig?.cliType === 'builtin' && agentConfig.agentType === 'antigravity') {
    return true;
  }
  return agentInfo?.name === ANTIGRAVITY_ACP_SERVER_NAME;
}

export interface AntigravityPollTimings {
  /** `session/list` interval while background work may be pending. */
  listPollIntervalMs: number;
  /** Transcript activity followed by this much stillness counts as one wakeup finished. */
  wakeupQuietMs: number;
  /** Activity within this window reports `running` instead of `background`. */
  runningGraceMs: number;
  /** Hard bound for one monitor, matching the Core `background` protection cap. */
  maxDurationMs: number;
  rpcTimeoutMs: number;
  maxConsecutiveFailures: number;
}

export const DEFAULT_ANTIGRAVITY_POLL_TIMINGS: AntigravityPollTimings = {
  listPollIntervalMs: 2_000,
  wakeupQuietMs: 30_000,
  runningGraceMs: 10_000,
  maxDurationMs: 24 * 60 * 60_000,
  rpcTimeoutMs: 15_000,
  maxConsecutiveFailures: 5,
};

export interface AntigravityMonitorState {
  settled: boolean;
  state: 'idle' | 'running';
  backgroundTaskCount: number;
}

/**
 * Tools whose completion only acknowledges dispatch; their result arrives later by waking
 * the model.
 */
const ASYNC_DISPATCH_TOOL_NAMES = new Set(['invoke_subagent', 'send_message', 'swarm']);

const NON_BACKGROUND_TOOL_KINDS = new Set([
  'read',
  'search',
  'edit',
  'write',
  'delete',
  'move',
  'think',
]);

const NON_BACKGROUND_TOOL_NAMES = new Set([
  'read_file',
  'view_file',
  'view_file_outline',
  'view_code_item',
  'edit_file',
  'write_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'grep_search',
  'find_by_name',
  'list_dir',
  'search_web',
]);

const BG_TASK_PLACEHOLDER_LINE_PATTERN =
  /^Tool is running as a background task with task id:\s+([A-Za-z0-9._:/-]+?)\.?$/i;

export interface AntigravityToolIdentity {
  kind?: string;
  name?: string;
}

interface KnownTool {
  status: string;
  kind?: string;
  name?: string;
  daemon: boolean;
  hasOutput: boolean;
  placeholder: boolean;
  wakeupCounted: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolName(raw: Record<string, unknown>): string | undefined {
  const meta = raw._meta;
  if (isRecord(meta) && isRecord(meta.lody) && typeof meta.lody.toolName === 'string') {
    return meta.lody.toolName;
  }
  return typeof raw.name === 'string' ? raw.name : undefined;
}

function isNonBackgroundTool(identity: AntigravityToolIdentity): boolean {
  const kind = identity.kind?.trim().toLowerCase();
  if (kind && NON_BACKGROUND_TOOL_KINDS.has(kind)) return true;
  const name = identity.name?.trim().toLowerCase();
  if (name && NON_BACKGROUND_TOOL_NAMES.has(name)) return true;
  return false;
}

function isDaemonTool(raw: Record<string, unknown>): boolean {
  const input = isRecord(raw.rawInput) ? raw.rawInput : isRecord(raw.args) ? raw.args : undefined;
  return input?.IsDaemon === true;
}

function matchSingleLinePlaceholder(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return null;
  const match = BG_TASK_PLACEHOLDER_LINE_PATTERN.exec(trimmed);
  const taskId = match?.[1];
  return taskId && /[A-Za-z0-9]/.test(taskId) ? taskId : null;
}

type ContentTextCheck = { kind: 'empty' } | { kind: 'single'; text: string } | { kind: 'invalid' };

function inspectContentOutput(content: unknown): ContentTextCheck {
  if (!Array.isArray(content) || content.length === 0) {
    return { kind: 'empty' };
  }
  const nonEmptyParts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) return { kind: 'invalid' };
    const text =
      typeof item.text === 'string'
        ? item.text
        : isRecord(item.content) && typeof item.content.text === 'string'
          ? item.content.text
          : null;
    if (text === null) return { kind: 'invalid' };
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      nonEmptyParts.push(trimmed);
    }
  }
  if (nonEmptyParts.length === 0) return { kind: 'empty' };
  if (nonEmptyParts.length > 1) return { kind: 'invalid' };
  return { kind: 'single', text: nonEmptyParts[0]! };
}

function matchBackgroundPlaceholder(
  raw: Record<string, unknown>,
  toolIdentity?: AntigravityToolIdentity
): string | null {
  const identity: AntigravityToolIdentity = {
    kind: toolIdentity?.kind ?? (typeof raw.kind === 'string' ? raw.kind : undefined),
    name: toolIdentity?.name ?? toolName(raw),
  };
  if (isNonBackgroundTool(identity)) return null;
  const rawText =
    typeof raw.rawOutput === 'string'
      ? raw.rawOutput.trim()
      : isRecord(raw.rawOutput) && typeof raw.rawOutput.output === 'string'
        ? raw.rawOutput.output.trim()
        : '';
  const contentCheck = inspectContentOutput(raw.content);

  if (rawText.length > 0) {
    const rawTaskId = matchSingleLinePlaceholder(rawText);
    if (rawTaskId === null) return null;
    if (contentCheck.kind === 'empty') return rawTaskId;
    if (contentCheck.kind === 'invalid') return null;
    return matchSingleLinePlaceholder(contentCheck.text) !== null ? rawTaskId : null;
  }

  if (contentCheck.kind === 'single') {
    return matchSingleLinePlaceholder(contentCheck.text);
  }
  return null;
}

export function hasAntigravityBackgroundPlaceholder(
  raw: Record<string, unknown>,
  toolIdentity?: AntigravityToolIdentity
): boolean {
  return matchBackgroundPlaceholder(raw, toolIdentity) !== null;
}

function isToolStillPending(tool: KnownTool): boolean {
  return (
    !tool.daemon &&
    tool.status !== 'failed' &&
    (tool.status === 'pending' || tool.status === 'in_progress')
  );
}

function isToolWakeupOnly(tool: KnownTool): boolean {
  return (
    !tool.daemon &&
    tool.status !== 'failed' &&
    (tool.placeholder ||
      (tool.name === 'run_workflow' && tool.status === 'completed' && !tool.hasOutput) ||
      (tool.name !== undefined && ASYNC_DISPATCH_TOOL_NAMES.has(tool.name)))
  );
}

function hasOutput(raw: Record<string, unknown>): boolean {
  const output = raw.rawOutput;
  const hasRaw =
    typeof output === 'string' || Array.isArray(output)
      ? output.length > 0
      : isRecord(output)
        ? Object.keys(output).length > 0
        : output !== undefined && output !== null;
  return hasRaw || (Array.isArray(raw.content) && raw.content.length > 0);
}

/**
 * Tracks the background work an Antigravity ACP v1 turn leaves behind at `end_turn`, and
 * decides from live tool updates (agy 1.5.10+) and `session/list` activity when it has
 * finished.
 *
 * Unfinished tools are tracked by `toolCallId` in `pendingToolIds` so terminal updates
 * received during a wakeup or a later turn settle the exact tool; async dispatch tools
 * and placeholder-only completions are tracked in `pendingWakeups`. Anonymous wakeup
 * completions inferred from stillness (agy 1.5.9 polling or wakeup-only dispatches) are
 * recorded in `inferredCompletions` and reconciled when a later turn replays terminal
 * tool updates, avoiding double-decrementing still-running work.
 */
export class AntigravitySessionTracker {
  private readonly timings: AntigravityPollTimings;
  private readonly tools = new Map<string, KnownTool>();
  private turnToolIds = new Set<string>();
  private readonly pendingToolIds = new Set<string>();
  private readonly wakeupStartedToolIds = new Set<string>();
  private pendingWakeups = 0;
  private inferredCompletions = 0;
  private turnEndedAtMs: number | null = null;
  private lastActivityAtMs = 0;
  private inWakeup = false;
  private observedPostTurnLiveStream = false;
  private awaitingReplyForSettledTool = false;
  private wakeupSawSettledTool = false;
  private wakeupSawCompletedHelperTool = false;
  private wakeupSawModelOutput = false;
  private wakeupSawLiveToolEvent = false;
  private wakeupSawPollActivity = false;
  private expiredPendingWork = false;

  constructor(timings?: Partial<AntigravityPollTimings>) {
    this.timings = { ...DEFAULT_ANTIGRAVITY_POLL_TIMINGS, ...timings };
  }

  getTimings(): AntigravityPollTimings {
    return this.timings;
  }

  /** Reset per-turn state before `session/prompt`; unfinished work carries into the new turn. */
  beginTurn(): void {
    this.turnToolIds = new Set();
    this.turnEndedAtMs = null;
    this.resetWakeupState();
    this.wakeupStartedToolIds.clear();
    this.awaitingReplyForSettledTool = false;
    this.expiredPendingWork = false;
  }

  /** Record a notification Lody received live on stdout. */
  observeLive(notification: acp.SessionNotification, nowMs = Date.now()): void {
    const raw = notification.update as unknown as Record<string, unknown>;
    const sessionUpdate = typeof raw.sessionUpdate === 'string' ? raw.sessionUpdate : undefined;
    const inMonitor = this.turnEndedAtMs !== null;
    if (inMonitor && sessionUpdate !== undefined) {
      if (sessionUpdate === 'agent_message_chunk' || sessionUpdate === 'agent_thought_chunk') {
        this.observedPostTurnLiveStream = true;
        this.wakeupSawModelOutput = true;
        this.lastActivityAtMs = nowMs;
        this.inWakeup = true;
      } else if (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update') {
        this.observedPostTurnLiveStream = true;
        this.wakeupSawLiveToolEvent = true;
        this.lastActivityAtMs = nowMs;
        this.inWakeup = true;
      }
    }
    if (
      (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') ||
      typeof raw.toolCallId !== 'string'
    ) {
      return;
    }
    const toolCallId = raw.toolCallId;
    const prev = this.tools.get(toolCallId);
    const nextKind = typeof raw.kind === 'string' ? raw.kind : prev?.kind;
    const nextName = toolName(raw) ?? prev?.name;
    const nextStatus =
      typeof raw.status === 'string'
        ? raw.status
        : (prev?.status ?? (sessionUpdate === 'tool_call' ? 'pending' : ''));
    const outputChanged = raw.rawOutput !== undefined || raw.content !== undefined;
    const nextPlaceholder =
      isNonBackgroundTool({ kind: nextKind, name: nextName }) || nextStatus === 'failed'
        ? false
        : outputChanged
          ? hasAntigravityBackgroundPlaceholder(raw, { kind: nextKind, name: nextName })
          : nextStatus === 'completed' && prev?.status !== 'completed'
            ? false
            : (prev?.placeholder ?? false);
    const nextTool: KnownTool = {
      status: nextStatus,
      kind: nextKind,
      name: nextName,
      daemon: (prev?.daemon ?? false) || isDaemonTool(raw),
      hasOutput: (prev?.hasOutput ?? false) || hasOutput(raw),
      placeholder: nextPlaceholder,
      wakeupCounted: prev?.wakeupCounted ?? false,
    };
    this.tools.set(toolCallId, nextTool);

    if (!inMonitor) {
      this.turnToolIds.add(toolCallId);
      if (!isToolStillPending(nextTool) && !isToolWakeupOnly(nextTool)) {
        const removed = this.pendingToolIds.delete(toolCallId);
        this.wakeupStartedToolIds.delete(toolCallId);
        if (removed && this.inferredCompletions > 0) {
          this.inferredCompletions -= 1;
        }
      }
      return;
    }

    if (isToolStillPending(nextTool)) {
      if (!this.pendingToolIds.has(toolCallId)) {
        this.pendingToolIds.add(toolCallId);
        if (this.pendingWakeups > 0 && !this.wakeupSawSettledTool) {
          this.wakeupStartedToolIds.add(toolCallId);
        }
      }
    } else if (isToolWakeupOnly(nextTool)) {
      this.pendingToolIds.delete(toolCallId);
      this.wakeupStartedToolIds.delete(toolCallId);
      if (!nextTool.wakeupCounted) {
        this.pendingWakeups += 1;
        nextTool.wakeupCounted = true;
      }
    } else {
      const wasWakeupStarted = this.wakeupStartedToolIds.delete(toolCallId);
      const removed = this.pendingToolIds.delete(toolCallId);
      if (removed && !wasWakeupStarted) {
        this.wakeupSawSettledTool = true;
        this.awaitingReplyForSettledTool = true;
      } else if (
        this.pendingWakeups > 0 &&
        !this.wakeupSawSettledTool &&
        (wasWakeupStarted || (prev === undefined && sessionUpdate === 'tool_call'))
      ) {
        this.wakeupSawCompletedHelperTool = true;
      }
    }
  }

  /**
   * Called when `session/prompt` resolves. Returns whether background work may still be
   * pending, in which case the caller starts a monitor.
   */
  turnEnded(stopReason: string | undefined, nowMs: number): boolean {
    if (stopReason === 'end_turn') {
      for (const id of this.turnToolIds) {
        const tool = this.tools.get(id);
        if (!tool) continue;
        if (isToolStillPending(tool)) {
          this.pendingToolIds.add(id);
        } else if (isToolWakeupOnly(tool)) {
          this.pendingToolIds.delete(id);
          if (!tool.wakeupCounted) {
            this.pendingWakeups += 1;
            tool.wakeupCounted = true;
          }
        }
      }
    }
    if (this.effectivePendingCount() === 0) {
      this.clearPendingState();
      return false;
    }
    this.turnEndedAtMs = nowMs;
    this.lastActivityAtMs = nowMs;
    this.resetWakeupState();
    return true;
  }

  /** `session/list` reported a new `updatedAt`. */
  noteActivity(nowMs: number): void {
    this.wakeupSawPollActivity = true;
    this.lastActivityAtMs = nowMs;
    this.inWakeup = true;
  }

  evaluate(nowMs: number): AntigravityMonitorState {
    if (this.inWakeup && nowMs - this.lastActivityAtMs >= this.timings.wakeupQuietMs) {
      const sawSettledTool = this.wakeupSawSettledTool;
      const sawModelOutput = this.wakeupSawModelOutput;
      const sawPollActivity = this.wakeupSawPollActivity;
      const sawWakeupCompletionSignal = sawModelOutput || this.wakeupSawCompletedHelperTool;
      const sawPollOnly = sawPollActivity && !this.wakeupSawLiveToolEvent;
      this.resetWakeupState();
      if (sawSettledTool) {
        if (sawModelOutput || sawPollActivity) {
          this.awaitingReplyForSettledTool = false;
        }
      } else if (this.awaitingReplyForSettledTool) {
        if (sawWakeupCompletionSignal) {
          this.awaitingReplyForSettledTool = false;
        }
      } else if (this.pendingWakeups > 0 && (sawWakeupCompletionSignal || sawPollOnly)) {
        if (sawWakeupCompletionSignal) {
          this.pendingWakeups -= 1;
          this.wakeupStartedToolIds.clear();
        } else if (this.effectivePendingCount() > 0) {
          this.inferredCompletions += 1;
        }
      } else if (
        !this.observedPostTurnLiveStream &&
        sawPollOnly &&
        this.effectivePendingCount() > 0
      ) {
        this.inferredCompletions += 1;
      }
    }
    const endedAtMs = this.turnEndedAtMs;
    if (endedAtMs === null || (this.effectivePendingCount() === 0 && !this.inWakeup)) {
      this.clearPendingState();
      this.expiredPendingWork = false;
      return { settled: true, state: 'idle', backgroundTaskCount: 0 };
    }
    if (nowMs - endedAtMs >= this.timings.maxDurationMs) {
      this.clearPendingState();
      this.expiredPendingWork = true;
      return { settled: true, state: 'idle', backgroundTaskCount: 0 };
    }
    return {
      settled: false,
      state:
        this.inWakeup && nowMs - this.lastActivityAtMs < this.timings.runningGraceMs
          ? 'running'
          : 'idle',
      backgroundTaskCount: Math.max(1, this.effectivePendingCount()),
    };
  }

  /** True when the monitor reached its protection cap with unconfirmed background work left. */
  hasExpiredPendingWork(): boolean {
    return this.expiredPendingWork;
  }

  private effectivePendingCount(): number {
    return Math.max(0, this.pendingToolIds.size + this.pendingWakeups - this.inferredCompletions);
  }

  private resetWakeupState(): void {
    this.inWakeup = false;
    this.wakeupSawSettledTool = false;
    this.wakeupSawCompletedHelperTool = false;
    this.wakeupSawModelOutput = false;
    this.wakeupSawLiveToolEvent = false;
    this.wakeupSawPollActivity = false;
  }

  private clearPendingState(): void {
    this.pendingToolIds.clear();
    this.wakeupStartedToolIds.clear();
    this.pendingWakeups = 0;
    this.inferredCompletions = 0;
    this.turnEndedAtMs = null;
    this.awaitingReplyForSettledTool = false;
    this.resetWakeupState();
  }
}

export function isMethodNotFoundError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.code === -32601) return true;
  return typeof error.message === 'string' && /method not found|-32601/i.test(error.message);
}

export interface AntigravityPollLoopOptions {
  /** Returns the session's `updatedAt`; omitted when the server lacks `session/list`. */
  listSessionUpdatedAt?: (signal: AbortSignal) => Promise<string | null | undefined>;
  onActivity: (nowMs: number) => void;
  /** Runs after every tick; returns true to stop. */
  step: (nowMs: number) => boolean;
  signal: AbortSignal;
  timings: AntigravityPollTimings;
  onError?: (error: unknown) => void;
}

async function withRpcTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  parent.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operationPromise = operation(controller.signal);
    operationPromise.catch(() => {});
    return await Promise.race([
      operationPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`Antigravity RPC timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        controller.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true }
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', onAbort);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Polls side-effect-free `session/list` for `updatedAt` changes. `session/load` is never used:
 * agy restarts the session's MCP servers on every load, which interrupts tool calls in progress.
 * Without a working `session/list` the monitor sees no activity and protects until its cap.
 */
export async function runAntigravityPollLoop(options: AntigravityPollLoopOptions): Promise<void> {
  const { signal, timings } = options;
  let list = options.listSessionUpdatedAt;
  let lastUpdatedAt: string | null | undefined;
  let baselineCaptured = false;
  let failures = 0;

  while (!signal.aborted) {
    await sleep(timings.listPollIntervalMs, signal);
    if (signal.aborted) break;
    const listFn = list;
    if (listFn) {
      try {
        const updatedAt = await withRpcTimeout(listFn, timings.rpcTimeoutMs, signal);
        if (baselineCaptured && updatedAt != null && updatedAt !== lastUpdatedAt) {
          options.onActivity(Date.now());
        }
        baselineCaptured = true;
        lastUpdatedAt = updatedAt;
        failures = 0;
      } catch (error) {
        if (signal.aborted) break;
        if (isMethodNotFoundError(error)) {
          list = undefined;
        } else {
          options.onError?.(error);
          failures += 1;
          if (failures >= timings.maxConsecutiveFailures) list = undefined;
        }
      }
    }
    if (options.step(Date.now())) break;
  }
}
