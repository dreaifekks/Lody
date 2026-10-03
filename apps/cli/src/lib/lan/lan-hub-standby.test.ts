import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import { getMachineRoomId, type MachineId, type MachineMeta, type WorkspaceId } from '@lody/shared';
import { getLanHubWorkspaceId } from '@lody/shared/lan-hub';
import type { LanHubRole } from '@lody/shared/lan-hub-role';
import { addLanHub, type LanHub } from '@lody/shared/node/lan-hub';
import type { Logger } from '@/utils/logger';
import type { pullLanHubSnapshot } from './hub-snapshot';
import type { askLanHubPeer, LanHubPeerAnswer } from './lan-hub-peers';
import { LanHubStandby, getLanHubStandbyDirectory, roundLanHubRtt } from './lan-hub-standby';
import type { LanMemberWorkspace } from './lan-members';
import { fillMissingLanHubCredentials } from './lan-credential-sync';

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

const THIS = 'machine-n100' as MachineId;
const HOST = 'machine-devnuc' as MachineId;
const OTHER = 'machine-other' as MachineId;
const home: LanHub = addLanHub([], {
  name: 'Home',
  url: 'http://10.0.0.1:8788',
  token: 'home-token-0123456789',
}).hub;
const START = Date.parse('2026-10-03T12:00:00.000Z');

describe('the standby of a LAN hub', () => {
  let root: string;
  let workspace: LanMemberWorkspace;
  let store: SqliteRepoStore;
  let now: number;
  let pulls: number;
  let capable: boolean;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-standby-'));
    store = new SqliteRepoStore({ path: path.join(root, 'home.sqlite3') });
    const repo = await LoroRepo.create({ storageAdapter: store.storage, metaDebounceCommitMs: 0 });
    workspace = {
      workspaceId: getLanHubWorkspaceId(home.id) as WorkspaceId,
      name: 'Home',
      userId: 'local:home',
      lan: true,
      repo,
      getOnlineMachineIds: async () => new Set([THIS, HOST, OTHER]),
      sync: { markMachineFlockDocDirty: () => {} },
    };
    for (const id of [THIS, HOST, OTHER]) await register(id);
    await register(HOST, { lanHubRole: { capable: true, hosting: true, hubRttMs: 0 } });
    now = START;
    pulls = 0;
    capable = true;
    adopted = [];
    term = 0;
    peerAnswers = [];
    asked = [];
    promoted = [];
    superseded = 0;
    hubHears = false;
  });

  afterEach(async () => {
    await workspace.repo.destroy();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function register(id: MachineId, meta: Partial<MachineMeta> = {}) {
    await workspace.repo.upsertDocMeta(getMachineRoomId(id), {
      id,
      name: id,
      ownerUserId: workspace.userId,
      os: 'linux',
      sessions: [],
      ...meta,
    } as Parameters<LoroRepo['upsertDocMeta']>[1]);
  }
  const roleOf = async (id: MachineId) =>
    ((await workspace.repo.getDocMeta(getMachineRoomId(id)))?.meta as MachineMeta | undefined)
      ?.lanHubRole;

  /** A pull that leaves a copy taken now, as the real one leaves in the directory. */
  const pull = (async ({ directory }: { directory: string }) => {
    pulls += 1;
    const current = path.join(directory, 'current');
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(path.join(current, 'streams.sqlite'), 'copy');
    const kept = {
      takenAt: new Date(now).toISOString(),
      hubUrl: home.url,
      sizeBytes: 4,
      blockBytes: 4,
      blocks: ['0'.repeat(64)],
    };
    fs.writeFileSync(path.join(directory, 'snapshot.json'), JSON.stringify(kept));
    return { ...kept, received: 1 };
  }) as unknown as typeof pullLanHubSnapshot;

  let adopted: Array<{ url: string; term: number; reason: string }>;
  let term: number;
  let peerAnswers: LanHubPeerAnswer[];
  let asked: string[];
  let promoted: Array<{ term: number; copy: string }>;
  let superseded: number;
  let hubHears: boolean;

  const standby = (rtt: number | null = 3) =>
    new LanHubStandby({
      logger: silentLogger(),
      machineId: THIS,
      dataDir: root,
      hubs: () => [home],
      workspaces: () => [workspace],
      adopt: (_hubId, location, reason) => {
        adopted.push({ ...location, reason });
        term = location.term;
        return true;
      },
      termOf: () => term,
      capable: async () => capable,
      hosting: async () => false,
      measure: async () => rtt,
      pull,
      askPeer: (async ({ machineId, request }) => {
        asked.push(`${request.type}:${machineId}`);
        if (request.type === 'moved') return { type: 'moved', followed: true };
        const answer = peerAnswers.shift();
        if (!answer) throw new Error('remote_unreachable');
        return answer;
      }) as typeof askLanHubPeer,
      promote: async ({ copy, term: next, announce }) => {
        promoted.push({ term: next, copy });
        await announce('http://10.0.0.2:8788');
        return 'http://10.0.0.2:8788';
      },
      supersede: async () => {
        superseded += 1;
        return hubHears;
      },
      now: () => now,
    });
  const endpoint = { version: 1 as const, host: '10.0.0.9', port: 8789 };

  it('says it could host the hub, and as the closest such member keeps a copy', async () => {
    await standby().tick();

    expect(pulls).toBe(1);
    expect(await roleOf(THIS)).toEqual({
      capable: true,
      hosting: false,
      hubRttMs: 5,
      snapshotAt: new Date(START).toISOString(),
      term: 0,
    } satisfies LanHubRole);
    expect(fs.existsSync(getLanHubStandbyDirectory(root, home.id))).toBe(true);
  });

  it('refreshes its copy every ten minutes, not on every round', async () => {
    const keeper = standby();
    await keeper.tick();
    now += 5 * 60_000;
    await keeper.tick();
    expect(pulls).toBe(1);
    now += 6 * 60_000;
    await keeper.tick();
    expect(pulls).toBe(2);
  });

  it('leaves the copy to a member that is clearly closer to the hub', async () => {
    await register(OTHER, { lanHubRole: { capable: true, hosting: false, hubRttMs: 1 } });
    await standby(20).tick();

    expect(pulls).toBe(0);
    expect(await roleOf(THIS)).toMatchObject({ hubRttMs: 20 });
  });

  it('says nothing and copies nothing on a machine that could never host', async () => {
    capable = false;
    await standby().tick();

    expect(pulls).toBe(0);
    expect(await roleOf(THIS)).toBeUndefined();
  });

  describe('while the hub is away', () => {
    beforeEach(async () => {
      await register(OTHER, { lanTerminal: endpoint });
      await register(HOST, {
        lanHubRole: { capable: true, hosting: true, hubRttMs: 0 },
        lanTerminal: { ...endpoint, host: '10.0.0.1' },
      });
    });

    /** A keeper that copied the hub, which then goes away for `minutes`. */
    const awayFor = async (minutes: number) => {
      await standby().tick();
      const away = standby(null);
      await away.tick();
      now += minutes * 60_000;
      await away.tick();
      return away;
    };

    it('asks the members after two minutes and follows a later term one of them knows', async () => {
      peerAnswers = [
        { type: 'where', location: { url: home.url, term: 0 }, reachable: false },
        { type: 'where', location: { url: 'http://10.0.0.7:8788', term: 2 }, reachable: true },
      ];
      await awayFor(2);

      expect(adopted).toEqual([
        { url: 'http://10.0.0.7:8788', term: 2, reason: 'a member follows it there' },
      ]);
      expect(promoted).toEqual([]);
    });

    it('takes over from its copy in the next term once nobody reaches the hub', async () => {
      peerAnswers = Array.from({ length: 4 }, () => ({
        type: 'where' as const,
        location: { url: home.url, term: 0 },
        reachable: false,
      }));
      await awayFor(3);

      expect(promoted).toEqual([
        { term: 1, copy: path.join(getLanHubStandbyDirectory(root, home.id), 'current') },
      ]);
      expect(asked).toContain(`moved:${OTHER}`);
      expect(adopted).toEqual([
        { url: 'http://10.0.0.2:8788', term: 1, reason: 'this machine took over' },
      ]);
    });

    it('does not take over while another member still reaches the hub', async () => {
      peerAnswers = Array.from({ length: 4 }, () => ({
        type: 'where' as const,
        location: { url: home.url, term: 0 },
        reachable: true,
      }));
      await awayFor(3);

      expect(promoted).toEqual([]);
      expect(adopted).toEqual([]);
    });

    it('tells the old address until a hub there hears it', async () => {
      await awayFor(3);
      expect(promoted).toHaveLength(1);

      const after = standby();
      await after.tick();
      await after.tick();
      expect(superseded).toBe(2);
      hubHears = true;
      await after.tick();
      await after.tick();
      expect(superseded).toBe(3);
    });
  });

  it('tells a member where it follows the hub and follows one that took over', async () => {
    const handler = standby().peerHandlerFor(getLanHubWorkspaceId(home.id));
    await standby().tick();

    expect(await handler?.where()).toEqual({
      location: { url: home.url, term: 0 },
      reachable: null,
    });
    expect(await handler?.moved({ url: 'http://10.0.0.2:8788', term: 1 })).toBe(true);
    expect(adopted).toEqual([
      { url: 'http://10.0.0.2:8788', term: 1, reason: 'a member says that hub took over' },
    ]);
  });

  it('says round trips in steps, so jitter changes nothing', () => {
    expect([0.4, 3, 7, 8, 12].map(roundLanHubRtt)).toEqual([5, 5, 5, 10, 10]);
    expect(roundLanHubRtt(null)).toBeNull();
  });
});

describe('a hub promoted from a standby copy', () => {
  it("takes from this machine's copy of the credentials only what the standby copy lacks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-promote-'));
    try {
      const hubDir = path.join(root, 'hub');
      const copy = path.join(root, 'copy');
      fs.mkdirSync(hubDir);
      fs.mkdirSync(copy);
      // The standby copy predates the APNs key; its phones are newer than the member's.
      fs.writeFileSync(path.join(hubDir, 'push-devices.json'), '{"devices":["standby"]}');
      for (const [name, content] of [
        ['github.json', '{"token":"github_pat_1"}'],
        ['apns.json', '{"keyId":"ABCDEFGHIJ","teamId":"TEAM123456"}'],
        ['apns-key.p8', 'key'],
        ['push-devices.json', '{"devices":["member"]}'],
      ]) {
        fs.writeFileSync(path.join(copy, name), content as string);
      }

      expect(fillMissingLanHubCredentials(hubDir, copy).sort()).toEqual([
        'apns-key.p8',
        'apns.json',
        'github.json',
      ]);
      expect(fs.readFileSync(path.join(hubDir, 'push-devices.json'), 'utf8')).toContain('standby');
      expect(fs.statSync(path.join(hubDir, 'apns-key.p8')).mode & 0o777).toBe(0o600);
      // Half a key is no key: an APNs pair is taken whole or not at all.
      fs.rmSync(path.join(hubDir, 'apns-key.p8'));
      expect(fillMissingLanHubCredentials(hubDir, copy)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
