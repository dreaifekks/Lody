import { useEffect, useRef } from 'react';
import { useLatestRef } from './use-latest-ref';

/** How often an open article is rechecked while its thread is working. */
export const FILE_DIGEST_WATCH_BUSY_MS = 5_000;
/** How often while the thread is idle: the agent rarely writes then. */
export const FILE_DIGEST_WATCH_IDLE_MS = 15_000;

/**
 * Rechecks a file on screen at a steady pace. Each `check` is expected to be
 * a digest revalidation (`requestFilePreview` with `knownDigest`), so an
 * unchanged file costs one small round trip. Checks never overlap; the pace
 * follows `busy`, and a turn ending (`busy` turning false) checks at once,
 * because that is when the agent has just written. Nothing runs while
 * `enabled` is false, and nothing is left behind after it turns false.
 */
export function useSessionFileDigestWatch({
  enabled,
  busy,
  check,
}: {
  readonly enabled: boolean;
  readonly busy: boolean;
  readonly check: () => Promise<void>;
}): void {
  const checkRef = useLatestRef(check);
  const wasBusyRef = useRef(busy);
  const inFlightRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const turnEnded = wasBusyRef.current && !busy;
    wasBusyRef.current = busy;
    if (!enabled) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interval = busy ? FILE_DIGEST_WATCH_BUSY_MS : FILE_DIGEST_WATCH_IDLE_MS;
    const run = async () => {
      // A check started under the previous pace finishes before the next one.
      await inFlightRef.current;
      if (disposed) return;
      const checking = checkRef.current();
      inFlightRef.current = checking;
      await checking;
      if (inFlightRef.current === checking) inFlightRef.current = null;
      if (!disposed) timer = setTimeout(() => void run(), interval);
    };
    if (turnEnded) void run();
    else timer = setTimeout(() => void run(), interval);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [busy, checkRef, enabled]);
}
