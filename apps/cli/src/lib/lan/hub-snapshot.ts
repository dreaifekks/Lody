// A copy of a running hub's data that a standby keeps to take over with. The
// hub backs its database up while it serves (SQLite's online backup, so the
// copy is consistent), and sends only the blocks the standby does not hold
// already: a backup keeps unchanged pages where they were, so after the first
// copy a pull is a small part of the database.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, type Writable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import type { LanHub } from '@lody/shared/node/lan-hub';
import { z } from 'zod';
import { LAN_HUB_HANDOVER_FILES } from './hub-handover';
import { ByteReader } from './lan-files';

export const LAN_HUB_SNAPSHOT_PATH = '/lan/snapshot';
export const LAN_HUB_SNAPSHOT_BLOCK_BYTES = 4 * 1024 * 1024;

const DATABASE_FILE_NAME = 'streams.sqlite';
/** What travels beside the database: everything a hub keeps except the database itself. */
const SIDE_FILES = LAN_HUB_HANDOVER_FILES.filter(
  (name) => !name.startsWith(DATABASE_FILE_NAME)
) as Array<(typeof LAN_HUB_HANDOVER_FILES)[number]>;
const LINE_MAX_BYTES = 1024 * 1024;
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);

const HeaderSchema = z
  .object({
    type: z.literal('snapshot'),
    takenAt: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    blockBytes: z.number().int().positive(),
    blocks: z.array(SHA256),
  })
  .strict();
const BlockSchema = z
  .object({ type: z.literal('block'), index: z.number().int().nonnegative() })
  .strict();
const FileSchema = z
  .object({
    type: z.literal('file'),
    name: z.enum(LAN_HUB_HANDOVER_FILES),
    sizeBytes: z.number().int().nonnegative(),
    sha256: SHA256,
  })
  .strict();
const EndSchema = z.object({ type: z.literal('end') }).strict();
export const LanHubSnapshotRequestSchema = z
  .object({ have: z.array(SHA256).max(1_000_000) })
  .strict();

/** What a standby keeps next to its copy, so the next pull need not read the copy again. */
const KeptSchema = z
  .object({
    takenAt: z.string(),
    hubUrl: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    blockBytes: z.number().int().positive(),
    blocks: z.array(SHA256),
  })
  .strict();
export type LanHubSnapshotKept = z.infer<typeof KeptSchema>;

function writeLine(stream: Writable, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

export async function hashLanHubBlocks(
  filePath: string,
  blockBytes = LAN_HUB_SNAPSHOT_BLOCK_BYTES
): Promise<string[]> {
  const blocks: string[] = [];
  let hash = crypto.createHash('sha256');
  let filled = 0;
  for await (const chunk of fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
    let data = chunk as Buffer;
    while (data.length > 0) {
      const take = Math.min(blockBytes - filled, data.length);
      hash.update(data.subarray(0, take));
      filled += take;
      data = data.subarray(take);
      if (filled === blockBytes) {
        blocks.push(hash.digest('hex'));
        hash = crypto.createHash('sha256');
        filled = 0;
      }
    }
  }
  if (filled > 0) blocks.push(hash.digest('hex'));
  return blocks;
}

async function backUpDatabase(source: string, target: string): Promise<void> {
  const database = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await database.backup(target);
  } finally {
    database.close();
  }
}

async function digest(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Sends a copy of the data of a hub that keeps serving: a header with the
 * digest of every block of a fresh backup, the blocks whose digest differs
 * from what the standby holds, and the hub's other files.
 */
export async function writeLanHubSnapshot(options: {
  dataDir: string;
  have: readonly string[];
  stream: Writable;
  blockBytes?: number;
  backup?: (source: string, target: string) => Promise<void>;
  now?: () => Date;
}): Promise<{ sizeBytes: number; blocks: number; sent: number }> {
  const blockBytes = options.blockBytes ?? LAN_HUB_SNAPSHOT_BLOCK_BYTES;
  // Beside the database, not in a temporary directory that may live in memory.
  const work = await fs.promises.mkdtemp(path.join(options.dataDir, '.snapshot-'));
  try {
    const copy = path.join(work, DATABASE_FILE_NAME);
    const takenAt = (options.now ?? (() => new Date()))().toISOString();
    await (options.backup ?? backUpDatabase)(path.join(options.dataDir, DATABASE_FILE_NAME), copy);
    const { size } = await fs.promises.stat(copy);
    const blocks = await hashLanHubBlocks(copy, blockBytes);
    writeLine(options.stream, { type: 'snapshot', takenAt, sizeBytes: size, blockBytes, blocks });
    let sent = 0;
    for (const [index, block] of blocks.entries()) {
      if (options.have[index] === block) continue;
      writeLine(options.stream, { type: 'block', index });
      const start = index * blockBytes;
      const end = Math.min(size, start + blockBytes) - 1;
      await pipeline(fs.createReadStream(copy, { start, end }), options.stream, { end: false });
      sent += 1;
    }
    for (const name of SIDE_FILES) {
      const filePath = path.join(options.dataDir, name);
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat?.isFile()) continue;
      writeLine(options.stream, {
        type: 'file',
        name,
        sizeBytes: stat.size,
        sha256: await digest(filePath),
      });
      if (stat.size > 0) {
        await pipeline(fs.createReadStream(filePath, { end: stat.size - 1 }), options.stream, {
          end: false,
        });
      }
    }
    writeLine(options.stream, { type: 'end' });
    return { sizeBytes: size, blocks: blocks.length, sent };
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true });
  }
}

const KEPT_FILE_NAME = 'snapshot.json';
const CURRENT = 'current';
const NEXT = 'next';
const PREVIOUS = 'previous';

/** The copy a standby keeps in `directory`, or `null` before its first pull. */
export function readKeptLanHubSnapshot(
  directory: string
): (LanHubSnapshotKept & { path: string }) | null {
  try {
    const kept = KeptSchema.parse(
      JSON.parse(fs.readFileSync(path.join(directory, KEPT_FILE_NAME), 'utf8'))
    );
    const dataDir = path.join(directory, CURRENT);
    const { size } = fs.statSync(path.join(dataDir, DATABASE_FILE_NAME));
    return size === kept.sizeBytes ? { ...kept, path: dataDir } : null;
  } catch {
    return null;
  }
}

/**
 * Brings the copy in `directory` up to the hub's data. The copy is patched
 * beside the current one, checked block by block against the hub's digests,
 * and only then takes the current one's place: a pull that fails leaves the
 * last good copy.
 */
export async function pullLanHubSnapshot(options: {
  hub: Pick<LanHub, 'url' | 'token'>;
  directory: string;
  fetch?: typeof fetch;
}): Promise<LanHubSnapshotKept & { received: number }> {
  const { directory } = options;
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const kept = readKeptLanHubSnapshot(directory);
  const response = await (options.fetch ?? fetch)(`${options.hub.url}${LAN_HUB_SNAPSHOT_PATH}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.hub.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ have: kept?.blocks ?? [] }),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`The hub answered ${response.status} when asked for a copy`);
  }

  const next = path.join(directory, NEXT);
  await fs.promises.rm(next, { recursive: true, force: true });
  await fs.promises.mkdir(next, { mode: 0o700 });
  const database = path.join(next, DATABASE_FILE_NAME);
  if (kept) {
    await fs.promises.copyFile(
      path.join(kept.path, DATABASE_FILE_NAME),
      database,
      fs.constants.COPYFILE_FICLONE
    );
  } else {
    await fs.promises.writeFile(database, '', { mode: 0o600 });
  }

  const reader = new ByteReader(
    Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
    Buffer.alloc(0)
  );
  const readLine = async () => {
    const line = await reader.readLine(LINE_MAX_BYTES);
    if (line === null) throw new Error('The hub stopped sending before it was done');
    return JSON.parse(line) as unknown;
  };

  const header = HeaderSchema.parse(await readLine());
  let received = 0;
  const handle = await fs.promises.open(database, 'r+');
  try {
    for (;;) {
      const value = await readLine();
      if (EndSchema.safeParse(value).success) break;
      const block = BlockSchema.safeParse(value);
      if (block.success) {
        const { index } = block.data;
        if (index >= header.blocks.length) throw new Error('The hub sent a block it did not list');
        const length = Math.min(header.blockBytes, header.sizeBytes - index * header.blockBytes);
        let position = index * header.blockBytes;
        await reader.readBytes(length, async (chunk) => {
          await handle.write(chunk, 0, chunk.length, position);
          position += chunk.length;
        });
        received += 1;
        continue;
      }
      const file = FileSchema.parse(value);
      const target = await fs.promises.open(path.join(next, file.name), 'wx', 0o600);
      const hash = crypto.createHash('sha256');
      try {
        await reader.readBytes(file.sizeBytes, async (chunk) => {
          hash.update(chunk);
          await target.write(chunk);
        });
      } finally {
        await target.close();
      }
      if (hash.digest('hex') !== file.sha256) throw new Error(`${file.name} arrived damaged`);
    }
    await handle.truncate(header.sizeBytes);
  } finally {
    await handle.close();
  }

  const blocks = await hashLanHubBlocks(database, header.blockBytes);
  if (blocks.length !== header.blocks.length || blocks.some((b, i) => b !== header.blocks[i])) {
    await fs.promises.rm(next, { recursive: true, force: true });
    throw new Error('The copy does not match the hub after patching');
  }

  const current = path.join(directory, CURRENT);
  const previous = path.join(directory, PREVIOUS);
  await fs.promises.rm(previous, { recursive: true, force: true });
  if (fs.existsSync(current)) await fs.promises.rename(current, previous);
  await fs.promises.rename(next, current);
  await fs.promises.rm(previous, { recursive: true, force: true });

  const result: LanHubSnapshotKept = {
    takenAt: header.takenAt,
    hubUrl: options.hub.url,
    sizeBytes: header.sizeBytes,
    blockBytes: header.blockBytes,
    blocks: header.blocks,
  };
  const keptPath = path.join(directory, KEPT_FILE_NAME);
  await fs.promises.writeFile(`${keptPath}.tmp`, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  await fs.promises.rename(`${keptPath}.tmp`, keptPath);
  return { ...result, received };
}
