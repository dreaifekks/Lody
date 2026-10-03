// The part an agent service plays in keeping its LANs' hubs.
//
// Every member watches its hubs, and one that cannot reach a hub for a while
// asks the other members, over their direct connections, where the hub is.
//
// A machine that could host a hub says so, with how far it is from it, and
// every member chooses the same standby from what all of them say. The
// standby keeps a copy of the hub's data, refreshed every few minutes. When
// the hub stays away and no member reaches it either, the standby starts a
// hub from its copy in the next term, tells the members, and keeps telling
// the old address until a hub there hears that it was superseded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseLanHubStandby, type LanHubRole } from '@lody/shared/lan-hub-role';
import { getLanHubWorkspaceId, normalizeLanHubUrl } from '@lody/shared/lan-hub';
import type { LanTerminalEndpoint } from '@lody/shared/lan-terminal';
import { measureLanHubLatency, type LanHub } from '@lody/shared/node/lan-hub';
import type { MachineId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { prepareLanHubFailover } from './hub-failover';
import {
  LAN_HUB_SUPERSEDED_PATH,
  readLanHubMoved,
  readLanHubTerm,
  writeLanHubTerm,
} from './hub-handover';
import { getDefaultLanHubDataDir, isLanHubServerInstalled, readLanHubToken } from './hub-server';
import { pullLanHubSnapshot, readKeptLanHubSnapshot } from './hub-snapshot';
import { hostLan, pickLanHostAddress } from './lan-host';
import {
  askLanHubPeer,
  type LanHubLocation,
  type LanHubPeerAnswer,
  type LanHubPeerHandler,
} from './lan-hub-peers';
import { publishLanHubRole, readLanHubCandidates, type LanMemberWorkspace } from './lan-members';
import { deriveLanTerminalKey } from './lan-terminal';
import { LanServiceManager, resolveLanServiceCommand } from './service';

const TICK_MS = 60_000;
const SNAPSHOT_INTERVAL_MS = 10 * 60_000;
/** A member that has not reached its hub for this long asks the others where it is. */
const ASK_PEERS_AFTER_MS = 2 * 60_000;
/** The standby takes over once the hub has been away this long and nobody reaches it. */
const FAILOVER_AFTER_MS = 3 * 60_000;
/** Round trips are said in steps of this many milliseconds, so jitter writes nothing. */
const RTT_STEP_MS = 5;
const PEER_TIMEOUT_MS = 8_000;
const FENCE_FILE_NAME = 'fence.json';

export function roundLanHubRtt(rttMs: number | null): number | null {
  return rttMs === null
    ? null
    : Math.max(RTT_STEP_MS, Math.round(rttMs / RTT_STEP_MS) * RTT_STEP_MS);
}

/** Where a standby keeps its copy of one LAN's hub. */
export function getLanHubStandbyDirectory(dataDir: string, hubId: string): string {
  return path.join(dataDir, 'lan-standby', hubId);
}

/**
 * Whether this machine could host a hub: a server whose agent service the
 * install script set up, with user services and the Streams server.
 * `LODY_LAN_STANDBY=off` keeps a machine out of it.
 */
export async function canThisMachineHostLanHub(options: {
  update: string;
  services?: LanServiceManager;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  if ((options.env ?? process.env).LODY_LAN_STANDBY?.trim().toLowerCase() === 'off') return false;
  if (options.update !== 'service' || !isLanHubServerInstalled()) return false;
  return await (options.services ?? new LanServiceManager()).isAvailable();
}

/** Whether this machine hosts that hub now: the hub service runs with its credential. */
export async function doesThisMachineHostLanHub(
  hub: LanHub,
  options: { dataDir?: string; services?: LanServiceManager } = {}
): Promise<boolean> {
  const dataDir = options.dataDir ?? getDefaultLanHubDataDir();
  if (readLanHubToken(dataDir) !== hub.token) return false;
  if (readLanHubMoved(dataDir)) return false;
  return (await (options.services ?? new LanServiceManager()).getState('hub')).active;
}

/**
 * Starts a hub on this machine from a standby's copy, in `term`. `announce`
 * runs once the hub answers and before this machine follows it, which
 * restarts the agent service.
 */
export async function promoteToLanHub(options: {
  hub: LanHub;
  copy: string;
  term: number;
  announce: (url: string) => Promise<void>;
  services?: LanServiceManager;
  dataDir?: string;
}): Promise<string> {
  const dataDir = options.dataDir ?? getDefaultLanHubDataDir();
  const existing = readLanHubToken(dataDir);
  if (existing && existing !== options.hub.token) {
    throw new Error(`${dataDir} holds another LAN`);
  }
  if (fs.existsSync(dataDir)) fs.renameSync(dataDir, `${dataDir}.replaced-${Date.now()}`);
  fs.cpSync(options.copy, dataDir, { recursive: true });
  prepareLanHubFailover(dataDir);
  writeLanHubTerm(dataDir, options.term);

  const host = pickLanHostAddress(os.networkInterfaces());
  if (!host) throw new Error('This machine has no private address to host the hub on');
  const port = Number(new URL(options.hub.url).port) || 8788;
  let announced = '';
  await hostLan(
    {
      name: null,
      host,
      port,
      dataDir,
      withAgent: false,
      beforeJoin: async (url) => {
        announced = url;
        await options.announce(url);
      },
    },
    {
      services: options.services ?? new LanServiceManager(),
      command: resolveLanServiceCommand(),
      searchPath: process.env.PATH ?? '',
      waitFor: async (condition, description) => {
        const deadline = Date.now() + 30_000;
        while (!(await condition())) {
          if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      },
    }
  );
  return announced;
}

export type LanHubStandbyOptions = {
  logger: Logger;
  machineId: MachineId;
  dataDir: string;
  hubs: () => readonly LanHub[];
  workspaces: () => LanMemberWorkspace[];
  /** Follows a LAN's hub to where it is now; whether the settings changed. */
  adopt: (hubId: string, location: LanHubLocation, reason: string) => boolean;
  termOf: (hubId: string) => number;
  /** Whether this machine could host a hub; asked once. */
  capable: () => Promise<boolean>;
  /** Whether this machine hosts that hub now. */
  hosting: (hub: LanHub) => Promise<boolean>;
  measure?: (hub: LanHub) => Promise<number | null>;
  pull?: typeof pullLanHubSnapshot;
  askPeer?: typeof askLanHubPeer;
  promote?: typeof promoteToLanHub;
  supersede?: (oldUrl: string, hub: LanHub, location: LanHubLocation) => Promise<boolean>;
  now?: () => number;
  tickMs?: number;
  snapshotIntervalMs?: number;
  failoverAfterMs?: number;
};

type Watch = { reachable: boolean | null; awaySince: number | null };
type Peer = { machineId: string; endpoint: LanTerminalEndpoint };

export class LanHubStandby {
  private timer: NodeJS.Timeout | null = null;
  private capable: Promise<boolean> | null = null;
  private running: Promise<void> | null = null;
  private readonly watches = new Map<string, Watch>();
  private closed = false;

  constructor(private readonly options: LanHubStandbyOptions) {}

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One round over every LAN; a round still running is not started twice. */
  tick(): Promise<void> {
    this.running ??= this.round().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** How this machine answers the other members about one LAN's hub. */
  peerHandlerFor(workspaceId: string): LanHubPeerHandler | null {
    const hub = this.hubOf(workspaceId);
    if (!hub) return null;
    return {
      where: async () => ({
        location: { url: hub.url, term: this.options.termOf(hub.id) },
        reachable: this.watches.get(hub.id)?.reachable ?? null,
      }),
      moved: async (location) => {
        if (this.options.adopt(hub.id, location, 'a member says that hub took over')) return true;
        return normalizeLanHubUrl(location.url) === normalizeLanHubUrl(hub.url);
      },
    };
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private hubOf(workspaceId: string): LanHub | null {
    return this.options.hubs().find((hub) => getLanHubWorkspaceId(hub.id) === workspaceId) ?? null;
  }

  private async round(): Promise<void> {
    this.capable ??= this.options.capable().catch(() => false);
    const capable = await this.capable;
    for (const workspace of this.options.workspaces()) {
      if (this.closed) return;
      if (!workspace.lan) continue;
      const hub = this.hubOf(workspace.workspaceId);
      if (!hub) continue;
      try {
        await this.keep(hub, workspace, capable);
      } catch (error) {
        this.options.logger.debug(`[standby] ${hub.name}: ${formatErrorMessage(error)}`);
      }
    }
  }

  private async keep(hub: LanHub, workspace: LanMemberWorkspace, capable: boolean): Promise<void> {
    const { machineId } = this.options;
    const now = this.now();
    const directory = getLanHubStandbyDirectory(this.options.dataDir, hub.id);
    await this.fence(hub, directory);

    const hosting = capable && (await this.options.hosting(hub));
    const rtt = hosting
      ? 0
      : roundLanHubRtt(await (this.options.measure ?? measureLanHubLatency)(hub));
    const watch = this.watches.get(hub.id) ?? { reachable: null, awaySince: null };
    watch.reachable = rtt !== null;
    watch.awaySince = rtt !== null ? null : (watch.awaySince ?? now);
    this.watches.set(hub.id, watch);

    const candidates = await readLanHubCandidates(workspace);
    const peers: Peer[] = candidates.flatMap((candidate) =>
      candidate.machineId !== machineId && candidate.endpoint
        ? [{ machineId: candidate.machineId, endpoint: candidate.endpoint }]
        : []
    );
    const away = watch.awaySince === null ? 0 : now - watch.awaySince;
    let answers: LanHubPeerAnswer[] = [];
    if (away >= ASK_PEERS_AFTER_MS) {
      answers = await this.askPeers(hub, peers, { type: 'where' });
      if (this.followPeers(hub, answers)) return;
    }

    if (!capable) return;
    let kept = readKeptLanHubSnapshot(directory);
    const role = (): LanHubRole => ({
      capable: true,
      hosting,
      hubRttMs: rtt,
      ...(kept && !hosting ? { snapshotAt: kept.takenAt } : {}),
    });
    await publishLanHubRole({ workspace, machineId, role: role() });

    // Who is online is what the hub says. While it is away nobody can say,
    // and every member chooses from what the candidates said about themselves.
    const voters = await readLanHubCandidates(workspace);
    const chosen = chooseLanHubStandby(
      rtt === null ? voters.map((candidate) => ({ ...candidate, online: true })) : voters,
      now
    );
    if (chosen !== machineId || hosting) return;

    if (rtt !== null) {
      const age = kept ? now - Date.parse(kept.takenAt) : Number.POSITIVE_INFINITY;
      if (age < (this.options.snapshotIntervalMs ?? SNAPSHOT_INTERVAL_MS)) return;
      const started = this.now();
      const pulled = await (this.options.pull ?? pullLanHubSnapshot)({ hub, directory });
      kept = readKeptLanHubSnapshot(directory);
      this.options.logger.info(
        `[standby] Copied ${hub.name}: ${pulled.received} of ${pulled.blocks.length} block(s) in ${
          this.now() - started
        } ms.`
      );
      await publishLanHubRole({ workspace, machineId, role: role() });
      return;
    }

    if (!kept || away < (this.options.failoverAfterMs ?? FAILOVER_AFTER_MS)) return;
    if (answers.some((answer) => answer.type === 'where' && answer.reachable === true)) {
      this.options.logger.info(
        `[standby] ${hub.name} is away from here, and another member still reaches it; not taking over.`
      );
      return;
    }
    await this.takeOver(hub, kept.path, kept.takenAt, peers, directory);
  }

  private async askPeers(
    hub: LanHub,
    peers: readonly Peer[],
    request: Parameters<typeof askLanHubPeer>[0]['request']
  ): Promise<LanHubPeerAnswer[]> {
    const ask = this.options.askPeer ?? askLanHubPeer;
    const key = deriveLanTerminalKey(hub.token);
    const settled = await Promise.allSettled(
      peers.map((peer) =>
        ask({
          endpoint: peer.endpoint,
          lanId: hub.id,
          key,
          machineId: peer.machineId,
          request,
          timeoutMs: PEER_TIMEOUT_MS,
        })
      )
    );
    return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  }

  /** Follows the latest term a member knows; whether this machine now follows another address. */
  private followPeers(hub: LanHub, answers: readonly LanHubPeerAnswer[]): boolean {
    const latest = answers
      .flatMap((answer) => (answer.type === 'where' ? [answer.location] : []))
      .sort((left, right) => right.term - left.term || left.url.localeCompare(right.url))[0];
    if (!latest || latest.term <= this.options.termOf(hub.id)) return false;
    return this.options.adopt(hub.id, latest, 'a member follows it there');
  }

  private async takeOver(
    hub: LanHub,
    copy: string,
    takenAt: string,
    peers: readonly Peer[],
    directory: string
  ): Promise<void> {
    const term = Math.max(readLanHubTerm(copy), this.options.termOf(hub.id)) + 1;
    this.options.logger.warn(
      `[standby] ${hub.name} has been away and no member reaches it; taking over in term ${term} from the copy of ${takenAt}.`
    );
    await (this.options.promote ?? promoteToLanHub)({
      hub,
      copy,
      term,
      announce: async (url) => {
        const location = { url, term };
        // Before anything else: the agent service starts again once it follows.
        fs.writeFileSync(
          path.join(directory, FENCE_FILE_NAME),
          `${JSON.stringify({ oldUrl: hub.url, location })}\n`,
          { mode: 0o600 }
        );
        const answers = await this.askPeers(hub, peers, { type: 'moved', location });
        const told = answers.filter((answer) => answer.type === 'moved' && answer.followed).length;
        this.options.logger.info(`[standby] ${told} of ${peers.length} member(s) follow ${url}.`);
        this.options.adopt(hub.id, location, 'this machine took over');
      },
    });
  }

  /** Tells the address the hub had before a takeover, until a hub there has heard it. */
  private async fence(hub: LanHub, directory: string): Promise<void> {
    const file = path.join(directory, FENCE_FILE_NAME);
    let fence: { oldUrl: string; location: LanHubLocation };
    try {
      fence = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof fence;
    } catch {
      return;
    }
    const supersede = this.options.supersede ?? supersedeLanHub;
    if (await supersede(fence.oldUrl, hub, fence.location)) {
      fs.rmSync(file, { force: true });
      this.options.logger.info(
        `[standby] The hub at ${fence.oldUrl} now points to ${fence.location.url}.`
      );
    }
  }
}

/** Tells a hub that came back that another one serves its LAN; whether it heard it. */
async function supersedeLanHub(
  oldUrl: string,
  hub: LanHub,
  location: LanHubLocation
): Promise<boolean> {
  try {
    const response = await fetch(`${oldUrl}${LAN_HUB_SUPERSEDED_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hub.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(location),
      signal: AbortSignal.timeout(10_000),
    });
    // A hub of a build without terms cannot hear it; nothing more can be said to it.
    return response.ok || response.status === 404 || response.status === 409;
  } catch {
    return false;
  }
}
