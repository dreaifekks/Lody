// A hub that starts from a standby's copy, after the hub it replaces went
// away. The copy may be minutes behind what that hub served, and a member that
// read past the copy's end would resume where the copy has other bytes: it
// would read entries out of place and never send again what only it and the
// lost hub had. So before the new hub serves, every CRDT stream of the copy
// continues at a base offset that no earlier hub reached, and the gate turns
// a read that names an offset from before the base away with 410. A client
// that hears 410 bootstraps again and sends what the hub lacks.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';

const EPOCH_FILE_NAME = 'epoch.json';
const DATABASE_FILE_NAME = 'streams.sqlite';
/** Room for what the lost hub may have written after the copy: far more than ever happens. */
const HEADROOM = 2 ** 40;
const BASE_STEP = 1e12;
/**
 * Only binary streams continue at the base. A JSON stream must be read at
 * a message boundary, which the base is not; JSON streams are the short-lived
 * request streams, whose clients start reading at the tail.
 */
const CRDT_CONTENT_TYPE = 'application/octet-stream';

const EpochSchema = z
  .object({ base: z.number().int().positive(), streams: z.array(z.string()) })
  .strict();
export type LanHubEpoch = { base: number; streams: ReadonlySet<string> };

export function readLanHubEpoch(dataDir: string): LanHubEpoch | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dataDir, EPOCH_FILE_NAME), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = EpochSchema.parse(JSON.parse(raw));
  return { base: parsed.base, streams: new Set(parsed.streams) };
}

/**
 * Makes the copy in `dataDir` safe to serve after a failover. The hub must
 * not be running on it. Returns the base every CRDT stream continues at.
 */
export function prepareLanHubFailover(dataDir: string): { base: number; streams: number } {
  const database = new Database(path.join(dataDir, DATABASE_FILE_NAME), { fileMustExist: true });
  try {
    const { highest } = database
      .prepare('SELECT COALESCE(MAX(next_offset), 0) AS highest FROM streams')
      .get() as { highest: number };
    const base = Math.ceil((highest + HEADROOM) / BASE_STEP) * BASE_STEP;
    const streams = (
      database
        .prepare('SELECT stream_id FROM streams WHERE content_type = ?')
        .all(CRDT_CONTENT_TYPE) as Array<{ stream_id: string }>
    ).map((row) => row.stream_id);
    database
      .prepare('UPDATE streams SET next_offset = ? WHERE content_type = ?')
      .run(base, CRDT_CONTENT_TYPE);
    // Fold the write-ahead log in, so the copy is one file again.
    database.pragma('wal_checkpoint(TRUNCATE)');
    const target = path.join(dataDir, EPOCH_FILE_NAME);
    fs.writeFileSync(`${target}.tmp`, `${JSON.stringify({ base, streams })}\n`, { mode: 0o600 });
    fs.renameSync(`${target}.tmp`, target);
    return { base, streams: streams.length };
  } finally {
    database.close();
  }
}

const READ_PATH = /^\/ds\/[^/]+\/([^/?]+)$/u;
const OFFSET = /^\d{1,20}$/u;

/**
 * Whether a request reads a stream of the copy from an offset of an earlier
 * hub. Bootstraps, reads from the start or the tail, and writes pass.
 */
export function readsBeforeLanHubEpoch(
  epoch: LanHubEpoch,
  method: string | undefined,
  requestUrl: string | undefined
): boolean {
  if ((method !== 'GET' && method !== 'HEAD') || !requestUrl) return false;
  const url = new URL(requestUrl, 'http://hub.invalid');
  const match = READ_PATH.exec(url.pathname);
  const offset = url.searchParams.get('offset');
  if (!match?.[1] || !offset || !OFFSET.test(offset)) return false;
  let streamId: string;
  try {
    streamId = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  return epoch.streams.has(streamId) && Number(offset) < epoch.base;
}
