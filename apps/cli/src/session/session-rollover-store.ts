import type { SessionId } from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Logger } from '@/utils/logger';

export const SESSION_ROLLOVER_STATE_VERSION = 1 as const;
export const SESSION_ROLLOVER_MAX_SPINE_ENTRIES = 8;

export type SessionRolloverReason =
  | 'manual_command'
  | 'proactive_threshold'
  | 'post_compact_recovery';

export type SessionRolloverStateCard = {
  /** Current goal and phase plan (<= 400 tok). */
  goalAndPlan: string;
  /**
   * Protected slot: confirmed features to preserve, UI/UX red lines, and negative
   * prohibitions. Only grows or shrinks by explicit revocation — never merged into
   * completed progress and trimmed. (<= 700 tok)
   */
  lockedInvariants: string[];
  /** Still-valid key decisions, rationale, and eliminated dead ends (<= 600 tok). */
  decisionsAndDeadEnds: string[];
  /** Workspace facts, key files, verification state, and doc paths such as invariants.md (<= 500 tok). */
  workspaceFacts: string;
  /** Open questions and immediate next steps (<= 400 tok). */
  openAndNext: string;
};

export type SessionRolloverSpineItem = {
  gen: number;
  nodeId: string;
  window: string;
  startTurnId: string;
  endTurnId: string;
  turnCount: number;
  oneLiner: string;
  quality: 'warm_llm' | 'cold_llm' | 'fallback';
};

export type SessionRolloverPendingSwitch = {
  runId: string;
  targetGen: number;
  nodeId: string;
  reason: SessionRolloverReason;
  sourceAcpSessionId?: string;
  /** Last ordinary Loro turnId covered by this seal (strictly monotonic, prevents tail overlap). */
  sealedThroughTurnId: string;
  sealedAtMs: number;
  usedBefore?: number;
  userHint?: string;
  /** Fresh ACP session created for an in-flight `:renew` attempt before completion. */
  attemptingAcpSessionId?: string;
  /** Recorded once `:renew` has completed on a fresh ACP session, for crash-recovery convergence. */
  preparedAcpSessionId?: string;
};

export type SessionRolloverState = {
  version: 1;
  sessionId: SessionId;
  generation: number;
  activeAcpSessionId?: string;
  originTurnId?: string;
  lastSealedTurnId?: string;
  usedAfterLastRollover?: number;
  degradedByNativeCompact?: boolean;
  stateCard: SessionRolloverStateCard;
  spine: SessionRolloverSpineItem[];
  pendingSwitch?: SessionRolloverPendingSwitch;
  updatedAt: number;
};

export type SessionRolloverStore = {
  get(sessionId: SessionId): Promise<SessionRolloverState | undefined>;
  set(sessionId: SessionId, state: SessionRolloverState): Promise<void>;
  update(
    sessionId: SessionId,
    updater: (current: SessionRolloverState | undefined) => SessionRolloverState | undefined
  ): Promise<SessionRolloverState | undefined>;
  clear(sessionId: SessionId): Promise<void>;
};

const SessionRolloverReasonSchema = z.enum([
  'manual_command',
  'proactive_threshold',
  'post_compact_recovery',
]);

const SessionRolloverStateCardSchema = z.object({
  goalAndPlan: z.string(),
  lockedInvariants: z.array(z.string()),
  decisionsAndDeadEnds: z.array(z.string()),
  workspaceFacts: z.string(),
  openAndNext: z.string(),
});

const SessionRolloverSpineItemSchema = z.object({
  gen: z.number().int().min(1),
  nodeId: z.string().min(1).max(64),
  window: z.string(),
  startTurnId: z.string().min(1),
  endTurnId: z.string().min(1),
  turnCount: z.number().int().nonnegative(),
  oneLiner: z.string(),
  quality: z.enum(['warm_llm', 'cold_llm', 'fallback']),
});

const SessionRolloverPendingSwitchSchema = z.object({
  runId: z.string().min(1),
  targetGen: z.number().int().min(1),
  nodeId: z.string().min(1).max(64),
  reason: SessionRolloverReasonSchema,
  sourceAcpSessionId: z.string().min(1).optional(),
  sealedThroughTurnId: z.string().min(1),
  sealedAtMs: z.number().nonnegative(),
  usedBefore: z.number().nonnegative().optional(),
  userHint: z.string().optional(),
  attemptingAcpSessionId: z.string().min(1).optional(),
  preparedAcpSessionId: z.string().min(1).optional(),
});

const SessionRolloverStateSchema = z.object({
  version: z.literal(SESSION_ROLLOVER_STATE_VERSION),
  sessionId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  activeAcpSessionId: z.string().min(1).optional(),
  originTurnId: z.string().min(1).optional(),
  lastSealedTurnId: z.string().min(1).optional(),
  usedAfterLastRollover: z.number().nonnegative().optional(),
  degradedByNativeCompact: z.boolean().optional(),
  stateCard: SessionRolloverStateCardSchema,
  spine: z.array(SessionRolloverSpineItemSchema),
  pendingSwitch: SessionRolloverPendingSwitchSchema.optional(),
  updatedAt: z.number(),
});

export function createEmptySessionRolloverStateCard(): SessionRolloverStateCard {
  return {
    goalAndPlan: '',
    lockedInvariants: [],
    decisionsAndDeadEnds: [],
    workspaceFacts: '',
    openAndNext: '',
  };
}

export function createInitialSessionRolloverState(
  sessionId: SessionId,
  nowMs: number
): SessionRolloverState {
  return {
    version: SESSION_ROLLOVER_STATE_VERSION,
    sessionId,
    generation: 0,
    stateCard: createEmptySessionRolloverStateCard(),
    spine: [],
    updatedAt: nowMs,
  };
}

function cloneState(state: SessionRolloverState): SessionRolloverState {
  return {
    ...state,
    stateCard: {
      ...state.stateCard,
      lockedInvariants: [...state.stateCard.lockedInvariants],
      decisionsAndDeadEnds: [...state.stateCard.decisionsAndDeadEnds],
    },
    spine: state.spine.map((item) => ({ ...item })),
    ...(state.pendingSwitch ? { pendingSwitch: { ...state.pendingSwitch } } : {}),
  };
}

function normalizeStateForPersistence(
  sessionId: SessionId,
  state: SessionRolloverState
): SessionRolloverState {
  const cloned = cloneState(state);
  cloned.version = SESSION_ROLLOVER_STATE_VERSION;
  cloned.sessionId = sessionId;
  if (cloned.spine.length > SESSION_ROLLOVER_MAX_SPINE_ENTRIES) {
    cloned.spine = cloned.spine.slice(-SESSION_ROLLOVER_MAX_SPINE_ENTRIES);
  }
  return cloned;
}

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Thrown by the file-backed rollover store when reading an existing state file
 * fails with a non-`ENOENT` I/O error (e.g. `EACCES`, `EMFILE`, `EIO`). Callers
 * and `update()` MUST fail closed rather than treating the error as an empty
 * gen-0 state and overwriting persisted state on disk.
 */
export class SessionRolloverStoreReadError extends Error {
  readonly code?: string;
  constructor(sessionId: SessionId, cause: unknown) {
    const code = (cause as NodeJS.ErrnoException | null | undefined)?.code;
    super(
      `Failed to read session rollover state for ${sessionId}${code ? ` (${code})` : ''}: ${formatError(cause)}`,
      { cause }
    );
    this.name = 'SessionRolloverStoreReadError';
    this.code = code;
  }
}

export function createMemorySessionRolloverStore(): SessionRolloverStore {
  const states = new Map<SessionId, SessionRolloverState>();
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

  return {
    get(sessionId) {
      return enqueue(sessionId, async () => {
        const state = states.get(sessionId);
        return state ? cloneState(state) : undefined;
      });
    },
    set(sessionId, state) {
      return enqueue(sessionId, async () => {
        states.set(sessionId, normalizeStateForPersistence(sessionId, state));
      });
    },
    update(sessionId, updater) {
      return enqueue(sessionId, async () => {
        const current = states.get(sessionId);
        const next = updater(current ? cloneState(current) : undefined);
        if (next === undefined) {
          states.delete(sessionId);
          return undefined;
        }
        const normalized = normalizeStateForPersistence(sessionId, next);
        states.set(sessionId, normalized);
        return cloneState(normalized);
      });
    },
    clear(sessionId) {
      return enqueue(sessionId, async () => {
        states.delete(sessionId);
      });
    },
  };
}

/**
 * Machine-local per-session linear rollover state store under
 * `<lodyDataDir>/session-rollover/<sha256(sessionId)>.json`.
 *
 * Kept strictly outside `SessionMeta` CRDT sync so linear rollover adds zero
 * synced metadata churn and zero cross-LAN schema compatibility risk, while
 * surviving daemon restarts and idle ACP garbage collection.
 */
export function createFileSessionRolloverStore(options?: {
  rootDir?: string;
  logger?: Logger;
}): SessionRolloverStore {
  const resolveRootDir = () => options?.rootDir ?? path.join(getLodyDataDir(), 'session-rollover');
  const filePathFor = (sessionId: SessionId): string => {
    const hash = createHash('sha256').update(sessionId).digest('hex');
    return path.join(resolveRootDir(), `${hash}.json`);
  };

  const cache = new Map<SessionId, SessionRolloverState | null>();
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

  const readFromDisk = async (
    sessionId: SessionId
  ): Promise<{ state: SessionRolloverState | undefined; cacheable: boolean }> => {
    let raw: string;
    try {
      raw = await readFile(filePathFor(sessionId), 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
      if (code === 'ENOENT') {
        return { state: undefined, cacheable: true };
      }
      options?.logger?.warn(
        `[${sessionId}] Failed to read session rollover state; refusing to treat as empty: ${formatError(error)}`
      );
      throw new SessionRolloverStoreReadError(sessionId, error);
    }
    try {
      const parsed = SessionRolloverStateSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.sessionId !== sessionId) {
        options?.logger?.warn(
          `[${sessionId}] Ignoring invalid session rollover state file on disk`
        );
        return { state: undefined, cacheable: true };
      }
      return {
        state: normalizeStateForPersistence(sessionId, parsed.data as SessionRolloverState),
        cacheable: true,
      };
    } catch (error) {
      options?.logger?.warn(
        `[${sessionId}] Failed to parse session rollover state JSON: ${formatError(error)}`
      );
      return { state: undefined, cacheable: true };
    }
  };

  const getUnlocked = async (sessionId: SessionId): Promise<SessionRolloverState | undefined> => {
    if (cache.has(sessionId)) {
      const cached = cache.get(sessionId);
      return cached ? cloneState(cached) : undefined;
    }
    const { state, cacheable } = await readFromDisk(sessionId);
    if (cacheable) {
      cache.set(sessionId, state ?? null);
    }
    return state ? cloneState(state) : undefined;
  };

  const writeUnlocked = async (
    sessionId: SessionId,
    state: SessionRolloverState
  ): Promise<SessionRolloverState> => {
    const normalized = normalizeStateForPersistence(sessionId, state);
    const targetPath = filePathFor(sessionId);
    const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryPath, targetPath);
      cache.set(sessionId, normalized);
      return normalized;
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      options?.logger?.warn(
        `[${sessionId}] Failed to persist session rollover state: ${formatError(error)}`
      );
      throw error;
    }
  };

  const clearUnlocked = async (sessionId: SessionId): Promise<void> => {
    cache.set(sessionId, null);
    try {
      await rm(filePathFor(sessionId), { force: true });
    } catch (error) {
      options?.logger?.debug(
        `[${sessionId}] Failed to remove session rollover state file: ${formatError(error)}`
      );
    }
  };

  return {
    get(sessionId) {
      return enqueue(sessionId, () => getUnlocked(sessionId));
    },
    set(sessionId, state) {
      return enqueue(sessionId, async () => {
        await writeUnlocked(sessionId, state);
      });
    },
    update(sessionId, updater) {
      return enqueue(sessionId, async () => {
        const current = await getUnlocked(sessionId);
        const next = updater(current);
        if (next === undefined) {
          await clearUnlocked(sessionId);
          return undefined;
        }
        const saved = await writeUnlocked(sessionId, next);
        return cloneState(saved);
      });
    },
    clear(sessionId) {
      return enqueue(sessionId, () => clearUnlocked(sessionId));
    },
  };
}
