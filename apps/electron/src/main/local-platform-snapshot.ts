import { LOCAL_USER_ID_PREFIX, LOCAL_WORKSPACE_ID_PREFIX } from '@lody/shared/platform-kind'
import type {
  ElectronLocalPlatformSnapshot,
  ElectronLocalWorkspace
} from '@lody/shared/electron-ipc'

/** What the snapshot needs to know about a LAN: never its credential. */
export type SnapshotLan = { id: string; url: string; workspaceId: string }

/**
 * Parse the CLI-owned atomic local identity/workspace bootstrap contract.
 *
 * Returns `null` while the catalog lists no active workspace: the CLI is then
 * between two sets of workspaces, as it is while the installation joins its
 * first LAN or leaves its last one.
 */
export function parseLocalPlatformSnapshot(
  decoded: unknown,
  lans: readonly SnapshotLan[] = []
): ElectronLocalPlatformSnapshot | null {
  if (!decoded || typeof decoded !== 'object') {
    throw new Error('Local platform catalog must be an object')
  }
  const catalog = decoded as Record<string, unknown>
  const identity = catalog.identity
  if (!identity || typeof identity !== 'object') {
    throw new Error('Local platform catalog is missing identity')
  }
  const userId = (identity as Record<string, unknown>).userId
  if (typeof userId !== 'string' || !userId.startsWith(LOCAL_USER_ID_PREFIX)) {
    throw new Error('Local platform catalog has an invalid local user id')
  }
  if (!Array.isArray(catalog.workspaces)) {
    throw new Error('Local platform catalog is missing workspaces')
  }
  const activeWorkspaces = catalog.workspaces.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      (entry as Record<string, unknown>).state === 'active'
  )
  const workspaces = activeWorkspaces.map((workspace): ElectronLocalWorkspace => {
    if (
      typeof workspace.workspaceId !== 'string' ||
      !workspace.workspaceId.startsWith(LOCAL_WORKSPACE_ID_PREFIX) ||
      typeof workspace.name !== 'string' ||
      typeof workspace.role !== 'string' ||
      (workspace.slug !== null && typeof workspace.slug !== 'string')
    ) {
      throw new Error('Local platform catalog has an invalid active workspace')
    }
    const lan = lans.find((candidate) => candidate.workspaceId === workspace.workspaceId)
    return {
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      slug: workspace.slug,
      role: workspace.role,
      lan: lan ? { id: lan.id, url: lan.url } : null
    }
  })
  // The settings and the catalog are written by different processes, so for a
  // moment the catalog may list the workspace of a LAN the settings no longer
  // name. It is reported as it is; the CLI catches up with the settings.
  const [first] = workspaces
  if (!first) return null
  return {
    userId,
    workspace: {
      workspaceId: first.workspaceId,
      name: first.name,
      slug: first.slug,
      role: first.role
    },
    workspaces
  }
}
