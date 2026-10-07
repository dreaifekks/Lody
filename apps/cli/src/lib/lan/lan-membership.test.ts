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
import { watchLanHubRequests } from './lan-hub-watch';
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

const termsPath = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-terms-')), 'terms.json');

/** What a hub that moved answers every request behind its gate with. */
const pointer = (movedTo: string) =>
  new Response(JSON.stringify({ error: 'moved', movedTo, term: 1, signature: 'sig' }), {
    status: 410,
    headers: { 'Content-Type': 'application/json' },
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
    requests: { fetch: async () => new Response(null, { status: 204 }) },
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

    harness.change(settings([home], 'desk'));
    harness.change(settings([]));

    expect(harness.restarts).toEqual(['this machine was renamed']);
    expect(harness.seen).toEqual([]);
  });

  it('follows a hub to another address without a restart', async () => {
    const harness = createMembership(settings([home, office]));
    // Built before the move, as the machine RPC client is.
    const provider = harness.membership.streamsTokens?.createTokenProvider({
      workspaceId: `lw_${home.id}` as never,
    });
    const moves: string[][] = [];
    harness.membership.onMoved((hubs) => moves.push(hubs.map((moved) => moved.url)));
    harness.membership.start();

    harness.change(settings([{ ...home, url: 'http://10.0.0.2:8788' }, office]));

    expect(harness.restarts).toEqual([]);
    expect(moves).toEqual([['http://10.0.0.2:8788']]);
    expect(provider?.getGatewayBaseUrl()).toBe('http://10.0.0.2:8788');
    await expect(provider?.getToken()).resolves.toBe('home-token');
    expect(gatewayOf(harness.membership, `lw_${home.id}`)?.url).toBe('http://10.0.0.2:8788');
    expect(gatewayOf(harness.membership, `lw_${office.id}`)?.url).toBe('http://10.0.1.1:8788');
    expect(harness.membership.workspaces.get().map((workspace) => workspace.name)).toEqual([
      'Home',
      'Office',
    ]);
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
        termsPath: termsPath(),
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
  describe('a request that fails the way a move explains', () => {
    const NEW_HOME = 'http://100.64.0.9:8788';

    function createFollower(respond: (url: string) => Promise<Response>) {
      let clock = 0;
      let pointsTo: string | null = null;
      let onDisk = settings([home, office]);
      let onChange: (next: LanHubSettings) => void = () => {};
      const requests = {
        fetch: async (input: Parameters<typeof fetch>[0]) => respond(String(input)),
      };
      const membership = new LanMembership({
        settings: onDisk,
        logger: silentLogger(),
        onRestartRequired: () => {},
        read: () => onDisk,
        write: (next) => {
          onDisk = { ...next, source: 'file' };
          onChange(onDisk);
          return 'lan-hub.json';
        },
        watch: (options) => {
          onChange = options.onChange;
          return { close: () => {} };
        },
        askWhere: async (asked) =>
          asked.id === home.id && pointsTo ? { url: pointsTo, term: 1 } : null,
        termsPath: termsPath(),
        now: () => clock,
        requests,
      });
      return {
        membership,
        requests,
        homeUrl: () => onDisk.hubs.find((entry) => entry.id === home.id)?.url,
        moveTo: (url: string) => (pointsTo = url),
        setClock: (ms: number) => (clock = ms),
      };
    }

    it('follows a hub that answers with a pointer at once, not at the next round', async () => {
      const follower = createFollower(async () => pointer(NEW_HOME));
      follower.moveTo(NEW_HOME);
      const moved = new Promise<string[]>((resolve) =>
        follower.membership.onMoved((hubs) => resolve(hubs.map((entry) => entry.url)))
      );
      follower.membership.start();

      const response = await follower.requests.fetch(`${home.url}/ds/lody/meta`);

      // The caller still reads the pointer it was answered with.
      expect(response.status).toBe(410);
      await expect(response.json()).resolves.toMatchObject({ movedTo: NEW_HOME });
      await expect(moved).resolves.toEqual([NEW_HOME]);
      expect(follower.homeUrl()).toBe(NEW_HOME);
      follower.membership.close();
    });

    it('asks one hub at most once in ten seconds, however many requests fail', async () => {
      const follower = createFollower(async () => new Response(null, { status: 204 }));
      follower.membership.start();

      await follower.membership.recheck(home.id);
      follower.moveTo(NEW_HOME);
      follower.setClock(9_999);
      expect(follower.membership.recheck(home.id)).toBeNull();
      expect(follower.homeUrl()).toBe(home.url);

      follower.setClock(10_000);
      await follower.membership.recheck(home.id);
      expect(follower.homeUrl()).toBe(NEW_HOME);
      // The round of every minute asks as well, and counts as asking.
      await follower.membership.follow();
      follower.setClock(15_000);
      expect(follower.membership.recheck(home.id)).toBeNull();
      expect(follower.membership.recheck('not-a-lan')).toBeNull();
      follower.membership.close();
    });
  });

  describe('watching the requests to the hubs', () => {
    function watch(respond: (url: string, init?: RequestInit) => Promise<Response>) {
      const original = async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        respond(String(input), init);
      const target = { fetch: original as typeof fetch };
      const troubles: string[] = [];
      const unwatch = watchLanHubRequests({
        hubs: () => [home, office],
        onTrouble: (hubId) => troubles.push(hubId),
        target,
      });
      return { target, troubles, unwatch, original };
    }
    const unreachable = async () => {
      throw new TypeError('fetch failed');
    };

    it('reports a hub after three requests in a row never reached it', async () => {
      let reachable = false;
      const { target, troubles } = watch(async () =>
        reachable ? new Response(null, { status: 204 }) : unreachable()
      );
      const attempt = () => target.fetch(`${home.url}/ds/lody/meta`).catch(() => null);

      await attempt();
      await attempt();
      reachable = true;
      await attempt();
      reachable = false;
      await attempt();
      await attempt();
      expect(troubles).toEqual([]);

      await attempt();
      expect(troubles).toEqual([home.id]);
    });

    it('says nothing of requests their caller gave up on, or of other addresses', async () => {
      const { target, troubles } = watch(async (_url, init) => {
        if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return unreachable();
      });
      const cancelled = new AbortController();
      cancelled.abort();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await target
          .fetch(`${home.url}/ds/lody/meta`, { signal: cancelled.signal })
          .catch(() => null);
        // Shares a prefix with the hub's address, and is another server.
        await target.fetch('http://10.0.0.1:87889/ds/lody/meta').catch(() => null);
      }
      expect(troubles).toEqual([]);
    });

    it('reports a pointer, and not a 410 for an offset the hub no longer holds', async () => {
      const { target, troubles } = watch(async (url) =>
        url.startsWith(office.url)
          ? pointer('http://100.64.0.3:8788')
          : new Response(JSON.stringify({ error: 'offset predates this hub' }), {
              status: 410,
              headers: { 'Content-Type': 'application/json' },
            })
      );

      await target.fetch(`${home.url}/ds/lody/meta?offset=12`);
      expect(troubles).toEqual([]);
      await target.fetch(`${office.url}/ds/lody/meta`);
      expect(troubles).toEqual([office.id]);
    });

    it('puts the fetch it wrapped back', () => {
      const { target, unwatch, original } = watch(async () => new Response(null));
      expect(target.fetch).not.toBe(original);
      unwatch();
      expect(target.fetch).toBe(original);
    });
  });
});
