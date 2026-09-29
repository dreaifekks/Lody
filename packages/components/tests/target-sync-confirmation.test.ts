import { describe, expect, it } from 'vitest';
import type { RepoSyncReport } from 'loro-repo';
import { confirmTargetSync } from '../src/providers/target-sync-confirmation';

const report = (ok: boolean, message?: string): RepoSyncReport =>
  ({
    ok,
    transports: [
      {
        transportId: 'cloud',
        ok,
        failures: message ? [{ kind: 'doc', id: 'session-1', error: new Error(message) }] : [],
      },
    ],
  }) as unknown as RepoSyncReport;

function harness(results: RepoSyncReport[], options: { planes?: string[] } = {}) {
  const waited: number[] = [];
  let syncs = 0;
  let planeReads = 0;
  const controller = new AbortController();
  return {
    controller,
    waited,
    syncs: () => syncs,
    confirm: () =>
      confirmTargetSync({
        plane: 'cloud',
        currentPlane: () => options.planes?.[planeReads++] ?? 'cloud',
        sync: async () => results[Math.min(syncs++, results.length - 1)]!,
        signal: controller.signal,
        wait: async (ms) => {
          waited.push(ms);
        },
      }),
  };
}

describe('confirmTargetSync', () => {
  it('reaches a room that was rejoining on the next attempt', async () => {
    const h = harness([report(false, 'Streams sync failed: internal_error'), report(true)]);

    await expect(h.confirm()).resolves.toBeUndefined();

    expect(h.syncs()).toBe(2);
    expect(h.waited).toEqual([1_000]);
  });

  it('gives up after its retries with the reason of the last attempt', async () => {
    const h = harness([
      report(false, 'Streams sync failed: internal_error'),
      report(false, 'Streams sync failed: internal_error'),
      report(false, 'Streams sync failed: server_error'),
    ]);

    await expect(h.confirm()).rejects.toThrow(
      'Target synchronization is not confirmed: Streams sync failed: server_error'
    );
    expect(h.syncs()).toBe(3);
    expect(h.waited).toEqual([1_000, 3_000]);
  });

  it('stops at once when the session moved to another plane', async () => {
    const h = harness([report(true)], { planes: ['local'] });

    await expect(h.confirm()).rejects.toThrow('the session moved to the local plane');
    expect(h.syncs()).toBe(1);
    expect(h.waited).toEqual([]);
  });

  it('stops retrying once the send is cancelled', async () => {
    const h = harness([report(false, 'Streams sync failed: internal_error'), report(true)]);
    const waiting = h.confirm();
    h.controller.abort();

    await expect(waiting).rejects.toThrow();
    expect(h.syncs()).toBe(1);
  });
});
