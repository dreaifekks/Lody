import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';
import {
  getShortcutBodyStreamId,
  getShortcutIndexStreamId,
  type ShortcutResource,
} from '../src/prompt-shortcuts/access';
import {
  projectShortcutIndex,
  type PromptShortcutIndexEntry,
} from '../src/prompt-shortcuts/catalog';
import { PromptShortcutDocument } from '../src/prompt-shortcuts/document';
import { LocalShortcutStore } from '../src/prompt-shortcuts/local-store';
import type { PromptShortcut } from '../src/prompt-shortcuts/model';
import {
  PromptShortcutRuntime,
  type ShortcutPublicationPort,
} from '../src/prompt-shortcuts/runtime';
import {
  createSingleUserShortcutPublication,
  SingleUserShortcutDirectory,
} from '../src/prompt-shortcuts/single-user';

const workspaceId = 'workspace-a';
const userId = 'user-a';

function shortcut(id: string): PromptShortcut {
  return {
    v: 1,
    id,
    workspaceId,
    ownerUserId: userId,
    visibility: 'workspace',
    name: `Shortcut ${id}`,
    slug: id,
    prompt: `Prompt ${id}`,
    mentions: [],
    scope: {},
    revision: `revision-${id}`,
    createdAt: 1,
    updatedAt: 1,
  };
}

function noopPublicationPort(acquire: ShortcutPublicationPort['acquire']): ShortcutPublicationPort {
  return {
    acquire,
    stage: vi.fn(async () => 'active'),
    activate: vi.fn(async () => {}),
    settle: vi.fn(async () => 'active'),
    revoke: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

async function createRuntime(
  values: readonly PromptShortcut[],
  acquire: ShortcutPublicationPort['acquire']
) {
  const repo = await LoroRepo.create({});
  const store = await LocalShortcutStore.open({ repo, workspaceId, userId });
  const entries = values.map((value) => projectShortcutIndex(value, `body-${value.id}`));
  await store.cacheDiscovery({
    entries,
    directory: entries.map((entry) => ({
      shortcutId: entry.id,
      bodyDocId: entry.bodyDocId,
      ownerUserId: entry.ownerUserId,
      visibility: entry.visibility,
      revision: entry.revision,
    })),
  });
  const runtime = new PromptShortcutRuntime(store, noopPublicationPort(acquire));
  return {
    entries,
    repo,
    runtime,
    async close() {
      await runtime.dispose();
      await repo.destroy();
    },
  };
}

async function saveBody(repo: LoroRepo, entry: PromptShortcutIndexEntry, value: PromptShortcut) {
  const docId = getShortcutBodyStreamId(entry.bodyDocId);
  const lease = await repo.acquireDoc(docId);
  try {
    new PromptShortcutDocument(lease.doc).save(value, []);
    await repo.persistDocNow(docId, lease.doc);
  } finally {
    await lease.release();
  }
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('PromptShortcutRuntime body warming', () => {
  it('coalesces a foreground read with the same in-flight body fetch', async () => {
    const value = shortcut('review');
    const gate = Promise.withResolvers<void>();
    let fixture!: Awaited<ReturnType<typeof createRuntime>>;
    const acquire = vi.fn(async () => ({
      sync: async () => {
        await gate.promise;
        await saveBody(fixture.repo, fixture.entries[0]!, value);
      },
      join: async () => {},
      release: async () => {},
    }));
    fixture = await createRuntime([value], acquire);
    cleanups.push(fixture.close);

    const warm = fixture.runtime.prefetch(fixture.entries);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
    const foreground = fixture.runtime.read(fixture.entries[0]!);
    gate.resolve();

    await expect(Promise.all([warm, foreground])).resolves.toEqual([undefined, value]);
    expect(acquire).toHaveBeenCalledTimes(1);
    await expect(fixture.runtime.read(fixture.entries[0]!)).resolves.toEqual(value);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('warms current bodies serially and continues after a failed body', async () => {
    const values = [shortcut('first'), shortcut('second'), shortcut('third')];
    let fixture!: Awaited<ReturnType<typeof createRuntime>>;
    let active = 0;
    let maxActive = 0;
    let firstFailures = 1;
    const acquired: string[] = [];
    const acquire = vi.fn(async (resource: ShortcutResource) => {
      if (resource.kind !== 'body') throw new Error('Unexpected index acquisition');
      acquired.push(resource.bodyDocId);
      return {
        sync: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            await Promise.resolve();
            if (resource.bodyDocId === 'body-first' && firstFailures > 0) {
              firstFailures -= 1;
              throw new Error('offline');
            }
            const index = fixture.entries.find((entry) => entry.bodyDocId === resource.bodyDocId)!;
            const value = values.find((item) => item.id === index.id)!;
            await saveBody(fixture.repo, index, value);
          } finally {
            active -= 1;
          }
        },
        join: async () => {},
        release: async () => {},
      };
    });
    fixture = await createRuntime(values, acquire);
    cleanups.push(fixture.close);

    await expect(fixture.runtime.prefetch(fixture.entries)).resolves.toBeUndefined();
    expect(acquired).toEqual(['body-first', 'body-second', 'body-third']);
    expect(maxActive).toBe(1);

    await fixture.runtime.prefetch(fixture.entries);
    expect(acquired).toEqual(['body-first', 'body-second', 'body-third', 'body-first']);
    await fixture.runtime.prefetch(fixture.entries);
    expect(acquired).toHaveLength(4);
  });

  it('serializes overlapping prefetch batches', async () => {
    const values = [shortcut('old'), shortcut('new')];
    const firstGate = Promise.withResolvers<void>();
    let fixture!: Awaited<ReturnType<typeof createRuntime>>;
    let active = 0;
    let maxActive = 0;
    const acquired: string[] = [];
    const acquire = vi.fn(async (resource: ShortcutResource) => {
      if (resource.kind !== 'body') throw new Error('Unexpected index acquisition');
      acquired.push(resource.bodyDocId);
      return {
        sync: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            if (resource.bodyDocId === 'body-old') await firstGate.promise;
            const index = fixture.entries.find((entry) => entry.bodyDocId === resource.bodyDocId)!;
            const value = values.find((item) => item.id === index.id)!;
            await saveBody(fixture.repo, index, value);
          } finally {
            active -= 1;
          }
        },
        join: async () => {},
        release: async () => {},
      };
    });
    fixture = await createRuntime(values, acquire);
    cleanups.push(fixture.close);

    const first = fixture.runtime.prefetch([fixture.entries[0]!]);
    await vi.waitFor(() => expect(acquired).toEqual(['body-old']));
    const second = fixture.runtime.prefetch([fixture.entries[1]!]);
    try {
      await Promise.resolve();
      expect(acquired).toEqual(['body-old']);
    } finally {
      firstGate.resolve();
    }

    await Promise.all([first, second]);
    expect(acquired).toEqual(['body-old', 'body-new']);
    expect(maxActive).toBe(1);
  });

  it('stops queued bodies when the prefetch scope is cancelled', async () => {
    const values = [shortcut('active'), shortcut('queued')];
    const activeGate = Promise.withResolvers<void>();
    let fixture!: Awaited<ReturnType<typeof createRuntime>>;
    const acquired: string[] = [];
    const acquire = vi.fn(async (resource: ShortcutResource) => {
      if (resource.kind !== 'body') throw new Error('Unexpected index acquisition');
      acquired.push(resource.bodyDocId);
      return {
        sync: async () => {
          if (resource.bodyDocId === 'body-active') await activeGate.promise;
          const index = fixture.entries.find((entry) => entry.bodyDocId === resource.bodyDocId)!;
          const value = values.find((item) => item.id === index.id)!;
          await saveBody(fixture.repo, index, value);
        },
        join: async () => {},
        release: async () => {},
      };
    });
    fixture = await createRuntime(values, acquire);
    cleanups.push(fixture.close);
    const controller = new AbortController();

    const warming = fixture.runtime.prefetch(fixture.entries, { signal: controller.signal });
    await vi.waitFor(() => expect(acquired).toEqual(['body-active']));
    controller.abort();
    activeGate.resolve();
    await warming;

    expect(acquired).toEqual(['body-active']);
  });
});

/**
 * A Streams gateway in memory: `sync` merges both ways, and a joined replica
 * receives what another one uploaded, as a live read would.
 */
function createGateway() {
  type Flock = Awaited<ReturnType<LoroRepo['acquireFlockDoc']>>['flock'];
  const bodies = new Map<string, Uint8Array>();
  const indexes = new Map<string, Awaited<ReturnType<Flock['exportJson']>>>();
  const live = new Map<string, Set<() => Promise<void>>>();
  const merge = async (repo: LoroRepo, resource: ShortcutResource, upload: boolean) => {
    if (resource.kind === 'body') {
      const id = getShortcutBodyStreamId(resource.bodyDocId);
      const lease = await repo.acquireDoc(id);
      try {
        const remote = bodies.get(id);
        if (remote) lease.doc.import(remote);
        if (upload) bodies.set(id, lease.doc.export({ mode: 'snapshot' }));
        await repo.persistDocNow(id, lease.doc);
      } finally {
        await lease.release();
      }
      return id;
    }
    const id = getShortcutIndexStreamId(resource.domain);
    const lease = await repo.acquireFlockDoc(id);
    try {
      const remote = indexes.get(id);
      if (remote) lease.flock.importJson(remote);
      if (upload) indexes.set(id, lease.flock.exportJson());
      await repo.persistFlockDocNow(id, lease.flock);
    } finally {
      await lease.release();
    }
    return id;
  };
  const attach =
    (repo: LoroRepo): ShortcutPublicationPort['acquire'] =>
    async (resource) => {
      const pull = async () => void (await merge(repo, resource, false));
      let joinedId: string | undefined;
      return {
        sync: async () => {
          const id = await merge(repo, resource, true);
          for (const other of live.get(id) ?? []) if (other !== pull) await other();
        },
        join: async () => {
          joinedId = await merge(repo, resource, false);
          const pulls = live.get(joinedId) ?? new Set();
          pulls.add(pull);
          live.set(joinedId, pulls);
        },
        release: async () => {
          if (joinedId) live.get(joinedId)?.delete(pull);
        },
      };
    };
  return Object.assign(attach, {
    /** What the hub holds now, to restore later as a backup would. */
    backup: () => ({ bodies: new Map(bodies), indexes: new Map(indexes) }),
    restore: (copy: { bodies: typeof bodies; indexes: typeof indexes }) => {
      bodies.clear();
      indexes.clear();
      for (const [id, value] of copy.bodies) bodies.set(id, value);
      for (const [id, value] of copy.indexes) indexes.set(id, value);
    },
  });
}

describe('Prompt Shortcuts through a single-user gateway', () => {
  async function openDesktop(
    attach: ReturnType<typeof createGateway> | null,
    repo: LoroRepo,
    unreachable = false
  ) {
    const reach = attach?.(repo);
    let down = unreachable;
    const acquire: ShortcutPublicationPort['acquire'] | undefined = reach
      ? (resource, write) =>
          down ? Promise.reject(new Error('gateway unreachable')) : reach(resource, write)
      : undefined;
    const store = await LocalShortcutStore.open({ repo, workspaceId, userId });
    const runtime = new PromptShortcutRuntime(
      store,
      acquire
        ? createSingleUserShortcutPublication({ acquire, dispose: async () => {} })
        : undefined,
      false
    );
    const directory = acquire ? new SingleUserShortcutDirectory(runtime, acquire) : null;
    await directory?.start();
    const close = async () => {
      await directory?.dispose();
      await runtime.dispose();
    };
    return { runtime, close, reconnect: () => void (down = false) };
  }

  async function openTwoDesktops(attach: ReturnType<typeof createGateway>, firstRepo?: LoroRepo) {
    const repos = [firstRepo ?? (await LoroRepo.create({})), await LoroRepo.create({})];
    const desktops = [];
    for (const repo of repos) desktops.push(await openDesktop(attach, repo));
    cleanups.push(async () => {
      for (const desktop of desktops) await desktop.close();
      for (const repo of repos) await repo.destroy();
    });
    return desktops.map((desktop) => desktop.runtime) as [
      PromptShortcutRuntime,
      PromptShortcutRuntime,
    ];
  }

  const names = (runtime: PromptShortcutRuntime) =>
    runtime.getSnapshot().entries.map((entry) => entry.name);
  const privateShortcut = (id: string): PromptShortcut => ({
    ...shortcut(id),
    visibility: 'private',
  });

  it('shows what one desktop saves, edits and deletes on the other', async () => {
    const [first, second] = await openTwoDesktops(createGateway());
    expect(first.canShare).toBe(false);

    const value = privateShortcut('review');
    await first.save({ value, base: null, bodyDocId: crypto.randomUUID() });
    await first.flush();
    await vi.waitFor(() => expect(names(second)).toEqual(['Shortcut review']));
    const seen = second.getSnapshot().entries[0]!;
    await expect(second.read(seen)).resolves.toEqual(value);

    const edited = { ...value, name: 'Edited', revision: 'revision-2', updatedAt: 2 };
    await second.save({ value: edited, base: seen, bodyDocId: seen.bodyDocId });
    await second.flush();
    await vi.waitFor(() => expect(names(first)).toEqual(['Edited']));
    await expect(first.read(first.getSnapshot().entries[0]!)).resolves.toEqual(edited);

    await first.remove(first.getSnapshot().entries[0]!);
    await first.flush();
    await vi.waitFor(() => expect(names(second)).toEqual([]));
    expect(names(first)).toEqual([]);
  });

  it('opens the index again after the gateway was unreachable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    cleanups.push(async () => void vi.useRealTimers());
    const attach = createGateway();
    const [first] = await openTwoDesktops(attach);
    const value = privateShortcut('later');
    await first.save({ value, base: null, bodyDocId: crypto.randomUUID() });
    await first.flush();

    const repo = await LoroRepo.create({});
    const late = await openDesktop(attach, repo, true);
    cleanups.push(async () => {
      await late.close();
      await repo.destroy();
    });
    expect(names(late.runtime)).toEqual([]);

    late.reconnect();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(names(late.runtime)).toEqual(['Shortcut later']));
  });

  it('publishes what was saved while the gateway was unreachable once it opens', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    cleanups.push(async () => void vi.useRealTimers());
    const attach = createGateway();
    const repo = await LoroRepo.create({});
    const offline = await openDesktop(attach, repo, true);
    cleanups.push(async () => {
      await offline.close();
      await repo.destroy();
    });
    const value = privateShortcut('pending');
    await offline.runtime.save({ value, base: null, bodyDocId: crypto.randomUUID() });
    await offline.runtime.flush();
    expect(offline.runtime.getSnapshot().pendingIds).toEqual(['pending']);

    offline.reconnect();
    await vi.advanceTimersByTimeAsync(30_000);
    const otherRepo = await LoroRepo.create({});
    const other = await openDesktop(attach, otherRepo);
    cleanups.push(async () => {
      await other.close();
      await otherRepo.destroy();
    });
    await vi.waitFor(() => expect(names(other.runtime)).toEqual(['Shortcut pending']));
  });

  it('uploads a published body again after the hub was restored without it', async () => {
    const attach = createGateway();
    const repo = await LoroRepo.create({});
    const before = attach.backup();
    const publisher = await openDesktop(attach, repo);
    const value = privateShortcut('kept');
    await publisher.runtime.save({ value, base: null, bodyDocId: crypto.randomUUID() });
    await publisher.runtime.flush();
    await publisher.close();
    attach.restore(before);

    const [, other] = await openTwoDesktops(attach, repo);
    await vi.waitFor(() => expect(names(other)).toEqual(['Shortcut kept']));
    await expect(other.read(other.getSnapshot().entries[0]!)).resolves.toEqual(value);
  });

  it('publishes a shortcut saved before the workspace synced shortcuts', async () => {
    const repo = await LoroRepo.create({});
    const offline = await openDesktop(null, repo);
    const value = privateShortcut('older');
    await offline.runtime.save({ value, base: null, bodyDocId: crypto.randomUUID() });
    await offline.runtime.flush();
    await offline.close();

    const [, second] = await openTwoDesktops(createGateway(), repo);
    await vi.waitFor(() => expect(names(second)).toEqual(['Shortcut older']));
    await expect(second.read(second.getSnapshot().entries[0]!)).resolves.toEqual(value);
  });
});
