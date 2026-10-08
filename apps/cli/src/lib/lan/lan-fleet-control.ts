// What an agent service does for the members of its LANs beyond running
// agents: it keeps what it says about itself current in every LAN, lists the
// machines it reaches, and carries requests between members: directly where
// it can connect to the member, through the hub where it cannot.
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
  type MachineMeta,
} from '@lody/shared';
import { getLanHubWorkspaceId } from '@lody/shared/lan-hub';
import { parseLanTerminalEndpoint, type LanTerminalEndpoint } from '@lody/shared/lan-terminal';
import type { LanSshDestination } from '@lody/shared/lan-ssh';
import type { LanHub } from '@lody/shared/node/lan-hub';
import { getCliHttpFetch } from '@/utils/http-transport';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { askLanMemberDirectly, LanMemberUnreachableError } from './lan-control-channel';
import {
  LanShareError,
  listLanSharedConversations,
  publishLanShare,
  readLanShareSettings,
  revokeLanShare,
  setLanShareImage,
  setLanSharePublicUrl,
} from './lan-shares';
import type { LanGitHubSource } from './lan-github-credential';
import type { LanMachineControl } from './lan-machine-control';
import { deriveLanTerminalKey } from './lan-terminal';
import {
  answerLanMemberControl,
  type LanUsageSource,
  forwardLanMemberControl,
  listLanMachines,
  publishLanMachineFacts,
  publishLanSshDestination,
  writeLanMachineAlias,
  type LanMemberWorkspace,
} from './lan-members';

type LanShareControlRequest = Extract<
  LocalProjectControlRequest,
  {
    type:
      | 'lan/shares'
      | 'lan/share-publish'
      | 'lan/share-revoke'
      | 'lan/share-settings'
      | 'lan/share-image';
  }
>;

export type LanControlRequest = Extract<
  LocalProjectControlRequest,
  | { type: 'lan/machines' | 'lan/alias-machine' | 'lan/forward' | 'lan/github-token' }
  | LanShareControlRequest
  | LanMemberControlRequest
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
  'lan/usage': 20_000,
  'lan/restart-machine': 15_000,
  'lan/github': 30_000,
};

export function isLanControlRequest(
  message: LocalProjectControlRequest
): message is LanControlRequest {
  return (
    message.type === 'lan/machines' ||
    message.type === 'lan/alias-machine' ||
    message.type === 'lan/forward' ||
    message.type === 'lan/shares' ||
    message.type === 'lan/share-publish' ||
    message.type === 'lan/share-revoke' ||
    message.type === 'lan/share-settings' ||
    message.type === 'lan/share-image' ||
    message.type === 'lan/github-token' ||
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
  /** Puts a request to a member at the endpoint it publishes. */
  sendDirect?: (
    hub: LanHub,
    endpoint: LanTerminalEndpoint,
    request: LanMemberControlRequest
  ) => Promise<LocalProjectControlResponse | null>;
  /** Puts a request to a member through the hub, for one this machine cannot connect to. */
  sendThroughHub?: (
    hub: LanHub,
    request: LanMemberControlRequest
  ) => Promise<LocalProjectControlResponse | null>;
  /**
   * Where the SSH server of this machine answers the members of a LAN: `null`
   * for nowhere, `undefined` while that cannot be told. Absent on a machine
   * that says nothing about it.
   */
  ssh?: (hub: LanHub) => Promise<LanSshDestination | null | undefined>;
  /** What this machine's agents used; absent where nothing counts it. */
  usage?: LanUsageSource;
  /** The GitHub credentials of this machine, and the hubs' token; absent where none is told. */
  github?: LanGitHubSource;
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
        const result = await writeLanMachineAlias({
          workspaces: this.options.workspaces(),
          target: message.target,
          alias: message.alias,
          color: message.color,
        });
        return { ok: true, type: message.type, result };
      } catch (error) {
        return {
          ok: false,
          type: message.type,
          error: 'execution_failed',
          message: formatErrorMessage(error),
        };
      }
    }
    if (message.type === 'lan/github-token') {
      try {
        const hub = this.hubOf(message.workspaceId);
        if (!hub) throw new Error('No LAN of this machine carries the workspace');
        if (!this.options.github) throw new Error('This agent service keeps no GitHub token');
        return {
          ok: true,
          type: message.type,
          result: await this.options.github.save(hub, message.token),
        };
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
            send: async (forwarded, machine) => await this.send(forwarded, machine),
          }),
        },
      };
    }
    if (
      message.type === 'lan/shares' ||
      message.type === 'lan/share-publish' ||
      message.type === 'lan/share-revoke' ||
      message.type === 'lan/share-settings' ||
      message.type === 'lan/share-image'
    ) {
      return await this.share(message);
    }
    return await this.answer(message);
  }

  /** The shares of a workspace's LAN, which its hub keeps. */
  private async share(message: LanShareControlRequest): Promise<LocalProjectControlResponse> {
    const hub = this.options
      .hubs()
      .find((candidate) => getLanHubWorkspaceId(candidate.id) === message.workspaceId);
    if (!hub) {
      return {
        ok: false,
        type: message.type,
        error: 'workspace_not_found',
        message: `No LAN of this machine carries workspace ${message.workspaceId}`,
      };
    }
    try {
      if (message.type === 'lan/shares') {
        return {
          ok: true,
          type: message.type,
          result: { shares: await listLanSharedConversations(hub) },
        };
      }
      if (message.type === 'lan/share-revoke') {
        return {
          ok: true,
          type: message.type,
          result: { revoked: await revokeLanShare(hub, message.shareId) },
        };
      }
      if (message.type === 'lan/share-settings') {
        if (message.publicUrl !== undefined) await setLanSharePublicUrl(hub, message.publicUrl);
        return { ok: true, type: message.type, result: await readLanShareSettings(hub) };
      }
      if (message.type === 'lan/share-image') {
        await setLanShareImage(hub, message.kind, message.path);
        return { ok: true, type: message.type, result: await readLanShareSettings(hub) };
      }
      const share = await publishLanShare(hub, {
        directory: message.directory,
        shareId: message.shareId,
        expectedRevision: message.expectedRevision,
        rootSourceId: message.rootSourceId,
        sources: message.sources,
      });
      return { ok: true, type: message.type, result: { share } };
    } catch (error) {
      return {
        ok: false,
        type: message.type,
        error: 'execution_failed',
        message: formatErrorMessage(error),
        ...(error instanceof LanShareError && error.status !== null
          ? { data: { status: error.status } }
          : {}),
      };
    }
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
    const { github } = this.options;
    const response = await answerLanMemberControl({
      request,
      workspace,
      machineId: this.options.machineId,
      control: this.options.control,
      usage: this.options.usage,
      ...(github ? { github: () => github.describe(this.hubOf(request.workspaceId)) } : {}),
    });
    // What was imported or installed is something the members should see.
    if (
      response.ok &&
      request.type !== 'hosted-config/preview' &&
      request.type !== 'lan/usage' &&
      request.type !== 'lan/restart-machine' &&
      request.type !== 'lan/github'
    ) {
      void this.publish();
    }
    return response;
  }

  /**
   * Connects to the member where it says it accepts members; the hub carries
   * the request only when that connection never got as far as the request,
   * so the member is never asked twice.
   */
  private async send(
    request: LanMemberControlRequest,
    machine: MachineMeta
  ): Promise<LocalProjectControlResponse | null> {
    const hub = this.hubOf(request.workspaceId);
    if (!hub) throw new Error('no LAN of this machine carries the workspace');
    const endpoint = parseLanTerminalEndpoint(machine.lanTerminal);
    if (endpoint) {
      try {
        return await (this.options.sendDirect ?? sendDirectly)(hub, endpoint, request);
      } catch (error) {
        if (!(error instanceof LanMemberUnreachableError)) throw error;
        this.options.logger.debug(
          `[lan] ${machine.name} takes no request directly, asking through the hub: ${formatErrorMessage(error)}`
        );
      }
    }
    return await (this.options.sendThroughHub ?? sendThroughHub(this.options.logger))(hub, request);
  }

  private hubOf(workspaceId: string): LanHub | null {
    return (
      this.options.hubs().find((candidate) => getLanHubWorkspaceId(candidate.id) === workspaceId) ??
      null
    );
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

async function sendDirectly(
  hub: LanHub,
  endpoint: LanTerminalEndpoint,
  request: LanMemberControlRequest
): Promise<LocalProjectControlResponse> {
  return await askLanMemberDirectly({
    endpoint,
    lanId: hub.id,
    key: deriveLanTerminalKey(hub.token),
    machineId: request.machineId,
    request,
    timeoutMs: ANSWER_TIMEOUT_MS[request.type],
  });
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
