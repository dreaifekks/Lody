import type {
  MutableStore,
  PlatformSessionState,
  PlatformStreamsGateway,
  WorkspaceSummary,
  WorkspacesState,
} from '@lody/platform';
import type { ElectronLocalPlatformSnapshot } from '@lody/shared/electron-ipc';
import { getLanHubRendererOrigin } from '@lody/shared/lan-hub';

/** Fallback slug for workspace routes while a workspace has none. */
export const LOCAL_WORKSPACE_FALLBACK_SLUG = 'local';

/**
 * The shell forwards the origin of a LAN to its hub and supplies the real
 * credential itself; this value only fills the transport's bearer slot.
 */
const LAN_BEARER_PLACEHOLDER = 'lan-hub';

export function getLocalWorkspaceSlug(workspace: WorkspaceSummary): string {
  return workspace.slug ?? LOCAL_WORKSPACE_FALLBACK_SLUG;
}

/**
 * The workspace a route names. Without a slug, and for a slug no workspace
 * has, the answer is the active workspace: a window without a route yet, or a
 * route into a LAN this installation left, continues where the user last was.
 */
export function resolveLocalWorkspace(
  state: WorkspacesState,
  slug: string | null | undefined
): WorkspaceSummary | null {
  if (state.status !== 'ready') return null;
  const named = slug
    ? state.workspaces.find((workspace) => getLocalWorkspaceSlug(workspace) === slug)
    : undefined;
  return (
    named ??
    state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ??
    state.workspaces[0] ??
    null
  );
}

export type LocalPlatformFollower = {
  /** Reads the snapshot once and applies what changed. */
  refresh(): Promise<void>;
  /** Whether a snapshot was applied; until then a refresh is due more often. */
  isReady(): boolean;
  activate(workspaceId: string): void;
  resolveStreams(workspaceId: string): PlatformStreamsGateway | null;
};

/**
 * Keeps the renderer's identity and workspaces equal to what the CLI catalog
 * says. The catalog changes while the application runs: the installation
 * joins and leaves LANs, and each LAN brings a workspace.
 */
export function createLocalPlatformFollower(options: {
  read: () => Promise<ElectronLocalPlatformSnapshot | null | undefined>;
  session: MutableStore<PlatformSessionState>;
  workspaces: MutableStore<WorkspacesState>;
  readPreferredSlug: () => string | null;
  /**
   * The installation itself became another user, as it does once it joins its
   * first LAN or leaves its last one. Everything a renderer holds was loaded
   * for the previous user, so the renderer has to start over. Moving between
   * the workspaces of two LANs is not this: it changes the user in place.
   */
  onIdentityChanged: () => void;
  onError?: (error: unknown) => void;
}): LocalPlatformFollower {
  let applied: string | null = null;
  let userId: string | null = null;
  let selectedWorkspaceId: string | null = null;
  let identityChanged = false;
  let inFlight: Promise<void> | null = null;
  let lans = new Map<string, string>();
  let summaries: WorkspaceSummary[] = [];
  let sessionUserId: string | null = null;

  const publishWorkspaces = (): void => {
    const preferredSlug = options.readPreferredSlug();
    const active =
      summaries.find((workspace) => workspace.id === selectedWorkspaceId) ??
      summaries.find((workspace) => getLocalWorkspaceSlug(workspace) === preferredSlug) ??
      summaries[0];
    // The user is published before the workspace that makes it current, so
    // nothing reads the workspace of one LAN as the user of another.
    const activeUserId = active?.userId ?? userId;
    if (activeUserId && activeUserId !== sessionUserId) {
      sessionUserId = activeUserId;
      options.session.set({ status: 'authenticated', user: { id: activeUserId, name: 'Local' } });
    }
    options.workspaces.set({
      status: 'ready',
      workspaces: summaries,
      activeWorkspaceId: active?.id ?? null,
    });
  };

  const apply = (snapshot: ElectronLocalPlatformSnapshot): void => {
    if (userId !== null && userId !== snapshot.userId) {
      identityChanged = true;
      options.onIdentityChanged();
      return;
    }
    const serialized = JSON.stringify(snapshot);
    if (serialized === applied) return;
    applied = serialized;
    lans = new Map(
      snapshot.workspaces.flatMap((workspace) =>
        workspace.lan ? [[workspace.workspaceId, workspace.lan.id] as const] : []
      )
    );
    summaries = snapshot.workspaces.map((workspace) => ({
      id: workspace.workspaceId,
      name: workspace.name,
      slug: workspace.slug,
      role: workspace.role,
      userId: workspace.userId,
    }));
    userId = snapshot.userId;
    publishWorkspaces();
  };

  const read = async (): Promise<void> => {
    try {
      const snapshot = await options.read();
      // No snapshot: the CLI has not provisioned a workspace yet, or it is
      // between two sets of them. What was applied before stays in place.
      if (snapshot) apply(snapshot);
    } catch (error) {
      options.onError?.(error);
      if (applied === null) {
        options.workspaces.set({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  return {
    refresh: async () => {
      if (identityChanged) return;
      inFlight ??= read().finally(() => {
        inFlight = null;
      });
      await inFlight;
    },
    isReady: () => applied !== null,
    activate: (workspaceId) => {
      if (!summaries.some((workspace) => workspace.id === workspaceId)) return;
      selectedWorkspaceId = workspaceId;
      publishWorkspaces();
    },
    resolveStreams: (workspaceId) => {
      const lanId = lans.get(workspaceId);
      return lanId
        ? { gatewayBaseUrl: getLanHubRendererOrigin(lanId), token: LAN_BEARER_PLACEHOLDER }
        : null;
    },
  };
}
