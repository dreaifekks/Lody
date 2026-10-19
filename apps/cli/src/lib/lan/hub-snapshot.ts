// A copy of a running hub's data that a standby keeps to take over with. The
// hub serializes a consistent database image in memory and sends only changed
// blocks. The standby stages and checks them before patching its database.
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
import { pullLanHubSharesCopy } from './hub-shares';
import { ByteReader } from './lan-files';

export const LAN_HUB_SNAPSHOT_PATH = '/lan/snapshot';
export const LAN_HUB_SNAPSHOT_BLOCK_BYTES = 64 * 1024;

const DATABASE_FILE_NAME = 'streams.sqlite';
/** What travels beside the database: everything a hub keeps except the database itself. */
const SIDE_FILES = LAN_HUB_HANDOVER_FILES.filter(
  (name) => !name.startsWith(DATABASE_FILE_NAME)
) as Array<(typeof LAN_HUB_HANDOVER_FILES)[number]>;
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
    name: z.enum(LAN_HUB_HANDOVER_FILES),
    sizeBytes: z.number().int().nonnegative(),
    sha256: SHA256,
  })
  .strict();
const EndSchema = z.object({ type: z.literal('end') }).strict();
export const LanHubSnapshotRequestSchema = z
  .object({ have: z.array(SHA256).max(MAX_BLOCKS) })
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

function line(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
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

function serializeDatabase(source: string): Buffer {
  const database = new Database(source, { readonly: true, fileMustExist: true });
  try {
    return database.serialize();
  } finally {
    database.close();
  }
}

/** Sends a consistent in-memory image and side files through one owned pipeline. */
export async function writeLanHubSnapshot(options: {
  dataDir: string;
  have: readonly string[];
  stream: Writable;
  blockBytes?: number;
  now?: () => Date;
}): Promise<{ sizeBytes: number; blocks: number; sent: number }> {
  const blockBytes = options.blockBytes ?? LAN_HUB_SNAPSHOT_BLOCK_BYTES;
  const result = { sizeBytes: 0, blocks: 0, sent: 0 };
  async function* chunks(): AsyncGenerator<Buffer> {
    const takenAt = (options.now ?? (() => new Date()))().toISOString();
    const copy = serializeDatabase(path.join(options.dataDir, DATABASE_FILE_NAME));
    const blocks: string[] = [];
    for (let start = 0; start < copy.length; start += blockBytes) {
      blocks.push(
        crypto
          .createHash('sha256')
          .update(copy.subarray(start, start + blockBytes))
          .digest('hex')
      );
    }
    result.sizeBytes = copy.length;
    result.blocks = blocks.length;
    yield line({ type: 'snapshot', takenAt, sizeBytes: copy.length, blockBytes, blocks });
    for (const [index, block] of blocks.entries()) {
      if (options.have[index] === block) continue;
      yield line({ type: 'block', index });
      yield copy.subarray(index * blockBytes, (index + 1) * blockBytes);
      result.sent += 1;
    }
    for (const name of SIDE_FILES) {
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
  const kept = readKeptLanHubSnapshot(directory);
  const response = await (options.fetch ?? fetch)(`${options.hub.url}${LAN_HUB_SNAPSHOT_PATH}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.hub.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ have: kept?.blocks ?? [] }),
    signal: AbortSignal.timeout(10 * 60_000),
  });
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
      if (!kept) await handle.truncate(header.sizeBytes);
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

    // Finish all network work before invalidating the last good copy.
    await pullLanHubSharesCopy({
      hub: options.hub,
      next,
      previous: kept?.path ?? null,
      fetch: options.fetch,
    });

    const keptPath = path.join(directory, KEPT_FILE_NAME);
    if (kept) {
      await fs.promises.rm(keptPath);
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
        }
        await target.truncate(header.sizeBytes);
      } finally {
        await target.close();
      }
      await fs.promises.rename(currentDatabase, database);
      await fs.promises.rm(patch);
    }
    const blocks = await hashLanHubBlocks(database, header.blockBytes);
    if (blocks.length !== header.blocks.length || blocks.some((b, i) => b !== header.blocks[i])) {
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
    await fs.promises.writeFile(`${keptPath}.tmp`, `${JSON.stringify(result)}\n`, { mode: 0o600 });
    await fs.promises.rename(`${keptPath}.tmp`, keptPath);
    return { ...result, received };
  } finally {
    source.destroy();
    await fs.promises.rm(next, { recursive: true, force: true });
  }
}
