// How a command asks the agent service of this machine about the machines of
// its LANs, and through it the other members.
import {
  resolveLanUpdateAvailability,
  type LanMachine,
  type LanMachines,
  type LanMemberControlRequest,
  type LanMemberControlResponse,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import { makeLocalProbeClientAuto } from '@lody/shared/node/local-ipc';
import { Effect } from 'effect';
import { DAEMON_NOT_RUNNING_MESSAGE } from '@/lib/command-runtime';
import { sendLocalProjectControl } from '@/lib/local-project-control-client';
import { makeLocalWorkspaceCatalog } from '@/lib/local-workspace-catalog';

const PROBE_TIMEOUT_MS = 3_000;
const LIST_TIMEOUT_MS = 30_000;
// The agent service waits for the member; the command waits a little longer.
const ASK_TIMEOUT_MS = 150_000;

/** The agent service names its machine itself, so no account is involved. */
export async function resolveLocalMachineId(): Promise<MachineId> {
  try {
    const health = await Effect.runPromise(
      makeLocalProbeClientAuto().health({ timeoutMs: PROBE_TIMEOUT_MS })
    );
    return health.machineId as MachineId;
  } catch {
    throw new Error(DAEMON_NOT_RUNNING_MESSAGE);
  }
}

export async function listLanMachinesOfThisMachine(machineId: MachineId): Promise<LanMachines> {
  const response = await sendLocalProjectControl(
    { type: 'lan/machines', machineId },
    { timeoutMs: LIST_TIMEOUT_MS }
  );
  if (!response.ok) throw new Error(response.message);
  if (response.type !== 'lan/machines') throw new Error('Unexpected response');
  return response.result;
}

/** A machine by its id, or by its name or short name when only one machine has it. */
export function findLanMachine(machines: readonly LanMachine[], selector: string): LanMachine {
  const wanted = selector.trim();
  const byId = machines.find((machine) => machine.machineId === wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase();
  const byName = machines.filter((machine) => machine.name.toLowerCase() === lower);
  const named =
    byName.length > 0
      ? byName
      : machines.filter((machine) => machine.alias?.toLowerCase() === lower);
  if (named.length === 1 && named[0]) return named[0];
  const candidates = machines.map((machine) => `${machine.name} (${machine.machineId})`);
  throw new Error(
    named.length > 1
      ? `Several machines are called ${wanted}; use an id: ${candidates.join(', ')}`
      : `No machine ${wanted}; there are ${candidates.join(', ') || 'none'}`
  );
}

/**
 * The workspace a request to a machine names. Another member is asked in a
 * LAN both are in; this machine in any workspace its agent service runs.
 */
export async function resolveControlWorkspace(
  machine: LanMachine,
  selector?: string
): Promise<WorkspaceId> {
  const wanted = selector?.trim();
  if (machine.lans.length > 0) {
    const lan = wanted
      ? machine.lans.find((entry) => entry.workspaceId === wanted || entry.name === wanted)
      : machine.lans[0];
    if (!lan) {
      throw new Error(
        `${machine.name} is in no LAN ${wanted}; it is in ${machine.lans.map((entry) => entry.name).join(', ')}`
      );
    }
    return lan.workspaceId as WorkspaceId;
  }
  if (!machine.self) throw new Error(`${machine.name} is reached through no LAN`);
  const workspaces = await Effect.runPromise(makeLocalWorkspaceCatalog().listActiveWorkspaces());
  const workspace = wanted
    ? workspaces.find((entry) => entry.workspaceId === wanted || entry.name === wanted)
    : workspaces[0];
  if (!workspace) throw new Error(wanted ? `No workspace ${wanted}` : DAEMON_NOT_RUNNING_MESSAGE);
  return workspace.workspaceId as WorkspaceId;
}

/** Puts a request to a machine: to this one directly, to a member through the hub. */
export async function askLanMachine(
  localMachineId: MachineId,
  request: LanMemberControlRequest
): Promise<LanMemberControlResponse> {
  if (request.machineId === localMachineId) {
    const response = await sendLocalProjectControl(request, { timeoutMs: ASK_TIMEOUT_MS });
    if (response.type !== request.type) throw new Error('Unexpected response');
    return response as LanMemberControlResponse;
  }
  const response = await sendLocalProjectControl(
    { type: 'lan/forward', machineId: localMachineId, request },
    { timeoutMs: ASK_TIMEOUT_MS }
  );
  if (!response.ok) throw new Error(response.message);
  if (response.type !== 'lan/forward') throw new Error('Unexpected response');
  return response.result.response;
}

/** What a list says about the build of a machine, in a few words. */
export function describeLanMachineUpdate(
  machine: LanMachine,
  newestVersion: string | null
): string {
  if (machine.update && machine.update.phase !== 'failed') {
    return `${machine.update.phase} ${machine.update.version}`;
  }
  const failed = machine.update ? `; ${machine.update.version} failed` : '';
  const availability = resolveLanUpdateAvailability(machine.version, newestVersion);
  if (availability === 'unknown') return `unknown${failed}`;
  if (availability === 'current') return `newest${failed}`;
  const who =
    machine.build?.update === 'service' && machine.controllable
      ? ''
      : machine.build?.update === 'desktop'
        ? ', from its desktop application'
        : ', by hand';
  return `${newestVersion ?? ''} available${who}${failed}`;
}
