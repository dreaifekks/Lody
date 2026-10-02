import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { MachineId, WorkspaceId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { pingMachineWithRuntime } from '@/lib/machine-ping';

/** A machine is pinged again this often while it is shown. */
export const MACHINE_PING_INTERVAL_MS = 15_000;
/** A machine that has not answered a ping by then is shown as not answering. */
export const MACHINE_PING_TIMEOUT_MS = 6_000;

/** How a machine answered its last ping; `checking` until the first answer. */
export type MachineReach =
  | { state: 'checking' }
  | { state: 'online'; ms: number }
  | { state: 'offline' };

/**
 * How long `machineId` takes to answer `machine/ping` through the workspace's
 * hub, measured while the caller is mounted. `null` without a machine or a
 * workspace to ask through. A new round keeps the last answer until its own.
 */
export function useMachineLatency(machineId: MachineId | null | undefined): MachineReach | null {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const [reach, setReach] = useState<MachineReach>({ state: 'checking' });

  useEffect(() => {
    setReach({ state: 'checking' });
    if (!runtime || !workspaceId || !machineId) return undefined;
    let active = true;
    let running = false;
    const run = () => {
      if (running) return;
      running = true;
      void pingMachineWithRuntime({
        runtime,
        workspaceId: workspaceId as WorkspaceId,
        machineId,
        timeoutMs: MACHINE_PING_TIMEOUT_MS,
        timeoutMessage: 'timeout',
        failedMessage: 'failed',
      }).then(
        (ms) => {
          running = false;
          if (active) setReach({ state: 'online', ms });
        },
        () => {
          running = false;
          if (active) setReach({ state: 'offline' });
        }
      );
    };
    run();
    const timer = setInterval(run, MACHINE_PING_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [runtime, workspaceId, machineId]);

  return runtime && workspaceId && machineId ? reach : null;
}
