import { describe, expect, it } from 'vitest';
import type { WorkspaceId } from '@lody/shared';
import {
  CLOUD_PLATFORM_CAPABILITIES,
  createCapabilitySet,
  defineCloudAction,
  defineCloudMutation,
  defineCloudQuery,
  createLocalCloudPort,
  createLocalPlatformProvider,
  createStaticStore,
  createStore,
  isLocalUserId,
  isLocalWorkspaceId,
  LOCAL_PLATFORM_CAPABILITIES,
  PLATFORM_CAPABILITIES,
  type PlatformSessionState,
  type WorkspacesState,
  DEFAULT_RUNTIME_ARTIFACTS_BASE_URL,
  resolveRuntimeArtifactsBaseUrl,
  resolvePlatformKind,
  resolvePlatformSync,
} from '../src/index';

describe('resolvePlatformKind', () => {
  it('defaults to local when unset or blank', () => {
    expect(resolvePlatformKind(undefined)).toBe('local');
    expect(resolvePlatformKind(null)).toBe('local');
    expect(resolvePlatformKind('')).toBe('local');
    expect(resolvePlatformKind('  ')).toBe('local');
  });

  it('parses explicit kinds and trims whitespace', () => {
    expect(resolvePlatformKind('local')).toBe('local');
    expect(resolvePlatformKind(' cloud ')).toBe('cloud');
  });

  it('throws on unrecognized values instead of silently running cloud', () => {
    expect(() => resolvePlatformKind('offline')).toThrow(/Unrecognized/);
  });
});

describe('capabilities', () => {
  it('local set is empty; cloud set covers every capability', () => {
    expect(LOCAL_PLATFORM_CAPABILITIES.list()).toEqual([]);
    for (const capability of PLATFORM_CAPABILITIES) {
      expect(LOCAL_PLATFORM_CAPABILITIES.has(capability)).toBe(false);
      expect(CLOUD_PLATFORM_CAPABILITIES.has(capability)).toBe(true);
    }
  });

  it('createCapabilitySet deduplicates and answers membership', () => {
    const set = createCapabilitySet(['billing', 'billing', 'cloudSync']);
    expect(set.list()).toEqual(['billing', 'cloudSync']);
    expect(set.has('billing')).toBe(true);
    expect(set.has('teamSharing')).toBe(false);
  });
});

describe('cloud operation descriptors', () => {
  it('carry only a validated backend-neutral operation identity', () => {
    expect(defineCloudQuery<{ workspaceId: string }, string>('billing', 'billing:getPlan')).toEqual(
      {
        kind: 'query',
        capability: 'billing',
        name: 'billing:getPlan',
        access: 'authenticated',
      }
    );
    expect(
      defineCloudMutation<{ enabled: boolean }, null>('githubIntegration', 'github:setEnabled')
    ).toEqual({
      kind: 'mutation',
      capability: 'githubIntegration',
      name: 'github:setEnabled',
      access: 'authenticated',
    });
    expect(
      defineCloudAction<Record<string, never>, string>('billing', 'billing:createCheckout')
    ).toEqual({
      kind: 'action',
      capability: 'billing',
      name: 'billing:createCheckout',
      access: 'authenticated',
    });
  });

  it('rejects malformed names at assembly instead of deferring the error to a request', () => {
    expect(() => defineCloudQuery('billing', 'missingFunctionSeparator')).toThrow(
      /Invalid cloud operation/
    );
  });
});

describe('stores', () => {
  it('createStore notifies subscribers only on actual change', () => {
    const store = createStore(1);
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    store.set(1);
    expect(notified).toBe(0);
    store.set(2);
    expect(notified).toBe(1);
    expect(store.get()).toBe(2);
    unsubscribe();
    store.set(3);
    expect(notified).toBe(1);
  });
});

describe('local id namespaces', () => {
  it('recognizes local prefixes and rejects cloud-shaped ids', () => {
    expect(isLocalWorkspaceId('lw_abc123')).toBe(true);
    expect(isLocalWorkspaceId('j57abcdefgh')).toBe(false);
    expect(isLocalUserId('local:abc')).toBe(true);
    expect(isLocalUserId('user_123')).toBe(false);
  });
});

describe('createLocalPlatformProvider', () => {
  const user = { id: 'local:u1', name: 'Local User' };
  const workspace = { id: 'lw_w1', name: 'Local', slug: null, role: 'owner' };

  it('resolves its injected identity with no capabilities and local sync mode', async () => {
    const session = createStore<PlatformSessionState>({ status: 'loading' });
    const provider = createLocalPlatformProvider({
      session,
      workspaces: createStaticStore({
        status: 'ready',
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
      } as const),
    });
    expect(provider.kind).toBe('local');
    expect(provider.sync.mode).toBe('local');
    expect(provider.capabilities.list()).toEqual([]);
    expect(provider.cloudApi).toBeNull();
    expect(provider.identity.session.get()).toEqual({ status: 'loading' });
    session.set({ status: 'authenticated', user });
    expect(provider.identity.session.get()).toEqual({ status: 'authenticated', user });
    expect(provider.workspaces.create).toBeUndefined();
    await expect(provider.workspaces.setActive(workspace.id)).resolves.toBeUndefined();
    await expect(provider.workspaces.setActive('lw_other')).rejects.toThrow(
      /no workspace lw_other/
    );
    expect(resolvePlatformSync(provider.sync, workspace.id)).toEqual({ mode: 'local' });
  });

  it('switches between the workspaces of the LANs an installation belongs to', async () => {
    const home = { id: 'lw_home', name: 'Home', slug: 'lan-home', role: 'owner' };
    const office = { id: 'lw_office', name: 'Office', slug: 'office', role: 'owner' };
    const workspaces = createStore<WorkspacesState>({
      status: 'ready',
      workspaces: [home, office],
      activeWorkspaceId: home.id,
    });
    const provider = createLocalPlatformProvider({
      session: createStaticStore({ status: 'authenticated', user } as const),
      workspaces,
      activateWorkspace: (workspaceId) =>
        workspaces.set({
          status: 'ready',
          workspaces: [home, office],
          activeWorkspaceId: workspaceId,
        }),
    });

    await provider.workspaces.setActive(office.id);

    expect(workspaces.get()).toMatchObject({ activeWorkspaceId: office.id });
    await expect(provider.workspaces.setActive('lw_gone')).rejects.toThrow(/no workspace lw_gone/);
    expect(workspaces.get()).toMatchObject({ activeWorkspaceId: office.id });
    // Still no capability that needs an account.
    expect(provider.capabilities.list()).toEqual([]);
  });

  it('syncs each workspace through the gateway of its own LAN', () => {
    const gateways: Record<string, { gatewayBaseUrl: string; token: string } | null> = {
      lw_home: { gatewayBaseUrl: 'lody-hub://home', token: 'lan-hub' },
      lw_office: { gatewayBaseUrl: 'lody-hub://office', token: 'lan-hub' },
      lw_local: null,
    };
    const provider = createLocalPlatformProvider({
      session: createStaticStore({ status: 'authenticated', user } as const),
      workspaces: createStaticStore({ status: 'loading' } as const),
      // A new object on every call, as a store that was just refreshed returns.
      resolveStreams: (workspaceId) => {
        const gateway = gateways[workspaceId];
        return gateway ? { ...gateway } : null;
      },
    });

    const home = resolvePlatformSync(provider.sync, 'lw_home');
    expect(home).toEqual({
      mode: 'dual',
      streams: { gatewayBaseUrl: 'lody-hub://home', token: 'lan-hub' },
    });
    expect(resolvePlatformSync(provider.sync, 'lw_office').streams?.gatewayBaseUrl).toBe(
      'lody-hub://office'
    );
    expect(resolvePlatformSync(provider.sync, 'lw_local')).toEqual({ mode: 'local' });
    expect(resolvePlatformSync(provider.sync, 'lw_unknown')).toEqual({ mode: 'local' });
    expect(resolvePlatformSync(provider.sync, null)).toMatchObject({ mode: 'local' });
    // An effect keyed by the answer must not run again for an unchanged workspace.
    expect(resolvePlatformSync(provider.sync, 'lw_home')).toBe(home);

    gateways.lw_home = { gatewayBaseUrl: 'lody-hub://moved', token: 'lan-hub' };
    expect(resolvePlatformSync(provider.sync, 'lw_home')).not.toBe(home);
  });
});

describe('createLocalCloudPort', () => {
  const identity = { userId: 'local:u1' };
  const workspaces = [{ id: 'lw_w1', name: 'Local', slug: null, role: 'owner' }];

  it('allows only the owner and disables every optional port', async () => {
    const port = createLocalCloudPort({ identity, workspaces });
    expect(port.kind).toBe('local');
    expect(port.streamsTokens).toBeNull();
    expect(port.notifications).toBeNull();
    expect(port.usage).toBeNull();
    expect(port.billing).toBeNull();
    expect(port.githubTokens).toBeNull();
    expect(port.bugReports).toBeNull();
    expect(port.prAssociation).toBeNull();
    expect(port.attachmentUpload).toBeNull();
    expect(port.remotePreview).toBeNull();
    expect(port.runtimeArtifacts.baseUrl).toBe(DEFAULT_RUNTIME_ARTIFACTS_BASE_URL);

    await expect(
      port.access.verifyMachineAccess({
        workspaceId: 'lw_w1' as WorkspaceId,
        requesterUserId: 'local:u1',
      })
    ).resolves.toEqual({ allowed: true });
    await expect(
      port.access.verifyMachineAccess({
        workspaceId: 'lw_w1' as WorkspaceId,
        requesterUserId: 'cloud-user',
      })
    ).resolves.toEqual({ allowed: false, reason: 'requester_not_member' });

    const seen: unknown[] = [];
    const unsubscribe = port.access.watchWorkspaceAccess(
      (snapshot) => seen.push(snapshot),
      (error) => {
        throw error;
      }
    );
    expect(seen).toEqual([{ status: 'authorized', userId: identity.userId, workspaces }]);
    unsubscribe();
  });

  it('admits the user of a LAN to the workspace of that LAN only', async () => {
    const port = createLocalCloudPort({
      identity: { userId: 'local:home-user' },
      workspaces: [
        { id: 'lw_home', name: 'Home', slug: 'home', role: 'owner', userId: 'local:home-user' },
        { id: 'lw_office', name: 'Office', slug: 'office', role: 'owner', userId: 'local:office-user' },
        { id: 'lw_plain', name: 'Plain', slug: null, role: 'owner' },
      ],
    });
    const verdict = async (workspaceId: string, requesterUserId: string) =>
      (await port.access.verifyMachineAccess({ workspaceId: workspaceId as WorkspaceId, requesterUserId }))
        .allowed;

    expect(await verdict('lw_home', 'local:home-user')).toBe(true);
    expect(await verdict('lw_office', 'local:office-user')).toBe(true);
    // Holding the credential of one LAN opens no other.
    expect(await verdict('lw_office', 'local:home-user')).toBe(false);
    expect(await verdict('lw_home', 'local:office-user')).toBe(false);
    // A workspace that names no user belongs to the installation.
    expect(await verdict('lw_plain', 'local:home-user')).toBe(true);
    await expect(
      port.access.resolveWorkspaceUser({
        workspaceId: 'lw_office' as WorkspaceId,
        userId: 'local:office-user',
      })
    ).resolves.toEqual({ id: 'local:office-user' });
    await expect(
      port.access.resolveWorkspaceUser({
        workspaceId: 'lw_office' as WorkspaceId,
        userId: 'local:home-user',
      })
    ).resolves.toBeNull();
  });

  it('reports the workspaces again whenever the LANs of the installation change', () => {
    const home = { id: 'lw_home', name: 'Home', slug: 'lan-home', role: 'owner' };
    const office = { id: 'lw_office', name: 'Office', slug: 'office', role: 'owner' };
    const live = createStore<readonly (typeof home)[]>([home]);
    const tokens = { createTokenProvider: () => { throw new Error('not used'); } };
    const port = createLocalCloudPort({ identity, workspaces: live, streamsTokens: tokens });
    expect(port.streamsTokens).toBe(tokens);

    const seen: string[][] = [];
    const unsubscribe = port.access.watchWorkspaceAccess(
      (snapshot) =>
        seen.push(
          snapshot.status === 'authorized' ? snapshot.workspaces.map((entry) => entry.id) : []
        ),
      (error) => {
        throw error;
      }
    );
    live.set([home, office]);
    live.set([office]);
    unsubscribe();
    live.set([]);

    expect(seen).toEqual([['lw_home'], ['lw_home', 'lw_office'], ['lw_office']]);
  });
});

describe('runtime artifact channel assembly', () => {
  it('uses the public R2-backed artifact channel by default', () => {
    expect(resolveRuntimeArtifactsBaseUrl()).toBe(DEFAULT_RUNTIME_ARTIFACTS_BASE_URL);
  });

  it('allows an explicit operator mirror to override the public channel', () => {
    expect(resolveRuntimeArtifactsBaseUrl('https://artifacts.example.test/')).toBe(
      'https://artifacts.example.test'
    );
  });

  it('rejects an invalid operator mirror at process assembly', () => {
    expect(() => resolveRuntimeArtifactsBaseUrl('not a URL')).toThrow(
      /Invalid runtime artifacts base URL/
    );
  });
});
