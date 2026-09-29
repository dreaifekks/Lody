import type { RepoSyncReport } from 'loro-repo';
import { throwIfSendAborted } from '../lib/session-send-resources';

/**
 * Waits between attempts to confirm a sent turn's sync. On a slow link a room
 * can be rejoining just as the confirmation syncs it ("subscription closed");
 * the next attempt reaches the rejoined room. Syncing is idempotent.
 */
export const TARGET_SYNC_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

export type TargetSyncConfirmation = {
  /** The plane that must confirm the room, chosen before the first attempt. */
  plane: string;
  /** The plane the room reads from now; a change ends the confirmation. */
  currentPlane: () => string;
  sync: () => Promise<RepoSyncReport>;
  signal: AbortSignal;
  delaysMs?: readonly number[];
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
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

function describeFailure(report: RepoSyncReport, plane: string): string {
  const outcome = report.transports.find((transport) => transport.transportId === plane);
  if (!outcome) return `the ${plane} plane did not take part`;
  return (
    outcome.failures
      .map((failure) =>
        failure.error instanceof Error ? failure.error.message : String(failure.error)
      )
      .join('; ') || `the ${plane} plane reported no success`
  );
}

/**
 * Confirms that a room reached its plane, retrying a failed sync a bounded
 * number of times. The turn is usually delivered already through the dispatch
 * call, so the error it throws in the end says why confirmation failed: a slow
 * or failing plane, or a route that moved.
 */
export async function confirmTargetSync(options: TargetSyncConfirmation): Promise<void> {
  const delays = options.delaysMs ?? TARGET_SYNC_RETRY_DELAYS_MS;
  const wait = options.wait ?? waitFor;
  let reason = '';
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (attempt > 0) {
      await wait(delays[attempt - 1]!, options.signal);
      throwIfSendAborted(options.signal);
    }
    const report = await options.sync();
    throwIfSendAborted(options.signal);
    const movedTo = options.currentPlane();
    if (movedTo !== options.plane) {
      throw new Error(
        `Target synchronization is not confirmed: the session moved to the ${movedTo} plane`
      );
    }
    const outcome = report.transports.find((transport) => transport.transportId === options.plane);
    if (outcome?.ok) return;
    reason = describeFailure(report, options.plane);
  }
  throw new Error(`Target synchronization is not confirmed: ${reason}`);
}
