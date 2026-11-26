import { z } from 'zod';
import type { SessionContextWindowUsage, SessionHistoryInput } from './schema';

/**
 * Linear node rollover for ordinary Sessions (standalone chats, Board threads,
 * and child Tabs; Board coordinators use their own fold-rollover continuity).
 *
 * Underlying `:seal` and `:renew` turns carry this prefix in their `userTurnId`
 * and stay hidden in chat streams, unread counters, notifications, and exports.
 * The user sees a single quiet `session_context_rollover` divider row.
 */
export const SESSION_ROLLOVER_TURN_PREFIX = 'session-rollover:';

export type SessionRolloverStep = 'seal' | 'renew';

/** The divider turn id of one linear rollover run. */
export const sessionRolloverTurnId = (runId: string): string =>
  `${SESSION_ROLLOVER_TURN_PREFIX}${runId}`;

/** The provenance id of one rollover step; its assistant entry carries it as `userTurnId`. */
export const sessionRolloverStepId = (runId: string, step: SessionRolloverStep): string =>
  `${SESSION_ROLLOVER_TURN_PREFIX}${runId}:${step}`;

/** True for a rollover divider turn id or a rollover step's `userTurnId`. */
export const isSessionRolloverTurnId = (id: string | undefined): boolean =>
  id !== undefined && id.startsWith(SESSION_ROLLOVER_TURN_PREFIX);

/** Extract the rollover step (`seal` | `renew`) encoded in a step `userTurnId`, if any. */
export function sessionRolloverStepOfTurnId(
  id: string | undefined
): SessionRolloverStep | undefined {
  if (!id || !id.startsWith(SESSION_ROLLOVER_TURN_PREFIX)) return undefined;
  const suffixIndex = id.lastIndexOf(':');
  if (suffixIndex <= SESSION_ROLLOVER_TURN_PREFIX.length) return undefined;
  const step = id.slice(suffixIndex + 1);
  return step === 'seal' || step === 'renew' ? step : undefined;
}

/** A rollover step's assistant entry: hidden, its divider speaks for it. */
export const isSessionRolloverEntry = (
  entry: Pick<SessionHistoryInput, 'role' | 'userTurnId'>
): boolean => entry.role === 'assistant' && isSessionRolloverTurnId(entry.userTurnId);

/** True for a hidden `:seal` assistant entry. */
export const isSessionRolloverSealEntry = (
  entry: Pick<SessionHistoryInput, 'role' | 'userTurnId'>
): boolean =>
  entry.role === 'assistant' && sessionRolloverStepOfTurnId(entry.userTurnId) === 'seal';

/** True for a hidden `:renew` assistant entry. */
export const isSessionRolloverRenewEntry = (
  entry: Pick<SessionHistoryInput, 'role' | 'userTurnId'>
): boolean =>
  entry.role === 'assistant' && sessionRolloverStepOfTurnId(entry.userTurnId) === 'renew';

export const SessionRolloverTriggerSchema = z.enum(['manual', 'auto', 'recovery']);
export type SessionRolloverTrigger = z.infer<typeof SessionRolloverTriggerSchema>;

export const SessionRolloverStatusSchema = z.enum([
  'sealing',
  'sealed',
  'switching',
  'done',
  'failed',
  'interrupted',
]);
export type SessionRolloverStatus = z.infer<typeof SessionRolloverStatusSchema>;

export const SessionRolloverNoticeMetaSchema = z
  .object({
    kind: z.literal('linear_rollover'),
    trigger: SessionRolloverTriggerSchema,
    status: SessionRolloverStatusSchema,
    generation: z.number().int().min(1),
    nodeId: z.string().min(1).max(64).optional(),
    usedBefore: z.number().nonnegative().optional(),
    usedAfter: z.number().nonnegative().optional(),
    reason: z.string().max(200).optional(),
  })
  .strict();
export type SessionRolloverNoticeMeta = z.infer<typeof SessionRolloverNoticeMetaSchema>;

/**
 * One rollover run's divider: a system turn kept up to date across `sealing`,
 * `sealed`, `switching`, and terminal states. `finished: true` is stamped only
 * when `status === 'done'` so scalar-only directory readers (`resolveEditableTail`)
 * recognize a completed node boundary without reading turn bodies.
 */
export function sessionRolloverTurn(
  runId: string,
  meta: SessionRolloverNoticeMeta,
  timestamp: string
): SessionHistoryInput {
  return {
    id: sessionRolloverTurnId(runId),
    role: 'system',
    timestamp,
    ...(meta.status === 'done' ? { finished: true } : {}),
    fileDiff: [],
    items: [{ type: 'system_notice', name: 'session_context_rollover', meta }],
  };
}

/** Read the rollover notice metadata from a divider turn, or undefined for any other turn. */
export function readSessionRolloverNotice(
  turn: Pick<SessionHistoryInput, 'id' | 'role' | 'items'>
): SessionRolloverNoticeMeta | undefined {
  if (turn.role !== 'system' || !isSessionRolloverTurnId(turn.id)) return undefined;
  const notice = turn.items?.find(
    (item) => item.type === 'system_notice' && item.name === 'session_context_rollover'
  );
  const parsed = SessionRolloverNoticeMetaSchema.safeParse(
    notice?.type === 'system_notice' ? notice.meta : undefined
  );
  return parsed.success ? parsed.data : undefined;
}

/**
 * An automatic (`auto` or `recovery`) rollover attempt that yielded/interrupted
 * before switching leaves no divider on screen: nothing changed that the user
 * needs to know about.
 */
export const isSilentSessionRollover = (meta: SessionRolloverNoticeMeta): boolean =>
  (meta.trigger === 'auto' || meta.trigger === 'recovery') && meta.status === 'interrupted';

/** Default absolute context ceiling (tokens) for proactive linear rollover. */
export const DEFAULT_SESSION_ROLLOVER_MAX_TOKENS = 350_000;
/** Default context-window ratio (35%) before absolute ceiling kicks in. */
export const DEFAULT_SESSION_ROLLOVER_WINDOW_RATIO = 0.35;
/** Minimum token growth since the last rollover before auto-rollover may trigger again. */
export const DEFAULT_SESSION_ROLLOVER_MIN_DELTA_TOKENS = 80_000;

export type SessionRolloverThresholdSettings = {
  /** Absolute token cap (default 350,000). */
  maxTokens?: number;
  /** Fraction of context window in (0, 1] (default 0.35). */
  windowRatio?: number;
  /** Alternative integer percentage form (e.g. 35 -> 0.35); ignored if `windowRatio` is set. */
  windowPercent?: number;
  /** Minimum net token increase since last rollover (default 80,000). */
  minDeltaTokens?: number;
};

/**
 * Context-window token threshold for proactive rollover:
 * `min(maxTokens, floor(size * windowRatio))` (default `min(350_000, floor(size * 0.35))`).
 * Falls back to `maxTokens` (350,000) when `size` is absent or non-positive.
 */
export function sessionRolloverThreshold(
  size: number | undefined,
  settings?: SessionRolloverThresholdSettings
): number {
  const maxTokens =
    settings?.maxTokens !== undefined && Number.isFinite(settings.maxTokens) && settings.maxTokens > 0
      ? Math.floor(settings.maxTokens)
      : DEFAULT_SESSION_ROLLOVER_MAX_TOKENS;
  const ratio =
    settings?.windowRatio !== undefined &&
    Number.isFinite(settings.windowRatio) &&
    settings.windowRatio > 0
      ? settings.windowRatio
      : settings?.windowPercent !== undefined &&
          Number.isFinite(settings.windowPercent) &&
          settings.windowPercent > 0
        ? settings.windowPercent / 100
        : DEFAULT_SESSION_ROLLOVER_WINDOW_RATIO;
  if (!size || !Number.isFinite(size) || size <= 0) {
    return maxTokens;
  }
  return Math.min(maxTokens, Math.floor(size * ratio));
}

export type SessionAutoRolloverSkipReason =
  | 'disabled'
  | 'coordinator'
  | 'goal_active'
  | 'pinned_native_session'
  | 'pending_native_work'
  | 'queued_messages'
  | 'pending_switch'
  | 'compacted_in_turn'
  | 'no_usage'
  | 'below_threshold'
  | 'below_min_delta';

export type SessionAutoRolloverDecision =
  | {
      readonly shouldRollover: true;
      readonly threshold: number;
      readonly used: number;
      readonly delta: number;
    }
  | {
      readonly shouldRollover: false;
      readonly reason: SessionAutoRolloverSkipReason;
      readonly threshold?: number;
    };

export type SessionAutoRolloverInput = {
  readonly enabled?: boolean;
  readonly usage: SessionContextWindowUsage | undefined;
  readonly usedAfterLastRollover?: number;
  readonly isBoardCoordinator?: boolean;
  readonly isGoalActive?: boolean;
  readonly hasPinnedNativeSessionId?: boolean;
  readonly hasPendingNativeWork?: boolean;
  readonly hasQueuedUserMessages?: boolean;
  readonly hasPendingSwitch?: boolean;
  readonly compactedInThisTurn?: boolean;
  readonly settings?: SessionRolloverThresholdSettings;
};

/**
 * Pure safety-gate evaluator for end-of-turn proactive warm `:seal`.
 * Every safety gate must pass before auto-rollover triggers.
 */
export function decideSessionAutoRollover(
  input: SessionAutoRolloverInput
): SessionAutoRolloverDecision {
  if (input.enabled === false) {
    return { shouldRollover: false, reason: 'disabled' };
  }
  if (input.isBoardCoordinator) {
    return { shouldRollover: false, reason: 'coordinator' };
  }
  if (input.isGoalActive) {
    return { shouldRollover: false, reason: 'goal_active' };
  }
  if (input.hasPinnedNativeSessionId) {
    return { shouldRollover: false, reason: 'pinned_native_session' };
  }
  if (input.hasPendingNativeWork) {
    return { shouldRollover: false, reason: 'pending_native_work' };
  }
  if (input.hasQueuedUserMessages) {
    return { shouldRollover: false, reason: 'queued_messages' };
  }
  if (input.hasPendingSwitch) {
    return { shouldRollover: false, reason: 'pending_switch' };
  }
  if (input.compactedInThisTurn) {
    return { shouldRollover: false, reason: 'compacted_in_turn' };
  }
  const usage = input.usage;
  if (!usage || !Number.isFinite(usage.used) || usage.used <= 0) {
    return { shouldRollover: false, reason: 'no_usage' };
  }
  const threshold = sessionRolloverThreshold(usage.size, input.settings);
  if (usage.used < threshold) {
    return { shouldRollover: false, reason: 'below_threshold', threshold };
  }
  const minDelta =
    input.settings?.minDeltaTokens !== undefined &&
    Number.isFinite(input.settings.minDeltaTokens) &&
    input.settings.minDeltaTokens >= 0
      ? Math.floor(input.settings.minDeltaTokens)
      : DEFAULT_SESSION_ROLLOVER_MIN_DELTA_TOKENS;
  const baseline =
    input.usedAfterLastRollover !== undefined &&
    Number.isFinite(input.usedAfterLastRollover) &&
    input.usedAfterLastRollover >= 0
      ? input.usedAfterLastRollover
      : 0;
  const delta = usage.used - baseline;
  if (delta < minDelta) {
    return { shouldRollover: false, reason: 'below_min_delta', threshold };
  }
  return {
    shouldRollover: true,
    threshold,
    used: usage.used,
    delta,
  };
}
