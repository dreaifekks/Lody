// Members of a LAN judge each other's request deadlines by their own clocks.
// The hosted service aligns every client to its `/api/time`; a LAN has no such
// service, so each member aligns to its hub instead. A member whose clock runs
// a minute behind otherwise sends requests that expire before they arrive.
import { createServerTimeFetcher, syncTime } from '@lody/shared';
import { LAN_HUB_TIME_PATH } from '@lody/shared/lan-hub';
import type { LanHub } from '@lody/shared/node/lan-hub';
import { formatErrorMessage } from '@/utils/format-error';

/** Clocks drift slowly; a hub that moved is asked again at once. */
export const LAN_CLOCK_SYNC_INTERVAL_MS = 5 * 60_000;

/**
 * Keeps the clock of this process, `getServerNow()`, aligned to the hub of the
 * first LAN. The clock is one per process, so a member of several LANs follows
 * one hub: the first, whose user also acts for what belongs to no workspace.
 */
export class LanHubClock {
  private timer: NodeJS.Timeout | null = null;
  /** The last request for the time: an earlier answer arriving later is dropped. */
  private latest = 0;

  constructor(
    private readonly options: {
      hubs: () => readonly LanHub[];
      log: (line: string) => void;
      intervalMs?: number;
    }
  ) {}

  start(): void {
    if (this.timer) return;
    void this.sync();
    this.timer = setInterval(
      () => void this.sync(),
      this.options.intervalMs ?? LAN_CLOCK_SYNC_INTERVAL_MS
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.latest += 1;
  }

  /** Asks the hub for its time; a hub that does not answer leaves the clock as it was. */
  async sync(): Promise<void> {
    const hub = this.options.hubs()[0];
    if (!hub) return;
    const attempt = ++this.latest;
    const fetchHubTime = createServerTimeFetcher(`${hub.url}${LAN_HUB_TIME_PATH}`, undefined, {
      authorization: `Bearer ${hub.token}`,
    });
    try {
      await syncTime(async () => {
        const serverTime = await fetchHubTime();
        // A later request, such as one to a hub that moved, decides the clock.
        if (attempt !== this.latest) throw new Error('superseded');
        return serverTime;
      });
    } catch (error) {
      if (attempt !== this.latest) return;
      this.options.log(
        `[lan] Could not read the clock of ${hub.name}: ${formatErrorMessage(error)}`
      );
    }
  }
}
