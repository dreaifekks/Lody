import type { PlatformCapabilities } from './capabilities';
import type { CloudApi } from './cloud-api';
import type { ReadonlyStore } from './store';
import type { PlatformKind } from '@lody/shared/platform-kind';

export {
  PLATFORM_ENV_VAR,
  PLATFORM_VITE_ENV_VAR,
  resolvePlatformKind,
  type PlatformKind,
} from '@lody/shared/platform-kind';

/**
 * Which platform implementation a build is wired with. Selected at build time
 * (D-O1: the cloud build must not expose a runtime switch into local mode).
 */
export interface PlatformUser {
  id: string;
  email?: string;
  name?: string | null;
  image?: string | null;
}

export type PlatformSessionState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; user: PlatformUser };

export interface PlatformIdentity {
  session: ReadonlyStore<PlatformSessionState>;
  /**
   * Local platform: no account exists, so this resolves without effect (the
   * `cloudAccount` capability hides the affordance).
   */
  signOut(): Promise<void>;
}

/** Mirrors the workspace list item shape used by both the cloud org list and the CLI local catalog. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string | null;
  role: string;
  /**
   * The user this installation acts as in this workspace, when that differs
   * between its workspaces: the members of a LAN share the user of that LAN.
   */
  userId?: string;
}

export type WorkspacesState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      workspaces: readonly WorkspaceSummary[];
      activeWorkspaceId: string | null;
    };

export interface WorkspaceCreateInput {
  name: string;
  slug?: string;
}

export interface PlatformWorkspaces {
  state: ReadonlyStore<WorkspacesState>;
  /** Re-fetch workspace state after a recoverable read failure. */
  retry?(): Promise<void>;
  /**
   * Local platform: an installation without a LAN has exactly one implicit
   * workspace (D-O14), and a member of LANs has one per LAN. Any listed
   * workspace can be made active; an id that is not listed rejects.
   */
  setActive(workspaceId: string): Promise<void>;
  /** Repair or replace the route slug for an existing workspace. */
  updateSlug?(workspaceId: string, slug: string): Promise<WorkspaceSummary>;
  /** Present only when the `multiWorkspace` capability is available. */
  create?(input: WorkspaceCreateInput): Promise<WorkspaceSummary>;
}

/**
 * How the workspace runtime attaches sync transports per room:
 * - `local`: every room mounts only the local data plane; zero cloud I/O.
 * - `cloud`: Streams only (web/mobile today).
 * - `dual`: local-primary dual-homing for local rooms (Electron today).
 *
 * Cloud-only fields (e.g. the Streams token provider factory) are added here
 * by WS-B when the workspace runtime starts consuming this seam.
 */
export type PlatformSyncMode = 'local' | 'cloud' | 'dual';

/** How one workspace syncs. */
export interface PlatformWorkspaceSync {
  mode: PlatformSyncMode;
  /**
   * A fixed Streams gateway that needs no token endpoint. Present only when
   * the assembly already knows the gateway and its credential; absent, the
   * workspace runtime mints tokens from the hosted endpoint.
   */
  streams?: PlatformStreamsGateway;
}

export interface PlatformSync extends PlatformWorkspaceSync {
  /**
   * Present when the workspaces of one assembly sync differently: a workspace
   * shared through a self-hosted gateway next to one that never leaves the
   * machine, or workspaces shared through different gateways. `mode` and
   * `streams` then describe a workspace the assembly knows nothing about.
   *
   * The answer for one workspace keeps its identity while nothing changed, so
   * it can key an effect.
   */
  resolve?(workspaceId: string): PlatformWorkspaceSync;
}

export interface PlatformStreamsGateway {
  gatewayBaseUrl: string;
  token: string;
}

/** How `workspaceId` syncs; `null` asks about no workspace in particular. */
export function resolvePlatformSync(
  sync: PlatformSync,
  workspaceId: string | null | undefined
): PlatformWorkspaceSync {
  return (workspaceId ? sync.resolve?.(workspaceId) : undefined) ?? sync;
}

/**
 * The frontend seam between the open-source local build and the cloud build.
 * One instance is assembled per app entry (thin cloud entries import the cloud
 * implementation; open-source entries import the local one) and injected above
 * the workspace runtime. UI must consume these contracts instead of Convex /
 * Better Auth APIs.
 */
export interface PlatformProvider {
  readonly kind: PlatformKind;
  identity: PlatformIdentity;
  workspaces: PlatformWorkspaces;
  capabilities: PlatformCapabilities;
  /**
   * Present only on a cloud implementation. A capability claiming availability
   * while this adapter is absent is an invalid assembly and consumers fail fast.
   */
  cloudApi: CloudApi | null;
  sync: PlatformSync;
}
