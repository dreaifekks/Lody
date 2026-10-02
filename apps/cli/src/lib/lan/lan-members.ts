// The machines of the LANs this machine is a member of: what they say about
// themselves, what this machine says about itself, and the requests members
// put to each other.
import {
  LanMemberControlResponseSchema,
  getMachineRoomId,
  machineSupportsLanControl,
  normalizeLanMachineAlias,
  normalizeLanMachineColor,
  parseLanAgentRuntimes,
  sameLanAgentRuntimes,
  type LanAgentRuntime,
  type LanMachine,
  type LanMachineColor,
  type LanMachines,
  type LanMemberControlRequest,
  type LanMemberControlResponse,
  type LocalProjectControlResponse,
  type MachineId,
  type MachineMeta,
  type WorkspaceId,
} from '@lody/shared';
import { parseLanMachineBuild, parseLanMachineUpdate } from '@lody/shared/lan-release';
import {
  parseLanSshDestination,
  sameLanSshDestination,
  type LanSshDestination,
} from '@lody/shared/lan-ssh';
import type { LoroRepo } from 'loro-repo';
import {
  listMachineIds,
  listMergedAgentConfigs,
  type MachineFlockSyncScheduler,
} from '@/lib/agent-config-machine-flock';
import { formatErrorMessage } from '@/utils/format-error';
import {
  LanControlRefused,
  readLanMachineUpdate,
  settleLanMachineUpdate,
  type LanMachineControl,
} from './lan-machine-control';

/** A workspace the agent service of this machine runs. */
export type LanMemberWorkspace = {
  workspaceId: WorkspaceId;
  name: string;
  /** Who this machine acts as in the workspace; the members of a LAN are one user. */
  userId: string;
  /** Whether a LAN carries the workspace. The implicit one has this machine only. */
  lan: boolean;
  repo: LoroRepo;
  /** `null` while the hub has not said who is there. */
  getOnlineMachineIds: () => Promise<ReadonlySet<MachineId> | null>;
  sync: MachineFlockSyncScheduler;
};

type MachineFacts = Pick<MachineMeta, 'lanBuild' | 'lanUpdate' | 'lanAgents'>;

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

async function readMachineMeta(repo: LoroRepo, machineId: MachineId): Promise<MachineMeta | null> {
  const record = await repo.getDocMeta(getMachineRoomId(machineId));
  return (record?.meta as MachineMeta | undefined) ?? null;
}

/** The short name the members of a workspace's LAN gave a machine, if any. */
export async function readLanMachineAlias(
  repo: LoroRepo,
  machineId: MachineId
): Promise<string | null> {
  return normalizeLanMachineAlias((await readMachineMeta(repo, machineId))?.lanAlias);
}

async function describeOwnAgents(
  workspace: LanMemberWorkspace,
  machineId: MachineId,
  control: LanMachineControl
): Promise<LanAgentRuntime[]> {
  const configs = await listMergedAgentConfigs(workspace.repo, workspace.workspaceId, [machineId]);
  return await control.describeAgents(configs.filter((config) => config.machineId === machineId));
}

function mergeOnline(known: boolean | null, seen: boolean | null): boolean | null {
  if (known === true || seen === true) return true;
  return known === null && seen === null ? null : false;
}

function mergeAgents(
  known: readonly LanAgentRuntime[],
  seen: readonly LanAgentRuntime[]
): LanAgentRuntime[] {
  const merged = new Map(known.map((agent) => [agent.agentType, agent]));
  for (const agent of seen) {
    if (!merged.has(agent.agentType)) merged.set(agent.agentType, agent);
  }
  return [...merged.values()];
}

/**
 * Every machine this machine reaches through its LANs, itself first. A machine
 * that is a member of several of them is listed once.
 */
export async function listLanMachines(options: {
  workspaces: readonly LanMemberWorkspace[];
  machineId: MachineId;
  machineName: string;
  os: string;
  control: LanMachineControl;
  now: number;
}): Promise<LanMachines> {
  const { control, machineId } = options;
  const machines = new Map<string, LanMachine>();
  machines.set(machineId, {
    machineId,
    name: options.machineName,
    alias: null,
    color: null,
    os: options.os,
    self: true,
    online: true,
    lans: [],
    version: control.build.version,
    build: control.build,
    update: control.update,
    controllable: true,
    agents: [],
  });

  for (const workspace of options.workspaces) {
    const [ids, online] = await Promise.all([
      listMachineIds(workspace.repo),
      workspace.getOnlineMachineIds().catch(() => null),
    ]);
    const lan = { workspaceId: workspace.workspaceId, name: workspace.name };

    for (const id of ids) {
      const meta = await readMachineMeta(workspace.repo, id);
      if (!meta) continue;
      // The members of a LAN are one user; anything else in its workspace was
      // left there by a build that had another idea of who they are.
      if (meta.ownerUserId && meta.ownerUserId !== workspace.userId) continue;

      if (id === machineId) {
        const self = machines.get(machineId);
        if (!self) continue;
        self.name = meta.name || self.name;
        if (workspace.lan) {
          self.lans.push(lan);
          self.alias ??= normalizeLanMachineAlias(meta.lanAlias);
          self.color ??= normalizeLanMachineColor(meta.lanColor);
        }
        self.update ??= settleLanMachineUpdate(
          parseLanMachineUpdate(meta.lanUpdate),
          control.build.version,
          options.now
        );
        self.agents = mergeAgents(
          self.agents,
          await describeOwnAgents(workspace, machineId, control)
        );
        continue;
      }
      // Nothing but this machine is reached through a workspace no LAN carries.
      if (!workspace.lan) continue;

      const seenOnline = online ? online.has(id) : null;
      const known = machines.get(id);
      if (known) {
        known.lans.push(lan);
        known.alias ??= normalizeLanMachineAlias(meta.lanAlias);
        known.color ??= normalizeLanMachineColor(meta.lanColor);
        known.online = mergeOnline(known.online, seenOnline);
        known.agents = mergeAgents(known.agents, parseLanAgentRuntimes(meta.lanAgents));
        continue;
      }
      machines.set(id, {
        machineId: id,
        name: meta.name,
        alias: normalizeLanMachineAlias(meta.lanAlias),
        color: normalizeLanMachineColor(meta.lanColor),
        os: meta.os ?? null,
        self: false,
        online: seenOnline,
        lans: [lan],
        version: meta.cliVersion ?? null,
        build: parseLanMachineBuild(meta.lanBuild),
        update: readLanMachineUpdate(
          parseLanMachineUpdate(meta.lanUpdate),
          meta.cliVersion ?? null,
          options.now
        ),
        controllable: machineSupportsLanControl(meta),
        agents: parseLanAgentRuntimes(meta.lanAgents),
      });
    }
  }

  const rank = (machine: LanMachine) => (machine.self ? 0 : machine.online ? 1 : 2);
  return {
    machines: [...machines.values()].sort(
      (left, right) =>
        rank(left) - rank(right) ||
        (left.alias ?? left.name).localeCompare(right.alias ?? right.name)
    ),
    newest: await control.readNewestRelease(),
  };
}

/**
 * Writes what this machine says about itself into its metadata of a LAN's
 * workspace, where the other members read it. Nothing is written while
 * nothing changed, so it may be called as often as something might have.
 */
export async function publishLanMachineFacts(options: {
  workspace: LanMemberWorkspace;
  machineId: MachineId;
  control: LanMachineControl;
  now: number;
}): Promise<boolean> {
  const { workspace, machineId, control } = options;
  if (!workspace.lan) return false;
  const meta = await readMachineMeta(workspace.repo, machineId);
  // The machine registers first; its facts follow with the next call.
  if (!meta) return false;

  const update =
    control.update ??
    settleLanMachineUpdate(
      parseLanMachineUpdate(meta.lanUpdate),
      control.build.version,
      options.now
    );
  const agents = await describeOwnAgents(workspace, machineId, control);

  const facts: MachineFacts = {};
  if (!same(meta.lanBuild, control.build)) facts.lanBuild = control.build;
  if (!same(meta.lanUpdate, update)) facts.lanUpdate = update ?? undefined;
  if (!sameLanAgentRuntimes(parseLanAgentRuntimes(meta.lanAgents), agents)) {
    facts.lanAgents = agents;
  }
  if (Object.keys(facts).length === 0) return false;

  await workspace.repo.upsertDocMeta(
    getMachineRoomId(machineId),
    facts as Parameters<LoroRepo['upsertDocMeta']>[1]
  );
  return true;
}

/**
 * Writes where the SSH server of this machine answers into its metadata of a
 * LAN's workspace, where the editors of the other members read it; `null`
 * takes back what it said. It is told apart from the other facts because
 * finding it out asks the network, and they must not wait for that.
 */
export async function publishLanSshDestination(options: {
  workspace: LanMemberWorkspace;
  machineId: MachineId;
  destination: LanSshDestination | null;
}): Promise<boolean> {
  const { workspace, machineId, destination } = options;
  if (!workspace.lan) return false;
  const meta = await readMachineMeta(workspace.repo, machineId);
  // The machine registers first; where it answers follows with the next call.
  if (!meta) return false;

  const unchanged = destination
    ? sameLanSshDestination(parseLanSshDestination(meta.lanSsh), destination)
    : meta.lanSsh === undefined;
  if (unchanged) return false;

  await workspace.repo.upsertDocMeta(getMachineRoomId(machineId), {
    lanSsh: destination ?? undefined,
  } as Parameters<LoroRepo['upsertDocMeta']>[1]);
  return true;
}

/**
 * Gives a machine a short name and a color for it, or takes them back with
 * `null`, in every LAN of this machine that the machine is a member of. Each
 * member writes them into the machine's metadata of the LAN's workspace, where
 * every member reads them; the machine itself need not be there. A color left
 * out stays as it is.
 */
export async function writeLanMachineAlias(options: {
  workspaces: readonly LanMemberWorkspace[];
  target: MachineId;
  alias: string | null;
  color?: LanMachineColor | null;
}): Promise<{ alias: string | null; color?: LanMachineColor | null }> {
  const alias = normalizeLanMachineAlias(options.alias);
  const color = options.color === undefined ? undefined : normalizeLanMachineColor(options.color);
  let written = 0;
  for (const workspace of options.workspaces) {
    if (!workspace.lan) continue;
    const meta = await readMachineMeta(workspace.repo, options.target);
    if (!meta || (meta.ownerUserId && meta.ownerUserId !== workspace.userId)) continue;
    const change: Partial<MachineMeta> = {};
    if (normalizeLanMachineAlias(meta.lanAlias) !== alias) change.lanAlias = alias ?? undefined;
    if (color !== undefined && normalizeLanMachineColor(meta.lanColor) !== color) {
      change.lanColor = color ?? undefined;
    }
    if (Object.keys(change).length > 0) {
      await workspace.repo.upsertDocMeta(
        getMachineRoomId(options.target),
        change as Parameters<LoroRepo['upsertDocMeta']>[1]
      );
    }
    written += 1;
  }
  if (written === 0) throw new Error('No LAN of this machine has that machine');
  return color === undefined ? { alias } : { alias, color };
}

function refuse(
  request: LanMemberControlRequest,
  message: string,
  data?: unknown
): LanMemberControlResponse {
  return {
    ok: false,
    type: request.type,
    error: 'execution_failed',
    message,
    ...(data === undefined ? {} : { data }),
  };
}

/** Carries out what a member asked of this machine. */
export async function answerLanMemberControl(options: {
  request: LanMemberControlRequest;
  workspace: LanMemberWorkspace;
  machineId: MachineId;
  control: LanMachineControl;
}): Promise<LanMemberControlResponse> {
  const { request, workspace, control } = options;
  try {
    if (request.type === 'lan/update-machine') {
      return { ok: true, type: request.type, result: await control.startUpdate() };
    }
    if (request.type === 'lan/install-agent') {
      return {
        ok: true,
        type: request.type,
        result: await control.installAgent(request.agentType),
      };
    }

    const { importHostedConfig, previewHostedImport } =
      await import('@/lib/hosted-config/hosted-config-import');
    const target = {
      repo: workspace.repo,
      workspaceId: workspace.workspaceId,
      machineId: options.machineId,
      userId: workspace.userId,
      sync: workspace.sync,
    };
    return request.type === 'hosted-config/preview'
      ? { ok: true, type: request.type, result: await previewHostedImport(target) }
      : { ok: true, type: request.type, result: await importHostedConfig(target, request) };
  } catch (error) {
    return error instanceof LanControlRefused
      ? refuse(request, error.message, { reason: error.reason })
      : refuse(request, formatErrorMessage(error));
  }
}

/**
 * Puts a request to another member of a LAN and brings back what it answers.
 * A machine that would not understand the request is not asked: it drops what
 * it cannot read without a word, and the asking member would wait in vain.
 */
export async function forwardLanMemberControl(options: {
  request: LanMemberControlRequest;
  /** The workspace the request names, if this machine runs it. */
  workspace: LanMemberWorkspace | null;
  machineId: MachineId;
  send: (request: LanMemberControlRequest) => Promise<LocalProjectControlResponse | null>;
}): Promise<LanMemberControlResponse> {
  const { request, workspace } = options;
  if (!workspace?.lan) {
    return refuse(request, 'This machine is a member of no LAN with that workspace');
  }
  if (request.machineId === options.machineId) {
    return refuse(request, 'A request to this machine is not forwarded');
  }
  const meta = await readMachineMeta(workspace.repo, request.machineId);
  if (!meta || (meta.ownerUserId && meta.ownerUserId !== workspace.userId)) {
    return refuse(request, `${workspace.name} has no such machine`);
  }
  if (!machineSupportsLanControl(meta)) {
    return refuse(
      request,
      `${meta.name} runs a build that takes no requests from members; update it where it was installed`,
      { reason: 'manual' }
    );
  }

  let answer: LocalProjectControlResponse | null;
  try {
    answer = await options.send(request);
  } catch (error) {
    return refuse(request, `${meta.name} could not be reached: ${formatErrorMessage(error)}`);
  }
  if (!answer) return refuse(request, `${meta.name} did not answer`);

  const parsed = LanMemberControlResponseSchema.safeParse(answer);
  if (!parsed.success || parsed.data.type !== request.type) {
    return refuse(request, `${meta.name} answered something else than it was asked`);
  }
  return parsed.data as LanMemberControlResponse;
}
