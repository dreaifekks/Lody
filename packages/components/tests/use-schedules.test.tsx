// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleDocument } from '@lody/shared';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import { activeWorkspaceRuntimeAtom } from '../src/atoms/runtime';
import { scheduleRegistryAtom } from '../src/atoms/schedules';
import {
  useScheduleDocument,
  useScheduleRegistrySync,
  useSchedules,
} from '../src/hooks/use-schedules';
import { resolveScheduleDetailView } from '../src/components/schedules/schedules-workspace';

const scope = vi.hoisted(() => ({ workspaceId: 'workspace-a', enabled: true }));
vi.mock('../src/atoms/runtime', async () => {
  const { atom } = await import('jotai');
  return { activeWorkspaceRuntimeAtom: atom(null) };
});
vi.mock('../src/hooks/use-resolved-workspace-scope', () => ({
  useResolvedWorkspaceScope: () => scope,
}));
vi.mock('../src/lib/client-log', () => ({ recordClientError: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const row = {
  scheduleId: 'schedule-a',
  title: 'Saved task',
  ownerId: 'owner',
  machineId: 'machine',
  enabled: true,
  activationId: 'activation',
  activeFrom: 0,
  createdAt: 0,
  updatedAt: 0,
  trigger: { kind: 'manual' },
  destination: { kind: 'new_session' },
  elevatedPermissions: false,
  agentConfigId: 'agent',
  definitionFingerprint: '0'.repeat(64),
};

function harness(workspaceId = 'workspace-a', initialRows = [row]) {
  let rows = initialRows;
  let openFailure = false;
  let scanFailure = false;
  let pendingOpen: ReturnType<typeof deferred> | undefined;
  let pendingJoin: ReturnType<typeof deferred> | undefined;
  const listeners = new Set<() => void>();
  const rooms = new Set<object>();
  const syncs: ReturnType<typeof deferred>[] = [];
  let opens = 0;
  const runtime = {
    workspaceId,
    contentMode: 'plaintext',
    repo: {
      openFlockDoc: async () => {
        opens++;
        if (pendingOpen) await pendingOpen.promise;
        if (openFailure) throw new Error('open failed');
        return {
          flock: {
            scan: () => {
              if (scanFailure) throw new Error('scan failed');
              return rows.map((value) => ({ key: ['schedule', value.scheduleId], value }));
            },
            subscribe: (listener: () => void) => {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
          },
          joinRoom: async () => {
            if (pendingJoin) await pendingJoin.promise;
            const sync = deferred();
            syncs.push(sync);
            const room = {
              transportIds: () => ['local', 'cloud'],
              subscription: (id: string) => {
                if (id !== 'local') throw new Error('wrong readiness transport');
                return { firstSyncedWithRemote: sync.promise };
              },
              get firstSyncedWithRemote(): never {
                throw new Error('ambiguous readiness');
              },
              unsubscribe: () => {
                rooms.delete(room);
              },
            };
            rooms.add(room);
            return room;
          },
        };
      },
    },
  } as unknown as WorkspaceRuntime;
  return {
    runtime,
    syncs,
    rooms,
    listeners,
    get opens() {
      return opens;
    },
    failOpen: (value: boolean) => {
      openFailure = value;
    },
    failScan: (value: boolean) => {
      scanFailure = value;
    },
    holdOpen: () => {
      pendingOpen = deferred();
      return pendingOpen;
    },
    holdJoin: () => {
      pendingJoin = deferred();
      return pendingJoin;
    },
    replaceRows: (value: typeof rows) => {
      rows = value;
      listeners.forEach((listener) => listener());
    },
  };
}

function Host() {
  useScheduleRegistrySync();
  const schedules = useSchedules();
  return <button onClick={schedules.onRetry}>Retry</button>;
}

describe('Schedule Registry recovery', () => {
  let root: Root;
  let container: HTMLDivElement;
  let store: ReturnType<typeof createStore>;
  const snapshot = () => store.get(scheduleRegistryAtom);
  const mount = async (h: ReturnType<typeof harness>) => {
    await act(async () => {
      store.set(activeWorkspaceRuntimeAtom, h.runtime);
      root.render(
        <Provider store={store}>
          <Host />
        </Provider>
      );
    });
  };
  beforeEach(() => {
    vi.useFakeTimers();
    scope.workspaceId = 'workspace-a';
    store = createStore();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('retains readable rows on sync failure and recovers without remounting', async () => {
    const h = harness();
    await mount(h);
    expect(snapshot().rows.map((item) => item.title)).toEqual(['Saved task']);
    await act(async () => h.syncs[0]!.reject(new Error('network_error')));
    expect(snapshot()).toMatchObject({ ready: true, error: 'REGISTRY_UNAVAILABLE', rows: [row] });
    expect(h.listeners.size).toBe(1);
    expect(h.rooms.size).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await act(async () => {
      h.replaceRows([{ ...row, title: 'Synced task' }]);
      h.syncs[1]!.resolve();
    });
    expect(snapshot().rows[0]!.title).toBe('Synced task');
    expect(snapshot().error).toBeUndefined();
    expect(snapshot().retrying).toBe(false);
    expect(h.listeners.size).toBe(1);
    expect(h.rooms.size).toBe(1);
  });

  it('does not claim an empty registry before first sync, including after a cold open failure', async () => {
    const h = harness('workspace-a', []);
    h.failOpen(true);
    await mount(h);
    expect(snapshot().error).toBe('REGISTRY_UNAVAILABLE');
    h.failOpen(false);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(snapshot().error).toBe('REGISTRY_UNAVAILABLE');
    await act(async () => h.syncs[0]!.resolve());
    expect(snapshot()).toMatchObject({ rows: [], ready: true, retrying: false });
    expect(snapshot().error).toBeUndefined();
  });

  it('releases an unreadable local subscription and retries after the scan recovers', async () => {
    const h = harness();
    h.failScan(true);
    await mount(h);
    expect(snapshot().error).toBe('REGISTRY_UNAVAILABLE');
    expect(h.listeners.size).toBe(0);
    expect(h.rooms.size).toBe(0);
    h.failScan(false);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await act(async () => h.syncs[0]!.resolve());
    expect(snapshot().rows[0]!.title).toBe('Saved task');
    expect(snapshot().error).toBeUndefined();
    expect(h.listeners.size).toBe(1);
    expect(h.rooms.size).toBe(1);
  });

  it('bounds automatic retries, then allows explicit retry to restore the list', async () => {
    const h = harness();
    h.failOpen(true);
    await mount(h);
    for (const delay of [1000, 3000, 10000, 60000]) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
    }
    expect(h.opens).toBe(4);
    expect(snapshot()).toMatchObject({ error: 'REGISTRY_UNAVAILABLE', retrying: false });
    h.failOpen(false);
    await act(async () => container.querySelector('button')!.click());
    await act(async () => h.syncs[0]!.resolve());
    expect(snapshot().rows[0]!.title).toBe('Saved task');
    expect(snapshot().error).toBeUndefined();
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(h.opens).toBe(5);
  });

  it('keeps local pause, deletion and creation visible after remote retries are exhausted', async () => {
    const h = harness();
    await mount(h);
    for (let attempt = 0; attempt < 4; attempt++) {
      await act(async () => h.syncs[attempt]!.reject(new Error('network_error')));
      if (attempt < 3) {
        await act(async () => vi.advanceTimersByTimeAsync([1000, 3000, 10000][attempt]!));
      }
    }
    expect(h.rooms.size).toBe(0);
    expect(h.listeners.size).toBe(1);
    await act(async () => h.replaceRows([{ ...row, enabled: false }]));
    expect(snapshot().rows[0]!.enabled).toBe(false);
    expect(snapshot()).toMatchObject({ error: 'REGISTRY_UNAVAILABLE', retrying: false });
    await act(async () => h.replaceRows([]));
    expect(snapshot().rows).toEqual([]);
    expect(snapshot().error).toBe('REGISTRY_UNAVAILABLE');
    await act(async () => h.replaceRows([{ ...row, scheduleId: 'new-task', title: 'New task' }]));
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(snapshot().rows[0]!.title).toBe('New task');
    expect(snapshot()).toMatchObject({ error: 'REGISTRY_UNAVAILABLE', retrying: false });
    expect(h.syncs.length).toBe(4);
    await act(async () => container.querySelector('button')!.click());
    expect(snapshot().error).toBe('REGISTRY_UNAVAILABLE');
    expect(snapshot().retrying).toBe(true);
    await act(async () => h.syncs[4]!.resolve());
    expect(snapshot().error).toBeUndefined();
    expect(snapshot().retrying).toBe(false);
    expect(h.listeners.size).toBe(1);
    expect(h.rooms.size).toBe(1);
  });

  it('retries on network restoration instead of waiting for the scheduled delay', async () => {
    const h = harness();
    await mount(h);
    await act(async () => h.syncs[0]!.reject(new Error('network_error')));
    await act(async () => window.dispatchEvent(new Event('online')));
    await act(async () => h.syncs[1]!.resolve());
    expect(snapshot().error).toBeUndefined();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(h.rooms.size).toBe(1);
    expect(h.opens).toBe(1);
  });

  it.each(['open', 'join', 'sync'] as const)(
    'fences a late %s result after workspace change',
    async (stage) => {
      const old = harness();
      const pending = stage === 'open' ? old.holdOpen() : stage === 'join' ? old.holdJoin() : null;
      await mount(old);
      const next = harness('workspace-b', [{ ...row, title: 'Workspace B task' }]);
      scope.workspaceId = 'workspace-b';
      await mount(next);
      await act(async () => {
        if (pending) pending.resolve();
        else old.syncs[0]!.resolve();
        next.syncs[0]!.resolve();
      });
      expect(snapshot().workspaceId).toBe('workspace-b');
      expect(snapshot().rows[0]!.title).toBe('Workspace B task');
      expect(old.listeners.size).toBe(0);
      expect(old.rooms.size).toBe(0);
      act(() => root.unmount());
      expect(next.listeners.size).toBe(0);
      expect(next.rooms.size).toBe(0);
    }
  );
});

describe('useScheduleDocument sync freshness', () => {
  let root: Root;
  let container: HTMLDivElement;
  let store: ReturnType<typeof createStore>;

  const makeDoc = (activationId: string, updatedAt: number, agentConfigId: string): ScheduleDocument =>
    ({
      definition: {
        scheduleId: 'schedule-a',
        title: 'Home morning',
        ownerId: 'owner',
        machineId: 'machine',
        enabled: true,
        activationId,
        activeFrom: updatedAt,
        createdAt: 1000,
        updatedAt,
        createdBy: 'owner',
        trigger: { kind: 'manual' },
        misfirePolicy: { kind: 'run_once' },
        overlapPolicy: 'skip',
        agent: { agentConfigId },
        destination: { kind: 'new_session' },
        retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
      },
      prompt: `prompt-${activationId}`,
      timeline: [],
    }) as ScheduleDocument;

  beforeEach(() => {
    scope.workspaceId = 'workspace-a';
    scope.enabled = true;
    store = createStore();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('tracks synced=false while cached doc lags Registry and remounts editor on fresh revision', async () => {
    const firstSynced = deferred();
    const listeners = new Set<() => void>();
    let currentDoc: ScheduleDocument | null = makeDoc('old-claude', 1000, 'claude-agent');
    const releaseRef = vi.fn();
    const runtime = {
      workspaceId: 'workspace-a',
      acquireScheduleStore: vi.fn(async () => ({
        roomId: 'schedule-schedule-a',
        firstSynced: firstSynced.promise,
        getState: () => currentDoc,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        waitUntilSynced: async () => {},
        dispose: () => {},
      })),
      releaseScheduleStoreRef: releaseRef,
    } as unknown as WorkspaceRuntime;

    const mountedWith: string[] = [];
    function FakeEditor({ doc, readOnly }: { doc: ScheduleDocument; readOnly: boolean }) {
      const [captured] = useState(doc.definition.agent.agentConfigId);
      mountedWith.push(captured);
      return (
        <span data-agent={captured} data-readonly={String(readOnly)}>
          {readOnly ? `${captured}:readonly` : captured}
        </span>
      );
    }

    function DetailHost({
      rowActivationId,
      rowUpdatedAt,
    }: {
      rowActivationId: string;
      rowUpdatedAt: number;
    }) {
      const detail = useScheduleDocument('schedule-a');
      const view = resolveScheduleDetailView({
        workspaceId: 'workspace-a',
        scheduleId: 'schedule-a',
        detail,
        row: { activationId: rowActivationId, updatedAt: rowUpdatedAt },
      });
      if (view.kind === 'loading') return <span>loading</span>;
      if (view.kind === 'missing') return <span>missing</span>;
      return (
        <FakeEditor key={view.editorKey} doc={view.document} readOnly={view.staleReadOnly} />
      );
    }

    await act(async () => {
      store.set(activeWorkspaceRuntimeAtom, runtime);
      root.render(
        <Provider store={store}>
          <DetailHost rowActivationId="new-neon" rowUpdatedAt={2000} />
        </Provider>
      );
    });

    // Cached Claude doc is older than Registry's Neon row -> wait instead of mounting stale state.
    expect(container.textContent).toBe('loading');
    expect(mountedWith).toEqual([]);

    // firstSynced brings the Neon doc from remote -> editor mounts editable with Neon.
    await act(async () => {
      currentDoc = makeDoc('new-neon', 2000, 'neon-agent');
      listeners.forEach((listener) => listener());
      firstSynced.resolve();
    });
    expect(container.textContent).toBe('neon-agent');
    expect(mountedWith).toEqual(['neon-agent']);

    // Live remote edit: Registry row arrives before schedule doc -> stays read-only until doc arrives,
    // then remounts editable onto argon-agent without freezing on neon-agent.
    await act(async () => {
      root.render(
        <Provider store={store}>
          <DetailHost rowActivationId="newer-argon" rowUpdatedAt={3000} />
        </Provider>
      );
    });
    expect(container.textContent).toBe('neon-agent:readonly');

    await act(async () => {
      currentDoc = makeDoc('newer-argon', 3000, 'argon-agent');
      listeners.forEach((listener) => listener());
    });
    expect(container.textContent).toBe('argon-agent');

    act(() => root.unmount());
    expect(releaseRef).toHaveBeenCalledWith('schedule-a');
    expect(listeners.size).toBe(0);
  });

  it('falls back to read-only cached view on offline sync timeout and recovers when target revision arrives', async () => {
    vi.useFakeTimers();
    try {
      const firstSynced = deferred();
      const listeners = new Set<() => void>();
      let currentDoc: ScheduleDocument | null = makeDoc('old-claude', 1000, 'claude-agent');
      const runtime = {
        workspaceId: 'workspace-a',
        acquireScheduleStore: vi.fn(async () => ({
          roomId: 'schedule-schedule-a',
          firstSynced: firstSynced.promise,
          getState: () => currentDoc,
          subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          waitUntilSynced: async () => {},
          dispose: () => {},
        })),
        releaseScheduleStoreRef: vi.fn(),
      } as unknown as WorkspaceRuntime;

      function DetailHost() {
        const detail = useScheduleDocument('schedule-a', { syncTimeoutMs: 500 });
        const view = resolveScheduleDetailView({
          workspaceId: 'workspace-a',
          scheduleId: 'schedule-a',
          detail,
          row: { activationId: 'new-neon', updatedAt: 2000 },
        });
        if (view.kind === 'loading') return <span>loading</span>;
        if (view.kind === 'missing') return <span>missing</span>;
        return (
          <span data-key={view.editorKey}>
            {view.document.definition.agent.agentConfigId}:{view.staleReadOnly ? 'readonly' : 'edit'}
          </span>
        );
      }

      await act(async () => {
        store.set(activeWorkspaceRuntimeAtom, runtime);
        root.render(
          <Provider store={store}>
            <DetailHost />
          </Provider>
        );
      });
      expect(container.textContent).toBe('loading');

      // Offline timeout ends the spinner and shows cached doc read-only, keeping subscription alive.
      await act(async () => vi.advanceTimersByTimeAsync(500));
      expect(container.textContent).toBe('claude-agent:readonly');
      expect(listeners.size).toBe(1);

      // Reconnecting later delivers Neon -> editor recovers to editable Neon.
      await act(async () => {
        currentDoc = makeDoc('new-neon', 2000, 'neon-agent');
        listeners.forEach((listener) => listener());
        firstSynced.resolve();
      });
      expect(container.textContent).toBe('neon-agent:edit');
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a readable local document in offline state (read-only if stale) when firstSynced rejects and recovers on online', async () => {
    const firstSynced = deferred();
    let currentDoc = makeDoc('local-v1', 1000, 'claude-agent');
    const sync = vi.fn(async () => {
      currentDoc = makeDoc('remote-v2', 2000, 'neon-agent');
    });
    const runtime = {
      workspaceId: 'workspace-a',
      repo: { sync },
      acquireScheduleStore: vi.fn(async () => ({
        roomId: 'schedule-schedule-a',
        firstSynced: firstSynced.promise,
        getState: () => currentDoc,
        subscribe: () => () => {},
        waitUntilSynced: async () => {},
        dispose: () => {},
      })),
      releaseScheduleStoreRef: vi.fn(),
    } as unknown as WorkspaceRuntime;

    let latest: ReturnType<typeof useScheduleDocument> | undefined;
    function Reader() {
      latest = useScheduleDocument('schedule-a');
      return <span>{latest.document?.definition.activationId ?? 'none'}</span>;
    }

    await act(async () => {
      store.set(activeWorkspaceRuntimeAtom, runtime);
      root.render(
        <Provider store={store}>
          <Reader />
        </Provider>
      );
    });
    expect(latest).toMatchObject({ ready: true, syncState: 'syncing' });

    await act(async () => {
      firstSynced.reject(new Error('offline'));
    });
    expect(latest).toMatchObject({ ready: true, syncState: 'offline' });
    expect(latest?.document?.definition.activationId).toBe('local-v1');

    // Stale cached doc after sync failure stays read-only, while up-to-date cache stays editable.
    expect(
      resolveScheduleDetailView({
        workspaceId: 'workspace-a',
        scheduleId: 'schedule-a',
        detail: latest!,
        row: { activationId: 'remote-v2', updatedAt: 2000 },
      })
    ).toMatchObject({ kind: 'ready', staleReadOnly: true });
    expect(
      resolveScheduleDetailView({
        workspaceId: 'workspace-a',
        scheduleId: 'schedule-a',
        detail: latest!,
        row: { activationId: 'local-v1', updatedAt: 1000 },
      })
    ).toMatchObject({ kind: 'ready', staleReadOnly: false });

    // Network restoration pulls the doc directly even when initial joinRoom failed.
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'doc', docIds: ['schedule-schedule-a'] })
    );
    expect(latest).toMatchObject({ ready: true, syncState: 'synced' });
    expect(
      resolveScheduleDetailView({
        workspaceId: 'workspace-a',
        scheduleId: 'schedule-a',
        detail: latest!,
        row: { activationId: 'remote-v2', updatedAt: 2000 },
      })
    ).toMatchObject({ kind: 'ready', staleReadOnly: false });
  });
});
