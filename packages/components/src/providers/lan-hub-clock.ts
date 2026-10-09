import { createServerTimeFetcher, syncTime } from '@lody/shared';
import { LAN_HUB_TIME_PATH } from '@lody/shared/lan-hub';
import { LAN_HUB_SCHEME } from '@lody/shared/platform-kind';

/** Clocks drift slowly; the hub behind the address may also have moved. */
export const LAN_HUB_CLOCK_SYNC_INTERVAL_MS = 5 * 60_000;

/**
 * Aligns this renderer's `getServerNow()` to the hub its workspace syncs
 * through, as a cloud renderer aligns to the hosted `/api/time`. Machine RPC
 * deadlines are judged by the clock of the machine asked; a renderer whose
 * clock runs behind would otherwise send requests that expire on arrival.
 * Any other gateway is left alone. Returns what stops it.
 */
export function startLanHubClock(
  gatewayBaseUrl: string | undefined,
  intervalMs: number = LAN_HUB_CLOCK_SYNC_INTERVAL_MS
): () => void {
  if (!gatewayBaseUrl?.startsWith(`${LAN_HUB_SCHEME}://`)) return () => {};
  const fetchHubTime = createServerTimeFetcher(`${gatewayBaseUrl}${LAN_HUB_TIME_PATH}`);
  const sync = (): void => {
    syncTime(fetchHubTime).catch((error: unknown) => {
      console.warn('RuntimeProvider: could not read the clock of the LAN', error);
    });
  };
  sync();
  const timer = setInterval(sync, intervalMs);
  return () => clearInterval(timer);
}
