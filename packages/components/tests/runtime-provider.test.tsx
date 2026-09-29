// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { atom, createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const environment = vi.hoisted(() => ({
  warm: true,
  mode: 'local',
  // The first workspace is the one the user was in last.
  workspaces: [{ id: 'local:workspace', slug: 'local' }] as { id: string; slug: string }[],
  syncByWorkspace: {} as Record<string, { mode: string; streams?: unknown }>,
}));
vi.mock('@/atoms', () => ({
  userAtom: atom({ id: 'local:user' }),
  currentWorkspaceSlugAtom: atom<string | null>(null),
  currentWorkspaceIdAtom: atom<string | null>(null),
}));
vi.mock('@/atoms/runtime', () => ({ authTokenAtom: atom(null), runtimeAtom: atom(null) }));
vi.mock('@/atoms/doc-meta', () => ({
  sessionMetaCacheAtom: atom({}),
  docMetaCacheReadyAtom: atom(false),
  clearDocMetaCacheAtom: atom(null, () => {}),
  docMetaSubscriptionAtom: atom(null),
}));
vi.mock('@/atoms/presence', () => ({
  clearLodyPresenceStatesAtom: atom(null, () => {}),
  setLodyPresenceNowMsAtom: atom(null, () => {}),
  setLodyPresenceStatesAtom: atom(null, () => {}),
  setLodyPresenceSyncStateAtom: atom(null, () => {}),
}));
vi.mock('@/atoms/local-probe', () => ({
  localAgentEnabledAtom: atom(false),
  localProbeAttemptedAtom: atom(false),
  localProbeEffectAtom: atom(null),
  localProbeResultAtom: atom(null),
}));
vi.mock('@/atoms/control-connection', () => ({
  lodyControlConnectionStateAtom: atom('idle'),
  runtimeInitializingAtom: atom(false),
  browserOnlineAtom: atom(true),
}));
vi.mock('@/lib', () => ({ API_BASE_URL: '' }));
vi.mock('@/lib/local-storage-cache', () => ({ getCachedWorkspaceId: () => null }));
vi.mock('@posthog/react', () => ({ usePostHog: () => null }));
vi.mock('@/lib/posthog-analytics', () => ({ capturePostHogEvent: () => {} }));
vi.mock('@/lib/clear-local-cache', () => ({ maybeClearLodyCacheOnBoot: async () => {} }));
vi.mock('@/lib/electron', () => ({ isElectronRenderer: () => true }));
vi.mock('@/lib/native-platform', () => ({ isNativeAppShell: () => false }));
vi.mock('@/lib/desktop-window', () => ({ isWarmWindow: () => environment.warm }));
vi.mock('@lody/platform/react', () => ({
  useCloudQuery: () => undefined,
  usePlatform: () => ({
    kind: environment.mode === 'cloud' ? 'cloud' : 'local',
    sync: {
      mode: environment.mode,
      resolve: (workspaceId: string) => environment.syncByWorkspace[workspaceId],
    },
    capabilities: new Set(),
  }),
}));
vi.mock('@/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => ({ isLoading: true }),
}));
vi.mock('@/providers/local-platform-provider', () => ({
  useLocalWorkspace: (slug: string | null) =>
    environment.workspaces.find((workspace) => workspace.slug === slug) ??
    environment.workspaces[0] ??
    null,
  getLocalWorkspaceSlug: (workspace: { slug: string }) => workspace.slug,
}));
vi.mock('../src/components/chat/session-pending-sends-host', () => ({
  SessionPendingSendsHost: () => null,
}));
vi.mock('@/providers/create-workspace-runtime', () => ({ createWorkspaceRuntime: vi.fn() }));

import { RuntimeProvider } from '../src/providers/runtime-provider';
import { createWorkspaceRuntime } from '../src/providers/create-workspace-runtime';
import { currentWorkspaceSlugAtom } from '../src/atoms';
import { runtimeAtom } from '../src/atoms/runtime';

function runtimeFixture() {
  return {
    workspaceId: 'local:workspace',
    workspaceSlug: 'local',
    disposed: false,
    metadata: new Map([['session', 'already prepared']]),
    setAuthToken: async () => {},
    async dispose() {
      this.disposed = true;
    },
  };
}

describe('RuntimeProvider warm workspace preparation', () => {
  let root: Root;
  let store: ReturnType<typeof createStore>;
  let prepared: ReturnType<typeof runtimeFixture>;
  const render = () =>
    act(async () => {
      root.render(
        <Provider store={store}>
          <RuntimeProvider>{null}</RuntimeProvider>
        </Provider>
      );
    });

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    environment.warm = true;
    environment.mode = 'local';
    environment.workspaces = [{ id: 'local:workspace', slug: 'local' }];
    environment.syncByWorkspace = {};
    store = createStore();
    root = createRoot(document.createElement('div'));
    prepared = runtimeFixture();
    vi.mocked(createWorkspaceRuntime)
      .mockReset()
      .mockResolvedValue(prepared as never);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
  });

  it('prepares before routing and retains the populated runtime when claimed', async () => {
    await render();
    expect(store.get(currentWorkspaceSlugAtom)).toBeNull();
    expect(store.get(runtimeAtom)).toBe(prepared);
    await act(async () => {
      environment.warm = false;
      store.set(currentWorkspaceSlugAtom, 'local');
    });
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(prepared.metadata.get('session')).toBe('already prepared');
    expect(prepared.disposed).toBe(false);
  });

  it('retains initialization already in flight when claimed early', async () => {
    let complete!: (runtime: never) => void;
    vi.mocked(createWorkspaceRuntime).mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      })
    );
    await render();
    expect(store.get(runtimeAtom)).toBeNull();
    await act(async () => {
      environment.warm = false;
      store.set(currentWorkspaceSlugAtom, 'local');
      complete(prepared as never);
    });
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(prepared.disposed).toBe(false);
  });

  it('disposes the prepared runtime when the route changes scope', async () => {
    environment.workspaces.push({ id: 'local:office', slug: 'office' });
    await render();
    const replacement = runtimeFixture();
    vi.mocked(createWorkspaceRuntime).mockResolvedValue(replacement as never);
    await act(async () => {
      store.set(currentWorkspaceSlugAtom, 'office');
    });
    expect(prepared.disposed).toBe(true);
    expect(store.get(runtimeAtom)).toBe(replacement);
    expect(vi.mocked(createWorkspaceRuntime).mock.lastCall?.[0]).toMatchObject({
      workspaceId: 'local:office',
      workspaceSlug: 'office',
    });
  });

  it('starts no runtime under a route that names no workspace', async () => {
    environment.warm = false;
    await render();
    await act(async () => {
      store.set(currentWorkspaceSlugAtom, 'garage');
    });
    expect(store.get(runtimeAtom)).toBeNull();
    expect(createWorkspaceRuntime).not.toHaveBeenCalled();
  });

  it('syncs each workspace the way its own LAN says', async () => {
    environment.warm = false;
    environment.workspaces = [
      { id: 'local:home', slug: 'home' },
      { id: 'local:office', slug: 'office' },
    ];
    const homeGateway = { gatewayBaseUrl: 'lody-hub://home', token: 'lan-hub' };
    const officeGateway = { gatewayBaseUrl: 'lody-hub://office', token: 'lan-hub' };
    environment.syncByWorkspace = {
      'local:home': { mode: 'local' },
      'local:office': { mode: 'local', streams: officeGateway },
    };
    await render();

    await act(async () => {
      store.set(currentWorkspaceSlugAtom, 'office');
    });
    expect(vi.mocked(createWorkspaceRuntime).mock.lastCall?.[0]).toMatchObject({
      workspaceId: 'local:office',
      streams: officeGateway,
    });

    environment.syncByWorkspace['local:home'] = { mode: 'local', streams: homeGateway };
    await act(async () => {
      store.set(currentWorkspaceSlugAtom, 'home');
    });
    expect(vi.mocked(createWorkspaceRuntime).mock.lastCall?.[0]).toMatchObject({
      workspaceId: 'local:home',
      streams: homeGateway,
    });
  });

  it.each(['ordinary', 'cloud', 'missing identity'])(
    'does not guess a workspace for %s',
    async (kind) => {
      if (kind === 'ordinary') environment.warm = false;
      if (kind === 'cloud') environment.mode = 'cloud';
      if (kind === 'missing identity') environment.workspaces = [];
      await render();
      expect(store.get(runtimeAtom)).toBeNull();
      expect(store.get(currentWorkspaceSlugAtom)).toBeNull();
    }
  );

  it('waits for local identity and disposes when the spare unmounts', async () => {
    environment.workspaces = [];
    await render();
    expect(store.get(runtimeAtom)).toBeNull();
    environment.workspaces = [{ id: 'local:workspace', slug: 'local' }];
    await render();
    expect(store.get(runtimeAtom)).toBe(prepared);
    await act(async () => {
      root.render(null);
    });
    expect(prepared.disposed).toBe(true);
    expect(store.get(runtimeAtom)).toBeNull();
  });
});
