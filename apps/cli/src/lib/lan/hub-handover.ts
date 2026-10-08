// Moving a hub to another machine. The new host asks the current one for its
// data directory; the current one stops its Streams server so the database
// stands still, sends the files, and once the new host runs points every
// member to it. A LAN is its credential, so the moved hub is the same LAN.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { normalizeLanHubUrl } from '@lody/shared/lan-hub';
import type { LanHub } from '@lody/shared/node/lan-hub';
import { z } from 'zod';
import { isLanHubShareFile, receiveFile, writeLanHubShareFiles } from './hub-shares';
import { ByteReader } from './lan-files';

export const LAN_HUB_HANDOVER_PATH = '/lan/handover';
export const LAN_HUB_HANDOVER_COMPLETE_PATH = '/lan/handover/complete';
export const LAN_HUB_HANDOVER_ABORT_PATH = '/lan/handover/abort';
/** Where a hub says whether it still serves its LAN, or where it went. */
export const LAN_HUB_WHERE_PATH = '/lan/where';
/** Where a hub that came back hears that another one took over meanwhile. */
export const LAN_HUB_SUPERSEDED_PATH = '/lan/superseded';

const MOVED_FILE_NAME = 'moved.json';
const HEADER_MAX_BYTES = 4096;

/**
 * What a hub keeps in its data directory and a new host needs. The database
 * goes with its write-ahead log: SQLite reads what the log still holds the
 * next time it opens the two together.
 */
export const LAN_HUB_HANDOVER_FILES = [
  'token',
  'streams.sqlite',
  'streams.sqlite-wal',
  'streams.sqlite-shm',
  'github.json',
  'apns.json',
  'apns-key.p8',
  'push-devices.json',
  'term.json',
] as const;

const TERM_FILE_NAME = 'term.json';

/**
 * How many times the LAN's hub moved, as the hub's data says: a hub that takes
 * over, by handover or failover, serves the next term. Members compare terms
 * to tell where the hub is now from where it was.
 */
export function readLanHubTerm(dataDir: string): number {
  try {
    const { term } = JSON.parse(fs.readFileSync(path.join(dataDir, TERM_FILE_NAME), 'utf8')) as {
      term?: unknown;
    };
    return typeof term === 'number' && Number.isInteger(term) && term >= 0 ? term : 0;
  } catch {
    return 0;
  }
}

export function writeLanHubTerm(dataDir: string, term: number): void {
  const target = path.join(dataDir, TERM_FILE_NAME);
  fs.writeFileSync(`${target}.tmp`, `${JSON.stringify({ term })}\n`, { mode: 0o600 });
  fs.renameSync(`${target}.tmp`, target);
}

const FileHeaderSchema = z
  .object({
    type: z.literal('file'),
    name: z.enum(LAN_HUB_HANDOVER_FILES),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
/** A file of the shares, sent only to a new host that asked for them. */
const ShareFileHeaderSchema = z
  .object({
    type: z.literal('share-file'),
    name: z.string().refine(isLanHubShareFile),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const EndSchema = z.object({ type: z.literal('end'), files: z.number().int() }).strict();

/**
 * Where a hub went, as it tells members who reach its old address: the
 * address signed alone, as builds that know no terms check it, and the term
 * with the address signed together.
 */
export type LanHubMoved = {
  movedTo: string;
  signature: string;
  term?: number;
  termSignature?: string;
};

const MovedSchema = z.object({
  movedTo: z.string().min(1),
  signature: z.string().min(1),
  term: z.number().int().nonnegative().optional(),
  termSignature: z.string().min(1).optional(),
});

function signLanHubLocation(token: string, url: string, term: number): string {
  const key = crypto.createHash('sha256').update(`lody-lan-hub:location:${token}`).digest();
  return crypto
    .createHmac('sha256', key)
    .update(`${term}\n${normalizeLanHubUrl(url)}`)
    .digest('hex');
}

function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Signed with the credential, so only someone who holds it can point members
 * elsewhere: a member then sends the credential to the address it names.
 */
export function signLanHubMove(token: string, movedTo: string): string {
  const key = crypto.createHash('sha256').update(`lody-lan-hub:moved:${token}`).digest();
  return crypto.createHmac('sha256', key).update(normalizeLanHubUrl(movedTo)).digest('hex');
}

export function verifyLanHubMove(token: string, moved: LanHubMoved): boolean {
  if (!sameDigest(signLanHubMove(token, moved.movedTo), moved.signature)) return false;
  if (moved.term === undefined) return moved.termSignature === undefined;
  return (
    moved.termSignature !== undefined &&
    sameDigest(signLanHubLocation(token, moved.movedTo, moved.term), moved.termSignature)
  );
}

export function readLanHubMoved(dataDir: string): LanHubMoved | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dataDir, MOVED_FILE_NAME), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return MovedSchema.parse(JSON.parse(raw));
}

export function writeLanHubMoved(
  dataDir: string,
  token: string,
  movedTo: string,
  term: number
): LanHubMoved {
  const url = normalizeLanHubUrl(movedTo);
  const moved: LanHubMoved = {
    movedTo: url,
    signature: signLanHubMove(token, url),
    term,
    termSignature: signLanHubLocation(token, url, term),
  };
  const target = path.join(dataDir, MOVED_FILE_NAME);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(
    temporary,
    `${JSON.stringify({ ...moved, movedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 }
  );
  fs.renameSync(temporary, target);
  return moved;
}

function writeLine(stream: Writable, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

async function digest(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Sends the files of a data directory that stands still: each as a line that
 * names it, its size and digest, followed by exactly its bytes. The shares
 * follow for a new host that asked for them; one of an older build would
 * refuse their lines.
 */
export async function writeLanHubHandover(
  dataDir: string,
  stream: Writable,
  options: { shares?: boolean } = {}
): Promise<number> {
  let count = 0;
  for (const name of LAN_HUB_HANDOVER_FILES) {
    const filePath = path.join(dataDir, name);
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat?.isFile()) continue;
    writeLine(stream, {
      type: 'file',
      name,
      sizeBytes: stat.size,
      sha256: await digest(filePath),
    });
    if (stat.size > 0) {
      await pipeline(fs.createReadStream(filePath, { end: stat.size - 1 }), stream, {
        end: false,
      });
    }
    count += 1;
  }
  if (options.shares) {
    count += await writeLanHubShareFiles(dataDir, stream, 'share-file');
  }
  writeLine(stream, { type: 'end', files: count });
  return count;
}

/**
 * Writes what a hub sent into `directory`, which must be empty, and checks
 * every file against its digest. Returns the names it wrote.
 */
export async function readLanHubHandover(stream: Readable, directory: string): Promise<string[]> {
  const reader = new ByteReader(stream, Buffer.alloc(0));
  const written: string[] = [];
  for (;;) {
    const line = await reader.readLine(HEADER_MAX_BYTES);
    if (line === null) throw new Error('The hub stopped sending before it was done');
    const value: unknown = JSON.parse(line);
    const end = EndSchema.safeParse(value);
    if (end.success) {
      if (end.data.files !== written.length)
        throw new Error('The hub sent fewer files than it said');
      if (!written.includes('token')) throw new Error('The hub sent no credential');
      return written;
    }
    const share = ShareFileHeaderSchema.safeParse(value);
    if (share.success) {
      if (written.includes(share.data.name))
        throw new Error(`The hub sent ${share.data.name} twice`);
      await receiveFile(reader, path.join(directory, share.data.name), share.data);
      written.push(share.data.name);
      continue;
    }
    const header = FileHeaderSchema.parse(value);
    if (written.includes(header.name)) throw new Error(`The hub sent ${header.name} twice`);
    const target = path.join(directory, header.name);
    const handle = await fs.promises.open(target, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    try {
      await reader.readBytes(header.sizeBytes, async (chunk) => {
        hash.update(chunk);
        await handle.write(chunk);
      });
    } finally {
      await handle.close();
    }
    if (hash.digest('hex') !== header.sha256) throw new Error(`${header.name} arrived damaged`);
    written.push(header.name);
  }
}

/**
 * Asks a hub whether it still serves its LAN. Returns the address it moved
 * to, and the term of the hub there, when it says so with the credential's
 * signature; `null` otherwise: a hub that is away has not moved.
 */
export async function askWhereLanHubIs(
  hub: Pick<LanHub, 'url' | 'token'>,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<{ url: string; term: number | null } | null> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${hub.url}${LAN_HUB_WHERE_PATH}`, {
      headers: { Authorization: `Bearer ${hub.token}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    return null;
  }
  if (response.status !== 200 && response.status !== 410) return null;
  const parsed = MovedSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success || !verifyLanHubMove(hub.token, parsed.data)) return null;
  const movedTo = normalizeLanHubUrl(parsed.data.movedTo);
  if (movedTo === normalizeLanHubUrl(hub.url)) return null;
  // A hub of a build without terms says none; whatever it points to is later.
  return { url: movedTo, term: parsed.data.term ?? null };
}
