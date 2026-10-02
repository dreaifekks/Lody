import { useEffect, useState } from 'react';
import type { ElectronLanSummary } from '@lody/shared/electron-ipc';
import { isElectronRenderer } from '@/lib/electron';
import { getIpcServices } from '@/lib/electron-ipc-client';

/** A hub's round trip is measured again this often while it is shown. */
export const LAN_HUB_LATENCY_INTERVAL_MS = 10_000;

function getLanIpc() {
  return isElectronRenderer() ? (getIpcServices()?.lan ?? null) : null;
}

/**
 * The hub's round trip in milliseconds while the caller is mounted: `undefined`
 * until the first measurement, `null` when the hub does not answer.
 */
export function useLanHubLatency(lanId: string | null | undefined): number | null | undefined {
  const [latency, setLatency] = useState<number | null>();

  useEffect(() => {
    setLatency(undefined);
    const lan = getLanIpc();
    if (!lan || !lanId) return undefined;
    let active = true;
    let running = false;
    const run = () => {
      if (running) return;
      running = true;
      void lan
        .latency({ id: lanId })
        .catch(() => null)
        .then((value) => {
          running = false;
          if (active) setLatency(value);
        });
    };
    run();
    const timer = setInterval(run, LAN_HUB_LATENCY_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [lanId]);

  return latency;
}

/** The LAN a workspace belongs to, as the desktop shell holds it; `null` for none. */
export function useLanOfWorkspace(
  workspaceId: string | null | undefined
): ElectronLanSummary | null {
  const [lans, setLans] = useState<readonly ElectronLanSummary[]>([]);

  useEffect(() => {
    const lan = getLanIpc();
    if (!lan || !workspaceId) return undefined;
    let active = true;
    void lan
      .getState()
      .then((state) => {
        if (active) setLans(state?.lans ?? []);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [workspaceId]);

  return lans.find((lan) => lan.workspaceId === workspaceId) ?? null;
}
