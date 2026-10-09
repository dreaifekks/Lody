import type net from 'node:net';
import { Effect } from 'effect';
import { initCliAnalytics } from '@/lib/analytics/posthog';
import {
  type CliRuntimeConnectivity,
  type CliRuntimeWorkspace,
  CliType,
  MachineId,
  WorkspaceId,
  createServerTimeFetcher,
  getMachineRoomId,
  getSessionRoomId,
  getServerNow,
  isLoroRepoDocDeleted,
  machineShellScope,
  machineSupportsLanShell,
  machineSupportsLanTunnel,
  parseMachineShellScope,
  syncTime,
  type LanMemberControlRequest,
  type LocalProjectControlErrorCode,
  type LocalProjectControlRequest,
  type LocalProjectControlResponse,
  type LocalProjectId,
  type LocalSessionControlRequest,
  type LocalSessionControlResponse,
  type MachineLifecycleCapability,
  type MachineMeta,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import type { LocalLoroDataPlaneServer } from '@lody/shared/local-loro-data-plane-server';
import pkg from '@/pkg';
import { Logger } from '@/utils/logger';
import { Lody } from '@/lib/lody';
import {
  startLocalIpcSocketServers,
  stopLocalIpcSocketServers,
} from '@/lib/local-ipc-socket-server';
import { startLodyMcpHttpServer, stopLodyMcpHttpServer } from '@/mcp/lody-mcp-http-server';
import type { LocalProbeConfig } from '@/lib/local-probe';
import type { LocalSessionControlConfig } from '@/lib/local-session-control';
import { startLocalTerminalServer, stopLocalTerminalServer } from '@/lib/local-terminal-server';
import { LocalTunnelServer } from '@/lib/local-tunnel-server';
import { getSessionCommandEnvironment } from '@/lib/session-command-environment';
import type { LocalUsageLedger } from '@/lib/usage/local-usage-ledger';
import type { LanHub } from '@lody/shared/node/lan-hub';
import { connectPort, openLanTunnel } from '@/lib/lan/lan-tunnel';
import {
  startLocalLoroDataPlaneServer,
  stopLocalLoroDataPlaneServer,
} from '@/lib/local-loro-data-plane-server';
import { LocalProjectControlService } from '@/lib/local-project-control-service';
import { LocalProjectHistorySyncService } from '@/lib/local-project-history-sync-service';
import { CliRuntimeStateReporter } from '@/lib/cli-runtime-state';
import { makeTerminalPtyService, type TerminalPtyServiceApi } from '@/lib/terminal-pty-service';
import {
  ScopedTerminalService,
  TerminalRouter,
  type RemoteTerminalLink,
  type TerminalSessionLocation,
} from '@/lib/terminal-services';
import {
  LanTerminalHost,
  resolveLanTerminalPort,
  type LanTerminalMembership,
} from '@/lib/lan/lan-terminal-host';
import { connectLanTerminal, deriveLanTerminalKey } from '@/lib/lan/lan-terminal';
import { askLanMemberRpc, LanRpcNotSentError } from '@/lib/lan/lan-rpc-channel';
import { LanFileHandoff } from '@/lib/lan/lan-file-handoff';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { LanFleetControl, isLanControlRequest } from '@/lib/lan/lan-fleet-control';
import { createLanGitHubSource } from '@/lib/lan/lan-github-credential';
import {
  LanHubStandby,
  canThisMachineHostLanHub,
  doesThisMachineHostLanHub,
} from '@/lib/lan/lan-hub-standby';
import type { LanMachineControl } from '@/lib/lan/lan-machine-control';
import { readLanMachineAlias, type LanMemberWorkspace } from '@/lib/lan/lan-members';
import { createLanSshDescriber } from '@/lib/lan/lan-ssh';
import { LanHubClock } from '@/lib/lan/lan-clock';
import { createLanNotificationsPort } from '@/lib/lan/lan-push-notifier';
import { createLanPushFallback, type LanPushFallback } from '@/lib/lan/lan-push-fallback';
import { getLanHubWorkspaceId } from '@lody/shared/lan-hub';
import { parseLanTerminalEndpoint, type LanTerminalEndpoint } from '@lody/shared/lan-terminal';
import {
  readMachineLocalProjects,
  reconcileMachineLocalProjectRootPaths,
  removeMachineLocalProject,
  resolveWorkspaceLocalProject,
  resolveWorkspaceLocalProjectRootPath,
  resolveWorkspaceLocalProjectRootPathWithRetry,
  resolveWorkspaceLocalProjectWithSyncOnMiss,
  upsertMachineLocalProject,
} from '@/lib/local-project-meta';
import { readTimeoutEnv } from '@/lib/loro/timeout-utils';
import {
  deleteLocalProjectWorktreeSetup,
  handleLocalProjectWorktreeConfigRequest,
  isLocalProjectWorktreeConfigRequest,
} from '@/session/worktree/worktree-setup-config-store';
import { formatErrorMessage } from '@/utils/format-error';
import {
  resolveMachineShellWorkdir,
  resolveTerminalWorkdirFromMetadata,
  type TerminalSessionMetaLookup,
} from '@/lib/terminal-workdir-resolver';
import {
  localCatalogWorkspaceToWorkspaceListItem,
  makeLocalWorkspaceCatalog,
  type LocalWorkspaceCatalogService,
  type LocalWorkspaceCatalogSnapshot,
} from '@/lib/local-workspace-catalog';
import { RemoteBridge } from '@/lib/remote-bridge';
import { ensureImplicitLocalWorkspace } from '@/lib/cli-platform';
import type { CloudAccessSnapshot, CloudPort } from '@lody/platform';
import type { MachineProcessLifecycleAction } from '@/lib/machine-lifecycle';
import { traceAsync } from '@/utils/trace-span';
import { MemoryPressureSampler } from '@/monitor/memory-pressure-sampler';
import { makePrStatusPoller, type PrStatusPollerShape } from '@/lib/pr-poller/pr-status-poller';
import { ACP_PLAN_PERMISSION_MODE_ID } from '@lody/shared';
import { createReviewAutomation } from '@/lib/review-automation/create-review-automation';
import type { ReviewAutomationWorkspaceHandle } from '@/lib/review-automation/review-automation-workspace';
import { GitHubCredentialResolver } from '@/lib/pr-poller/github-credential-resolver';
import { loadPrPollerConfig } from '@/lib/pr-poller/pr-poller-config';
import { PrPollerStateStore } from '@/lib/pr-poller/pr-poller-state';
import {
  createLodyPrPollerWorkspace,
  type PrPollerWorkspaceHandle,
} from '@/lib/pr-poller/pr-poller-workspace';
import { WorkspaceWatchCoordinator } from '@/lib/code-collab/workspace-watch-coordinator';
import { findWorkspacesBySelector, formatWorkspaceCandidate } from '@/lib/workspace-selector';
import { listAliveSessionMetas } from '@/lib/command-runtime';
import { AgentExecutionSlots } from './agent-execution-slots';
import {
  createScheduleWorkspace,
  type ScheduleWorkspaceHandle,
} from './schedules/schedule-workspace';
import { preflightLocalProjectWorktreeRemoval } from '@/lib/local-project-removal';

const FLEET_RUNTIME_STATE_INTERVAL_MS = 2_000;
const FLEET_REMOTE_BRIDGE_OFFLINE_GRACE_MS = 15_000;
const FLEET_RECONCILE_RETRY_INITIAL_DELAY_MS = 5_000;
const FLEET_RECONCILE_RETRY_MAX_DELAY_MS = 5 * 60_000;
const FLEET_WORKSPACE_START_CONCURRENCY = 4;

export async function syncCliServerTime(logger: Logger, serverUrl: string): Promise<void> {
  await traceAsync(logger, 'startup.sync_time', undefined, async () => {
    try {
      await syncTime(createServerTimeFetcher(`${serverUrl}/api/time`));
      logger.debug('Time synchronized with server');
    } catch (error) {
      logger.debug(
        `Failed to sync time with server ${serverUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });
}

type WorkspaceListItem = {
  id: string;
  name: string;
  slug: string | null;
  role: string;
  /** The user this machine acts as in the workspace, when workspaces differ. */
  userId?: string;
};

type AuthorizedWorkspaceList = Extract<CloudAccessSnapshot, { status: 'authorized' }>;

export type ImplicitLocalWorkspaceMemory = {
  workspaceId?: string;
  remember: (workspaceId: string) => Promise<void>;
};

type WorkspaceRuntimeState = {
  workspace: WorkspaceListItem;
  lody: Lody;
  unsubscribeTerminalCleanup: () => void;
  prPollerWorkspace: PrPollerWorkspaceHandle;
  schedules: ScheduleWorkspaceHandle;
  reviewAutomation: ReviewAutomationWorkspaceHandle | null;
};

export class LodyFleet {
  private readonly logger: Logger;
  /** Shared by the LAN workspaces: alerts sent from here while a hub is away. */
  private lanPushFallback: LanPushFallback | null = null;
  private readonly builtinAgentConfigCliTypes: CliType[];
  private readonly supportRegistryAgentTypes: string[];
  private readonly cliToken: string;
  private readonly userId: string;
  private readonly machineId: MachineId;
  private readonly machineName: string;
  private readonly machineNameExplicit: boolean;
  private readonly implicitLocalWorkspace: ImplicitLocalWorkspaceMemory | null;
  private readonly localProjectControlService: LocalProjectControlService;
  private readonly localWorkspaceCatalog: LocalWorkspaceCatalogService;
  private readonly remoteBridge: RemoteBridge | null;
  private readonly cloudPort: CloudPort;
  private readonly runtimeStateReporter: CliRuntimeStateReporter;
  private readonly terminalPtyService: TerminalPtyServiceApi;
  private readonly terminalRouter: TerminalRouter;
  private readonly localTunnelServer: LocalTunnelServer;
  private readonly usageLedger: LocalUsageLedger | null;
  private readonly lan: LanTerminalMembership | null;
  private readonly lanFileHandoff: LanFileHandoff;
  private lanTerminalHost: LanTerminalHost | null = null;
  private readonly lanFleetControl: LanFleetControl | null;
  private readonly lanHubStandby: LanHubStandby | null;
  private readonly lanHubClock: LanHubClock | null;
  private readonly memoryPressure: MemoryPressureSampler;
  private readonly onFatalAuthFailure?: (error: Error) => void;
  private readonly localPlatform: boolean;
  private readonly localFirstBootstrap: boolean;
  private readonly onProcessLifecycleAction?: (action: MachineProcessLifecycleAction) => void;
  private readonly startupTimeSync?: Promise<void>;
  private readonly machineLifecycleCapability: MachineLifecycleCapability;
  private readonly prStatusPoller: PrStatusPollerShape;
  private readonly workspaceWatchCoordinator: WorkspaceWatchCoordinator;

  private readonly runtimes = new Map<string, WorkspaceRuntimeState>();
  private readonly reviewCredentialResolvers = new Map<string, GitHubCredentialResolver>();
  private readonly startInFlight = new Map<string, Promise<void>>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly desiredWorkspaces = new Map<string, WorkspaceListItem>();
  private readonly remoteRevokedWorkspaceIds = new Set<string>();

  private unsubscribeWorkspaces: (() => void) | null = null;
  private stopped = false;
  private runtimeStateTimer: NodeJS.Timeout | null = null;
  private hasWorkspaceRetryIssue = false;
  private hasControlOfflineIssue = false;
  private hasControlReconnectingIssue = false;
  private lastConnectivity: CliRuntimeConnectivity | null = null;
  private invalidTokenReported = false;
  private lastCachedWorkspaceSignature: string | null = null;
  private remoteBridgeOfflineTimer: NodeJS.Timeout | null = null;
  private unsubscribeLanMoves: (() => void) | null = null;
  // Last valid workspace list, retried after an apply/reconcile failure. The
  // Convex subscription only re-fires on actual list changes, so without this a
  // one-off reconcile failure (e.g. a catalog write error) could leave the fleet
  // permanently un-reconciled / un-attached.
  private lastValidWorkspaceListResult: AuthorizedWorkspaceList | null = null;
  private reconcileRetryTimer: NodeJS.Timeout | null = null;
  private reconcileRetryDelayMs = 0;

  constructor(options: {
    logger: Logger;
    builtinAgentConfigCliTypes: CliType[];
    supportRegistryAgentTypes?: string[];
    cliToken: string;
    userId: string;
    machineId: MachineId;
    machineName: string;
    /**
     * The name was chosen for this machine rather than derived from its host
     * name, so it replaces the name a workspace stored for it.
     */
    machineNameExplicit?: boolean;
    /** Local-only operation: which workspace is the implicit one, and how to record it. */
    implicitLocalWorkspace?: ImplicitLocalWorkspaceMemory;
    runtimeStateReporter: CliRuntimeStateReporter;
    localWorkspaceCatalog?: LocalWorkspaceCatalogService;
    cloudPort: CloudPort;
    localFirstBootstrap?: boolean;
    startupTimeSync?: Promise<void>;
    machineLifecycleCapability: MachineLifecycleCapability;
    onFatalAuthFailure?: (error: Error) => void;
    onProcessLifecycleAction?: (action: MachineProcessLifecycleAction) => void;
    /** The LANs of this machine: their members reach its terminals, and it theirs. */
    lan?: LanTerminalMembership;
    /** What this machine tells the members of its LANs, and does when they ask. */
    lanControl?: LanMachineControl;
    /** What this machine's agents used, which the members of its LANs ask for. */
    usageLedger?: LocalUsageLedger;
  }) {
    this.logger = options.logger;
    this.builtinAgentConfigCliTypes = options.builtinAgentConfigCliTypes;
    this.supportRegistryAgentTypes = options.supportRegistryAgentTypes ?? [];
    this.cliToken = options.cliToken;
    this.userId = options.userId;
    this.machineId = options.machineId;
    this.machineName = options.machineName;
    this.machineNameExplicit = options.machineNameExplicit ?? false;
    this.implicitLocalWorkspace = options.implicitLocalWorkspace ?? null;
    this.cloudPort = options.cloudPort;
    if (this.cloudPort.identity.userId !== this.userId) {
      throw new Error(
        `CloudPort identity ${this.cloudPort.identity.userId} does not match Fleet identity ${this.userId}`
      );
    }
    this.runtimeStateReporter = options.runtimeStateReporter;
    this.machineLifecycleCapability = options.machineLifecycleCapability;
    this.onFatalAuthFailure = options.onFatalAuthFailure;
    this.localWorkspaceCatalog = options.localWorkspaceCatalog ?? makeLocalWorkspaceCatalog();
    this.memoryPressure = new MemoryPressureSampler(this.logger);
    this.remoteBridge = this.cloudPort.streamsTokens
      ? new RemoteBridge({
          logger: this.logger,
          catalog: this.localWorkspaceCatalog,
          userId: this.userId,
          machineId: this.machineId,
          machineName: this.machineName,
          getRuntime: (workspaceId) => this.runtimes.get(workspaceId)?.lody,
        })
      : null;
    // A local platform assembled with a Streams gateway keeps its no-account
    // identity but reconciles and attaches like any workspace with a remote
    // plane; only the gateway-less assembly is the zero-network lifecycle.
    this.localPlatform = this.cloudPort.kind === 'local' && !this.remoteBridge;
    // The local platform has no cloud reconcile: the catalog bootstrap is the
    // only workspace source, so it is unconditionally on.
    // A LAN member starts from its settings: they answer at once, and unlike
    // the catalog they say which user each workspace runs as.
    const lanMember = this.cloudPort.kind === 'local' && this.remoteBridge !== null;
    this.localFirstBootstrap =
      this.localPlatform ||
      (!lanMember &&
        (options.localFirstBootstrap ?? process.env.LODY_LOCAL_FIRST_BOOTSTRAP !== '0'));
    this.startupTimeSync = options.startupTimeSync;
    this.onProcessLifecycleAction = options.onProcessLifecycleAction;
    this.localProjectControlService = new LocalProjectControlService(this.logger);
    this.terminalPtyService = makeTerminalPtyService({
      logger: this.logger,
      resolveSessionWorkdir: async (sessionId) =>
        await this.resolveTerminalSessionWorkdir(sessionId),
      resolveShellWorkdir: async (machineId, requested) => {
        // Every caller routes another machine's shell away before it gets here.
        if (machineId !== this.machineId) {
          throw new Error(`session_machine_mismatch:${machineShellScope(machineId)}:${machineId}`);
        }
        return resolveMachineShellWorkdir(requested);
      },
    });
    this.lan = options.lan ?? null;
    this.lanHubClock = this.lan
      ? new LanHubClock({
          hubs: () => this.lan?.hubs ?? [],
          log: (line) => this.logger.info(line),
        })
      : null;
    this.lanFleetControl = options.lanControl
      ? new LanFleetControl({
          logger: this.logger,
          machineId: this.machineId,
          machineName: this.machineName,
          control: options.lanControl,
          ...(options.usageLedger ? { usage: options.usageLedger } : {}),
          ssh: createLanSshDescriber({ logger: this.logger }),
          github: createLanGitHubSource(),
          hubs: () => this.lan?.hubs ?? [],
          workspaces: () =>
            Array.from(this.runtimes.values(), (runtime) => this.toLanMemberWorkspace(runtime)),
          workspace: async (workspaceId) => {
            await this.startInFlight.get(workspaceId)?.catch(() => undefined);
            const runtime = this.runtimes.get(workspaceId);
            return runtime ? this.toLanMemberWorkspace(runtime) : null;
          },
        })
      : null;
    const lanControl = options.lanControl;
    this.lanHubStandby = lanControl
      ? new LanHubStandby({
          logger: this.logger,
          machineId: this.machineId,
          dataDir: getLodyDataDir(),
          hubs: () => this.lan?.hubs ?? [],
          workspaces: () =>
            Array.from(this.runtimes.values(), (runtime) => this.toLanMemberWorkspace(runtime)),
          capable: async () => await canThisMachineHostLanHub({ update: lanControl.build.update }),
          adopt: (hubId, location, reason) => this.lan?.adopt?.(hubId, location, reason) ?? false,
          termOf: (hubId) => this.lan?.termOf?.(hubId) ?? 0,
          hosting: async (hub) => await doesThisMachineHostLanHub(hub),
        })
      : null;
    this.lanFileHandoff = new LanFileHandoff({
      machineId: this.machineId,
      logger: this.logger,
      hubs: () => this.lan?.hubs ?? [],
      workspace: (workspaceId) => {
        const runtime = this.runtimes.get(workspaceId);
        if (!runtime || !this.isLanWorkspace(workspaceId)) return null;
        const { repo } = runtime.lody.documentManager;
        return {
          lookupSession: async (sessionId) =>
            await this.lookupTerminalSessionMeta(runtime, sessionId),
          readMachine: async (machineId) =>
            (await repo.getDocMeta(getMachineRoomId(machineId)))?.meta as MachineMeta | undefined,
          storeLocally: async (request) => await runtime.lody.dispatchLocalControl(request),
        };
      },
      localSessions: (workspaceId) => {
        const runtime = this.runtimes.get(workspaceId);
        return runtime
          ? async (sessionId) => await this.lookupTerminalSessionMeta(runtime, sessionId)
          : null;
      },
    });
    this.terminalRouter = new TerminalRouter({
      local: this.terminalPtyService,
      machineId: this.machineId,
      locate: async (sessionId) => await this.locateTerminalSession(sessionId as SessionId),
      ...(this.lan ? { connect: async (location) => await this.connectLanTerminal(location) } : {}),
    });
    this.usageLedger = options.usageLedger ?? null;
    this.localTunnelServer = new LocalTunnelServer({
      logger: this.logger,
      connect: async (request) =>
        await this.openMachineTunnel(
          request.machineId ?? this.machineId,
          request.port,
          request.host
        ),
    });
    this.prStatusPoller = makePrStatusPoller({
      config: loadPrPollerConfig(),
      stateStore: new PrPollerStateStore({ logger: this.logger }),
      logger: this.logger,
    });
    this.workspaceWatchCoordinator = new WorkspaceWatchCoordinator(this.logger);
  }

  async start(): Promise<void> {
    if (this.cloudPort.kind !== 'local' && this.cloudPort.usage) {
      // Start the analytics poster before any events fire (idempotent; no-op
      // without a key). Local platform: telemetry is off by contract (D-O12).
      initCliAnalytics();
    }
    this.memoryPressure.start();
    // Sync time once before any time-sensitive operations (heartbeats, unread
    // detection). Local platform: no time server; getServerNow() falls back to
    // the local clock.
    if (this.startupTimeSync) {
      this.runtimeStateReporter.setStartupStage('sync-time');
      await this.startupTimeSync;
    }
    // A LAN member follows its hub's clock instead, without waiting on a hub
    // that may be away.
    this.lanHubClock?.start();

    const localProbeConfig: LocalProbeConfig = {
      machineId: this.machineId,
      cliVersion: pkg.version,
      logger: this.logger,
      getRuntimeState: () => this.runtimeStateReporter.snapshot(),
    };

    this.runtimeStateReporter.setStartupStage('fleet-start');
    const localControlConfig: LocalSessionControlConfig = {
      machineId: this.machineId,
      logger: this.logger,
      dispatchSession: async (message, options) =>
        await this.dispatchLocalSessionControl(message, options),
      dispatchProject: async (message) => await this.dispatchLocalProjectControl(message),
      dispatchSchedule: async (message) => {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId as WorkspaceId);
        const { executeScheduleCommand } = await import('./schedules/schedule-command-service');
        try {
          const result = await executeScheduleCommand(
            {
              manager: runtime.lody.documentManager,
              workspace: runtime.workspace,
              auth: {
                token: this.cliToken,
                userId: this.userIdFor(runtime.workspace.id),
                userName: '',
                userEmail: '',
                machineId: this.machineId,
                machineName: this.machineName,
              },
              localOnly: this.localPlatform,
              hostedAccess: this.cloudPort.kind !== 'local',
              requesterSessionId: message.requesterSessionId as SessionId | undefined,
              requesterPermissionTier: message.requesterPermissionTier,
            },
            message.command
          );
          return { ok: true, result };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Schedule command failed',
          };
        }
      },
      dispatchMachineRpc: async (message) => await this.dispatchLocalMachineRpc(message),
    };
    await traceAsync(this.logger, 'startup.local_ipc', undefined, async () => {
      await startLocalIpcSocketServers({
        probe: localProbeConfig,
        control: localControlConfig,
        version: pkg.version,
      });
    });
    await Promise.all([
      traceAsync(this.logger, 'startup.local_terminal', undefined, async () => {
        await startLocalTerminalServer({
          logger: this.logger,
          terminalService: this.terminalRouter,
        });
      }),
      traceAsync(this.logger, 'startup.local_data_plane', undefined, async () => {
        await startLocalLoroDataPlaneServer({
          logger: this.logger,
          getWorkspaceServer: (workspaceId) => this.getWorkspaceLoroDataPlaneServer(workspaceId),
        });
      }),
      traceAsync(this.logger, 'startup.local_tunnel', undefined, async () => {
        // Never fatal: only `lan forward` needs it.
        await this.localTunnelServer.start().catch((error: unknown) => {
          this.logger.warn(`[lan-tunnel] ${formatErrorMessage(error)}`);
        });
      }),
      traceAsync(this.logger, 'startup.mcp_http', undefined, async () => {
        // Never fatal: on failure agents keep the per-session stdio MCP entry.
        await startLodyMcpHttpServer({ logger: this.logger });
      }),
    ]);

    this.startLanTerminalHost();
    this.lanFleetControl?.start();
    this.lanHubStandby?.start();
    this.unsubscribeLanMoves = this.lan?.onMoved?.((hubs) => this.followLanMoves(hubs)) ?? null;

    // Start the PR poller BEFORE any workspace runtime can connect: the
    // local-first catalog bootstrap below registers each workspace with the
    // poller as it connects, and registration on a not-yet-started poller is
    // dropped (regression: a freshly restarted daemon polled nothing because
    // all local-catalog workspaces registered before the poller started).
    // Repository reads use local credentials even without hosted integration.
    Effect.runSync(this.prStatusPoller.start);

    if (this.localPlatform) {
      // D-O14: the single implicit workspace is provisioned before bootstrap
      // so a first run and a restart take the same path.
      await traceAsync(this.logger, 'startup.local_workspace_provision', undefined, async () => {
        await ensureImplicitLocalWorkspace({
          catalog: this.localWorkspaceCatalog,
          identity: {
            userId: this.userId,
            createdAt: new Date(getServerNow()).toISOString(),
            ...(this.implicitLocalWorkspace?.workspaceId
              ? { workspaceId: this.implicitLocalWorkspace.workspaceId }
              : {}),
          },
          machineId: this.machineId,
          machineName: this.machineName,
          logger: this.logger,
          remember: this.implicitLocalWorkspace?.remember,
        });
      });
    }

    if (this.localFirstBootstrap) {
      await traceAsync(this.logger, 'startup.local_catalog_bootstrap', undefined, async () => {
        await this.bootstrapFromLocalCatalog();
      });
      this.runtimeStateReporter.setStartupStage('ready');
      this.refreshRuntimeState();
      this.startRuntimeStateLoop();
    }

    if (this.localPlatform) {
      // Zero cloud I/O: no Convex client, no workspace subscription, no remote
      // bridge attach. The catalog bootstrap above is the entire workspace
      // lifecycle.
      return;
    }

    await traceAsync(
      this.logger,
      'startup.workspace_subscription',
      { waitForInitial: !this.localFirstBootstrap },
      async () =>
        await this.startWorkspaceSubscription({ waitForInitial: !this.localFirstBootstrap })
    );
  }

  private async bootstrapFromLocalCatalog(): Promise<void> {
    let snapshot: LocalWorkspaceCatalogSnapshot;
    try {
      snapshot = await Effect.runPromise(this.localWorkspaceCatalog.read());
    } catch (error) {
      if (this.localPlatform) {
        throw new Error(
          `[fleet] Local workspace catalog is unavailable: ${formatErrorMessage(error)}`,
          { cause: error }
        );
      }
      // Missing/corrupt catalogs already self-recover inside read(); anything
      // that still fails here (e.g. a permission error in the installation data root) must not
      // take the daemon down — skip the local-first bootstrap and let the
      // Convex subscription drive the workspace list instead.
      this.logger.warn(
        `[fleet] Skipping local catalog bootstrap (catalog unreadable): ${formatErrorMessage(error)}`
      );
      return;
    }

    // The catalog was written under the identity of the last reconciled login.
    // After an account switch none of it may be booted for the current user:
    // starting another account's cached workspaces would serve their local data
    // plane and leave ghost runtimes running (the remote reconcile only marks
    // them remote_missing; it does not stop retained runtimes).
    if (snapshot.identity?.userId !== this.userId) {
      this.logger.debug(
        '[fleet] Local workspace catalog identity does not match the current user; skipping local-first bootstrap'
      );
      return;
    }

    const workspaces = snapshot.workspaces.filter((workspace) => workspace.state === 'active');
    if (workspaces.length === 0) {
      this.logger.debug('[fleet] Local workspace catalog is empty');
      return;
    }

    this.logger.debug(`[fleet] Bootstrapping ${workspaces.length} workspace(s) from local catalog`);
    await this.applyWorkspaceList(workspaces.map(localCatalogWorkspaceToWorkspaceListItem));
  }

  private async startWorkspaceSubscription(options: { waitForInitial: boolean }): Promise<void> {
    // Subscribe to the user's workspace list. Remote is the reconcile source once reachable;
    // local catalog remains the bootstrap source so startup does not wait on Convex.
    const confirmationStartedAt = Date.now();
    const initial = new Promise<void>((resolve, reject) => {
      let initialResolved = false;

      const rejectRemoteAuthentication = (message: string) => {
        if (this.invalidTokenReported) return;
        this.invalidTokenReported = true;
        this.logger.error(message);
        this.runtimeStateReporter.setBackendAuthorization('rejected');
        this.runtimeStateReporter.setBackendConnection('disconnected');
        this.runtimeStateReporter.upsertIssue({
          code: 'auth_token_invalid',
          severity: 'fatal',
          recoverable: false,
          message,
        });
        void this.handleRemoteBridgeOffline();
        const error = new Error(message);
        if (!initialResolved) {
          initialResolved = true;
          if (options.waitForInitial) {
            reject(error);
          } else {
            this.onFatalAuthFailure?.(error);
            resolve();
          }
        } else {
          this.onFatalAuthFailure?.(error);
        }
      };

      const unsubscribe = this.cloudPort.access.watchWorkspaceAccess(
        (result) => {
          if (result.status === 'unauthorized') {
            rejectRemoteAuthentication(result.reason);
            return;
          }
          if (result.userId !== this.userId) {
            rejectRemoteAuthentication(
              `Remote CLI identity ${result.userId} does not match cached identity ${this.userId}.`
            );
            return;
          }

          this.runtimeStateReporter.setBackendAuthorization('authorized');
          this.runtimeStateReporter.setBackendConnection('connected');

          if (!initialResolved) {
            this.logger.debug(
              `[startup] Remote authentication confirmed durationMs=${
                Date.now() - confirmationStartedAt
              }`
            );
          }
          this.runtimeStateReporter.clearIssue('workspace_subscription_error');
          this.lastValidWorkspaceListResult = result;
          const applyPromise = this.applyRemoteWorkspaceList(result);

          if (!initialResolved) {
            initialResolved = true;
            void applyPromise
              .then(() => {
                this.runtimeStateReporter.setStartupStage('ready');
                this.refreshRuntimeState();
                this.startRuntimeStateLoop();
                resolve();
              })
              .catch(reject);
          } else {
            void applyPromise.catch((error: unknown) => {
              const message = `[fleet] Failed to apply workspace list: ${formatErrorMessage(
                error
              )}`;
              this.logger.warn(message);
              this.runtimeStateReporter.upsertIssue({
                code: 'workspace_list_apply_failed',
                severity: 'warning',
                recoverable: true,
                message,
              });
              this.scheduleReconcileRetry();
            });
          }
        },
        (error) => {
          const message = `[fleet] Workspace subscription error: ${formatErrorMessage(error)}`;
          this.logger.warn(message);
          this.runtimeStateReporter.setBackendConnection('disconnected');
          this.runtimeStateReporter.upsertIssue({
            code: 'workspace_subscription_error',
            severity: 'error',
            recoverable: true,
            message,
          });
          this.refreshRuntimeState();
          // Transient subscription errors get a grace window before the data
          // plane detaches; a recovered workspace list cancels the timer.
          this.scheduleRemoteBridgeOffline();

          if (!initialResolved) {
            initialResolved = true;
            if (options.waitForInitial) {
              if (typeof unsubscribe === 'function') {
                unsubscribe();
              }
              this.unsubscribeWorkspaces = null;
              reject(new Error(message));
            } else {
              resolve();
            }
          }
        }
      );

      this.unsubscribeWorkspaces = unsubscribe;
    });

    if (options.waitForInitial) {
      await initial;
      return;
    }

    void initial.catch((error: unknown) => {
      this.logger.warn(`[fleet] Workspace subscription failed: ${formatErrorMessage(error)}`);
    });
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopRuntimeStateLoop();
    this.memoryPressure.stop();
    Effect.runSync(this.prStatusPoller.stop);
    this.lanPushFallback?.close();
    this.unsubscribeLanMoves?.();
    this.unsubscribeLanMoves = null;
    this.lanHubClock?.stop();

    // Stop accepting local work before draining workspace runtimes. Endpoint
    // teardown must not sit behind slow agent/session cleanup, and the owning
    // Host lease remains held until this shutdown barrier completes.
    const localServicesStopped = Promise.allSettled([
      stopLocalIpcSocketServers(),
      stopLocalTerminalServer(),
      this.localTunnelServer.stop(),
      this.lanTerminalHost?.close(),
      this.lanFleetControl?.close(),
      this.lanHubStandby?.close(),
      stopLocalLoroDataPlaneServer(),
      stopLodyMcpHttpServer(),
    ]);

    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.cancelScheduledRemoteBridgeOffline();
    this.clearReconcileRetry();
    this.remoteBridge?.shutdown();

    this.unsubscribeWorkspaces?.();
    this.unsubscribeWorkspaces = null;

    const runtimes = Array.from(this.runtimes.values());
    this.runtimes.clear();
    for (const runtime of runtimes) {
      try {
        await runtime.schedules.dispose();
        await runtime.lody.cleanup();
        runtime.unsubscribeTerminalCleanup();
        await runtime.prPollerWorkspace.dispose();
        await runtime.reviewAutomation?.dispose();
      } catch (error) {
        runtime.unsubscribeTerminalCleanup();
        this.logger.debug(
          `[fleet] Failed to cleanup workspace runtime ${runtime.workspace.id}: ${formatErrorMessage(
            error
          )}`
        );
      }
    }
    await this.workspaceWatchCoordinator.dispose();
    // After the runtimes: their sessions report their last usage as they stop.
    this.usageLedger?.close();
    await this.cloudPort.dispose();

    for (const result of await localServicesStopped) {
      if (result.status === 'rejected') {
        this.logger.debug(
          `[fleet] Failed to stop a local service: ${formatErrorMessage(result.reason)}`
        );
      }
    }
    this.terminalRouter.dispose();
    this.terminalPtyService.closeAll();
  }

  private async applyWorkspaceList(
    next: WorkspaceListItem[],
    options: { retainRunningWorkspaceIds?: Set<string> } = {}
  ): Promise<void> {
    if (this.stopped) return;

    this.desiredWorkspaces.clear();
    for (const workspace of next) {
      this.desiredWorkspaces.set(workspace.id, workspace);
      const runtime = this.runtimes.get(workspace.id);
      if (runtime) {
        runtime.workspace = workspace;
      }
    }

    const nextIds = new Set(this.desiredWorkspaces.keys());
    const prevIds = new Set([
      ...this.runtimes.keys(),
      ...this.retryTimers.keys(),
      ...this.startInFlight.keys(),
    ]);

    // Remove workspaces no longer present.
    for (const workspaceId of prevIds) {
      if (nextIds.has(workspaceId)) continue;
      if (options.retainRunningWorkspaceIds?.has(workspaceId) && this.runtimes.has(workspaceId)) {
        continue;
      }
      await this.stopWorkspace(workspaceId);
    }

    // Workspace repos are independent SQLite databases. Start a small bounded
    // batch concurrently so one slow workspace does not serialize fleet readiness.
    const workspacesToStart = next.filter((workspace) => !this.runtimes.has(workspace.id));
    for (
      let index = 0;
      index < workspacesToStart.length;
      index += FLEET_WORKSPACE_START_CONCURRENCY
    ) {
      await Promise.all(
        workspacesToStart
          .slice(index, index + FLEET_WORKSPACE_START_CONCURRENCY)
          .map(async (workspace) => await this.startWorkspace(workspace))
      );
    }

    this.runtimeStateReporter.clearIssue('workspace_list_apply_failed');
    this.refreshRuntimeState();
  }

  private async applyRemoteWorkspaceList(result: AuthorizedWorkspaceList): Promise<void> {
    const remoteBridge = this.remoteBridge;
    if (!remoteBridge) {
      throw new Error('Cloud workspace access is configured without a Streams bridge');
    }
    // The subscription re-fires on every reactive change; only repeat the remote
    // bridge reconcile when the meaningful workspace set actually changed.
    const signature = JSON.stringify({
      userId: result.userId,
      machineId: this.machineId,
      machineName: this.machineName,
      workspaces: result.workspaces.map((workspace) => [
        workspace.id,
        workspace.name,
        workspace.slug,
        workspace.role,
        workspace.userId ?? null,
      ]),
    });
    // A valid workspace list means the control plane is reachable again; cancel
    // any pending offline grace timer before it detaches the data plane.
    this.cancelScheduledRemoteBridgeOffline();
    let revokedRunningWorkspaceIds = new Set<string>();
    if (signature !== this.lastCachedWorkspaceSignature) {
      const reconcile = await remoteBridge.reconcileOnline({
        workspaces: [...result.workspaces],
        runningWorkspaceIds: this.runtimes.keys(),
      });
      revokedRunningWorkspaceIds = reconcile.revokedRunningWorkspaceIds;
      for (const workspace of result.workspaces) {
        this.remoteRevokedWorkspaceIds.delete(workspace.id);
      }
      // An account can lose a workspace without its user acting, so that
      // workspace keeps serving what it holds locally. A LAN only leaves the
      // list because the user removed it here, and its runtime stops with it.
      if (this.cloudPort.kind !== 'local') {
        for (const workspaceId of revokedRunningWorkspaceIds) {
          this.remoteRevokedWorkspaceIds.add(workspaceId);
        }
      }
      this.lastCachedWorkspaceSignature = signature;
    }
    await this.applyWorkspaceList([...result.workspaces], {
      retainRunningWorkspaceIds: this.remoteRevokedWorkspaceIds,
    });
    await remoteBridge.attachAllowedRuntimes(result.workspaces.map((workspace) => workspace.id));
    this.refreshRuntimeState();
    // A full apply succeeded; drop any pending reconcile retry + reset backoff.
    this.clearReconcileRetry();
    this.runtimeStateReporter.clearIssue('workspace_list_apply_failed');
  }

  private scheduleReconcileRetry(): void {
    if (this.stopped || this.reconcileRetryTimer || !this.lastValidWorkspaceListResult) {
      return;
    }
    const delayMs = this.reconcileRetryDelayMs || FLEET_RECONCILE_RETRY_INITIAL_DELAY_MS;
    this.reconcileRetryDelayMs = Math.min(delayMs * 2, FLEET_RECONCILE_RETRY_MAX_DELAY_MS);
    const timer = setTimeout(() => {
      this.reconcileRetryTimer = null;
      const result = this.lastValidWorkspaceListResult;
      if (this.stopped || !result) {
        return;
      }
      void this.applyRemoteWorkspaceList(result).catch((error: unknown) => {
        this.logger.warn(`[fleet] Reconcile retry failed: ${formatErrorMessage(error)}`);
        this.scheduleReconcileRetry();
      });
    }, delayMs);
    timer.unref?.();
    this.reconcileRetryTimer = timer;
  }

  private clearReconcileRetry(): void {
    if (this.reconcileRetryTimer) {
      clearTimeout(this.reconcileRetryTimer);
      this.reconcileRetryTimer = null;
    }
    this.reconcileRetryDelayMs = 0;
  }

  private async startWorkspace(workspace: WorkspaceListItem): Promise<void> {
    if (this.stopped) return;
    if (!this.desiredWorkspaces.has(workspace.id)) return;
    if (this.runtimes.has(workspace.id)) return;

    const retryTimer = this.retryTimers.get(workspace.id);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.retryTimers.delete(workspace.id);
      this.refreshRuntimeState();
    }

    const inFlight = this.startInFlight.get(workspace.id);
    if (inFlight) {
      await inFlight;
      if (this.stopped) return;
      if (this.runtimes.has(workspace.id)) return;
      if (!this.desiredWorkspaces.has(workspace.id)) return;
    }

    const task = (async () => {
      const workspaceLabel = workspace.slug?.trim() || workspace.name || workspace.id;
      const workspaceLogger = this.logger.child({
        workspaceId: workspace.id,
        workspaceName: workspaceLabel,
      });

      let lody: Lody | null = null;
      let stopSchedules: (() => Promise<void>) | undefined;
      const workspaceStartAt = Date.now();
      const workspaceCloudPort = this.cloudPortFor(workspace);
      try {
        lody = await Lody.create({
          logger: workspaceLogger,
          builtinAgentConfigCliTypes: this.builtinAgentConfigCliTypes,
          supportRegistryAgentTypes: this.supportRegistryAgentTypes,
          workspaceId: workspace.id as WorkspaceId,
          workspaceSlug: workspace.slug ?? undefined,
          token: this.cliToken,
          userId: workspace.userId ?? this.userId,
          machineId: this.machineId,
          machineName: this.machineName,
          machineNameExplicit: this.machineNameExplicit,
          cloudPort: workspaceCloudPort,
          localWorkspaceCatalog: this.localWorkspaceCatalog,
          memoryPressure: this.memoryPressure,
          machineLifecycleCapability: this.machineLifecycleCapability,
          closeSessionTerminals: (sessionId) => this.terminalPtyService.closeSession(sessionId),
          cleanupLocalProjectWorktreeSetupIfUnreferenced: (localProjectId) =>
            this.cleanupLocalProjectWorktreeSetupIfUnreferenced(localProjectId),
          onFatalAuthFailure: this.onFatalAuthFailure,
          onProcessLifecycleAction: this.onProcessLifecycleAction,
          workspaceWatchCoordinator: this.workspaceWatchCoordinator,
          ...(this.lanFleetControl
            ? {
                answerLanMemberControl: async (request) =>
                  await (this.lanFleetControl as LanFleetControl).answer(request),
              }
            : {}),
          acceptsLanMemberFiles: this.lanTerminalHost !== null && this.isLanWorkspace(workspace.id),
          lanWorkspace: this.isLanWorkspace(workspace.id),
          ...(this.isLanWorkspace(workspace.id)
            ? {
                askLanMemberDirect: async (machineId, request) => {
                  const forwarded = await this.forwardLanRpc({
                    workspaceId: workspace.id,
                    targetMachineId: machineId,
                    request,
                  });
                  if (!forwarded.sent) return null;
                  if (forwarded.error) throw new Error(forwarded.error);
                  return forwarded.answers;
                },
              }
            : {}),
        });

        if (!this.desiredWorkspaces.has(workspace.id) || this.stopped) {
          await lody.cleanup();
          return;
        }

        await lody.start();

        await reconcileMachineLocalProjectRootPaths(
          lody.documentManager.repo,
          workspace.id as WorkspaceId,
          this.machineId,
          lody.documentManager
        ).catch((error: unknown) => {
          workspaceLogger.warn(
            `Failed to reconcile local project paths: ${formatErrorMessage(error)}`
          );
        });

        if (!this.desiredWorkspaces.has(workspace.id) || this.stopped) {
          await lody.cleanup();
          return;
        }

        const startedLody = lody;
        const unsubscribeTerminalCleanup = startedLody.onSessionTerminated((sessionId) => {
          this.terminalPtyService.closeSession(sessionId);
        });
        const prPollerWorkspace = createLodyPrPollerWorkspace({
          documentManager: startedLody.documentManager,
          workspaceId: workspace.id,
          userId: workspace.userId ?? this.userId,
          machineId: this.machineId,
          githubTokens: this.cloudPort.githubTokens,
          prAssociation: this.cloudPort.prAssociation,
          logger: workspaceLogger,
        });
        // Scheduled automation: this machine runs the schedules it owns, so
        // entrusted work continues while nobody is looking.
        const executionSlots = new AgentExecutionSlots();
        const schedules = await createScheduleWorkspace({
          manager: startedLody.documentManager,
          workspace,
          auth: {
            token: this.cliToken,
            userId: workspace.userId ?? this.userId,
            userName: '',
            userEmail: '',
            machineId: this.machineId,
            machineName: this.machineName,
          },
          localOnly: this.localPlatform,
          slots: executionSlots,
          logger: workspaceLogger,
          hasSessionWork: (sessionId) => startedLody.hasAutomationSessionWork(sessionId),
          notifications: workspaceCloudPort.notifications,
        });
        stopSchedules = schedules.dispose;
        // Auto review and merge. It runs here rather than through MCP because
        // the orchestration chain-depth guard caps a chain at five hops from the
        // last human input, and because CI and GitHub state are explicitly
        // outside that contract.
        const asSessionCommand =
          <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
          async (...args: A) =>
            await startedLody.runAsSessionCommand(() => run(...args));
        const reviewAutomation = this.cloudPort.githubTokens
          ? createReviewAutomation({
              documentManager: startedLody.documentManager,
              workspaceId: workspace.id as WorkspaceId,
              machineId: this.machineId,
              logger: workspaceLogger,
              resolveGitHubToken: async (repoFullName) => {
                if (!repoFullName) {
                  return null;
                }
                const credential = await this.reviewCredentialResolver(
                  workspace.id,
                  workspaceLogger
                ).resolve(repoFullName);
                return credential?.token ?? null;
              },
              // On the local platform there is no hosted account to check the
              // reviewer's machine against; the workspace's session command
              // environment checks it against the members instead.
              createReviewerSession: asSessionCommand(async (args) => {
                const { createSessionResult, resolveTurnDispatchConfig } =
                  await import('@/commands/session');
                const created = await createSessionResult(
                  this.reviewAuth(),
                  workspace,
                  startedLody.documentManager,
                  args.prompt,
                  {
                    parent: args.parentSessionId,
                    title: 'Review',
                    // New runs freeze the exact machine-local config. The
                    // agent-type fallback only exists for runs authorized by a
                    // client from before machine reviewer configs shipped.
                    ...(args.agentConfigId
                      ? { agentConfig: args.agentConfigId }
                      : args.agentType
                        ? { agent: args.agentType }
                        : {}),
                  },
                  {
                    ...resolveTurnDispatchConfig({
                      // New machine configs freeze the mode/config options the
                      // settings UI displayed. Keep plan as the safe fallback
                      // only for runs authorized by older clients.
                      mode:
                        args.modeId ??
                        (args.agentConfigId ? undefined : ACP_PLAN_PERMISSION_MODE_ID),
                      ...(args.modelId ? { model: args.modelId } : {}),
                    }),
                    ...(args.configOptionValues
                      ? { configOptionValues: args.configOptionValues }
                      : {}),
                  }
                );
                return { sessionId: created.sessionId };
              }),
              sendChat: asSessionCommand(async (sessionId: SessionId, prompt: string) => {
                const { sendSessionChatResult, resolveTurnDispatchConfig } =
                  await import('@/commands/session');
                const sent = await sendSessionChatResult(
                  this.reviewAuth(),
                  workspace,
                  startedLody.documentManager,
                  sessionId,
                  prompt,
                  resolveTurnDispatchConfig({})
                );
                return { userTurnId: sent.userTurnId };
              }),
            })
          : null;
        this.runtimes.set(workspace.id, {
          workspace,
          lody: startedLody,
          unsubscribeTerminalCleanup,
          prPollerWorkspace,
          schedules,
          reviewAutomation,
        });
        this.prStatusPoller.registerWorkspace(prPollerWorkspace);
        void this.remoteBridge?.attachRuntimeIfAllowed(workspace.id);
        void this.publishLanTerminalEndpoint(
          workspace.id,
          this.lanTerminalHost?.endpointFor(workspace.id)
        );
        this.lanFleetControl?.publishAfterStart();
        this.logger.debug(`[fleet] Connected workspace: ${workspaceLabel} (${workspace.id})`);
        this.logger.debug(
          `[startup] Workspace runtime ready workspaceId=${workspace.id} durationMs=${
            Date.now() - workspaceStartAt
          }`
        );
        this.runtimeStateReporter.clearIssue(`workspace_start_failed:${workspace.id}`);
        this.refreshRuntimeState();
      } catch (error) {
        await stopSchedules?.();
        if (lody) {
          await lody.cleanup().catch((cleanupError: unknown) => {
            this.logger.debug(
              `[fleet] Failed to cleanup failed workspace runtime ${workspace.id}: ${formatErrorMessage(
                cleanupError
              )}`
            );
          });
        }
        throw error;
      }
    })()
      .catch((error: unknown) => {
        const message = `[fleet] Failed to start workspace runtime ${workspace.id}: ${formatErrorMessage(
          error,
          { includeStack: true }
        )}`;
        this.logger.warn(message);
        this.runtimeStateReporter.upsertIssue({
          code: `workspace_start_failed:${workspace.id}`,
          severity: 'warning',
          recoverable: true,
          message,
        });
        this.scheduleRetry(workspace);
      })
      .finally(() => {
        this.startInFlight.delete(workspace.id);
        this.refreshRuntimeState();
      });

    this.startInFlight.set(workspace.id, task);
    this.refreshRuntimeState();
    return await task;
  }

  private scheduleRetry(workspace: WorkspaceListItem): void {
    if (this.stopped) return;
    if (!this.desiredWorkspaces.has(workspace.id)) return;
    if (this.retryTimers.has(workspace.id)) return;

    const delayMs = 10_000;
    const timer = setTimeout(() => {
      this.retryTimers.delete(workspace.id);
      this.refreshRuntimeState();
      const desiredWorkspace = this.desiredWorkspaces.get(workspace.id);
      if (!desiredWorkspace || this.stopped) return;
      void this.startWorkspace(desiredWorkspace);
    }, delayMs);
    timer.unref?.();
    this.retryTimers.set(workspace.id, timer);
    this.refreshRuntimeState();
  }

  /** Who this machine is in one workspace: the members of a LAN share a user. */
  private userIdFor(workspaceId: string): string {
    return (
      this.runtimes.get(workspaceId)?.workspace.userId ??
      this.desiredWorkspaces.get(workspaceId)?.userId ??
      this.userId
    );
  }

  /**
   * The port as one workspace sees it. Everything below the fleet asks the
   * port who the owner is, and the owner of a LAN workspace is the user of
   * that LAN rather than the one the process started as.
   */
  private cloudPortFor(workspace: WorkspaceListItem): CloudPort {
    // A LAN has no hosted backend; its hub pushes to the phones of the LAN.
    const notifications =
      !this.cloudPort.notifications && this.isLanWorkspace(workspace.id)
        ? createLanNotificationsPort({
            resolveHub: () =>
              this.lan?.hubs.find((hub) => getLanHubWorkspaceId(hub.id) === workspace.id) ?? null,
            machineId: this.machineId,
            // Alerts have little room; the short name the LAN gave this machine fits better.
            machineName: async () => {
              const repo = this.runtimes.get(workspace.id)?.lody.documentManager.repo;
              const alias = repo
                ? await readLanMachineAlias(repo, this.machineId).catch(() => null)
                : null;
              return alias ?? this.machineName;
            },
            logger: this.logger,
            fallback: (this.lanPushFallback ??= createLanPushFallback({ logger: this.logger })),
          })
        : this.cloudPort.notifications;
    const sameUser = !workspace.userId || workspace.userId === this.cloudPort.identity.userId;
    if (sameUser && notifications === this.cloudPort.notifications) {
      return this.cloudPort;
    }
    return {
      ...this.cloudPort,
      identity: sameUser
        ? this.cloudPort.identity
        : {
            ...this.cloudPort.identity,
            userId: workspace.userId ?? this.cloudPort.identity.userId,
          },
      notifications,
      // The fleet owns the port; a workspace that stops must not dispose it.
      dispose: () => Promise.resolve(),
    };
  }

  /**
   * Reconnects the workspaces of LANs whose hub now answers at another
   * address. Only what reads from the hub is replaced: the agents and their
   * turns keep running on the local replica, which the new connection
   * catches up. Machine RPC reads its request stream from the start, since
   * the offset it held may name nothing in a hub started from a copy; push,
   * GitHub and credentials read the address per request and hold no offset.
   */
  private followLanMoves(hubs: readonly LanHub[]): void {
    // Another machine hosts the hub now, with a clock of its own.
    void this.lanHubClock?.sync();
    for (const hub of hubs) {
      const workspaceId = getLanHubWorkspaceId(hub.id);
      const runtime = this.runtimes.get(workspaceId);
      if (!runtime || this.stopped) continue;
      runtime.lody.restartMachineRpcListener();
      // Queued before anything can attach again, so the next attach builds
      // its transport toward the new address.
      void runtime.lody
        .detachRemoteBridge()
        .then(async () => await this.remoteBridge?.attachRuntimeIfAllowed(workspaceId))
        .catch((error: unknown) => {
          this.logger.warn(
            `[lan] Could not reconnect ${hub.name} at ${hub.url}: ${formatErrorMessage(error)}`
          );
        });
    }
  }

  private async stopWorkspace(workspaceId: string): Promise<void> {
    const retryTimer = this.retryTimers.get(workspaceId);
    if (retryTimer) {
      clearTimeout(retryTimer);
    }
    this.retryTimers.delete(workspaceId);

    const state = this.runtimes.get(workspaceId);
    if (!state) return;
    this.runtimes.delete(workspaceId);
    // Keyed by workspace, so it would otherwise outlive every workspace this
    // process ever connected to.
    this.reviewCredentialResolvers.delete(workspaceId);
    this.prStatusPoller.unregisterWorkspace(workspaceId);

    try {
      await state.schedules.dispose();
      await state.reviewAutomation?.dispose();
      await state.lody.cleanup();
      state.unsubscribeTerminalCleanup();
      await state.prPollerWorkspace.dispose();
    } catch (error) {
      state.unsubscribeTerminalCleanup();
      this.logger.debug(
        `[fleet] Failed to cleanup workspace runtime ${workspaceId}: ${formatErrorMessage(error)}`
      );
    }
    this.refreshRuntimeState();
  }

  private startRuntimeStateLoop(): void {
    if (this.runtimeStateTimer) {
      return;
    }
    this.refreshRuntimeState();
    const timer = setInterval(() => {
      this.refreshRuntimeState();
    }, FLEET_RUNTIME_STATE_INTERVAL_MS);
    timer.unref?.();
    this.runtimeStateTimer = timer;
  }

  private stopRuntimeStateLoop(): void {
    if (!this.runtimeStateTimer) {
      return;
    }
    clearInterval(this.runtimeStateTimer);
    this.runtimeStateTimer = null;
  }

  /**
   * A transient Convex subscription error must not immediately tear down the
   * Streams data plane (detach + re-attach churn on every control-plane blip).
   * Schedule the detach after a grace window; a successful workspace-list
   * update cancels it.
   */
  private scheduleRemoteBridgeOffline(): void {
    if (this.stopped || this.remoteBridgeOfflineTimer) {
      return;
    }
    const timer = setTimeout(() => {
      this.remoteBridgeOfflineTimer = null;
      void this.handleRemoteBridgeOffline();
    }, FLEET_REMOTE_BRIDGE_OFFLINE_GRACE_MS);
    timer.unref?.();
    this.remoteBridgeOfflineTimer = timer;
  }

  private cancelScheduledRemoteBridgeOffline(): void {
    if (this.remoteBridgeOfflineTimer) {
      clearTimeout(this.remoteBridgeOfflineTimer);
      this.remoteBridgeOfflineTimer = null;
    }
  }

  private async handleRemoteBridgeOffline(): Promise<void> {
    this.cancelScheduledRemoteBridgeOffline();
    this.lastCachedWorkspaceSignature = null;
    await this.remoteBridge?.markOffline(
      Array.from(this.runtimes.values(), (runtime) => runtime.lody)
    );
    this.refreshRuntimeState();
  }

  /**
   * Auth context for engine-authored turns.
   *
   * Same shape scheduled automation uses: the daemon's own CLI credential
   * is the authorization principal, and the session's owner is inherited from
   * the session being driven.
   */
  private reviewAuthContext(): {
    token: string;
    userId: string;
    userName: string;
    userEmail: string;
    machineId: MachineId;
    machineName: string;
  } {
    return {
      token: this.cliToken,
      userId: this.userId,
      userName: '',
      userEmail: '',
      machineId: this.machineId,
      machineName: this.machineName,
    };
  }

  /**
   * Who auto review acts as: the session command environment's identity where
   * one runs (the local platform), the CLI token's otherwise.
   */
  private reviewAuth(): ReturnType<LodyFleet['reviewAuthContext']> {
    return getSessionCommandEnvironment()?.auth ?? this.reviewAuthContext();
  }

  /** One resolver per workspace, so the credential cache is shared across runs. */
  private reviewCredentialResolver(workspaceId: string, logger: Logger): GitHubCredentialResolver {
    const existing = this.reviewCredentialResolvers.get(workspaceId);
    if (existing) {
      return existing;
    }
    const resolver = new GitHubCredentialResolver({
      tokenManager: this.cloudPort.githubTokens?.createTokenManager(workspaceId) ?? null,
      writeTokenContext: { requesterUserId: this.userId, machineId: this.machineId },
      workspaceId,
      logger,
    });
    this.reviewCredentialResolvers.set(workspaceId, resolver);
    return resolver;
  }

  private refreshRuntimeState(): void {
    const desiredCount = this.desiredWorkspaces.size;
    let connectedCount = 0;
    let reconnectingCount = 0;
    let totalActiveSessions = 0;
    let totalConnectedRooms = 0;
    const connectedWorkspaces: CliRuntimeWorkspace[] = [];
    for (const runtime of this.runtimes.values()) {
      if (runtime.lody.isControlPlaneReady()) {
        connectedCount += 1;
      } else if (runtime.lody.isControlPlaneRecovering()) {
        reconnectingCount += 1;
      }
      totalActiveSessions += runtime.lody.getActiveSessionCount();
      totalConnectedRooms += runtime.lody.getConnectedRoomCount();
      connectedWorkspaces.push({
        id: runtime.workspace.id,
        name: runtime.workspace.name,
        slug: runtime.workspace.slug,
        role: runtime.workspace.role,
        backendConnection: runtime.lody.isRemoteBridgeAttached()
          ? runtime.lody.isControlPlaneRecovering()
            ? 'reconnecting'
            : 'connected'
          : 'disconnected',
      });
    }
    connectedWorkspaces.sort(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    );
    this.runtimeStateReporter.setActiveSessionCount(totalActiveSessions);
    this.runtimeStateReporter.setConnectedRoomCount(totalConnectedRooms);
    this.runtimeStateReporter.setConnectedWorkspaces(connectedWorkspaces);

    const hasWorkspaceRetry = this.retryTimers.size > 0 || this.startInFlight.size > 0;
    const nextConnectivity: CliRuntimeConnectivity =
      desiredCount === 0
        ? 'online'
        : connectedCount === desiredCount
          ? 'online'
          : reconnectingCount > 0 || hasWorkspaceRetry
            ? 'reconnecting'
            : 'offline';

    if (this.lastConnectivity !== nextConnectivity) {
      this.lastConnectivity = nextConnectivity;
      this.runtimeStateReporter.setConnectivity(nextConnectivity);
    }

    if (hasWorkspaceRetry && !this.hasWorkspaceRetryIssue) {
      this.hasWorkspaceRetryIssue = true;
      this.runtimeStateReporter.upsertIssue({
        code: 'workspace_runtime_retrying',
        severity: 'warning',
        recoverable: true,
        message: 'Workspace runtime is retrying in background.',
      });
    } else if (!hasWorkspaceRetry && this.hasWorkspaceRetryIssue) {
      this.hasWorkspaceRetryIssue = false;
      this.runtimeStateReporter.clearIssue('workspace_runtime_retrying');
    }

    if (nextConnectivity === 'offline') {
      if (!this.hasControlOfflineIssue) {
        this.hasControlOfflineIssue = true;
        this.runtimeStateReporter.upsertIssue({
          code: 'control_offline',
          severity: 'error',
          recoverable: true,
          message: 'Control connection is offline.',
        });
      }
    } else if (this.hasControlOfflineIssue) {
      this.hasControlOfflineIssue = false;
      this.runtimeStateReporter.clearIssue('control_offline');
    }

    if (nextConnectivity === 'reconnecting') {
      if (!this.hasControlReconnectingIssue) {
        this.hasControlReconnectingIssue = true;
        this.runtimeStateReporter.upsertIssue({
          code: 'control_reconnecting',
          severity: 'warning',
          recoverable: true,
          message: 'Control connection is reconnecting.',
        });
      }
    } else if (this.hasControlReconnectingIssue) {
      this.hasControlReconnectingIssue = false;
      this.runtimeStateReporter.clearIssue('control_reconnecting');
    }
  }

  private async dispatchLocalSessionControl(
    message: LocalSessionControlRequest,
    options: { onResponse?: (response: LocalSessionControlResponse) => void } = {}
  ): Promise<LocalSessionControlResponse[]> {
    if (message.type === 'session/file-read-local') {
      const response = await this.lanFileHandoff.read(message);
      options.onResponse?.(response);
      return [response];
    }
    if (
      message.type === 'session/file-send-local' &&
      message.targetMachineId &&
      message.targetMachineId !== this.machineId
    ) {
      const response = await this.lanFileHandoff.send({
        ...message,
        targetMachineId: message.targetMachineId,
      });
      options.onResponse?.(response);
      return [response];
    }

    // Image and file uploads (from the in-session MCP server) may omit the
    // workspaceId; resolve it by finding the single active runtime that holds
    // the session doc. Both share the same resolution + ambiguity handling.
    if (
      (message.type === 'session/image-upload' ||
        message.type === 'session/file-upload' ||
        message.type === 'session/file-send-local') &&
      !message.workspaceId
    ) {
      const responseType =
        message.type === 'session/image-upload'
          ? 'session/image-upload_response'
          : message.type === 'session/file-upload'
            ? 'session/file-upload_response'
            : 'session/file-send-local_response';
      const roomId = getSessionRoomId(message.sessionId);
      const matches: WorkspaceRuntimeState[] = [];

      for (const runtime of this.runtimes.values()) {
        const meta = await runtime.lody.documentManager.repo.getDocMeta(roomId);
        if (meta?.meta && !isLoroRepoDocDeleted(meta)) {
          matches.push(runtime);
        }
      }

      if (matches.length === 0) {
        const response = {
          type: responseType,
          sessionId: message.sessionId,
          success: false,
          error: 'session_not_found',
          message: `Session not found: ${message.sessionId}`,
        } as LocalSessionControlResponse;
        options.onResponse?.(response);
        return [response];
      }

      if (matches.length > 1) {
        const response = {
          type: responseType,
          sessionId: message.sessionId,
          success: false,
          error: 'session_ambiguous',
          message: `Session ${message.sessionId} exists in multiple active workspace runtimes`,
        } as LocalSessionControlResponse;
        options.onResponse?.(response);
        return [response];
      }

      return await matches[0]!.lody.dispatchLocalControl(
        {
          ...message,
          workspaceId: matches[0]!.workspace.id as WorkspaceId,
        },
        options
      );
    }

    const workspaceId = message.workspaceId;
    if (!workspaceId) {
      throw new Error('workspace_runtime_unavailable:missing_workspace_id');
    }

    const pendingStart = this.startInFlight.get(workspaceId);
    if (pendingStart) {
      await pendingStart;
    }

    const runtime = this.runtimes.get(workspaceId);
    if (!runtime) {
      throw new Error(`workspace_runtime_unavailable:${workspaceId}`);
    }

    return await runtime.lody.dispatchLocalControl(message, options);
  }

  private async dispatchLocalMachineRpc(
    message: import('@lody/shared').LocalMachineRpcRequestValidated
  ): Promise<import('@lody/shared').LocalMachineRpcResponse> {
    if (message.method === 'lan/rpc-forward') {
      return {
        ok: true,
        result: await this.forwardLanRpc({ workspaceId: message.workspaceId, ...message.params }),
      };
    }
    const pendingStart = this.startInFlight.get(message.workspaceId);
    if (pendingStart) {
      await pendingStart;
    }

    const runtime = this.runtimes.get(message.workspaceId);
    if (!runtime) {
      return { ok: false, error: `workspace_runtime_unavailable:${message.workspaceId}` };
    }

    return await runtime.lody.dispatchLocalMachineRpc(message);
  }

  /**
   * Carries a machine RPC request, of a desktop or of this machine's own Lody
   * tools, to the member of a LAN it is for, over the connection terminals use. `sent` false leaves it to the
   * hub: the member publishes no endpoint, runs a build without `rpc`, or
   * cannot be reached from here.
   */
  private async forwardLanRpc(message: {
    workspaceId: string;
    targetMachineId: string;
    request: unknown;
  }): Promise<import('@lody/shared').LanRpcForwardResult> {
    const notSent = (error: string) => ({
      type: 'lan/rpc-forward_response' as const,
      sent: false,
      answers: [],
      error,
    });
    const { workspaceId, targetMachineId, request } = message;
    const hub = this.lan?.hubs.find(
      (candidate) => getLanHubWorkspaceId(candidate.id) === workspaceId
    );
    const runtime = this.runtimes.get(workspaceId);
    if (!hub || !runtime) return notSent('No LAN of this machine carries the workspace');
    const meta = (
      await runtime.lody.documentManager.repo.getDocMeta(
        getMachineRoomId(targetMachineId as MachineId)
      )
    )?.meta as MachineMeta | undefined;
    const endpoint = parseLanTerminalEndpoint(meta?.lanTerminal);
    if (!endpoint) return notSent('The member accepts no direct connections');
    const expiresAt = (request as { expiresAt?: unknown }).expiresAt;
    const timeoutMs =
      typeof expiresAt === 'number'
        ? Math.min(Math.max(expiresAt - getServerNow(), 1_000), 5 * 60_000)
        : 30_000;
    try {
      const answers = await askLanMemberRpc({
        endpoint,
        lanId: hub.id,
        key: deriveLanTerminalKey(hub.token),
        machineId: targetMachineId,
        request,
        timeoutMs,
      });
      return { type: 'lan/rpc-forward_response', sent: true, answers };
    } catch (error) {
      if (error instanceof LanRpcNotSentError) return notSent(error.message);
      return {
        type: 'lan/rpc-forward_response',
        sent: true,
        answers: [],
        error: formatErrorMessage(error),
      };
    }
  }

  // Resolves the push-based data-plane engine for a workspace the CLI socket
  // server can route a client connection to. Returns null when no runtime is
  // running yet (the client receives a retryable error).
  private getWorkspaceLoroDataPlaneServer(workspaceId: string): LocalLoroDataPlaneServer | null {
    const runtime = this.runtimes.get(workspaceId);
    if (!runtime) {
      return null;
    }
    return runtime.lody.documentManager.getLocalLoroDataPlaneServer();
  }

  private async lookupTerminalSessionMeta(
    runtime: WorkspaceRuntimeState,
    sessionId: SessionId
  ): Promise<TerminalSessionMetaLookup> {
    const record = await runtime.lody.documentManager.repo.getDocMeta(getSessionRoomId(sessionId));
    if (!record?.meta) {
      return { type: 'missing' };
    }
    if (isLoroRepoDocDeleted(record)) {
      return { type: 'deleted' };
    }
    return { type: 'found', meta: record.meta as SessionMeta };
  }

  private toLanMemberWorkspace(runtime: WorkspaceRuntimeState): LanMemberWorkspace {
    const manager = runtime.lody.documentManager;
    return {
      workspaceId: runtime.workspace.id as WorkspaceId,
      name: runtime.workspace.name,
      userId: this.userIdFor(runtime.workspace.id),
      lan: this.isLanWorkspace(runtime.workspace.id),
      repo: manager.repo,
      // A hub that is away answers late; the list of machines does not wait for it.
      getOnlineMachineIds: async () => await manager.getOnlineMachineIds({ timeoutMs: 2_000 }),
      sync: manager,
    };
  }

  private isLanWorkspace(workspaceId: string): boolean {
    return this.lan?.hubs.some((hub) => getLanHubWorkspaceId(hub.id) === workspaceId) ?? false;
  }

  private startLanTerminalHost(): void {
    if (!this.lan) return;
    let port: number | null;
    try {
      port = resolveLanTerminalPort();
    } catch (error) {
      this.logger.warn(`[lan-terminal] ${formatErrorMessage(error)}`);
      port = null;
    }
    if (port === null) {
      this.logger.info('[lan-terminal] Terminals of this machine are closed to LAN members.');
      return;
    }
    const control = this.lanFleetControl;
    this.lanTerminalHost = new LanTerminalHost({
      machineId: this.machineId,
      logger: this.logger,
      lans: this.lan,
      port,
      serviceFor: (workspaceId) =>
        this.runtimes.has(workspaceId)
          ? new ScopedTerminalService(
              this.terminalPtyService,
              async (sessionId) =>
                await this.verifyLanTerminalSession(workspaceId, sessionId as SessionId),
              this.machineId
            )
          : null,
      filesFor: (workspaceId) => this.lanFileHandoff.receiverFor(workspaceId),
      ...(control
        ? {
            controlFor: (workspaceId: string) =>
              this.runtimes.has(workspaceId)
                ? async (request: LanMemberControlRequest) => await control.answer(request)
                : null,
          }
        : {}),
      ...(this.lanHubStandby
        ? {
            hubFor: (workspaceId: string) =>
              this.lanHubStandby?.peerHandlerFor(workspaceId) ?? null,
          }
        : {}),
      tunnels: true,
      rpcFor: (workspaceId: string) => {
        const runtime = this.runtimes.get(workspaceId);
        if (!runtime) return null;
        return async (request: unknown) => {
          const answers = await runtime.lody.handleDirectMachineRpc(request);
          if (answers === null) throw new Error('This machine takes no machine requests');
          return answers;
        };
      },
      publish: async (workspaceId, endpoint) =>
        await this.publishLanTerminalEndpoint(workspaceId, endpoint),
    });
    this.lanTerminalHost.start();
  }

  /**
   * Records in a LAN's workspace where its members open terminals on this
   * machine. A workspace that starts before the endpoint is known, or while
   * terminals are closed, loses the endpoint an earlier run left there.
   */
  private async publishLanTerminalEndpoint(
    workspaceId: string,
    endpoint: LanTerminalEndpoint | undefined
  ): Promise<void> {
    if (!this.isLanWorkspace(workspaceId)) return;
    const runtime = this.runtimes.get(workspaceId);
    if (!runtime) return;
    try {
      await runtime.lody.documentManager.repo.upsertDocMeta(getMachineRoomId(this.machineId), {
        lanTerminal: endpoint,
      } as Parameters<typeof runtime.lody.documentManager.repo.upsertDocMeta>[1]);
    } catch (error) {
      this.logger.debug(
        `[lan-terminal] Failed to publish the terminal endpoint into ${workspaceId}: ${formatErrorMessage(error)}`
      );
    }
  }

  /** Answers a LAN member that asks for the terminals of a session of this machine. */
  private async verifyLanTerminalSession(workspaceId: string, sessionId: SessionId): Promise<void> {
    const runtime = this.runtimes.get(workspaceId);
    const lookup = runtime
      ? await this.lookupTerminalSessionMeta(runtime, sessionId)
      : ({ type: 'missing' } as const);
    if (lookup.type === 'missing') throw new Error(`session_not_found:${sessionId}`);
    if (lookup.type === 'deleted') throw new Error(`session_deleted:${sessionId}`);
    if (lookup.meta.isArchived) throw new Error(`session_archived:${sessionId}`);
    if (lookup.meta.machineId !== this.machineId) {
      throw new Error(`session_machine_mismatch:${sessionId}:${lookup.meta.machineId}`);
    }
  }

  /** Where a session lives, for a terminal that may be on another machine. */
  private async locateTerminalSession(
    sessionId: SessionId
  ): Promise<TerminalSessionLocation | null> {
    const shellMachineId = parseMachineShellScope(sessionId);
    if (shellMachineId !== null) return await this.locateMachineShell(shellMachineId);
    for (const runtime of this.runtimes.values()) {
      const lookup = await this.lookupTerminalSessionMeta(runtime, sessionId);
      if (lookup.type !== 'found') continue;
      // Metadata whose owner has not arrived yet names no machine to reach.
      const machineId: unknown = lookup.meta.machineId;
      if (typeof machineId !== 'string' || machineId === '') return null;
      return { workspaceId: runtime.workspace.id, machineId };
    }
    return null;
  }

  /**
   * The LAN through which another machine's shell is reached; `null` for this
   * machine. A machine no LAN of this one reaches is refused rather than
   * answered with a shell here.
   */
  private async locateMachineShell(machineId: string): Promise<TerminalSessionLocation | null> {
    if (machineId === this.machineId) return null;
    const member = await this.findLanMember(machineId, machineSupportsLanShell, 'opens no shell');
    return { workspaceId: member.workspaceId, machineId };
  }

  /**
   * A LAN of this machine in which another machine publishes where members
   * reach it and says it serves what `supports` asks; refused otherwise.
   */
  private async findLanMember(
    machineId: string,
    supports: (meta: MachineMeta) => boolean,
    refusal: string
  ): Promise<{ workspaceId: string; hub: LanHub; endpoint: LanTerminalEndpoint }> {
    let found: MachineMeta | undefined;
    for (const runtime of this.runtimes.values()) {
      const hub = this.lan?.hubs.find(
        (candidate) => getLanHubWorkspaceId(candidate.id) === runtime.workspace.id
      );
      if (!hub) continue;
      const meta = (
        await runtime.lody.documentManager.repo.getDocMeta(getMachineRoomId(machineId as MachineId))
      )?.meta as MachineMeta | undefined;
      if (!meta) continue;
      found ??= meta;
      const endpoint = parseLanTerminalEndpoint(meta.lanTerminal);
      if (endpoint && supports(meta)) return { workspaceId: runtime.workspace.id, hub, endpoint };
    }
    throw new Error(
      found
        ? `remote_unreachable:${found.name ?? machineId} ${refusal} to members; update it`
        : `remote_unreachable:no LAN of this machine reaches ${machineId}`
    );
  }

  /** A port a machine reaches: this machine directly, a member over its LAN. */
  private async openMachineTunnel(
    machineId: string,
    port: number,
    host?: string
  ): Promise<net.Socket> {
    if (machineId === this.machineId) return await connectPort(port, host);
    const member = await this.findLanMember(machineId, machineSupportsLanTunnel, 'opens no port');
    return await openLanTunnel({
      endpoint: member.endpoint,
      lanId: member.hub.id,
      key: deriveLanTerminalKey(member.hub.token),
      machineId,
      port,
      ...(host ? { host } : {}),
    });
  }

  private async connectLanTerminal(location: TerminalSessionLocation): Promise<RemoteTerminalLink> {
    const hub = this.lan?.hubs.find(
      (candidate) => getLanHubWorkspaceId(candidate.id) === location.workspaceId
    );
    const runtime = this.runtimes.get(location.workspaceId);
    if (!hub || !runtime) {
      throw new Error('remote_unreachable:the session belongs to no LAN of this machine');
    }
    const machine = (
      await runtime.lody.documentManager.repo.getDocMeta(
        getMachineRoomId(location.machineId as MachineId)
      )
    )?.meta as MachineMeta | undefined;
    const endpoint = parseLanTerminalEndpoint(machine?.lanTerminal);
    if (!endpoint) {
      throw new Error(
        `remote_unreachable:${machine?.name ?? location.machineId} accepts no terminals; update it`
      );
    }
    return await connectLanTerminal({
      endpoint,
      lanId: hub.id,
      key: deriveLanTerminalKey(hub.token),
      machineId: location.machineId,
    });
  }

  private async assertTerminalSessionAllowed(sessionId: SessionId): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      const lookup = await this.lookupTerminalSessionMeta(runtime, sessionId);
      if (lookup.type === 'missing') {
        continue;
      }
      if (lookup.type === 'deleted') {
        throw new Error(`session_deleted:${sessionId}`);
      }
      if (lookup.meta.isArchived) {
        throw new Error(`session_archived:${sessionId}`);
      }
      if (lookup.meta.machineId !== this.machineId) {
        throw new Error(`session_machine_mismatch:${sessionId}:${lookup.meta.machineId}`);
      }
      return;
    }
  }

  private async resolveActiveTerminalSessionWorkdir(sessionId: SessionId): Promise<string | null> {
    const matches: string[] = [];
    for (const runtime of this.runtimes.values()) {
      const workdir = await runtime.lody.resolveSessionWorkdir(sessionId);
      if (workdir) {
        matches.push(workdir);
      }
    }

    if (matches.length > 1) {
      throw new Error(`session_ambiguous:${sessionId}`);
    }
    return matches[0] ?? null;
  }

  private async resolveTerminalSessionWorkdirFromMetadata(sessionId: SessionId): Promise<string> {
    const matches: string[] = [];
    const errors: Error[] = [];

    for (const runtime of this.runtimes.values()) {
      try {
        const workdir = await resolveTerminalWorkdirFromMetadata({
          sessionId,
          machineId: this.machineId,
          lookupSessionMeta: async (targetSessionId) =>
            await this.lookupTerminalSessionMeta(runtime, targetSessionId),
          resolveLocalProjectRootPath: async (localProjectId) =>
            await resolveWorkspaceLocalProjectRootPath(
              runtime.lody.documentManager.repo,
              runtime.workspace.id as WorkspaceId,
              this.machineId,
              localProjectId
            ),
        });
        matches.push(workdir);
      } catch (error) {
        const message = formatErrorMessage(error);
        if (message.startsWith('session_not_found:')) {
          continue;
        }
        errors.push(error instanceof Error ? error : new Error(message));
      }
    }

    if (matches.length > 1) {
      throw new Error(`session_ambiguous:${sessionId}`);
    }
    if (matches.length === 1) {
      return matches[0]!;
    }
    if (errors[0]) {
      throw errors[0];
    }
    throw new Error(`session_not_found:${sessionId}`);
  }

  private async resolveTerminalSessionWorkdir(sessionId: SessionId): Promise<string> {
    await this.assertTerminalSessionAllowed(sessionId);
    const activeWorkdir = await this.resolveActiveTerminalSessionWorkdir(sessionId);
    if (activeWorkdir) {
      return activeWorkdir;
    }
    return await this.resolveTerminalSessionWorkdirFromMetadata(sessionId);
  }

  private toProjectControlError(
    type: LocalProjectControlRequest['type'],
    error: LocalProjectControlErrorCode,
    message: string,
    data?: unknown
  ): LocalProjectControlResponse {
    return {
      ok: false,
      type,
      error,
      message,
      ...(typeof data === 'undefined' ? {} : { data }),
    };
  }

  private mapProjectExecutionError(
    type: LocalProjectControlRequest['type'],
    error: unknown
  ): LocalProjectControlResponse {
    const message = formatErrorMessage(error);
    const normalized = message.toLowerCase();

    if (
      normalized.includes('local project path not found') ||
      normalized.includes('local project not found')
    ) {
      return this.toProjectControlError(type, 'local_project_not_found', message);
    }
    if (normalized.includes('project path') || normalized.includes('directory')) {
      return this.toProjectControlError(type, 'path_invalid', message);
    }
    if (normalized.includes('workspace_runtime_unavailable')) {
      return this.toProjectControlError(
        type,
        'workspace_not_found',
        'Local workspace runtime is unavailable. Wait for the local CLI to finish starting, or restart it.'
      );
    }
    return this.toProjectControlError(type, 'execution_failed', message);
  }

  private listWorkspaceCandidates(): Array<{ id: string; slug: string | null; name: string }> {
    return Array.from(this.runtimes.values()).map((runtime) => ({
      id: runtime.workspace.id,
      slug: runtime.workspace.slug,
      name: runtime.workspace.name,
    }));
  }

  private async resolveTargetWorkspaceRuntimes(
    selector: string | undefined,
    allWorkspaces: boolean | undefined
  ): Promise<
    | { ok: true; runtimes: WorkspaceRuntimeState[] }
    | {
        ok: false;
        error: LocalProjectControlResponse;
      }
  > {
    if (allWorkspaces) {
      const runtimes = Array.from(this.runtimes.values());
      if (runtimes.length === 0) {
        return {
          ok: false,
          error: this.toProjectControlError(
            'local-project/add',
            'workspace_not_found',
            'No active workspace runtime is available'
          ),
        };
      }
      return { ok: true, runtimes };
    }

    const trimmedSelector = selector?.trim();
    if (trimmedSelector) {
      const matches = findWorkspacesBySelector(
        Array.from(this.desiredWorkspaces.values()),
        trimmedSelector
      );
      if (matches.length === 0) {
        return {
          ok: false,
          error: this.toProjectControlError(
            'local-project/add',
            'workspace_not_found',
            `Workspace not found: ${trimmedSelector}`
          ),
        };
      }
      if (matches.length > 1) {
        return {
          ok: false,
          error: this.toProjectControlError(
            'local-project/add',
            'workspace_not_found',
            `Workspace selector is ambiguous: ${trimmedSelector}. Matches: ${matches.map(formatWorkspaceCandidate).join(', ')}. Use a workspace id or slug instead.`
          ),
        };
      }

      const targetWorkspace = matches[0]!;

      const pending = this.startInFlight.get(targetWorkspace.id);
      if (pending) {
        await pending;
      }

      const runtime = this.runtimes.get(targetWorkspace.id);
      if (!runtime) {
        return {
          ok: false,
          error: this.toProjectControlError(
            'local-project/add',
            'workspace_not_found',
            `Workspace runtime is unavailable: ${targetWorkspace.id}`
          ),
        };
      }
      return { ok: true, runtimes: [runtime] };
    }

    const runtimes = Array.from(this.runtimes.values());
    if (runtimes.length === 1) {
      return { ok: true, runtimes };
    }
    if (runtimes.length === 0) {
      return {
        ok: false,
        error: this.toProjectControlError(
          'local-project/add',
          'workspace_not_found',
          'No active workspace runtime is available'
        ),
      };
    }

    return {
      ok: false,
      error: this.toProjectControlError(
        'local-project/add',
        'workspace_required',
        'Multiple workspaces are active; specify --workspace or --all-workspaces',
        { candidates: this.listWorkspaceCandidates() }
      ),
    };
  }

  private async upsertProjectMetaInWorkspace(
    runtime: WorkspaceRuntimeState,
    entry: { localProjectId: LocalProjectId; name: string; rootPath: string }
  ): Promise<void> {
    const repo = runtime.lody.documentManager.repo;
    const workspaceId = runtime.workspace.id as WorkspaceId;
    const existing = await readMachineLocalProjects(repo, workspaceId, this.machineId);
    const previous = existing[entry.localProjectId];
    const nowMs = getServerNow();

    await upsertMachineLocalProject(
      repo,
      workspaceId,
      this.machineId,
      {
        ...(previous ?? {}),
        id: entry.localProjectId,
        name: entry.name,
        rootPath: entry.rootPath,
        createdAtMs: previous?.createdAtMs ?? nowMs,
        lastOpenedAtMs: nowMs,
      },
      nowMs,
      { sync: runtime.lody.documentManager, reason: 'local-project-add' }
    );
  }

  private async removeProjectMetaInWorkspace(
    runtime: WorkspaceRuntimeState,
    localProjectId: LocalProjectId
  ): Promise<void> {
    await removeMachineLocalProject(
      runtime.lody.documentManager.repo,
      runtime.workspace.id as WorkspaceId,
      this.machineId,
      localProjectId,
      undefined,
      { sync: runtime.lody.documentManager, reason: 'local-project-delete' }
    );
  }

  private async listProjectsByWorkspace(): Promise<
    Array<{
      workspaceId: WorkspaceId;
      workspaceName: string;
      projects: Array<{ localProjectId: LocalProjectId; name: string; rootPath: string }>;
    }>
  > {
    const groups: Array<{
      workspaceId: WorkspaceId;
      workspaceName: string;
      projects: Array<{ localProjectId: LocalProjectId; name: string; rootPath: string }>;
    }> = [];

    for (const runtime of this.runtimes.values()) {
      const existing = await readMachineLocalProjects(
        runtime.lody.documentManager.repo,
        runtime.workspace.id as WorkspaceId,
        this.machineId
      );

      const projects: Array<{ localProjectId: LocalProjectId; name: string; rootPath: string }> =
        [];
      for (const localProjectMeta of Object.values(existing)) {
        if (!localProjectMeta) {
          continue;
        }
        const rootPath = localProjectMeta.rootPath?.trim();
        if (!rootPath) continue;

        projects.push({
          localProjectId: localProjectMeta.id,
          name: localProjectMeta.name,
          rootPath,
        });
      }

      projects.sort((a, b) => {
        const nameCompare = a.name.localeCompare(b.name);
        if (nameCompare !== 0) {
          return nameCompare;
        }
        return a.rootPath.localeCompare(b.rootPath);
      });

      if (projects.length === 0) {
        continue;
      }

      groups.push({
        workspaceId: runtime.workspace.id as WorkspaceId,
        workspaceName: runtime.workspace.name,
        projects,
      });
    }

    groups.sort((a, b) => a.workspaceName.localeCompare(b.workspaceName));
    return groups;
  }

  private async isLocalProjectReferencedByAnyWorkspace(
    localProjectId: LocalProjectId
  ): Promise<boolean> {
    const workspaces = await this.listProjectsByWorkspace();
    return workspaces.some((workspace) =>
      workspace.projects.some((project) => project.localProjectId === localProjectId)
    );
  }

  private async cleanupLocalProjectWorktreeSetupIfUnreferenced(
    localProjectId: LocalProjectId
  ): Promise<void> {
    if (await this.isLocalProjectReferencedByAnyWorkspace(localProjectId)) {
      return;
    }
    await deleteLocalProjectWorktreeSetup(localProjectId);
  }

  private async listRegisteredLocalProjectRootPaths(
    workspaceId?: WorkspaceId
  ): Promise<Record<LocalProjectId, string>> {
    const rootPaths: Record<LocalProjectId, string> = {};
    const workspaces = await this.listProjectsByWorkspace();
    for (const workspace of workspaces) {
      if (workspaceId && workspace.workspaceId !== workspaceId) {
        continue;
      }
      for (const project of workspace.projects) {
        rootPaths[project.localProjectId] = project.rootPath;
      }
    }
    return rootPaths;
  }

  private async resolveWorkspaceRuntime(workspaceId: WorkspaceId): Promise<WorkspaceRuntimeState> {
    const pendingStart = this.startInFlight.get(workspaceId);
    if (pendingStart) {
      await pendingStart;
    }

    const runtime = this.runtimes.get(workspaceId);
    if (!runtime) {
      throw new Error(`workspace_runtime_unavailable:${workspaceId}`);
    }
    return runtime;
  }

  private async resolveWorkspaceProjectRootPath(
    runtime: WorkspaceRuntimeState,
    localProjectId: LocalProjectId
  ): Promise<string> {
    const rootPath = await resolveWorkspaceLocalProjectRootPathWithRetry(
      runtime.lody.documentManager.repo,
      runtime.workspace.id as WorkspaceId,
      this.machineId,
      localProjectId,
      {
        requestSync: () =>
          runtime.lody.documentManager.syncMachineFlockDoc(this.machineId, {
            reason: 'local-project-control-resolve',
            timeoutMs: readTimeoutEnv('LODY_LOCAL_PROJECT_RESOLVE_SYNC_TIMEOUT_MS', 1_500),
          }),
      }
    );
    if (!rootPath) {
      throw new Error(`Local project not found in workspace: ${localProjectId}`);
    }
    return rootPath;
  }

  private async dispatchLocalProjectControl(
    message: LocalProjectControlRequest
  ): Promise<LocalProjectControlResponse> {
    const requestType = message.type;
    if (message.machineId !== this.machineId) {
      return this.toProjectControlError(
        requestType,
        'machine_mismatch',
        `Machine mismatch: expected ${this.machineId}`
      );
    }

    try {
      if (message.type === 'local-project/list-roots') {
        return {
          ok: true,
          type: 'local-project/list-roots',
          result: await this.localProjectControlService.listBrowseRoots(),
        };
      }

      if (message.type === 'local-project/browse-dir') {
        return {
          ok: true,
          type: 'local-project/browse-dir',
          result: await this.localProjectControlService.browseDirectory({
            absolutePath: message.absolutePath,
            showHidden: message.showHidden,
            limit: message.limit,
            cursor: message.cursor,
            registeredProjects: await this.listRegisteredLocalProjectRootPaths(message.workspaceId),
          }),
        };
      }

      if (message.type === 'local-project/prepare-add') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const preparedProject = this.localProjectControlService.prepareProject(message.rootPath);
        const existingProject = await resolveWorkspaceLocalProjectWithSyncOnMiss(
          runtime.lody.documentManager.repo,
          message.workspaceId,
          this.machineId,
          preparedProject.localProjectId,
          {
            requestSync: () =>
              runtime.lody.documentManager.syncMachineFlockDoc(this.machineId, {
                reason: 'local-project-prepare-add-resolve',
                timeoutMs: readTimeoutEnv('LODY_LOCAL_PROJECT_RESOLVE_SYNC_TIMEOUT_MS', 1_500),
              }),
          }
        );
        return {
          ok: true,
          type: 'local-project/prepare-add',
          result: {
            localProjectId: preparedProject.localProjectId,
            name: existingProject?.name ?? preparedProject.name,
            rootPath: existingProject?.rootPath ?? preparedProject.rootPath,
            alreadyRegistered: existingProject !== null,
          },
        };
      }

      if (message.type === 'local-project/add') {
        const workspaceResolution = await this.resolveTargetWorkspaceRuntimes(
          message.workspace,
          message.allWorkspaces
        );
        if (!workspaceResolution.ok) {
          return workspaceResolution.error;
        }

        const addedProject = this.localProjectControlService.prepareProject(message.rootPath);
        for (const runtime of workspaceResolution.runtimes) {
          await this.upsertProjectMetaInWorkspace(runtime, {
            localProjectId: addedProject.localProjectId,
            name: addedProject.name,
            rootPath: addedProject.rootPath,
          });
        }

        return {
          ok: true,
          type: 'local-project/add',
          result: {
            localProjectId: addedProject.localProjectId,
            name: addedProject.name,
            rootPath: addedProject.rootPath,
            workspaceIds: workspaceResolution.runtimes.map(
              (runtime) => runtime.workspace.id as WorkspaceId
            ),
          },
        };
      }

      if (message.type === 'local-project/delete') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const existingProject = await resolveWorkspaceLocalProject(
          runtime.lody.documentManager.repo,
          runtime.workspace.id as WorkspaceId,
          this.machineId,
          message.localProjectId
        );
        if (!existingProject) {
          throw new Error(`Local project not found in workspace: ${message.localProjectId}`);
        }
        await this.removeProjectMetaInWorkspace(runtime, message.localProjectId);
        await this.cleanupLocalProjectWorktreeSetupIfUnreferenced(message.localProjectId);

        return {
          ok: true,
          type: 'local-project/delete',
          result: {
            localProjectId: message.localProjectId,
            name: existingProject.name,
            rootPath: existingProject.rootPath,
            workspaceIds: [message.workspaceId],
          },
        };
      }

      if (message.type === 'local-project/removal-preflight') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const rootPath = await this.resolveWorkspaceProjectRootPath(
          runtime,
          message.localProjectId
        );
        const sessions = (await listAliveSessionMetas(runtime.lody.documentManager)).map(
          ({ meta }) => meta
        );
        return {
          ok: true,
          type: 'local-project/removal-preflight',
          result: await preflightLocalProjectWorktreeRemoval({
            machineId: this.machineId,
            localProjectId: message.localProjectId,
            originalRootPath: rootPath,
            sessions,
            logger: this.logger,
          }),
        };
      }

      if (message.type === 'local-project/list') {
        return {
          ok: true,
          type: 'local-project/list',
          result: {
            workspaces: await this.listProjectsByWorkspace(),
          },
        };
      }

      if (message.type === 'local-project/git-state') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const rootPath = await this.resolveWorkspaceProjectRootPath(
          runtime,
          message.localProjectId
        );
        return {
          ok: true,
          type: 'local-project/git-state',
          result: await this.localProjectControlService.getProjectGitState(rootPath),
        };
      }

      if (message.type === 'local-project/list-files') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const rootPath = await this.resolveWorkspaceProjectRootPath(
          runtime,
          message.localProjectId
        );
        return {
          ok: true,
          type: 'local-project/list-files',
          result: await this.localProjectControlService.listProjectFiles(rootPath, {
            maxFiles: message.maxFiles,
          }),
        };
      }

      if (message.type === 'local-project/list-dir') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const rootPath = await this.resolveWorkspaceProjectRootPath(
          runtime,
          message.localProjectId
        );
        return {
          ok: true,
          type: 'local-project/list-dir',
          result: await this.localProjectControlService.listProjectDirectory(
            rootPath,
            message.relativePath,
            { limit: message.limit }
          ),
        };
      }

      if (message.type === 'local-project/list-skills') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const rootPath = await this.resolveWorkspaceProjectRootPath(
          runtime,
          message.localProjectId
        );
        return {
          ok: true,
          type: 'local-project/list-skills',
          result: await this.localProjectControlService.listProjectSkills(
            rootPath,
            message.skillDirs
          ),
        };
      }

      if (message.type === 'local-project/list-global-skills') {
        await this.resolveWorkspaceRuntime(message.workspaceId);
        return {
          ok: true,
          type: 'local-project/list-global-skills',
          result: await this.localProjectControlService.listGlobalSkills(),
        };
      }

      if (message.type === 'local-project/read-file') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const rootPath = await this.resolveWorkspaceProjectRootPath(
          runtime,
          message.localProjectId
        );
        return {
          ok: true,
          type: 'local-project/read-file',
          result: this.localProjectControlService.readProjectFile(rootPath, message.relativePath, {
            maxBytes: message.maxBytes,
          }),
        };
      }

      if (message.type === 'local-project/checkout-branch') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const rootPath = await this.resolveWorkspaceProjectRootPath(
          runtime,
          message.localProjectId
        );
        return {
          ok: true,
          type: 'local-project/checkout-branch',
          result: await this.localProjectControlService.checkoutProjectBranch(
            rootPath,
            message.branchName
          ),
        };
      }

      if (isLanControlRequest(message)) {
        return this.lanFleetControl
          ? await this.lanFleetControl.dispatch(message)
          : this.toProjectControlError(
              requestType,
              'execution_failed',
              'This agent service takes no requests about the machines of a LAN'
            );
      }

      if (isLocalProjectWorktreeConfigRequest(message)) {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        await this.resolveWorkspaceProjectRootPath(runtime, message.localProjectId);
        return await handleLocalProjectWorktreeConfigRequest(message);
      }

      if (message.type === 'local-project/sync-history') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const rootPath = await this.resolveWorkspaceProjectRootPath(
          runtime,
          message.localProjectId
        );
        const service = new LocalProjectHistorySyncService(
          runtime.lody.documentManager,
          this.logger,
          {
            workspaceId: message.workspaceId,
            machineId: this.machineId,
            userId: this.userIdFor(message.workspaceId),
          },
          message.provider
        );
        const result = await service.syncLocalProject({
          localProjectId: message.localProjectId,
          rootPath,
        });
        return {
          ok: true,
          type: 'local-project/sync-history',
          result,
        };
      }

      if (message.type === 'local-project/import-history') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const rootPath = await this.resolveWorkspaceProjectRootPath(
          runtime,
          message.localProjectId
        );
        const service = new LocalProjectHistorySyncService(
          runtime.lody.documentManager,
          this.logger,
          {
            workspaceId: message.workspaceId,
            machineId: this.machineId,
            userId: this.userIdFor(message.workspaceId),
          },
          message.provider
        );
        const result = await service.importLocalProjectSessions({
          localProjectId: message.localProjectId,
          rootPath,
          acpSessionIds: message.acpSessionIds,
        });
        return {
          ok: true,
          type: 'local-project/import-history',
          result,
        };
      }

      if (message.type === 'local-project/resolve-history-conflict') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const rootPath = await this.resolveWorkspaceProjectRootPath(
          runtime,
          message.localProjectId
        );
        const service = new LocalProjectHistorySyncService(
          runtime.lody.documentManager,
          this.logger,
          {
            workspaceId: message.workspaceId,
            machineId: this.machineId,
            userId: this.userIdFor(message.workspaceId),
          },
          message.provider
        );
        const result = await service.resolveHistoryConflict({
          localProjectId: message.localProjectId,
          rootPath,
          sessionId: message.sessionId,
          acpSessionId: message.acpSessionId,
        });
        return {
          ok: true,
          type: 'local-project/resolve-history-conflict',
          result,
        };
      }

      if (message.type === 'worktree/list-files') {
        return {
          ok: true,
          type: 'worktree/list-files',
          result: await this.localProjectControlService.listWorktreeFiles(
            message.repoFullName,
            message.sessionId,
            { maxFiles: message.maxFiles }
          ),
        };
      }

      if (message.type === 'worktree/read-file') {
        return {
          ok: true,
          type: 'worktree/read-file',
          result: this.localProjectControlService.readWorktreeFile(
            message.repoFullName,
            message.sessionId,
            message.relativePath,
            { maxBytes: message.maxBytes }
          ),
        };
      }

      return this.toProjectControlError(requestType, 'invalid_request', 'Unsupported request type');
    } catch (error) {
      return this.mapProjectExecutionError(requestType, error);
    }
  }
}
