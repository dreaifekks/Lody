import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Effect } from 'effect';
import {
  LOCAL_USER_ID_PREFIX,
  LOCAL_WORKSPACE_ID_PREFIX,
  resolvePlatformKind,
  type PlatformKind,
} from '@lody/platform';
import { getServerNow } from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { loadEnv } from '@/utils/const';
import type { Logger } from '@/utils/logger';
import type {
  LocalCatalogWorkspace,
  LocalWorkspaceCatalogService,
  LocalWorkspaceCatalogSnapshot,
} from '@/lib/local-workspace-catalog';

/**
 * CLI-side platform selection (specs/platform-providers.md). `local` is the
 * open-source no-account mode and the public workspace default.
 * Unrecognized values throw so a misconfigured local build fails loudly
 * instead of silently talking to the cloud.
 */
export function getCliPlatformKind(): PlatformKind {
  return resolvePlatformKind(process.env.LODY_PLATFORM);
}

/**
 * Defense in depth for the local platform's zero-cloud-I/O invariant: blank
 * every cloud endpoint env before modules read them. Cloud behavior is owned
 * by the injected CloudPort; this scrub prevents legacy environment readers
 * from becoming an accidental second composition root. A cloud operation
 * reached from local mode must still fail through the unavailable port.
 */
export function applyLocalPlatformEnv(): void {
  delete process.env.LODY_AUTH_URL;
  delete process.env.LODY_AUTH_SITE_URL;
  delete process.env.LODY_SERVER_URL;
  delete process.env.SITE_URL;
  delete process.env.LODY_POSTHOG_KEY;
  delete process.env.POSTHOG_API_KEY;
  delete process.env.POSTHOG_HOST;
  delete process.env.VITE_PUBLIC_POSTHOG_KEY;
  delete process.env.VITE_PUBLIC_POSTHOG_HOST;
  loadEnv();
}

const LOCAL_IDENTITY_FILE = 'local-identity.json';

export type LocalCliIdentity = {
  userId: string;
  createdAt: string;
  /**
   * The implicit workspace of this installation. Remembered here because the
   * catalog names its owner by whoever reconciled last: while the installation
   * belongs to a LAN that is the LAN's owner, and the catalog alone can no
   * longer tell which workspace was the local one.
   */
  workspaceId?: string;
};

export function getLocalIdentityPath(): string {
  return path.join(getLodyDataDir('local'), LOCAL_IDENTITY_FILE);
}

function parseLocalIdentity(raw: string): LocalCliIdentity | null {
  const parsed = JSON.parse(raw) as Partial<LocalCliIdentity>;
  if (
    typeof parsed.userId !== 'string' ||
    !parsed.userId.startsWith(LOCAL_USER_ID_PREFIX) ||
    typeof parsed.createdAt !== 'string'
  ) {
    return null;
  }
  return {
    userId: parsed.userId,
    createdAt: parsed.createdAt,
    ...(typeof parsed.workspaceId === 'string' &&
    parsed.workspaceId.startsWith(LOCAL_WORKSPACE_ID_PREFIX)
      ? { workspaceId: parsed.workspaceId }
      : {}),
  };
}

async function writeLocalIdentity(identityPath: string, identity: LocalCliIdentity): Promise<void> {
  const temporaryPath = `${identityPath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(identityPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(temporaryPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  try {
    await fs.rename(temporaryPath, identityPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

/** The identity of an installation that has one; never creates it. */
export async function readLocalIdentity(
  options: { filePath?: string } = {}
): Promise<LocalCliIdentity | null> {
  try {
    return parseLocalIdentity(
      await fs.readFile(options.filePath ?? getLocalIdentityPath(), 'utf-8')
    );
  } catch {
    return null;
  }
}

/**
 * The synthetic identity every local-platform write is authored under.
 * Generated once per install and persisted; the `local:` prefix keeps it
 * disjoint from cloud user ids so cloud-mode processes refuse local state
 * (and vice versa).
 */
export async function loadOrCreateLocalIdentity(
  logger: Logger,
  options: { filePath?: string } = {}
): Promise<LocalCliIdentity> {
  const identityPath = options.filePath ?? getLocalIdentityPath();
  try {
    const identity = parseLocalIdentity(await fs.readFile(identityPath, 'utf-8'));
    if (identity) return identity;
    logger.warn('[platform] Local identity file is malformed; regenerating');
  } catch {
    // Missing file: first run.
  }
  const identity: LocalCliIdentity = {
    userId: `${LOCAL_USER_ID_PREFIX}${crypto.randomUUID().replaceAll('-', '')}`,
    createdAt: new Date(getServerNow()).toISOString(),
  };
  await writeLocalIdentity(identityPath, identity);
  logger.info(`[platform] Created local identity ${identity.userId}`);
  return identity;
}

/** Records which workspace is the implicit one; a no-op when already recorded. */
export async function rememberImplicitLocalWorkspace(
  workspaceId: string,
  options: { filePath?: string } = {}
): Promise<void> {
  const identityPath = options.filePath ?? getLocalIdentityPath();
  const identity = await readLocalIdentity({ filePath: identityPath });
  if (!identity || identity.workspaceId === workspaceId) return;
  await writeLocalIdentity(identityPath, { ...identity, workspaceId });
}

export const LOCAL_WORKSPACE_NAME = 'Lody';
export const LOCAL_WORKSPACE_SLUG = 'local';

export type LocalWorkspaceListItem = {
  id: string;
  name: string;
  slug: string | null;
  role: string;
};

function isLocalCatalogWorkspace(workspace: LocalCatalogWorkspace): boolean {
  return workspace.workspaceId.startsWith(LOCAL_WORKSPACE_ID_PREFIX);
}

/**
 * The implicit workspace of an installation whose catalog currently belongs to
 * a LAN. `lanWorkspaceIds` are the workspaces of the LANs it belongs to now.
 *
 * Without a remembered id the workspace is only recognised when nothing else
 * could be meant: exactly one local workspace that a LAN displaced. Anything
 * less certain returns `null`, because adopting the wrong workspace would show
 * one LAN's sessions as local ones.
 */
export function findImplicitLocalWorkspace(options: {
  snapshot: LocalWorkspaceCatalogSnapshot;
  identity: LocalCliIdentity;
  lanWorkspaceIds?: ReadonlySet<string>;
}): LocalCatalogWorkspace | null {
  const { snapshot, identity } = options;
  const isCandidate = (workspace: LocalCatalogWorkspace) =>
    isLocalCatalogWorkspace(workspace) && !options.lanWorkspaceIds?.has(workspace.workspaceId);

  if (identity.workspaceId) {
    return (
      snapshot.workspaces.find(
        (workspace) => workspace.workspaceId === identity.workspaceId && isCandidate(workspace)
      ) ?? null
    );
  }
  const owner = snapshot.identity?.userId;
  if (owner === identity.userId) {
    return (
      snapshot.workspaces.find(
        (workspace) => isCandidate(workspace) && workspace.state === 'active'
      ) ?? null
    );
  }
  if (!owner?.startsWith(LOCAL_USER_ID_PREFIX)) return null;
  const displaced = snapshot.workspaces.filter(
    (workspace) => isCandidate(workspace) && workspace.state === 'remote_missing'
  );
  return displaced.length === 1 ? (displaced[0] ?? null) : null;
}

/**
 * Idempotently provisions the single implicit local workspace (D-O14). The
 * catalog is the same store the cloud reconcile writes; on the local platform
 * this function is its only writer, and the workspace id keeps the `lw_`
 * prefix so migration tooling (D-O13) can recognize local-born data.
 *
 * An installation that leaves its last LAN gets back the workspace it had
 * before it joined one, not a new empty one.
 */
export async function ensureImplicitLocalWorkspace(options: {
  catalog: LocalWorkspaceCatalogService;
  identity: LocalCliIdentity;
  machineId: string;
  machineName: string;
  logger: Logger;
  /** Persists the resolved workspace so a later LAN cannot hide which one it was. */
  remember?: (workspaceId: string) => Promise<void>;
}): Promise<LocalWorkspaceListItem> {
  const { catalog, identity, machineId, machineName, logger } = options;
  const snapshot = await Effect.runPromise(catalog.read());
  const existing = findImplicitLocalWorkspace({ snapshot, identity });
  const remember = async (workspaceId: string) => {
    if (identity.workspaceId !== workspaceId) await options.remember?.(workspaceId);
  };
  if (existing && existing.state === 'active' && snapshot.identity?.userId === identity.userId) {
    await remember(existing.workspaceId);
    return {
      id: existing.workspaceId,
      name: existing.name,
      slug: existing.slug,
      role: existing.role,
    };
  }

  // A remembered workspace the catalog no longer lists still owns its stored
  // sessions, so it is provisioned again under the same id.
  const restoredId = existing?.workspaceId ?? identity.workspaceId;
  const workspace: LocalWorkspaceListItem = {
    id: restoredId ?? `${LOCAL_WORKSPACE_ID_PREFIX}${crypto.randomUUID().replaceAll('-', '')}`,
    name: LOCAL_WORKSPACE_NAME,
    slug: LOCAL_WORKSPACE_SLUG,
    role: 'owner',
  };
  await Effect.runPromise(
    catalog.cacheRemoteWorkspaces({
      identity: { userId: identity.userId },
      machine: { machineId, machineName },
      workspaces: [workspace],
    })
  );
  await remember(workspace.id);
  logger.info(
    restoredId
      ? `[platform] Restored implicit local workspace ${workspace.id}`
      : `[platform] Provisioned implicit local workspace ${workspace.id}`
  );
  return workspace;
}

/**
 * Called when the installation starts as a LAN member: records the implicit
 * workspace while the catalog can still tell which one it is. The next
 * reconcile hands the catalog to the LAN's owner.
 */
export async function rememberImplicitLocalWorkspaceBeforeLan(options: {
  catalog: LocalWorkspaceCatalogService;
  lanWorkspaceIds: ReadonlySet<string>;
  logger: Logger;
  identityPath?: string;
}): Promise<void> {
  const identity = await readLocalIdentity({ filePath: options.identityPath });
  if (!identity || identity.workspaceId) return;
  let snapshot: LocalWorkspaceCatalogSnapshot;
  try {
    snapshot = await Effect.runPromise(options.catalog.read());
  } catch (error) {
    options.logger.debug(
      `[platform] Local workspace catalog is unreadable; the implicit workspace stays unrecorded: ${String(error)}`
    );
    return;
  }
  const workspace = findImplicitLocalWorkspace({
    snapshot,
    identity,
    lanWorkspaceIds: options.lanWorkspaceIds,
  });
  if (!workspace) return;
  await rememberImplicitLocalWorkspace(workspace.workspaceId, { filePath: options.identityPath });
  options.logger.debug(`[platform] Recorded implicit local workspace ${workspace.workspaceId}`);
}
