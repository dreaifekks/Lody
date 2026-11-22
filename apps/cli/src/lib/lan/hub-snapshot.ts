// A copy of a running hub's data that a standby keeps to take over with. The
// hub copies a consistent database image to disk beside its database and sends
// only changed blocks. The standby stages and checks them before patching its
// database.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, type Writable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import type { LanHub } from '@lody/shared/node/lan-hub';
import { z } from 'zod';
import { LAN_HUB_ALL_HANDOVER_FILES, LAN_HUB_HANDOVER_FILES } from './hub-handover';
import { pullLanHubSharesCopy } from './hub-shares';
import { ByteReader } from './lan-files';

export const LAN_HUB_SNAPSHOT_PATH = '/lan/snapshot';
export const LAN_HUB_SNAPSHOT_BLOCK_BYTES = 64 * 1024;

const DATABASE_FILE_NAME = 'streams.sqlite';
/** Where the hub keeps the image it sends while a standby takes it. */
const COPY_DIRECTORY_NAME = '.standby-copy';
/** Pages one backup step copies: a few milliseconds of the hub's event loop. */
const COPY_PAGES_PER_STEP = 1024;
/** What travels beside the database: baseline files for older receivers, plus credential files when requested. */
const BASE_SIDE_FILES = LAN_HUB_HANDOVER_FILES.filter(
  (name) => !name.startsWith(DATABASE_FILE_NAME)
) as Array<(typeof LAN_HUB_HANDOVER_FILES)[number]>;
const ALL_SIDE_FILES = LAN_HUB_ALL_HANDOVER_FILES.filter(
  (name) => !name.startsWith(DATABASE_FILE_NAME)
) as Array<(typeof LAN_HUB_ALL_HANDOVER_FILES)[number]>;
const MAX_BLOCKS = 1_000_000;
// Each SHA-256 occupies 67 JSON bytes, plus room for the header fields.
const LINE_MAX_BYTES = MAX_BLOCKS * 67 + 1024;
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
    name: z.enum(LAN_HUB_ALL_HANDOVER_FILES),
    sizeBytes: z.number().int().nonnegative(),
    sha256: SHA256,
  })
  .strict();
const EndSchema = z.object({ type: z.literal('end') }).strict();
export const LanHubSnapshotRequestSchema = z
  .object({ have: z.array(SHA256).max(MAX_BLOCKS) })
  .strict();

/** Expected block digests for validating the kept copy and requesting the next delta. */
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

function line(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

export async function hashLanHubBlocks(
  filePath: string,
  blockBytes = LAN_HUB_SNAPSHOT_BLOCK_BYTES,
  range?: { start: number; end: number }
): Promise<string[]> {
  const blocks: string[] = [];
  let hash = crypto.createHash('sha256');
  let filled = 0;
  for await (const chunk of fs.createReadStream(filePath, {
    ...range,
    highWaterMark: 1024 * 1024,
  })) {
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

/**
 * Copies the database page by page into `target`. The read transaction held on
 * the source keeps every backup step on one snapshot: the hub's writes
 * meanwhile neither restart the copy nor mix two moments into it, and no step
 * holds the event loop for long. Without it, a hub that writes every few
 * seconds restarts the copy before it ever finishes.
 */
async function copyDatabase(source: string, target: string): Promise<void> {
  const database = new Database(source, { readonly: true, fileMustExist: true });
  try {
    database.exec('BEGIN');
    database.prepare('SELECT count(*) FROM sqlite_schema').get();
    await database.backup(target, { progress: () => COPY_PAGES_PER_STEP });
  } finally {
    database.close();
  }
}

/**
 * Sends a consistent image and side files through one owned pipeline. The
 * image goes through a file on disk: no more than a block of it is in memory.
 */
export async function writeLanHubSnapshot(options: {
  dataDir: string;
  have: readonly string[];
  stream: Writable;
  blockBytes?: number;
  credentials?: boolean;
  now?: () => Date;
}): Promise<{ sizeBytes: number; blocks: number; sent: number }> {
  const blockBytes = options.blockBytes ?? LAN_HUB_SNAPSHOT_BLOCK_BYTES;
  const result = { sizeBytes: 0, blocks: 0, sent: 0 };
  const directory = path.join(options.dataDir, COPY_DIRECTORY_NAME);
  async function* chunks(): AsyncGenerator<Buffer> {
    const takenAt = (options.now ?? (() => new Date()))().toISOString();
    const copy = path.join(directory, DATABASE_FILE_NAME);
    // What a hub that stopped in the middle of a copy left behind.
    await fs.promises.rm(directory, { recursive: true, force: true });
    await fs.promises.mkdir(directory, { mode: 0o700 });
    try {
      await copyDatabase(path.join(options.dataDir, DATABASE_FILE_NAME), copy);
      const blocks = await hashLanHubBlocks(copy, blockBytes);
      const { size } = await fs.promises.stat(copy);
      result.sizeBytes = size;
      result.blocks = blocks.length;
      yield line({ type: 'snapshot', takenAt, sizeBytes: size, blockBytes, blocks });
      const handle = await fs.promises.open(copy, 'r');
      try {
        for (const [index, block] of blocks.entries()) {
          if (options.have[index] === block) continue;
          const { buffer, bytesRead } = await handle.read(
            Buffer.allocUnsafe(blockBytes),
            0,
            blockBytes,
            index * blockBytes
          );
          yield line({ type: 'block', index });
          yield buffer.subarray(0, bytesRead);
          result.sent += 1;
        }
      } finally {
        await handle.close();
      }
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
    for (const name of options.credentials ? ALL_SIDE_FILES : BASE_SIDE_FILES) {
      const filePath = path.join(options.dataDir, name);
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat?.isFile()) continue;
      const data = await fs.promises.readFile(filePath);
      yield line({
        type: 'file',
        name,
        sizeBytes: data.length,
        sha256: crypto.createHash('sha256').update(data).digest('hex'),
      });
      if (data.length > 0) yield data;
    }
    yield line({ type: 'end' });
  }
  await pipeline(Readable.from(chunks()), options.stream);
  return result;
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

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Stages verified changed blocks and side files before touching the current copy.
 * Once patching begins, snapshot.json stays absent until the whole image matches:
 * a crash or write failure forces a full pull and cannot promote a partial copy.
 */
export async function pullLanHubSnapshot(options: {
  hub: Pick<LanHub, 'url' | 'token'>;
  directory: string;
  fetch?: typeof fetch;
}): Promise<LanHubSnapshotKept & { received: number }> {
  const { directory } = options;
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const keptPath = path.join(directory, KEPT_FILE_NAME);
  let kept = readKeptLanHubSnapshot(directory);
  if (kept) {
    const blocks = await hashLanHubBlocks(
      path.join(kept.path, DATABASE_FILE_NAME),
      kept.blockBytes
    );
    const expected = kept.blocks;
    if (
      blocks.length !== expected.length ||
      blocks.some((block, index) => block !== expected[index])
    ) {
      await fs.promises.rm(keptPath);
      await syncDirectory(directory);
      kept = null;
    }
  }
  const response = await (options.fetch ?? fetch)(
    `${options.hub.url}${LAN_HUB_SNAPSHOT_PATH}?credentials=1`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.hub.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ have: kept?.blocks ?? [] }),
      signal: AbortSignal.timeout(10 * 60_000),
    }
  );
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`The hub answered ${response.status} when asked for a copy`);
  }

  const source = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
  const next = path.join(directory, NEXT);
  try {
    await fs.promises.rm(next, { recursive: true, force: true });
    await fs.promises.mkdir(next, { mode: 0o700 });
    const database = path.join(next, DATABASE_FILE_NAME);
    const patch = kept ? path.join(next, 'blocks') : database;
    const reader = new ByteReader(source, Buffer.alloc(0));
    const readLine = async () => {
      const value = await reader.readLine(LINE_MAX_BYTES);
      if (value === null) throw new Error('The hub stopped sending before it was done');
      return JSON.parse(value) as unknown;
    };
    const header = HeaderSchema.parse(await readLine());
    const changed = new Map<number, { offset: number; length: number }>();
    let received = 0;
    let offset = 0;
    const handle = await fs.promises.open(patch, 'wx', 0o600);
    try {
      for (;;) {
        const value = await readLine();
        if (EndSchema.safeParse(value).success) break;
        const block = BlockSchema.safeParse(value);
        if (block.success) {
          const { index } = block.data;
          if (index >= header.blocks.length)
            throw new Error('The hub sent a block it did not list');
          const length = Math.min(header.blockBytes, header.sizeBytes - index * header.blockBytes);
          const start = kept ? offset : index * header.blockBytes;
          let position = start;
          const hash = crypto.createHash('sha256');
          await reader.readBytes(length, async (chunk) => {
            hash.update(chunk);
            await handle.write(chunk, 0, chunk.length, position);
            position += chunk.length;
          });
          if (hash.digest('hex') !== header.blocks[index]) {
            throw new Error(`Block ${index} does not match the hub`);
          }
          changed.set(index, { offset: start, length });
          offset += length;
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
      if (!kept) {
        await handle.truncate(header.sizeBytes);
        await handle.datasync();
      }
    } finally {
      await handle.close();
    }
    if (
      header.blocks.length !== Math.ceil(header.sizeBytes / header.blockBytes) ||
      header.blocks.some(
        (hash, index) =>
          !changed.has(index) &&
          (kept?.blockBytes !== header.blockBytes || kept.blocks[index] !== hash)
      )
    ) {
      throw new Error('The hub did not send every changed block');
    }

    if (!kept) {
      const blocks = await hashLanHubBlocks(database, header.blockBytes);
      if (blocks.length !== header.blocks.length || blocks.some((b, i) => b !== header.blocks[i])) {
        throw new Error('The copy does not match the hub after patching');
      }
    }

    // Finish all network work before invalidating the last good copy.
    await pullLanHubSharesCopy({
      hub: options.hub,
      next,
      previous: kept?.path ?? null,
      fetch: options.fetch,
    });

    if (kept) {
      await fs.promises.rm(keptPath);
      await syncDirectory(directory);
      const currentDatabase = path.join(kept.path, DATABASE_FILE_NAME);
      const target = await fs.promises.open(currentDatabase, 'r+');
      try {
        for (const [index, block] of changed) {
          let position = index * header.blockBytes;
          for await (const chunk of fs.createReadStream(patch, {
            start: block.offset,
            end: block.offset + block.length - 1,
          })) {
            const data = chunk as Buffer;
            await target.write(data, 0, data.length, position);
            position += data.length;
          }
          const start = index * header.blockBytes;
          const [hash] = await hashLanHubBlocks(currentDatabase, header.blockBytes, {
            start,
            end: start + block.length - 1,
          });
          if (hash !== header.blocks[index])
            throw new Error(`Block ${index} does not match the hub after patching`);
        }
        await target.truncate(header.sizeBytes);
        await target.datasync();
      } finally {
        await target.close();
      }
      await fs.promises.rename(currentDatabase, database);
      await fs.promises.rm(patch);
    }
    await syncDirectory(next);

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
    const marker = await fs.promises.open(`${keptPath}.tmp`, 'w', 0o600);
    try {
      await marker.writeFile(`${JSON.stringify(result)}\n`);
      await marker.sync();
    } finally {
      await marker.close();
    }
    await fs.promises.rename(`${keptPath}.tmp`, keptPath);
    await syncDirectory(directory);
    return { ...result, received };
  } finally {
    source.destroy();
    await fs.promises.rm(next, { recursive: true, force: true });
  }
}
