import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addLanHub,
  deriveLanHubUserId,
  type LanHub,
  type LanHubSettings,
} from '@lody/shared/node/lan-hub';
import { LanMembership, toLanWorkspaces } from './lan-membership';
import type { Logger } from '@/utils/logger';

const silentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  setDebug: () => {},
  child: () => silentLogger(),
  close: async () => {},
});

const hub = (name: string, url: string, token: string): LanHub =>
  addLanHub([], { name, url, token }).hub;

const home = hub('Home', 'http://10.0.0.1:8788', 'home-token');
const office = hub('Office', 'http://10.0.1.1:8788', 'office-token');

const settings = (hubs: LanHub[], machineName: string | null = null): LanHubSettings => ({
  hubs,
  machineName,
  source: hubs.length > 0 ? 'file' : 'none',
});

function createMembership(initial: LanHubSettings) {
  const restarts: string[] = [];
  const warnings: string[] = [];
  let current = initial;
  let onChange: (next: LanHubSettings) => void = () => {};
  let onError: (error: unknown) => void = () => {};
  let watching = false;
  const membership = new LanMembership({
    settings: initial,
    logger: { ...silentLogger(), warn: (message: string) => warnings.push(message) },
    onRestartRequired: (reason) => restarts.push(reason),
    read: () => current,
    watch: (options) => {
      watching = true;
      onChange = options.onChange;
      onError = options.onError;
      return { close: () => (watching = false) };
    },
  });
  const seen: string[][] = [];
  membership.workspaces.subscribe(() =>
    seen.push(membership.workspaces.get().map((workspace) => workspace.name))
  );
  return {
    membership,
    restarts,
    warnings,
    seen,
    isWatching: () => watching,
    change: (next: LanHubSettings) => {
      current = next;
      onChange(next);
    },
    fail: (error: unknown) => onError(error),
    setOnDisk: (next: LanHubSettings) => (current = next),
  };
}

const gatewayOf = (membership: LanMembership, workspaceId: string) => {
  const provider = membership.streamsTokens?.createTokenProvider({
    workspaceId: workspaceId as never,
  });
  return provider ? { url: provider.getGatewayBaseUrl(), token: provider.getToken() } : null;
};

describe('LanMembership', () => {
  it('reaches every LAN through its own gateway with its own credential', async () => {
    const { membership } = createMembership(settings([home, office]));
    const [homeWorkspace, officeWorkspace] = toLanWorkspaces([home, office]);

    expect(membership.workspaces.get()).toEqual([
      {
        id: `lw_${home.id}`,
        name: 'Home',
        slug: 'lan-home',
        role: 'owner',
        userId: deriveLanHubUserId('home-token'),
      },
      {
        id: `lw_${office.id}`,
        name: 'Office',
        slug: 'office',
        role: 'owner',
        userId: deriveLanHubUserId('office-token'),
      },
    ]);
    const homeGateway = gatewayOf(membership, homeWorkspace!.id);
    const officeGateway = gatewayOf(membership, officeWorkspace!.id);
    expect(homeGateway?.url).toBe('http://10.0.0.1:8788');
    await expect(homeGateway?.token).resolves.toBe('home-token');
    expect(officeGateway?.url).toBe('http://10.0.1.1:8788');
    await expect(officeGateway?.token).resolves.toBe('office-token');
  });

  it('attaches no gateway for an installation without a LAN', () => {
    const { membership } = createMembership(settings([]));
    expect(membership.streamsTokens).toBeNull();
    expect(membership.workspaces.get()).toEqual([]);
  });

  it('follows a LAN that is joined while the service runs', async () => {
    const harness = createMembership(settings([home]));
    harness.membership.start();

    harness.change(settings([home, office]));

    expect(harness.seen).toEqual([['Home', 'Office']]);
    expect(harness.restarts).toEqual([]);
    await expect(gatewayOf(harness.membership, `lw_${office.id}`)?.token).resolves.toBe(
      'office-token'
    );
  });

  it('follows a LAN that is left and refuses to reach it afterwards', () => {
    const harness = createMembership(settings([home, office]));
    harness.membership.start();

    harness.change(settings([home]));

    expect(harness.seen).toEqual([['Home']]);
    expect(() => gatewayOf(harness.membership, `lw_${office.id}`)).toThrow(
      /No LAN carries workspace/
    );
  });

  it('follows a rename without a restart', () => {
    const harness = createMembership(settings([home]));
    harness.membership.start();

    harness.change(settings([{ ...home, name: 'Flat' }]));

    expect(harness.membership.workspaces.get()).toEqual([
      {
        id: `lw_${home.id}`,
        name: 'Flat',
        slug: 'flat',
        role: 'owner',
        userId: deriveLanHubUserId('home-token'),
      },
    ]);
    expect(harness.restarts).toEqual([]);
  });

  it('asks for a restart once when a change cannot be followed', () => {
    const harness = createMembership(settings([home]));
    harness.membership.start();

    harness.change(settings([{ ...home, url: 'http://10.0.0.2:8788' }]));
    harness.change(settings([]));

    expect(harness.restarts).toEqual(['Home moved to another address']);
    expect(harness.seen).toEqual([]);
    // The running service keeps talking to the address it started with.
    expect(gatewayOf(harness.membership, `lw_${home.id}`)?.url).toBe('http://10.0.0.1:8788');
  });

  it('asks for a restart when the first LAN is joined', () => {
    const harness = createMembership(settings([]));
    harness.membership.start();

    harness.change(settings([home]));

    expect(harness.restarts).toEqual(['the first LAN was added']);
    expect(harness.membership.streamsTokens).toBeNull();
  });

  it('applies a change made between reading the settings and watching them', () => {
    const harness = createMembership(settings([home]));
    harness.setOnDisk(settings([home, office]));

    harness.membership.start();

    expect(harness.seen).toEqual([['Home', 'Office']]);
  });

  it('keeps its LANs when the settings become unreadable', () => {
    const harness = createMembership(settings([home]));
    harness.membership.start();

    harness.fail(new Error('LAN config is not valid JSON'));

    expect(harness.warnings).toEqual([
      '[lan] Ignoring LAN settings that cannot be read: LAN config is not valid JSON',
    ]);
    expect(harness.membership.workspaces.get().map((workspace) => workspace.name)).toEqual([
      'Home',
    ]);
  });

  it('never watches settings that come from the environment', () => {
    const harness = createMembership({ hubs: [home], machineName: null, source: 'environment' });
    harness.membership.start();
    expect(harness.isWatching()).toBe(false);
  });

  it('stops watching when closed', () => {
    const harness = createMembership(settings([home]));
    harness.membership.start();
    expect(harness.isWatching()).toBe(true);
    harness.membership.close();
    expect(harness.isWatching()).toBe(false);
  });

  describe('a hub that moved', () => {
    const follow = async (options: {
      onDisk: LanHubSettings;
      movedTo: Record<string, string | null>;
    }) => {
      let onDisk = options.onDisk;
      const written: LanHubSettings[] = [];
      const membership = new LanMembership({
        settings: settings([home, office]),
        logger: silentLogger(),
        onRestartRequired: () => {},
        read: () => onDisk,
        write: (next) => {
          onDisk = { ...next, source: 'file' };
          written.push(onDisk);
          return 'lan-hub.json';
        },
        askWhere: async (asked) => {
          const url = options.movedTo[asked.name];
          return url ? { url, term: 1 } : null;
        },
        termsPath: path.join(
          fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-terms-')),
          'terms.json'
        ),
      });
      await membership.follow();
      return written;
    };

    it('is followed to where it says it went, and the other LANs stay', async () => {
      const written = await follow({
        onDisk: settings([home, office], 'desk'),
        movedTo: { Home: 'http://100.64.0.9:8788' },
      });

      expect(written).toEqual([
        {
          hubs: [{ ...home, url: 'http://100.64.0.9:8788' }, office],
          machineName: 'desk',
          source: 'file',
        },
      ]);
    });

    it('is left alone where the settings already changed', async () => {
      const elsewhere = { ...home, url: 'http://100.64.0.7:8788' };
      expect(
        await follow({
          onDisk: settings([elsewhere, office]),
          movedTo: { Home: 'http://100.64.0.9:8788' },
        })
      ).toEqual([]);
      expect(await follow({ onDisk: settings([office]), movedTo: { Home: 'x' } })).toEqual([]);
    });
  });
});
