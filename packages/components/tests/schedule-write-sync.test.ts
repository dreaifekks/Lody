import { describe, expect, it, vi } from 'vitest';
import { createManagedStoreCache } from '../src/providers/store-ref-tracker';
import {
  isScheduleRevisionStale,
  ScheduleSyncRequiredError,
  waitForScheduleWriteSync,
  withScheduleWrite,
} from '../src/providers/schedule-write-sync';

describe('schedule-write-sync', () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  describe('Schedule authored write synchronization', () => {
    it('opens an unopened document before writing and retains it through offline idle cleanup until acknowledgement', async () => {
      const ack = deferred();
      const dispose = vi.fn();
      const create = vi.fn(async () => ({
        dispose,
        waitUntilSynced: () => ack.promise,
        getState: () => ({}),
        firstSynced: Promise.resolve(),
      }));
      const cache = createManagedStoreCache({ create, releaseDelayMs: 60_000 });
      const write = vi.fn(() => {
        expect(create).toHaveBeenCalledWith('schedule');
        return 'saved locally';
      });
      expect(await withScheduleWrite(cache, 'schedule', write)).toBe('saved locally');
      await cache.releaseIdle();
      expect(dispose).not.toHaveBeenCalled();
      ack.resolve();
      await ack.promise;
      await cache.releaseIdle();
      expect(dispose).toHaveBeenCalledOnce();
      await cache.disposeAll();
    });

    it('does not accept an acknowledgement from an old connection generation', async () => {
      let status = 'joined';
      let notify = () => {};
      const old = deferred();
      const current = deferred();
      const waitUntilSynced = vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise);
      const off = vi.fn();
      const binding = {
        get status() {
          return status;
        },
        waitUntilSynced,
        onStatusChange: (listener: () => void) => {
          notify = listener;
          return off;
        },
      };
      const abort = new AbortController();
      const done = vi.fn();
      const result = waitForScheduleWriteSync(binding as never, abort.signal).then(done);
      status = 'detached';
      notify();
      status = 'joined';
      notify();
      old.resolve();
      await old.promise;
      expect(done).not.toHaveBeenCalled();
      expect(waitUntilSynced).toHaveBeenCalledTimes(2);
      current.resolve();
      await result;
      expect(done).toHaveBeenCalledOnce();
      expect(off).toHaveBeenCalledOnce();
    });
  });

  it('waits for a missing definition to hydrate before mutating a Registry-only schedule', async () => {
    const hydrate = deferred();
    const cache = createManagedStoreCache({
      releaseDelayMs: 60_000,
      create: async () => ({
        dispose() {},
        getState: () => null,
        firstSynced: hydrate.promise,
        waitUntilSynced: async () => {},
      }),
    });
    const write = vi.fn(() => 'paused');
    const pending = withScheduleWrite(cache, 'unopened', write);
    await cache.get('unopened');
    expect(write).not.toHaveBeenCalled();
    hydrate.resolve();
    expect(await pending).toBe('paused');
    await cache.disposeAll();
  });
  it('creates a new definition offline without waiting for remote hydration', async () => {
    const cache = createManagedStoreCache({
      releaseDelayMs: 60_000,
      create: async () => ({
        dispose() {},
        getState: () => null,
        firstSynced: new Promise<void>(() => {}),
        waitUntilSynced: async () => {},
      }),
    });
    expect(await withScheduleWrite(cache, 'new', () => 'created', { create: true })).toBe(
      'created'
    );
    await cache.disposeAll();
  });

  it('waits for remote sync before writing when the cached document lags behind the Registry', async () => {
    const hydrate = deferred();
    const listeners = new Set<() => void>();
    let state = { definition: { activationId: 'old-claude', updatedAt: 1000 } };
    const cache = createManagedStoreCache({
      releaseDelayMs: 60_000,
      create: async () => ({
        dispose() {},
        getState: () => state,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        firstSynced: hydrate.promise,
        waitUntilSynced: async () => {},
      }),
    });
    const observed: string[] = [];
    const write = vi.fn((store: { getState: () => typeof state }) => {
      observed.push(store.getState().definition.activationId);
      return 'paused';
    });
    const pending = withScheduleWrite(cache, 'stale', write, {
      expectedActivationId: 'new-neon',
      expectedUpdatedAt: 2000,
    });
    await cache.get('stale');
    expect(write).not.toHaveBeenCalled();

    // Intermediate stale revisions (older or same-timestamp other activation)
    // must never unblock the write before the target or strictly newer revision arrives.
    state = { definition: { activationId: 'mid-claude', updatedAt: 1500 } };
    listeners.forEach((listener) => listener());
    hydrate.resolve();
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();

    state = { definition: { activationId: 'same-ts-other', updatedAt: 2000 } };
    listeners.forEach((listener) => listener());
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();

    state = { definition: { activationId: 'new-neon', updatedAt: 2000 } };
    listeners.forEach((listener) => listener());

    expect(await pending).toBe('paused');
    expect(observed).toEqual(['new-neon']);
    expect(listeners.size).toBe(0);
    await cache.disposeAll();
  });

  it('keeps waiting when initial hydration returns a revision older than expectedActivationId', async () => {
    const hydrate = deferred();
    const listeners = new Set<() => void>();
    let state: { definition: { activationId: string; updatedAt: number } } | null = null;
    const cache = createManagedStoreCache({
      releaseDelayMs: 60_000,
      create: async () => ({
        dispose() {},
        getState: () => state,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        firstSynced: hydrate.promise,
        waitUntilSynced: async () => {},
      }),
    });
    const write = vi.fn((store: { getState: () => typeof state }) => store.getState()?.definition);
    const pending = withScheduleWrite(cache, 'cold-stale', write, {
      expectedActivationId: 'target',
      expectedUpdatedAt: 2000,
    });
    await cache.get('cold-stale');

    // Initial sync finishes while only an older revision is present.
    state = { definition: { activationId: 'old', updatedAt: 1000 } };
    listeners.forEach((listener) => listener());
    hydrate.resolve();
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();

    // Only a strictly newer revision (or exact target) unblocks the write.
    state = { definition: { activationId: 'newer', updatedAt: 2001 } };
    listeners.forEach((listener) => listener());
    expect(await pending).toEqual({ activationId: 'newer', updatedAt: 2001 });
    expect(listeners.size).toBe(0);
    await cache.disposeAll();
  });

  it('waits for a live update when a warm cached store already completed firstSynced', async () => {
    const listeners = new Set<() => void>();
    let state = { definition: { activationId: 'v1', updatedAt: 1000 } };
    const cache = createManagedStoreCache({
      releaseDelayMs: 60_000,
      create: async () => ({
        dispose() {},
        getState: () => state,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        firstSynced: Promise.resolve(),
        waitUntilSynced: async () => {},
      }),
    });
    const write = vi.fn((store: { getState: () => typeof state }) => store.getState().definition);
    const pending = withScheduleWrite(cache, 'warm-stale', write, {
      expectedActivationId: 'v2',
      expectedUpdatedAt: 2000,
    });
    await cache.get('warm-stale');
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();

    state = { definition: { activationId: 'v2', updatedAt: 2000 } };
    listeners.forEach((listener) => listener());

    expect(await pending).toEqual({ activationId: 'v2', updatedAt: 2000 });
    expect(listeners.size).toBe(0);
    await cache.disposeAll();
  });

  it('writes offline immediately when local state matches or is newer than the Registry row', async () => {
    let state = { definition: { activationId: 'v2', updatedAt: 2000 } };
    const cache = createManagedStoreCache({
      releaseDelayMs: 60_000,
      create: async () => ({
        dispose() {},
        getState: () => state,
        firstSynced: new Promise<void>(() => {}),
        waitUntilSynced: async () => {},
      }),
    });
    expect(
      await withScheduleWrite(cache, 'current', () => 'matched', {
        expectedActivationId: 'v2',
        expectedUpdatedAt: 2000,
      })
    ).toBe('matched');

    state = { definition: { activationId: 'v3', updatedAt: 3000 } };
    expect(
      await withScheduleWrite(cache, 'current', () => 'newer', {
        expectedActivationId: 'v2',
        expectedUpdatedAt: 2000,
      })
    ).toBe('newer');
    expect(isScheduleRevisionStale(state, 'v2', 2000)).toBe(false);
    expect(isScheduleRevisionStale({ definition: { activationId: 'v1', updatedAt: 1000 } }, 'v2', 2000)).toBe(true);
    await cache.disposeAll();
  });

  it('rejects and releases its store ref when a stale document cannot sync within timeout, then allows retry', async () => {
    vi.useFakeTimers();
    try {
      const dispose = vi.fn();
      const listeners = new Set<() => void>();
      let state = { definition: { activationId: 'old-claude', updatedAt: 1000 } };
      let sync = deferred();
      const cache = createManagedStoreCache({
        releaseDelayMs: 60_000,
        create: async () => ({
          dispose,
          getState: () => state,
          subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          firstSynced: sync.promise,
          waitUntilSynced: () => new Promise<void>(() => {}),
        }),
      });
      const write = vi.fn(() => 'should-not-run');
      const pending = withScheduleWrite(cache, 'offline-stale', write, {
        expectedActivationId: 'new-neon',
        expectedUpdatedAt: 2000,
        syncTimeoutMs: 500,
      });
      const rejection = expect(pending).rejects.toBeInstanceOf(ScheduleSyncRequiredError);
      await vi.advanceTimersByTimeAsync(500);
      await rejection;
      expect(write).not.toHaveBeenCalled();
      expect(listeners.size).toBe(0);
      // Ref must be released immediately since no local write occurred.
      await cache.releaseIdle();
      expect(dispose).toHaveBeenCalledOnce();

      // Reconnecting later succeeds cleanly on retry.
      sync = deferred();
      const retryWrite = vi.fn((store: { getState: () => typeof state }) => store.getState().definition.activationId);
      const retry = withScheduleWrite(cache, 'offline-stale', retryWrite, {
        expectedActivationId: 'new-neon',
        expectedUpdatedAt: 2000,
        syncTimeoutMs: 500,
      });
      await cache.get('offline-stale');
      state = { definition: { activationId: 'new-neon', updatedAt: 2000 } };
      listeners.forEach((listener) => listener());
      sync.resolve();
      expect(await retry).toBe('new-neon');
      await cache.disposeAll();
    } finally {
      vi.useRealTimers();
    }
  });
});
