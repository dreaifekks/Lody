import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LanGitHubState,
  LanMachine,
  LanMemberControlRequest,
  LanMemberControlResponse,
  LocalProjectControlResponse,
  MachineId,
  WorkspaceId,
} from '@lody/shared';
import { isElectronRenderer } from '@/lib/electron';
import { getIpcServices } from '@/lib/electron-ipc-client';

// The shell fills in the machine it runs on.
const THIS_MACHINE = '' as MachineId;

export type LanGitHubMachine = {
  machineId: string;
  name: string;
  self: boolean;
  /** `null` while it is asked. */
  state: LanGitHubState | 'offline' | 'unanswered' | null;
};

export type LanGitHubControl = {
  /** `null` until the agent service listed the machines. */
  machines: LanGitHubMachine[] | null;
  /** Whether a LAN carries the workspace, so its hub can keep a token. */
  lan: boolean;
  /**
   * Who the token the hub keeps acts as, as this machine gets it: `null` for
   * none, `undefined` while that is not known.
   */
  hubToken: { login: string | null } | null | undefined;
  /** Gives the hub a token, or takes it back with `null`. */
  saveToken: (
    token: string | null
  ) => Promise<{ ok: true; login: string | null } | { ok: false; message: string }>;
  refresh: () => Promise<void>;
};

const UNAVAILABLE = 'The agent service of this machine is not running';

/** A machine and whether it is in the workspace's LAN; this machine may not be. */
type Entry = LanGitHubMachine & { lan: boolean };

function getControl() {
  return isElectronRenderer() ? (getIpcServices()?.localProjects ?? null) : null;
}

/**
 * The GitHub credentials of every machine of the workspace's LAN: this
 * machine answers itself, the others through its agent service. A token goes
 * from here to the hub through that agent service, and no answer carries one.
 */
export function useLanGitHub(workspaceId: string | null): LanGitHubControl {
  const [machines, setMachines] = useState<Entry[] | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const control = getControl();
    const current = ++generation.current;
    if (!control || !workspaceId) {
      setMachines([]);
      return;
    }
    const listed = await control
      .control({ type: 'lan/machines', machineId: THIS_MACHINE })
      .catch(() => null);
    const members: LanMachine[] =
      listed?.ok && listed.type === 'lan/machines'
        ? listed.result.machines.filter(
            (machine) => machine.self || machine.lans.some((lan) => lan.workspaceId === workspaceId)
          )
        : [];
    if (current !== generation.current) return;
    const named = (machine: LanMachine) => ({
      machineId: machine.machineId,
      name: machine.alias ?? machine.name,
      self: machine.self,
      lan: machine.lans.some((lan) => lan.workspaceId === workspaceId),
    });
    setMachines((previous) =>
      members.map((machine) => ({
        ...named(machine),
        // What a machine said last stays until it answers again.
        state: previous?.find((known) => known.machineId === machine.machineId)?.state ?? null,
      }))
    );

    const answers = await Promise.all(
      members.map(async (machine): Promise<Entry> => {
        if (!machine.self && machine.online === false) {
          return { ...named(machine), state: 'offline' };
        }
        const request: LanMemberControlRequest = {
          type: 'lan/github',
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
        return {
          ...named(machine),
          state: answer?.ok && answer.type === 'lan/github' ? answer.result : 'unanswered',
        };
      })
    );
    if (current !== generation.current) return;
    setMachines(answers);
  }, [workspaceId]);

  useEffect(() => {
    setMachines(null);
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  const saveToken = useCallback<LanGitHubControl['saveToken']>(
    async (token) => {
      const control = getControl();
      if (!control || !workspaceId) return { ok: false, message: UNAVAILABLE };
      const response = await control
        .control({
          type: 'lan/github-token',
          machineId: THIS_MACHINE,
          workspaceId: workspaceId as WorkspaceId,
          token,
        })
        .catch(() => null);
      if (!response) return { ok: false, message: UNAVAILABLE };
      if (!response.ok) return { ok: false, message: response.message };
      if (response.type !== 'lan/github-token') return { ok: false, message: UNAVAILABLE };
      void refresh();
      return { ok: true, login: response.result.login };
    },
    [refresh, workspaceId]
  );

  const self = machines?.find((machine) => machine.self) ?? null;
  return {
    machines: machines?.map(({ lan: _lan, ...machine }) => machine) ?? null,
    lan: self?.lan ?? false,
    hubToken: self?.state && typeof self.state === 'object' ? self.state.lan : undefined,
    saveToken,
    refresh,
  };
}
