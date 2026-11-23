import type { RepoRoomSubscription } from 'loro-repo';
import type { ManagedStoreCache } from './store-ref-tracker';

type Binding = ReturnType<RepoRoomSubscription['subscription']>;
/** Keep an authored room referenced through detach/reconnect until its write is acknowledged. */
export function waitForScheduleWriteSync(binding: Binding, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let checking = false;
    let finished = false;
    let generation = 0;
    let off = () => {};
    const done = () => {
      if (finished) return;
      finished = true;
      off();
      signal.removeEventListener('abort', done);
      resolve();
    };
    const check = async () => {
      if (checking || finished || binding.status !== 'joined') return;
      checking = true;
      const current = generation;
      try {
        await binding.waitUntilSynced();
        if (current === generation && binding.status === 'joined') done();
      } catch {
        // Keep the write referenced until the next connection edge retries.
      } finally {
        checking = false;
        if (current !== generation) void check();
      }
    };
    off = binding.onStatusChange(() => {
      generation++;
      void check();
    });
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
    else void check();
  });
}

export type ScheduleWriteOptions = {
  create?: boolean;
  /** Latest Registry activationId observed by the caller; guards against stale local writes. */
  expectedActivationId?: string;
  /** Latest Registry updatedAt observed by the caller; lets strictly newer local docs proceed. */
  expectedUpdatedAt?: number;
  /** Upper bound on waiting for a missing or stale schedule document to sync. */
  syncTimeoutMs?: number;
};

export const SCHEDULE_WRITE_SYNC_TIMEOUT_MS = 10_000;

export class ScheduleSyncRequiredError extends Error {
  constructor() {
    super('Schedule is still syncing the latest version. Try again once connected.');
    this.name = 'ScheduleSyncRequiredError';
  }
}

export class ScheduleEditConflictError extends Error {
  constructor() {
    super('This schedule was updated elsewhere. Review the latest version before saving.');
    this.name = 'ScheduleEditConflictError';
  }
}

type ScheduleRevision = {
  activationId?: string;
  updatedAt?: number;
};

function readScheduleRevision(state: unknown): ScheduleRevision | null {
  if (!state || typeof state !== 'object') return null;
  const definition = (state as { definition?: unknown }).definition;
  if (!definition || typeof definition !== 'object') return {};
  const record = definition as { activationId?: unknown; updatedAt?: unknown };
  return {
    activationId: typeof record.activationId === 'string' ? record.activationId : undefined,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : undefined,
  };
}

/**
 * True when a locally cached ScheduleDocument lags behind the live Registry row.
 * Strictly newer local revisions (e.g. a live room update ahead of `:sr`) are
 * never treated as stale.
 */
export function isScheduleRevisionStale(
  state: unknown,
  expectedActivationId?: string,
  expectedUpdatedAt?: number
): boolean {
  if (!expectedActivationId) return false;
  const revision = readScheduleRevision(state);
  if (!revision) return true;
  if (revision.activationId === expectedActivationId) return false;
  if (
    expectedUpdatedAt !== undefined &&
    revision.updatedAt !== undefined &&
    revision.updatedAt > expectedUpdatedAt
  ) {
    return false;
  }
  return true;
}

async function waitForFreshScheduleState<
  S extends {
    getState(): unknown;
    firstSynced: Promise<void>;
    subscribe?: (listener: () => void) => () => void;
  },
>(store: S, options?: ScheduleWriteOptions): Promise<void> {
  if (options?.create) return;
  const initialState = store.getState();
  const expectedActivationId = options?.expectedActivationId;
  const expectedUpdatedAt = options?.expectedUpdatedAt;
  const needsHydration = !initialState;
  const needsFreshRevision =
    !!initialState && isScheduleRevisionStale(initialState, expectedActivationId, expectedUpdatedAt);
  if (!needsHydration && !needsFreshRevision) return;

  const timeoutMs = options?.syncTimeoutMs ?? SCHEDULE_WRITE_SYNC_TIMEOUT_MS;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      if (err !== undefined) reject(err);
      else resolve();
    };
    const isNowFresh = () => {
      const state = store.getState();
      if (!state) return false;
      return !isScheduleRevisionStale(state, expectedActivationId, expectedUpdatedAt);
    };
    const timer = setTimeout(() => finish(new ScheduleSyncRequiredError()), timeoutMs);
    if (store.subscribe) {
      unsubscribe = store.subscribe(() => {
        if (isNowFresh()) finish();
      });
    }
    void store.firstSynced.then(
      () => {
        const state = store.getState();
        // Absent doc after initial sync means it does not exist remotely;
        // callers without expectedActivationId only required initial hydration.
        if (!state || !expectedActivationId) {
          finish();
          return;
        }
        if (isNowFresh()) {
          finish();
          return;
        }
        if (!store.subscribe) finish(new ScheduleSyncRequiredError());
      },
      () => {
        finish(new ScheduleSyncRequiredError());
      }
    );
    if (isNowFresh()) finish();
  });
}

/** Resolve on local durability; hold the uploader through idle eviction and reconnect. */
export async function withScheduleWrite<
  T,
  S extends {
    dispose(): void;
    waitUntilSynced(): Promise<void>;
    getState(): unknown;
    firstSynced: Promise<void>;
    subscribe?: (listener: () => void) => () => void;
  },
>(
  cache: ManagedStoreCache<string, S>,
  id: string,
  write: (store: S) => T | Promise<T>,
  options?: ScheduleWriteOptions
): Promise<T> {
  const store = await cache.acquire(id);
  let wrote = false;
  try {
    await waitForFreshScheduleState(store, options);
    wrote = true;
    return await write(store);
  } finally {
    if (wrote) {
      void store
        .waitUntilSynced()
        .finally(() => cache.releaseRef(id))
        .catch(() => {});
    } else {
      cache.releaseRef(id);
    }
  }
}
