import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LanMachine,
  LanMemberControlRequest,
  LanMemberControlResponse,
  LocalProjectControlResponse,
  MachineId,
  WorkspaceId,
} from '@lody/shared';
import { isElectronRenderer } from '@/lib/electron';
import { getIpcServices } from '@/lib/electron-ipc-client';
import type { LanUsageMachineReport } from '@/lib/lan-usage';

// Usage changes as agents work; the page reads it again while it is open.
const REFRESH_MS = 60_000;

// The shell fills in the machine it runs on.
const THIS_MACHINE = '' as MachineId;

export type LanUsageState = {
  /** `null` until the first round of answers came back. */
  reports: LanUsageMachineReport[] | null;
  /** Machines of the workspace whose usage is not in `reports`, and why. */
  missing: Array<{ machineId: string; name: string; reason: 'offline' | 'unanswered' }>;
  refresh: () => Promise<void>;
};

function getControl() {
  return isElectronRenderer() ? (getIpcServices()?.localProjects ?? null) : null;
}

function nameOf(machine: LanMachine): string {
  return machine.alias ?? machine.name;
}

/**
 * What every machine of the workspace's LAN counted for it: this machine
 * answers itself, the others through the agent service of this machine,
 * directly where it can reach them and through the hub where it cannot.
 */
export function useLanUsage(workspaceId: string | null): LanUsageState {
  const [reports, setReports] = useState<LanUsageMachineReport[] | null>(null);
  const [missing, setMissing] = useState<LanUsageState['missing']>([]);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const control = getControl();
    const current = ++generation.current;
    if (!control || !workspaceId) {
      setReports([]);
      setMissing([]);
      return;
    }
    const listed = await control
      .control({ type: 'lan/machines', machineId: THIS_MACHINE })
      .catch(() => null);
    const machines =
      listed?.ok && listed.type === 'lan/machines'
        ? listed.result.machines.filter(
            (machine) => machine.self || machine.lans.some((lan) => lan.workspaceId === workspaceId)
          )
        : [];

    const answers = await Promise.all(
      machines.map(async (machine) => {
        if (!machine.self && machine.online === false) {
          return { machine, rows: null, reason: 'offline' as const };
        }
        const request: LanMemberControlRequest = {
          type: 'lan/usage',
          machineId: machine.self ? THIS_MACHINE : (machine.machineId as MachineId),
          workspaceId: workspaceId as WorkspaceId,
        };
        const response: LocalProjectControlResponse | null = await control
          .control(
            machine.self ? request : { type: 'lan/forward', machineId: THIS_MACHINE, request }
          )
          .catch(() => null);
        const answer: LanMemberControlResponse | null =
          response?.ok && response.type === 'lan/forward'
            ? response.result.response
            : ((response as LanMemberControlResponse | null) ?? null);
        return answer?.ok && answer.type === 'lan/usage'
          ? { machine, rows: answer.result.rows, reason: null }
          : { machine, rows: null, reason: 'unanswered' as const };
      })
    );
    if (current !== generation.current) return;
    setReports(
      answers.flatMap(({ machine, rows }) =>
        rows ? [{ machineId: machine.machineId, name: nameOf(machine), rows }] : []
      )
    );
    setMissing(
      answers.flatMap(({ machine, reason }) =>
        reason ? [{ machineId: machine.machineId, name: nameOf(machine), reason }] : []
      )
    );
  }, [workspaceId]);

  useEffect(() => {
    setReports(null);
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      clearInterval(timer);
      generation.current += 1;
    };
  }, [refresh]);

  return { reports, missing, refresh };
}
