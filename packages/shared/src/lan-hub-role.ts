/**
 * What a member of a LAN says about its part in keeping the hub: whether it
 * could host it, whether it does, how far it is from it, and whether it keeps
 * a copy of the hub's data to take over with. Every member reads what every
 * other one says and chooses the same standby from it.
 */
export type LanHubRole = {
  /** This machine runs services and the Streams server: it could host the hub. */
  capable: boolean;
  /** This machine hosts the hub now. */
  hosting: boolean;
  /** The round trip to the hub, in milliseconds; `null` when it did not answer. */
  hubRttMs: number | null;
  /** When the copy of the hub's data this machine keeps was taken (ISO 8601). */
  snapshotAt?: string;
  /** The term of the hub as this machine knows it: how often the hub moved. */
  term?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseLanHubRole(value: unknown): LanHubRole | null {
  if (!isRecord(value)) return null;
  const { capable, hosting, hubRttMs, snapshotAt, term } = value;
  if (typeof capable !== 'boolean' || typeof hosting !== 'boolean') return null;
  if (hubRttMs !== null && (typeof hubRttMs !== 'number' || !Number.isFinite(hubRttMs))) {
    return null;
  }
  const role: LanHubRole = { capable, hosting, hubRttMs: hubRttMs === null ? null : hubRttMs };
  if (typeof snapshotAt === 'string' && Number.isFinite(Date.parse(snapshotAt))) {
    role.snapshotAt = snapshotAt;
  }
  if (typeof term === 'number' && Number.isInteger(term) && term >= 0) role.term = term;
  return role;
}

export function sameLanHubRole(left: LanHubRole | null, right: LanHubRole | null): boolean {
  if (!left || !right) return !left && !right;
  return (
    left.capable === right.capable &&
    left.hosting === right.hosting &&
    left.hubRttMs === right.hubRttMs &&
    left.snapshotAt === right.snapshotAt &&
    left.term === right.term
  );
}

/** A copy older than this no longer makes its keeper the standby by itself. */
export const LAN_HUB_SNAPSHOT_FRESH_MS = 30 * 60_000;
/** Another candidate replaces a standby only when it is clearly closer to the hub. */
const CLOSER_FACTOR = 0.7;

export type LanHubCandidate = {
  machineId: string;
  online: boolean;
  role: LanHubRole | null;
};

/**
 * The member that keeps a copy of the hub's data, chosen the same way by
 * every member from what all of them say: an online member that could host
 * the hub and does not, the one closest to the hub. One that already keeps a
 * fresh copy stays the standby unless another is clearly closer, so the
 * choice does not move with every measurement. `null` when nobody qualifies.
 */
export function chooseLanHubStandby(
  candidates: readonly LanHubCandidate[],
  now: number
): string | null {
  const eligible = candidates.filter(
    (candidate) => candidate.online && candidate.role?.capable && !candidate.role.hosting
  );
  if (eligible.length === 0) return null;
  const rtt = (candidate: LanHubCandidate) => candidate.role?.hubRttMs ?? Number.POSITIVE_INFINITY;
  const [closest] = [...eligible].sort(
    (left, right) => rtt(left) - rtt(right) || left.machineId.localeCompare(right.machineId)
  );
  const keepers = eligible
    .filter((candidate) => {
      const at = Date.parse(candidate.role?.snapshotAt ?? '');
      return Number.isFinite(at) && now - at <= LAN_HUB_SNAPSHOT_FRESH_MS;
    })
    .sort((left, right) => left.machineId.localeCompare(right.machineId));
  const keeper = keepers[0];
  if (keeper && closest && !(rtt(closest) < rtt(keeper) * CLOSER_FACTOR)) {
    return keeper.machineId;
  }
  return closest?.machineId ?? null;
}

/** What a machine does for its LAN's hub, as a member shows it. */
export type LanHubPart = 'hub' | 'standby' | 'candidate';

/**
 * A machine's part from what it said about itself. A standby is told by a
 * fresh copy: every member keeps choosing the one that holds it.
 */
export function describeLanHubPart(role: LanHubRole | null, now: number): LanHubPart | null {
  if (!role?.capable) return null;
  if (role.hosting) return 'hub';
  const at = Date.parse(role.snapshotAt ?? '');
  return Number.isFinite(at) && now - at <= LAN_HUB_SNAPSHOT_FRESH_MS ? 'standby' : 'candidate';
}
