import {
  getShortcutBodyStreamId,
  getShortcutIndexStreamId,
  type ShortcutAccessDomain,
  type ShortcutResource,
} from './access';
import { PromptShortcutCatalog } from './catalog';
import type { ShortcutDirectoryEntry } from './local-store';
import type { PromptShortcutRuntime, ShortcutPublicationPort } from './runtime';
import type { ShortcutStreamGrant, ShortcutSyncLease } from './sync';

/**
 * Shortcuts shared through a Streams gateway whose members are all one user,
 * as the members of a LAN are. Nothing there stages, activates, revokes or
 * lists documents, and nothing has to: whoever reaches the gateway may read
 * and write all of it. A publication uploads its body and then its index row,
 * a deletion is the row's tombstone, and the user's own index is the directory.
 * There is nobody to share with, so every shortcut stays private.
 */

const RETRY_MS = 30_000;

/** The gateway's credential is fixed; it never expires. */
export function getSingleUserShortcutGrant(
  gateway: { gatewayBaseUrl: string; token: string },
  resource: ShortcutResource
): ShortcutStreamGrant {
  return {
    token: gateway.token,
    gatewayBaseUrl: gateway.gatewayBaseUrl,
    expiresIn: Number.POSITIVE_INFINITY,
    streamId:
      resource.kind === 'index'
        ? getShortcutIndexStreamId(resource.domain)
        : getShortcutBodyStreamId(resource.bodyDocId),
  };
}

export function createSingleUserShortcutPublication(
  sync: Pick<ShortcutPublicationPort, 'acquire' | 'dispose'>
): ShortcutPublicationPort {
  return {
    acquire: (resource, write) => sync.acquire(resource, write),
    // No server knows whether it holds the body already: upload it every time.
    stage: () => Promise.resolve('staged'),
    activate: () => Promise.resolve(),
    // An obsolete job is published before its successor. The index row is
    // idempotent, and acknowledging the job keeps the record's `published` exact.
    settle: () => Promise.resolve('active'),
    revoke: () => Promise.resolve(),
    dispose: () => sync.dispose(),
  };
}

/**
 * Feeds the runtime the directory its user's index holds, and publishes again
 * an acknowledged shortcut the index has never seen: one saved before this
 * gateway carried shortcuts, or one a restored hub lost. Each time the room
 * opens, it uploads the bodies this machine published and sends what waited
 * for the gateway.
 */
export class SingleUserShortcutDirectory {
  private opening: Promise<void> | null = null;
  private close: (() => Promise<void>) | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly runtime: PromptShortcutRuntime,
    private readonly acquire: (
      resource: ShortcutResource,
      write: boolean
    ) => Promise<ShortcutSyncLease>
  ) {}

  /** Opens the index room; a room that failed to open is tried again. */
  start(): Promise<void> {
    if (this.disposed || this.close) return Promise.resolve();
    clearTimeout(this.retryTimer);
    this.opening ??= this.open()
      .catch(() => {
        if (!this.disposed) this.retryTimer = setTimeout(() => void this.start(), RETRY_MS);
      })
      .finally(() => {
        this.opening = null;
      });
    return this.opening;
  }

  private async open() {
    const domain: ShortcutAccessDomain = {
      workspaceId: this.runtime.workspaceId,
      ownerUserId: this.runtime.userId,
      visibility: 'private',
    };
    const id = getShortcutIndexStreamId(domain);
    const sync = await this.acquire({ kind: 'index', domain }, true);
    const lease = await this.runtime.store.repo
      .acquireFlockDoc(id)
      .catch(async (error: unknown) => {
        await sync.release();
        throw error;
      });
    let unsubscribe: (() => void) | undefined;
    const close = async () => {
      unsubscribe?.();
      await sync.release();
      await lease.release();
    };
    try {
      await sync.sync();
      await sync.join();
      if (this.disposed) throw new Error('Shortcut directory disposed');
      // A failed publication is tried again with the next change of the index.
      unsubscribe = lease.flock.subscribe(() => void this.publish(lease.flock).catch(() => {}));
      this.close = close;
    } catch (error) {
      await close();
      throw error;
    }
    await this.publish(lease.flock, true);
  }

  /** `opened`: the room has just opened, and the hub may have lost bodies or
   * missed publications while it was away. */
  private async publish(flock: PromptShortcutCatalog['flock'], opened = false) {
    if (this.disposed) return;
    const { runtime } = this;
    const entries = new PromptShortcutCatalog(flock).list();
    const rows: ShortcutDirectoryEntry[] = entries.map((entry) => ({
      shortcutId: entry.id,
      bodyDocId: entry.bodyDocId,
      ownerUserId: entry.ownerUserId,
      visibility: entry.visibility,
      revision: entry.revision,
    }));
    for (const row of flock.scan({ prefix: ['deletedPromptShortcut'] })) {
      if (typeof row.key[1] !== 'string' || typeof row.value !== 'string') continue;
      rows.push({
        shortcutId: row.key[1],
        bodyDocId: '',
        ownerUserId: runtime.userId,
        visibility: 'private',
        revision: row.value,
        deleted: true,
      });
    }
    const known = new Set(rows.map((row) => row.shortcutId));
    const records = runtime.store.list().filter((record) => !record.deleted && !record.operation);
    const unpublished = records.filter((record) => !known.has(record.entry.id));
    // The index can come back from this machine's own copy while the hub lost
    // the body it points to; uploading a body the hub holds sends nothing new.
    const listed = new Set(entries.map((entry) => entry.bodyDocId));
    const bodies = opened
      ? records.flatMap((record) =>
          record.published && listed.has(record.published.bodyDocId)
            ? [record.published.bodyDocId]
            : []
        )
      : [];
    await runtime.setDirectory(rows);
    for (const bodyDocId of bodies) {
      if (this.disposed) return;
      const body = await this.acquire({ kind: 'body', bodyDocId }, true);
      try {
        await body.sync();
      } finally {
        await body.release();
      }
    }
    if (this.disposed) return;
    for (const record of unpublished) await runtime.store.republish(record.entry.id);
    if (opened || unpublished.length > 0) await runtime.flush();
  }

  async dispose() {
    this.disposed = true;
    clearTimeout(this.retryTimer);
    await this.opening;
    await this.close?.();
    this.close = null;
  }
}
