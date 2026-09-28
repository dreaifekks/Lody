import {
  createLocalPlatformProvider,
  createStore,
  createStaticStore,
  type MutableStore,
  type PlatformProvider,
  type PlatformSessionState,
  type ReadonlyStore,
  type WorkspaceSummary,
  type WorkspacesState,
} from '@lody/platform';
import { useStoreValue } from '@lody/platform/react';
import { isLocalAppPlatform } from '@/lib/app-platform';
import { reloadApp } from '@/lib/clear-local-cache';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { readPreferredWorkspaceSlug } from '@/lib/workspace';
import {
  createLocalPlatformFollower,
  getLocalWorkspaceSlug,
  LOCAL_WORKSPACE_FALLBACK_SLUG,
  resolveLocalWorkspace,
  type LocalPlatformFollower,
} from './local-platform-follower';

export { getLocalWorkspaceSlug, LOCAL_WORKSPACE_FALLBACK_SLUG, resolveLocalWorkspace };

/**
 * Renderer-side assembly of the open-source local `PlatformProvider`
 * (specs/platform-providers.md). The CLI provisions the workspaces (D-O14: one
 * implicit workspace, or one per LAN the installation belongs to) and the
 * Electron main process surfaces them over
 * `getIpcServices()?.localPlatform.getSnapshot()`; this module follows that
 * bridge. Identity and workspaces come from one atomic snapshot, so renderer
 * writes and CLI access checks use the same durable synthetic identity.
 */

/** Until the CLI provisioned a workspace, the window has nothing to show. */
const BOOTSTRAP_POLL_INTERVAL_MS = 500;
/** Afterwards a change is a LAN joined or left, which is rare. */
const FOLLOW_POLL_INTERVAL_MS = 2_000;

let cachedProvider: PlatformProvider | null = null;
let cachedSessionStore: MutableStore<PlatformSessionState> | null = null;
let cachedWorkspacesStore: MutableStore<WorkspacesState> | null = null;
let cachedFollower: LocalPlatformFollower | null = null;
let followingStarted = false;

const CLOUD_WORKSPACES_STORE: ReadonlyStore<WorkspacesState> = createStaticStore({
  status: 'loading',
} as WorkspacesState);

function getLocalWorkspacesStore(): MutableStore<WorkspacesState> {
  if (!cachedWorkspacesStore) {
    cachedWorkspacesStore = createStore<WorkspacesState>({ status: 'loading' });
  }
  return cachedWorkspacesStore;
}

function getLocalSessionStore(): MutableStore<PlatformSessionState> {
  if (!cachedSessionStore) {
    cachedSessionStore = createStore<PlatformSessionState>({ status: 'loading' });
  }
  return cachedSessionStore;
}

function getLocalPlatformFollower(): LocalPlatformFollower {
  cachedFollower ??= createLocalPlatformFollower({
    read: async () => await getIpcServices()?.localPlatform.getSnapshot(),
    session: getLocalSessionStore(),
    workspaces: getLocalWorkspacesStore(),
    readPreferredSlug: readPreferredWorkspaceSlug,
    onIdentityChanged: reloadApp,
    onError: (error) => console.error('local-platform: reading the snapshot failed', error),
  });
  return cachedFollower;
}

function ensureLocalPlatformFollowing(): void {
  if (followingStarted) return;
  followingStarted = true;
  const follower = getLocalPlatformFollower();
  const follow = (): void => {
    void follower.refresh().finally(() => {
      setTimeout(
        follow,
        follower.isReady() ? FOLLOW_POLL_INTERVAL_MS : BOOTSTRAP_POLL_INTERVAL_MS
      );
    });
  };
  follow();
}

/**
 * Applies a change to the LANs of this installation without waiting for the
 * next poll. The workspaces only change once the CLI followed the settings.
 */
export async function refreshLocalPlatformSnapshot(): Promise<void> {
  if (!isLocalAppPlatform()) return;
  await getLocalPlatformFollower().refresh();
}

/**
 * The one local `PlatformProvider` instance of this renderer. Only call on the
 * local platform (root route mounts `PlatformContext` behind
 * `isLocalAppPlatform()`); the first call starts following the snapshot.
 */
export function getLocalPlatformProvider(): PlatformProvider {
  if (!cachedProvider) {
    const follower = getLocalPlatformFollower();
    cachedProvider = createLocalPlatformProvider({
      session: getLocalSessionStore(),
      workspaces: getLocalWorkspacesStore(),
      activateWorkspace: follower.activate,
      resolveStreams: follower.resolveStreams,
    });
    ensureLocalPlatformFollowing();
  }
  return cachedProvider;
}

/** Bootstrap state for route-level loading/error handling. */
export function useLocalPlatformWorkspacesState(): WorkspacesState {
  if (isLocalAppPlatform()) {
    ensureLocalPlatformFollowing();
  }
  const store = isLocalAppPlatform() ? getLocalWorkspacesStore() : CLOUD_WORKSPACES_STORE;
  return useStoreValue(store);
}

/**
 * The local workspace the route slug names, or the active one without a slug.
 * Null while the CLI has not provisioned a workspace (and always null on the
 * cloud platform, without starting any polling). Usable outside
 * `PlatformContext` — the runtime provider mounts above the route tree that
 * provides the context.
 */
export function useLocalWorkspace(slug: string | null | undefined): WorkspaceSummary | null {
  return resolveLocalWorkspace(useLocalPlatformWorkspacesState(), slug);
}

const NO_WORKSPACES: readonly WorkspaceSummary[] = [];

/** Every workspace of this installation: one, or one per LAN it belongs to. */
export function useLocalWorkspaces(): readonly WorkspaceSummary[] {
  const state = useLocalPlatformWorkspacesState();
  return state.status === 'ready' ? state.workspaces : NO_WORKSPACES;
}
