import { z } from 'zod';
import { isSensitiveAcpConfigOptionId } from './acp-config-option-sensitivity';
import type { SessionContextWindowUsage, SessionHistoryInput } from './schema';

/**
 * A Board coordinator is one continuous conversation. Lody keeps its history
 * whole and, when the coordinator sits idle with a large context, compacts the
 * agent's own context in place; the user can also start a fresh agent
 * conversation inside the same Session. Both are "maintenance": system-driven
 * turns that run in the coordinator's Session and render as one divider.
 */
export const BOARD_MAINTENANCE_TURN_PREFIX = 'board-maintenance:';

/** The divider turn of one maintenance run. */
export const boardMaintenanceTurnId = (runId: string): string =>
  `${BOARD_MAINTENANCE_TURN_PREFIX}${runId}`;

export type BoardMaintenanceStep = 'memory' | 'compact' | 'renew' | 'handoff' | 'seal' | 'fold';

/** The provenance id of one maintenance step; its assistant entry carries it as `userTurnId`. */
export const boardMaintenanceStepId = (runId: string, step: BoardMaintenanceStep): string =>
  `${BOARD_MAINTENANCE_TURN_PREFIX}${runId}:${step}`;

/** True for a divider turn id or a maintenance step's `userTurnId`. */
export const isBoardMaintenanceTurnId = (id: string | undefined): boolean =>
  id !== undefined && id.startsWith(BOARD_MAINTENANCE_TURN_PREFIX);

/** The run whose `renew` step a maintenance `userTurnId` names, or undefined for any other id. */
export function boardMaintenanceRenewRunId(userTurnId: string | undefined): string | undefined {
  const suffix = ':renew';
  return userTurnId?.startsWith(BOARD_MAINTENANCE_TURN_PREFIX) && userTurnId.endsWith(suffix)
    ? userTurnId.slice(BOARD_MAINTENANCE_TURN_PREFIX.length, -suffix.length)
    : undefined;
}

/** A maintenance step's assistant entry: hidden, its divider speaks for it. */
export const isBoardMaintenanceEntry = (
  entry: Pick<SessionHistoryInput, 'role' | 'userTurnId'>
): boolean => entry.role === 'assistant' && isBoardMaintenanceTurnId(entry.userTurnId);

/**
 * Agents whose `/compact` only starts a compaction in the background: the turn
 * ends first, so Lody can never confirm it and Board maintenance skips them like
 * an agent that cannot compact. Named by agent type because the `compaction`
 * capability (acp-extension-core) does not say when the compaction finishes.
 */
const BACKGROUND_COMPACTION_AGENT_TYPES: ReadonlySet<string> = new Set(['kimi', 'kimi-code']);
export const compactsInBackground = (agentType: string | undefined): boolean =>
  agentType !== undefined && BACKGROUND_COMPACTION_AGENT_TYPES.has(agentType);

export const BoardContinuityStrategySchema = z.enum(['compact', 'fold_rollover']);
export type BoardContinuityStrategy = z.infer<typeof BoardContinuityStrategySchema>;

export const BoardContinuitySettingsSchema = z.object({
  /** How Lody tidies the coordinator's context: native `/compact` or fold rollover. */
  strategy: BoardContinuityStrategySchema.default('compact'),
  /** Compact the coordinator's context once it sits idle with a large context. */
  idleCompaction: z.boolean().default(true),
  idleMinutes: z.number().int().min(1).max(1440).default(10),
  /** The context threshold is the smaller of this and `windowPercent` of the window. */
  maxTokens: z.number().int().min(10_000).max(10_000_000).default(150_000),
  windowPercent: z.number().int().min(5).max(95).default(40),
});
export type BoardContinuitySettings = z.infer<typeof BoardContinuitySettingsSchema>;
export const DEFAULT_BOARD_CONTINUITY: BoardContinuitySettings = {
  strategy: 'compact',
  idleCompaction: true,
  idleMinutes: 10,
  maxTokens: 150_000,
  windowPercent: 40,
};

/** Tokens at which an idle coordinator is compacted: min(cap, share of the window). */
export function boardCompactionThreshold(
  size: number | undefined,
  settings: Pick<BoardContinuitySettings, 'maxTokens' | 'windowPercent'>
): number {
  if (!size || !Number.isFinite(size) || size <= 0) return settings.maxTokens;
  return Math.min(settings.maxTokens, Math.floor((size * settings.windowPercent) / 100));
}

export type BoardIdleCompactionDecision =
  | { kind: 'compact' }
  | { kind: 'wait'; delayMs: number }
  | { kind: 'none'; reason: 'disabled' | 'no-usage' | 'below-threshold' };

/**
 * The usage policy: compact once the coordinator has been idle long enough and
 * its context, with the results its next input will carry, crossed the threshold.
 * Pure, so a thread's handoff hint can reuse it.
 */
export function decideBoardIdleCompaction(input: {
  settings: BoardContinuitySettings;
  usage: SessionContextWindowUsage | undefined;
  /** Estimated tokens of the Inbox results waiting for the next input. */
  pendingTokens: number;
  idleSinceMs: number;
  nowMs: number;
}): BoardIdleCompactionDecision {
  const { settings, usage } = input;
  if (!settings.idleCompaction) return { kind: 'none', reason: 'disabled' };
  if (!usage || !Number.isFinite(usage.used) || usage.used <= 0)
    return { kind: 'none', reason: 'no-usage' };
  if (usage.used + input.pendingTokens < boardCompactionThreshold(usage.size, settings))
    return { kind: 'none', reason: 'below-threshold' };
  const delayMs = input.idleSinceMs + settings.idleMinutes * 60_000 - input.nowMs;
  return delayMs > 0 ? { kind: 'wait', delayMs } : { kind: 'compact' };
}

export const BoardMaintenanceKindSchema = z.enum(['compact', 'new_conversation', 'fold_rollover']);
export type BoardMaintenanceKind = z.infer<typeof BoardMaintenanceKindSchema>;
export const BoardMaintenanceStatusSchema = z.enum([
  /** Asked for by the user; the coordinator's machine starts it when the coordinator is free. */
  'requested',
  'running',
  'done',
  /** The agent cannot compact its context. */
  'unsupported',
  'failed',
  /** Stopped, or yielded to the user's or the Inbox's next turn. */
  'interrupted',
]);
export type BoardMaintenanceStatus = z.infer<typeof BoardMaintenanceStatusSchema>;
/**
 * New conversation: the agent configuration on the coordinator's machine, and
 * its run settings, that the coordinator continues with. The limits of a
 * schedule's agent (`ScheduleAgentSchema`), written out because
 * `message-schemas` imports this module.
 */
export const BoardCoordinatorAgentSchema = z
  .object({
    agentConfigId: z.string().min(1),
    modeId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    configOptionValues: z
      .record(
        z
          .string()
          .min(1)
          .max(100)
          .refine(
            (key) => !isSensitiveAcpConfigOptionId(key),
            'Credentials belong in the Agent configuration'
          ),
        z.union([z.string().max(1024), z.boolean()])
      )
      .refine((value) => Object.keys(value).length <= 50, 'Too many config options')
      // A record parse copies the `$cid` Mirror leaves on a stored map; it is no option.
      .transform((values) =>
        Object.fromEntries(Object.entries(values).filter(([key]) => key !== '$cid'))
      )
      .optional(),
  })
  .strict();
export type BoardCoordinatorAgent = z.infer<typeof BoardCoordinatorAgentSchema>;
export const BoardMaintenanceMetaSchema = z
  .object({
    boardId: z.string().min(1),
    kind: BoardMaintenanceKindSchema,
    trigger: z.enum(['idle', 'manual']),
    status: BoardMaintenanceStatusSchema,
    usedBefore: z.number().nonnegative().optional(),
    usedAfter: z.number().nonnegative().optional(),
    /** The current Board instructions reached the agent after the context changed. */
    renewed: z.boolean().optional(),
    /**
     * New conversation: the handoff file the old agent wrote, or `none` when it
     * had no agent conversation. While the run is still `running`, the switch to
     * the new agent waits for a free moment.
     */
    handoff: z.string().min(1).max(200).optional(),
    /**
     * New conversation: the agent the user chose for it. The Session switches to
     * it when the new agent's first turn starts; that turn's `renew` entry marks
     * the switch in history. Absent: the coordinator keeps its agent and settings.
     */
    agent: BoardCoordinatorAgentSchema.optional(),
    /** Fold rollover: the sealed immutable segment node id. */
    nodeId: z.string().min(1).max(64).optional(),
    /** Fold rollover: the higher-level fold node id created in this run. */
    foldId: z.string().min(1).max(64).optional(),
    /** Fold rollover: number of lower-level nodes merged into `foldId`. */
    foldedCount: z.number().int().min(2).optional(),
    /** A short reason code, never agent output. */
    reason: z.string().max(200).optional(),
  })
  .strict();
export type BoardMaintenanceMeta = z.infer<typeof BoardMaintenanceMetaSchema>;

/** One maintenance run's divider: a system turn the coordinator's machine keeps current. */
export function boardMaintenanceTurn(
  runId: string,
  meta: BoardMaintenanceMeta,
  timestamp: string
): SessionHistoryInput {
  return {
    id: boardMaintenanceTurnId(runId),
    role: 'system',
    timestamp,
    fileDiff: [],
    items: [{ type: 'system_notice', name: 'board_context_maintenance', meta }],
  };
}

/**
 * An idle run that yielded before it changed anything leaves no divider on
 * screen: nothing happened that the user needs to know about.
 */
export const isSilentBoardMaintenance = (meta: BoardMaintenanceMeta): boolean =>
  meta.trigger === 'idle' && meta.status === 'interrupted';

/** The maintenance record of a divider turn, or undefined for any other turn. */
export function readBoardMaintenance(
  turn: Pick<SessionHistoryInput, 'id' | 'role' | 'items'>
): BoardMaintenanceMeta | undefined {
  if (turn.role !== 'system' || !isBoardMaintenanceTurnId(turn.id)) return undefined;
  const notice = turn.items?.find(
    (item) => item.type === 'system_notice' && item.name === 'board_context_maintenance'
  );
  const parsed = BoardMaintenanceMetaSchema.safeParse(
    notice?.type === 'system_notice' ? notice.meta : undefined
  );
  return parsed.success ? parsed.data : undefined;
}
