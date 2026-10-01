// What an agent service does for the members of its LANs beyond running
// agents: it keeps what it says about itself current in every LAN, lists the
// machines it reaches, and carries requests between members.
import {
  createLoroStreamsJsonStreamClient,
  LORO_STREAMS_RPC_RETENTION_SECONDS,
  LORO_STREAMS_RPC_VERSION,
  LoroStreamsMachineRpcClient,
} from '@lody/loro-streams-rpc';
import {
  LORO_STREAMS_BUCKET_ID,
  getServerNow,
  isLanMemberControlType,
  type LanMemberControlRequest,
  type LanMemberControlResponse,
  type LocalProjectControlRequest,
  type LocalProjectControlResponse,
  type MachineId,
} from '@lody/shared';
import { getLanHubWorkspaceId } from '@lody/shared/lan-hub';
import type { LanSshDestination } from '@lody/shared/lan-ssh';
import type { LanHub } from '@lody/shared/node/lan-hub';
import { getCliHttpFetch } from '@/utils/http-transport';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import type { LanMachineControl } from './lan-machine-control';
import {
  answerLanMemberControl,
  forwardLanMemberControl,
  listLanMachines,
  publishLanMachineFacts,
  publishLanSshDestination,
  writeLanMachineAlias,
  type LanMemberWorkspace,
} from './lan-members';

export type LanControlRequest = Extract<
  LocalProjectControlRequest,
  { type: 'lan/machines' | 'lan/alias-machine' | 'lan/forward' } | LanMemberControlRequest
>;

// An agent runtime that the service installs by itself shows up without anyone
// having asked for it; this is how long the members may not know.
const REFRESH_INTERVAL_MS = 5 * 60_000;
// A workspace that just started registers its providers a moment later, and
// their runtimes a while after that.
const AFTER_START_MS = [15_000, 90_000];
const CONNECT_TIMEOUT_MS = 15_000;
// A member answers an update as soon as it has read the release, and an
// import once it has copied and read a replica. Every wait ends before the
// two minutes a desktop waits for this machine.
const ANSWER_TIMEOUT_MS: Record<LanMemberControlRequest['type'], number> = {
  'lan/update-machine': 45_000,
  'lan/install-agent': 30_000,
  'hosted-config/preview': 90_000,
  'hosted-config/import': 100_000,
};

export function isLanControlRequest(
  message: LocalProjectControlRequest
): message is LanControlRequest {
  return (
    message.type === 'lan/machines' ||
    message.type === 'lan/alias-machine' ||
    message.type === 'lan/forward' ||
    isLanMemberControlType(message.type)
  );
}

export function isLanMemberControlRequest(
  message: LocalProjectControlRequest
): message is LanMemberControlRequest {
  return isLanMemberControlType(message.type);
}

export type LanFleetControlOptions = {
  logger: Logger;
  machineId: MachineId;
  machineName: string;
  control: LanMachineControl;
  /** The LANs of this machine as they are now. */
  hubs: () => readonly LanHub[];
  /** The workspaces the agent service runs right now. */
  workspaces: () => LanMemberWorkspace[];
  /** Waits for a workspace that is starting; `null` for one that is not run. */
  workspace: (workspaceId: string) => Promise<LanMemberWorkspace | null>;
  send?: (
    hub: LanHub,
    request: LanMemberControlRequest
  ) => Promise<LocalProjectControlResponse | null>;
  /**
   * Where the SSH server of this machine answers the members of a LAN: `null`
   * for nowhere, `undefined` while that cannot be told. Absent on a machine
   * that says nothing about it.
   */
  ssh?: (hub: LanHub) => Promise<LanSshDestination | null | undefined>;
  now?: () => number;
};

export class LanFleetControl {
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly afterStart = new Set<NodeJS.Timeout>();
  private publishing: Promise<void> = Promise.resolve();
  private publishingSsh: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: LanFleetControlOptions) {}

  start(): void {
    if (this.unsubscribe || this.closed) return;
    this.unsubscribe = this.options.control.onChange(() => {
      void this.publish();
    });
    this.timer = setInterval(() => {
      void this.publish();
      // An address can change under a running service: a laptop moves between networks.
      void this.publishSsh();
    }, REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const timer of this.afterStart) clearTimeout(timer);
    this.afterStart.clear();
  }

  /** Tells the LANs about this machine now, and again once a started workspace settled. */
  publishAfterStart(): void {
    void this.publish();
    void this.publishSsh();
    for (const delay of AFTER_START_MS) {
      const timer = setTimeout(() => {
        this.afterStart.delete(timer);
        void this.publish();
        void this.publishSsh();
      }, delay);
      timer.unref();
      this.afterStart.add(timer);
    }
  }

  /**
   * Tells every LAN what this machine says about itself now. Calls queue up
   * behind each other, so the last thing said is the last thing that changed.
   */
  publish(): Promise<void> {
    const run = async () => {
      if (this.closed) return;
      for (const workspace of this.options.workspaces()) {
        try {
          await publishLanMachineFacts({
            workspace,
            machineId: this.options.machineId,
            control: this.options.control,
            now: this.now(),
          });
        } catch (error) {
          this.options.logger.debug(
            `[lan] Could not tell ${workspace.name} about this machine: ${formatErrorMessage(error)}`
          );
        }
      }
    };
    this.publishing = this.publishing.then(run, run);
    return this.publishing;
  }

  /**
   * Tells every LAN where the SSH server of this machine answers its members.
   * Finding that out asks the network, so it keeps out of the way of what
   * `publish` says: an update reports itself just before the machine is gone.
   */
  publishSsh(): Promise<void> {
    const { ssh } = this.options;
    if (!ssh) return this.publishingSsh;
    const run = async () => {
      if (this.closed) return;
      for (const workspace of this.options.workspaces()) {
        const hub = this.options
          .hubs()
          .find((candidate) => getLanHubWorkspaceId(candidate.id) === workspace.workspaceId);
        if (!hub) continue;
        try {
          const destination = await ssh(hub);
          if (destination === undefined || this.closed) continue;
          await publishLanSshDestination({
            workspace,
            machineId: this.options.machineId,
            destination,
          });
        } catch (error) {
          this.options.logger.debug(
            `[lan-ssh] Could not tell ${workspace.name} where this machine answers: ${formatErrorMessage(error)}`
          );
        }
      }
    };
    this.publishingSsh = this.publishingSsh.then(run, run);
    return this.publishingSsh;
  }

  /** A request that reached this machine over its own socket. */
  async dispatch(message: LanControlRequest): Promise<LocalProjectControlResponse> {
    if (message.type === 'lan/machines') {
      return {
        ok: true,
        type: message.type,
        result: await listLanMachines({
          workspaces: this.options.workspaces(),
          machineId: this.options.machineId,
          machineName: this.options.machineName,
          os: process.platform,
          control: this.options.control,
          now: this.now(),
        }),
      };
    }
    if (message.type === 'lan/alias-machine') {
      try {
        const alias = await writeLanMachineAlias({
          workspaces: this.options.workspaces(),
          target: message.target,
          alias: message.alias,
        });
        return { ok: true, type: message.type, result: { alias } };
      } catch (error) {
        return {
          ok: false,
          type: message.type,
          error: 'execution_failed',
          message: formatErrorMessage(error),
        };
      }
    }
    if (message.type === 'lan/forward') {
      const { request } = message;
      return {
        ok: true,
        type: message.type,
        result: {
          response: await forwardLanMemberControl({
            request,
            workspace: await this.options.workspace(request.workspaceId),
            machineId: this.options.machineId,
            send: async (forwarded) => await this.send(forwarded),
          }),
        },
      };
    }
    return await this.answer(message);
  }

  /** What a member asked of this machine, from its own socket or through the hub. */
  async answer(request: LanMemberControlRequest): Promise<LanMemberControlResponse> {
    const refuse = (
      error: 'machine_mismatch' | 'workspace_not_found',
      message: string
    ): LanMemberControlResponse => ({ ok: false, type: request.type, error, message });
    if (request.machineId !== this.options.machineId) {
      return refuse('machine_mismatch', `Machine mismatch: expected ${this.options.machineId}`);
    }
    const workspace = await this.options.workspace(request.workspaceId);
    if (!workspace) {
      return refuse(
        'workspace_not_found',
        `This machine does not run workspace ${request.workspaceId}`
      );
    }
    const response = await answerLanMemberControl({
      request,
      workspace,
      machineId: this.options.machineId,
      control: this.options.control,
    });
    // What was imported or installed is something the members should see.
    if (response.ok && request.type !== 'hosted-config/preview') void this.publish();
    return response;
  }

  private async send(
    request: LanMemberControlRequest
  ): Promise<LocalProjectControlResponse | null> {
    const hub = this.options
      .hubs()
      .find((candidate) => getLanHubWorkspaceId(candidate.id) === request.workspaceId);
    if (!hub) throw new Error('no LAN of this machine carries the workspace');
    return await (this.options.send ?? sendThroughHub(this.options.logger))(hub, request);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

/**
 * Puts a request on the stream the member reads in the hub of their LAN, the
 * way a desktop does for the projects of another machine.
 */
function sendThroughHub(logger: Logger) {
  return async (
    hub: LanHub,
    request: LanMemberControlRequest
  ): Promise<LocalProjectControlResponse | null> => {
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: request.workspaceId,
      machineId: request.machineId,
      streamClient: createLoroStreamsJsonStreamClient({
        bucketId: LORO_STREAMS_BUCKET_ID,
        getToken: () => Promise.resolve(hub.token),
        getBaseUrl: () => hub.url,
        fetchImpl: getCliHttpFetch({ logger }),
        timeout: { connectTimeoutMs: CONNECT_TIMEOUT_MS },
      }),
      rpcVersion: LORO_STREAMS_RPC_VERSION,
      retentionSeconds: LORO_STREAMS_RPC_RETENTION_SECONDS,
      now: getServerNow,
      logger,
    });
    await client.start();
    try {
      return await client.requestLocalProjectControl({
        request,
        timeoutMs: ANSWER_TIMEOUT_MS[request.type],
      });
    } finally {
      client.stop();
    }
  };
}
