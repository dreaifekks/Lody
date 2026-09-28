import { LOCAL_PLATFORM_CAPABILITIES } from './capabilities';
import type {
  CloudPort,
  CloudPortIdentity,
  CloudStreamsTokenPort,
  RuntimeArtifactsPort,
} from './cloud-port';
import type {
  PlatformIdentity,
  PlatformProvider,
  PlatformSessionState,
  PlatformStreamsGateway,
  PlatformWorkspaceSync,
  PlatformWorkspaces,
  WorkspacesState,
  WorkspaceSummary,
} from './provider';
import { createStaticStore, type ReadonlyStore } from './store';
import { resolveRuntimeArtifactsBaseUrl } from './runtime-artifacts';

export {
  LOCAL_USER_ID_PREFIX,
  LOCAL_WORKSPACE_ID_PREFIX,
  isLocalUserId,
  isLocalWorkspaceId,
} from '@lody/shared/platform-kind';

/**
 * Local id namespaces. Both prefixes are load-bearing isolation boundaries:
 * - `lw_` workspace ids never collide with cloud (Convex-minted) workspace ids,
 *   which keeps local and cloud data physically separate on disk and marks
 *   data eligible for full migration (D-O13/D-O14).
 * - `local:` user ids never collide with cloud user ids, so a cloud-mode CLI
 *   refuses a local-identity catalog and vice versa.
 */
export function createLocalRuntimeArtifactsPort(baseUrl?: string): RuntimeArtifactsPort {
  return {
    baseUrl: resolveRuntimeArtifactsBaseUrl(baseUrl),
  };
}

export function createLocalIdentity(
  session: ReadonlyStore<PlatformSessionState>
): PlatformIdentity {
  return {
    session,
    signOut: () => Promise.resolve(),
  };
}

export function createLocalWorkspaces(
  state: ReadonlyStore<WorkspacesState>,
  /** Makes a listed workspace the active one; absent, the active one is fixed. */
  activate?: (workspaceId: string) => void
): PlatformWorkspaces {
  return {
    state,
    setActive: (workspaceId) => {
      const current = state.get();
      if (current.status === 'ready' && current.activeWorkspaceId === workspaceId) {
        return Promise.resolve();
      }
      const listed =
        current.status === 'ready' &&
        current.workspaces.some((workspace) => workspace.id === workspaceId);
      if (!listed || !activate) {
        return Promise.reject(
          new Error(`Local platform has no workspace ${workspaceId} to activate`)
        );
      }
      activate(workspaceId);
      return Promise.resolve();
    },
    // No `create`: the implicit workspace is provisioned by the CLI (D-O14),
    // and a LAN workspace appears when the installation joins that LAN.
  };
}

export interface LocalPlatformProviderOptions {
  /** loading → authenticated once the CLI catalog snapshot is available. */
  session: ReadonlyStore<PlatformSessionState>;
  /** Fed by the renderer's local-CLI connection: loading → ready(the workspaces of the catalog). */
  workspaces: ReadonlyStore<WorkspacesState>;
  /** Makes a listed workspace the active one. */
  activateWorkspace?: (workspaceId: string) => void;
  /**
   * The self-hosted Streams gateway of a workspace that is shared through one
   * (a LAN). Its rooms dual-home onto the gateway so other devices of that LAN
   * are reachable; hosted capabilities stay absent. `null` for a workspace
   * that never leaves this machine.
   */
  resolveStreams?: (workspaceId: string) => PlatformStreamsGateway | null;
}

const LOCAL_ONLY_SYNC: PlatformWorkspaceSync = { mode: 'local' };

export function createLocalPlatformProvider(
  options: LocalPlatformProviderOptions
): PlatformProvider {
  // One answer per gateway, so an unchanged workspace keeps the identity of
  // its answer across the snapshots that confirm it.
  const shared = new Map<string, PlatformWorkspaceSync>();
  const resolveStreams = options.resolveStreams;
  return {
    kind: 'local',
    identity: createLocalIdentity(options.session),
    workspaces: createLocalWorkspaces(options.workspaces, options.activateWorkspace),
    capabilities: LOCAL_PLATFORM_CAPABILITIES,
    cloudApi: null,
    sync: {
      ...LOCAL_ONLY_SYNC,
      ...(resolveStreams
        ? {
            resolve: (workspaceId) => {
              const streams = resolveStreams(workspaceId);
              if (!streams) return LOCAL_ONLY_SYNC;
              const key = `${streams.gatewayBaseUrl}\n${streams.token}`;
              let sync = shared.get(key);
              if (!sync) {
                sync = { mode: 'dual', streams };
                shared.set(key, sync);
              }
              return sync;
            },
          }
        : {}),
    },
  };
}

export interface LocalCloudPortOptions {
  identity: CloudPortIdentity;
  /**
   * The implicit local workspace set from the local catalog, or a live set
   * that follows the LANs this installation belongs to.
   */
  workspaces: readonly WorkspaceSummary[] | ReadonlyStore<readonly WorkspaceSummary[]>;
  /** Optional operator mirror; the public artifact channel is the default. */
  runtimeArtifactsBaseUrl?: string;
  /**
   * Self-hosted Streams gateways. Present ⇒ the data plane attaches the
   * gateway of each workspace and `workspaces` is the set shared through
   * them; account, billing and every other hosted port stay absent.
   */
  streamsTokens?: CloudStreamsTokenPort;
}

function isWorkspaceStore(
  value: LocalCloudPortOptions['workspaces']
): value is ReadonlyStore<readonly WorkspaceSummary[]> {
  return !Array.isArray(value);
}

/**
 * The open-source CLI platform: every hosted port is `null`, the access
 * oracle answers from the injected catalog snapshot, and only the daemon
 * owner is ever allowed. Without `streamsTokens` it guarantees zero network
 * I/O by construction; with it the only remote peers are the configured
 * gateways.
 */
export function createLocalCloudPort(options: LocalCloudPortOptions): CloudPort {
  const { identity } = options;
  const workspaces = isWorkspaceStore(options.workspaces)
    ? options.workspaces
    : createStaticStore(options.workspaces);
  return {
    kind: 'local',
    identity,
    access: {
      watchWorkspaceAccess: (listener) => {
        const emit = () =>
          listener({ status: 'authorized', userId: identity.userId, workspaces: workspaces.get() });
        emit();
        return workspaces.subscribe(emit);
      },
      verifyMachineAccess: (request) =>
        Promise.resolve(
          request.requesterUserId === identity.userId
            ? { allowed: true }
            : { allowed: false, reason: 'requester_not_member' }
        ),
      registerMachineAccess: () => Promise.resolve(),
      resolveWorkspaceUser: (request) =>
        Promise.resolve(request.userId === identity.userId ? { id: identity.userId } : null),
    },
    streamsTokens: options.streamsTokens ?? null,
    notifications: null,
    usage: null,
    billing: null,
    githubTokens: null,
    bugReports: null,
    sessionSharing: null,
    prAssociation: null,
    attachmentUpload: null,
    remotePreview: null,
    runtimeArtifacts: createLocalRuntimeArtifactsPort(options.runtimeArtifactsBaseUrl),
    dispose: () => Promise.resolve(),
  };
}
