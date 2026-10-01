import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import type {
  HostedConfigCategory,
  HostedConfigImportResult,
  HostedConfigPreview,
  LanAgentInstallResult,
  LanMachine,
  LanMachineUpdateResult,
  LanMachines,
  LanMemberControlRequest,
  LanMemberControlResponse,
  MachineId,
  WorkspaceId,
} from '@lody/shared';
import { readLanControlRefusal, type LanControlRefusal } from '@lody/shared/lan-control';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { isElectronRenderer } from '@/lib/electron';
import { getIpcServices } from '@/lib/electron-ipc-client';

export type LanMachineAnswer<T> =
  | { ok: true; result: T }
  | { ok: false; message: string; reason: LanControlRefusal | null };

export type LanMachinesControl = {
  /** `null` until the agent service answered, and while it does not. */
  inventory: LanMachines | null;
  loading: boolean;
  refresh: () => Promise<void>;
  updateMachine: (machine: LanMachine) => Promise<LanMachineAnswer<LanMachineUpdateResult>>;
  installAgent: (
    machine: LanMachine,
    agentType: string
  ) => Promise<LanMachineAnswer<LanAgentInstallResult>>;
  previewHostedImport: (machine: LanMachine) => Promise<LanMachineAnswer<HostedConfigPreview>>;
  importHostedConfig: (
    machine: LanMachine,
    input: { sourceWorkspaceId: string; categories: HostedConfigCategory[] }
  ) => Promise<LanMachineAnswer<HostedConfigImportResult>>;
  /** Gives a machine a short name in the LANs; `null` takes it back. */
  setAlias: (
    machine: LanMachine,
    alias: string | null
  ) => Promise<LanMachineAnswer<{ alias: string | null }>>;
};

const UNAVAILABLE = 'The agent service of this machine is not running';
// Who is there and what runs where changes without this window doing anything.
const REFRESH_MS = 5_000;
// A machine that updates says where it stands every few seconds.
const REFRESH_WHILE_UPDATING_MS = 2_000;

// The shell fills in the machine it runs on.
const THIS_MACHINE = '' as MachineId;

type MemberRequest<Type extends LanMemberControlRequest['type']> = Omit<
  Extract<LanMemberControlRequest, { type: Type }>,
  'machineId' | 'workspaceId'
>;
type MemberResult<Type extends LanMemberControlRequest['type']> = Extract<
  LanMemberControlResponse,
  { ok: true; type: Type }
>['result'];

function getControl() {
  return isElectronRenderer() ? (getIpcServices()?.localProjects ?? null) : null;
}

function isUpdating(inventory: LanMachines | null): boolean {
  return (
    inventory?.machines.some(
      (machine) =>
        (machine.update && machine.update.phase !== 'failed') ||
        machine.agents.some((agent) => agent.state === 'updating')
    ) ?? false
  );
}

/**
 * The workspace a request to a machine names: the LAN this window shows when
 * the machine is in it, another LAN both are in otherwise, and for this
 * machine without a LAN the workspace the window shows.
 */
export function resolveLanMachineWorkspace(
  machine: LanMachine,
  currentWorkspaceId: string | null
): WorkspaceId | null {
  const shown = machine.lans.find((lan) => lan.workspaceId === currentWorkspaceId);
  const lan = shown ?? machine.lans[0];
  if (lan) return lan.workspaceId as WorkspaceId;
  return machine.self ? (currentWorkspaceId as WorkspaceId | null) : null;
}

/**
 * The machines this machine reaches through its LANs, and what is asked of
 * them. The agent service of this machine answers for itself and carries a
 * request to another member through the hub of a LAN both are in.
 */
export function useLanMachines(): LanMachinesControl {
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom);
  const [inventory, setInventory] = useState<LanMachines | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const control = getControl();
    const response = control
      ? await control.control({ type: 'lan/machines', machineId: THIS_MACHINE }).catch(() => null)
      : null;
    if (!mounted.current) return;
    setLoading(false);
    // An agent service that is away keeps what it said last on the page.
    if (response?.ok && response.type === 'lan/machines') setInventory(response.result);
  }, []);

  const updating = isUpdating(inventory);
  useEffect(() => {
    void refresh();
    const timer = setInterval(
      () => void refresh(),
      updating ? REFRESH_WHILE_UPDATING_MS : REFRESH_MS
    );
    return () => clearInterval(timer);
  }, [refresh, updating]);

  const ask = useCallback(
    async <Type extends LanMemberControlRequest['type']>(
      machine: LanMachine,
      request: MemberRequest<Type> & { type: Type }
    ): Promise<LanMachineAnswer<MemberResult<Type>>> => {
      const control = getControl();
      const workspaceId = resolveLanMachineWorkspace(machine, currentWorkspaceId);
      if (!control || !workspaceId) return { ok: false, message: UNAVAILABLE, reason: null };

      const member = {
        ...request,
        machineId: machine.self ? THIS_MACHINE : (machine.machineId as MachineId),
        workspaceId,
      } as LanMemberControlRequest;
      const response = await control
        .control(
          machine.self ? member : { type: 'lan/forward', machineId: THIS_MACHINE, request: member }
        )
        .catch(() => null);
      void refresh();

      const answer: LanMemberControlResponse | null =
        response?.ok && response.type === 'lan/forward'
          ? response.result.response
          : ((response as LanMemberControlResponse | null) ?? null);
      if (!answer) return { ok: false, message: UNAVAILABLE, reason: null };
      if (!answer.ok) {
        return {
          ok: false,
          message: answer.message,
          reason: readLanControlRefusal(answer.data),
        };
      }
      if (answer.type !== request.type) {
        return { ok: false, message: UNAVAILABLE, reason: null };
      }
      return { ok: true, result: answer.result as MemberResult<Type> };
    },
    [currentWorkspaceId, refresh]
  );

  // Written by this machine into the LANs it shares with the machine, which
  // need not be online for it.
  const setAlias = useCallback(
    async (
      machine: LanMachine,
      alias: string | null
    ): Promise<LanMachineAnswer<{ alias: string | null }>> => {
      const control = getControl();
      if (!control) return { ok: false, message: UNAVAILABLE, reason: null };
      const response = await control
        .control({
          type: 'lan/alias-machine',
          machineId: THIS_MACHINE,
          target: machine.machineId as MachineId,
          alias,
        })
        .catch(() => null);
      void refresh();
      if (!response) return { ok: false, message: UNAVAILABLE, reason: null };
      if (!response.ok) return { ok: false, message: response.message, reason: null };
      if (response.type !== 'lan/alias-machine') {
        return { ok: false, message: UNAVAILABLE, reason: null };
      }
      return { ok: true, result: response.result };
    },
    [refresh]
  );

  return {
    inventory,
    loading,
    refresh,
    setAlias,
    updateMachine: useCallback((machine) => ask(machine, { type: 'lan/update-machine' }), [ask]),
    installAgent: useCallback(
      (machine, agentType) => ask(machine, { type: 'lan/install-agent', agentType }),
      [ask]
    ),
    previewHostedImport: useCallback(
      (machine) => ask(machine, { type: 'hosted-config/preview' }),
      [ask]
    ),
    importHostedConfig: useCallback(
      (machine, input) => ask(machine, { type: 'hosted-config/import', ...input }),
      [ask]
    ),
  };
}
