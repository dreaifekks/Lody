import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAN_SHARES_COPY_PATH } from '@lody/shared/lan-share';
import { writeLanHubSharesCopy } from './hub-shares';
import { pullLanHubSnapshot, readKeptLanHubSnapshot, writeLanHubSnapshot } from './hub-snapshot';

const BLOCK = 64 * 1024;

describe('a standby copy of a hub', () => {
  let root: string;
  let hubDir: string;
  let standbyDir: string;
  let database: Database.Database;
  let sends: Promise<unknown>[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-hub-snapshot-'));
    hubDir = path.join(root, 'hub');
    standbyDir = path.join(root, 'standby');
    fs.mkdirSync(hubDir);
    fs.writeFileSync(path.join(hubDir, 'token'), 'the-credential\n');
    // The Streams server keeps its database in WAL mode and writes while copies are taken.
    database = new Database(path.join(hubDir, 'streams.sqlite'));
    database.pragma('journal_mode = WAL');
    database.exec('create table entries (id integer primary key, body blob)');
    append(200);
    sends = [];
  });

  afterEach(async () => {
    await Promise.allSettled(sends);
    vi.restoreAllMocks();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function append(count: number): void {
    const insert = database.prepare('insert into entries (body) values (?)');
    for (let i = 0; i < count; i += 1) insert.run(Buffer.alloc(2048, i % 251));
  }

  /** The hub, as a standby reaches it: the request is answered with what the hub writes. */
  const hubFetch = (
    options: {
      damage?: boolean;
      blockBytes?: number;
      interrupt?: boolean;
      shares?: () => Response | Promise<Response>;
    } = {}
  ) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const { have } = JSON.parse(String(init?.body)) as { have: string[] };
      if (String(url).endsWith(LAN_SHARES_COPY_PATH) && options.shares) return options.shares();
      const stream = new PassThrough();
      const sending = String(url).endsWith(LAN_SHARES_COPY_PATH)
        ? writeLanHubSharesCopy({ dataDir: hubDir, have }, stream).then(() => {
            stream.end();
          })
        : writeLanHubSnapshot({
            dataDir: hubDir,
            have,
            stream,
            blockBytes: options.blockBytes ?? BLOCK,
          });
      // Observe rejection immediately; individual tests inspect the transfer outcome.
      sends.push(sending);
      void sending.catch(() => {});
      let flipped = false;
      let binary = false;
      const body = (Readable.toWeb(stream) as ReadableStream<Uint8Array>).pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            if (binary) {
              binary = false;
              if (options.interrupt) {
                controller.enqueue(chunk.subarray(0, 10));
                controller.terminate();
                return;
              }
              if (options.damage && !flipped) {
                chunk = Buffer.from(chunk);
                chunk[chunk.length - 1] ^= 0xff;
                flipped = true;
              }
            } else if (Buffer.from(chunk).toString().startsWith('{"type":"block"')) {
              binary = true;
            }
            // Fragment even a large header, as HTTP does; an unsplit line would
            // bypass ByteReader's buffered-length limit.
            for (let start = 0; start < chunk.length; start += 16 * 1024) {
              controller.enqueue(chunk.subarray(start, start + 16 * 1024));
            }
          },
        })
      );
      return new Response(body, { status: 200 });
    }) as typeof fetch;
  const hub = { url: 'http://hub.invalid:8788', token: 'the-credential' };
  const rowsOf = (dataDir: string) => {
    const copy = new Database(path.join(dataDir, 'streams.sqlite'), { readonly: true });
    try {
      return (copy.prepare('select count(*) as n from entries').get() as { n: number }).n;
    } finally {
      copy.close();
    }
  };

  it('copies the whole hub once, and afterwards only what changed', async () => {
    const first = await pullLanHubSnapshot({ hub, directory: standbyDir, fetch: hubFetch() });
    expect(first.received).toBe(first.blocks.length);
    const kept = readKeptLanHubSnapshot(standbyDir);
    expect(kept && rowsOf(kept.path)).toBe(200);
    expect(fs.readFileSync(path.join(kept?.path ?? '', 'token'), 'utf8')).toBe('the-credential\n');

    const inode = fs.statSync(path.join(kept?.path ?? '', 'streams.sqlite')).ino;
    append(5);
    const second = await pullLanHubSnapshot({ hub, directory: standbyDir, fetch: hubFetch() });
    expect(second.received).toBeGreaterThan(0);
    expect(second.received).toBeLessThan(second.blocks.length / 2);
    const current = readKeptLanHubSnapshot(standbyDir)?.path ?? '';
    expect(fs.statSync(path.join(current, 'streams.sqlite')).ino).toBe(inode);
    expect(fs.readFileSync(path.join(current, 'streams.sqlite'))).toEqual(database.serialize());
    expect(rowsOf(current)).toBe(205);
  });

  it('keeps the last good copy when a copy arrives damaged', async () => {
    await pullLanHubSnapshot({ hub, directory: standbyDir, fetch: hubFetch() });
    const marker = fs.readFileSync(path.join(standbyDir, 'snapshot.json'));
    append(50);

    await expect(
      pullLanHubSnapshot({ hub, directory: standbyDir, fetch: hubFetch({ damage: true }) })
    ).rejects.toThrow(/does not match/);
    expect(fs.readFileSync(path.join(standbyDir, 'snapshot.json'))).toEqual(marker);
    expect(rowsOf(readKeptLanHubSnapshot(standbyDir)?.path ?? '')).toBe(200);
  });

  it('receives a fragmented header larger than 1 MB', async () => {
    const result = await pullLanHubSnapshot({
      hub,
      directory: standbyDir,
      fetch: hubFetch({ blockBytes: 48 }),
    });
    expect(result.blocks.length * 67).toBeGreaterThan(1024 * 1024);
    expect(result.received).toBe(result.blocks.length);
    expect(rowsOf(readKeptLanHubSnapshot(standbyDir)?.path ?? '')).toBe(200);
  });

  it.skipIf(process.platform !== 'linux')(
    'finishes a disconnected send without snapshot files, open descriptors or growing listeners',
    async () => {
      const descriptors = () =>
        fs
          .readdirSync('/proc/self/fd')
          .flatMap((fd) => {
            try {
              const file = fs.readlinkSync(`/proc/self/fd/${fd}`);
              return file.startsWith(hubDir) ? [file] : [];
            } catch {
              return [];
            }
          })
          .sort();
      // SQLite may defer an fd close while another connection in this process
      // holds WAL locks. Warm that pool, then prove repeated sends do not grow it.
      await writeLanHubSnapshot({
        dataDir: hubDir,
        have: [],
        stream: new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        }),
      });
      const before = descriptors();
      for (const stopAt of [20, 2000]) {
        let chunks = 0;
        const counts: number[][] = [];
        const stream = new Writable({
          write(_chunk, _encoding, done) {
            chunks += 1;
            counts.push(
              ['close', 'error', 'end', 'finish'].map((event) => stream.listenerCount(event))
            );
            if (chunks === stopAt) stream.destroy(new Error('client disconnected'));
            done();
          },
        });
        await expect(
          writeLanHubSnapshot({ dataDir: hubDir, have: [], stream, blockBytes: 48 })
        ).rejects.toThrow('client disconnected');
        expect(counts.length).toBe(stopAt);
        expect(counts.every((count) => JSON.stringify(count) === JSON.stringify(counts[0]))).toBe(
          true
        );
        expect(Math.max(...counts.flat())).toBeLessThanOrEqual(5);
        expect(descriptors()).toEqual(before);
        expect(fs.readdirSync(hubDir).filter((name) => name.startsWith('.snapshot-'))).toEqual([]);
      }
      database.close();
      expect(descriptors()).toEqual([]);
    }
  );

  it('keeps the current image and marker usable after an interrupted pull', async () => {
    await pullLanHubSnapshot({ hub, directory: standbyDir, fetch: hubFetch() });
    const current = path.join(standbyDir, 'current');
    const image = fs.readFileSync(path.join(current, 'streams.sqlite'));
    const marker = fs.readFileSync(path.join(standbyDir, 'snapshot.json'));
    append(50);
    fs.writeFileSync(path.join(hubDir, 'token'), 'new-side-file');
    await expect(
      pullLanHubSnapshot({ hub, directory: standbyDir, fetch: hubFetch({ interrupt: true }) })
    ).rejects.toThrow(/middle of a file/);
    expect(fs.readFileSync(path.join(current, 'streams.sqlite'))).toEqual(image);
    expect(fs.readFileSync(path.join(standbyDir, 'snapshot.json'))).toEqual(marker);
    expect(fs.readFileSync(path.join(current, 'token'), 'utf8')).toBe('the-credential\n');
    expect(rowsOf(readKeptLanHubSnapshot(standbyDir)?.path ?? '')).toBe(200);
    expect(fs.existsSync(path.join(standbyDir, 'next'))).toBe(false);
    const outcomes = await Promise.allSettled(sends);
    expect(outcomes.at(-1)?.status).toBe('rejected');
  });

  it('cancels the response when parsing fails', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('{"type":"invalid"}\n'));
        },
        cancel() {
          cancelled = true;
        },
      })
    );
    await expect(
      pullLanHubSnapshot({
        hub,
        directory: standbyDir,
        fetch: (async () => response) as typeof fetch,
      })
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(readKeptLanHubSnapshot(standbyDir)).toBeNull();
  });

  it('keeps the database, side files and shares together when the shares transfer fails', async () => {
    await pullLanHubSnapshot({ hub, directory: standbyDir, fetch: hubFetch() });
    const current = path.join(standbyDir, 'current');
    const marker = fs.readFileSync(path.join(standbyDir, 'snapshot.json'));
    fs.writeFileSync(path.join(current, 'shares', 'index.json'), 'previous shares');
    append(5);
    fs.writeFileSync(path.join(hubDir, 'token'), 'updated token');
    let cancelled = false;
    await expect(
      pullLanHubSnapshot({
        hub,
        directory: standbyDir,
        fetch: hubFetch({
          shares: () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(Buffer.from('{"type":"invalid"}\n'));
                },
                cancel() {
                  cancelled = true;
                },
              })
            ),
        }),
      })
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(fs.readFileSync(path.join(standbyDir, 'snapshot.json'))).toEqual(marker);
    expect(rowsOf(current)).toBe(200);
    expect(fs.readFileSync(path.join(current, 'token'), 'utf8')).toBe('the-credential\n');
    expect(fs.readFileSync(path.join(current, 'shares', 'index.json'), 'utf8')).toBe(
      'previous shares'
    );
  });

  it('promotes side files and reuses share objects alongside an incremental database patch', async () => {
    const object = Buffer.from('shared object');
    const sha256 = crypto.createHash('sha256').update(object).digest('hex');
    const shares = (index: string, sendObject: boolean) => () => {
      const file = (name: string, data: Buffer) => [
        Buffer.from(
          `${JSON.stringify({
            type: 'file',
            name,
            sizeBytes: data.length,
            sha256: crypto.createHash('sha256').update(data).digest('hex'),
          })}\n`
        ),
        data,
      ];
      return new Response(
        Buffer.concat([
          Buffer.from(`${JSON.stringify({ type: 'shares', objects: [sha256] })}\n`),
          ...file('shares/index.json', Buffer.from(index)),
          ...(sendObject ? file(`shares/objects/${sha256}`, object) : []),
          Buffer.from('{"type":"end"}\n'),
        ])
      );
    };
    await pullLanHubSnapshot({
      hub,
      directory: standbyDir,
      fetch: hubFetch({ shares: shares('first', true) }),
    });
    const current = path.join(standbyDir, 'current');
    const objectPath = path.join(current, 'shares', 'objects', sha256);
    const inode = fs.statSync(objectPath).ino;
    append(5);
    fs.writeFileSync(path.join(hubDir, 'token'), 'updated token');
    await pullLanHubSnapshot({
      hub,
      directory: standbyDir,
      fetch: hubFetch({ shares: shares('second', false) }),
    });
    expect(rowsOf(current)).toBe(205);
    expect(fs.readFileSync(path.join(current, 'token'), 'utf8')).toBe('updated token');
    expect(fs.readFileSync(path.join(current, 'shares', 'index.json'), 'utf8')).toBe('second');
    expect(fs.readFileSync(objectPath)).toEqual(object);
    expect(fs.statSync(objectPath).ino).toBe(inode);
    expect(fs.existsSync(path.join(standbyDir, 'previous'))).toBe(false);
  });

  it('invalidates the marker before patching and recovers with a full pull after a write failure', async () => {
    await pullLanHubSnapshot({ hub, directory: standbyDir, fetch: hubFetch() });
    append(5);
    const open = fs.promises.open;
    const spy = vi
      .spyOn(fs.promises, 'open')
      .mockImplementation(async (...args: Parameters<typeof open>) => {
        if (args[0] === path.join(standbyDir, 'current', 'streams.sqlite') && args[1] === 'r+') {
          expect(readKeptLanHubSnapshot(standbyDir)).toBeNull();
          throw new Error('disk write failed');
        }
        return open(...args);
      });
    await expect(
      pullLanHubSnapshot({ hub, directory: standbyDir, fetch: hubFetch() })
    ).rejects.toThrow('disk write failed');
    expect(readKeptLanHubSnapshot(standbyDir)).toBeNull();
    spy.mockRestore();
    const recovered = await pullLanHubSnapshot({ hub, directory: standbyDir, fetch: hubFetch() });
    expect(recovered.received).toBe(recovered.blocks.length);
    expect(rowsOf(readKeptLanHubSnapshot(standbyDir)?.path ?? '')).toBe(205);
  });

  it('truncates the patched image when the hub database shrinks', async () => {
    const first = await pullLanHubSnapshot({ hub, directory: standbyDir, fetch: hubFetch() });
    database.exec('delete from entries where id > 5; vacuum;');
    const second = await pullLanHubSnapshot({ hub, directory: standbyDir, fetch: hubFetch() });
    expect(second.sizeBytes).toBeLessThan(first.sizeBytes);
    const current = readKeptLanHubSnapshot(standbyDir)?.path ?? '';
    expect(fs.readFileSync(path.join(current, 'streams.sqlite'))).toEqual(database.serialize());
    expect(rowsOf(current)).toBe(5);
  });

  it('rejects a missing changed block before invalidating the current image', async () => {
    await pullLanHubSnapshot({ hub, directory: standbyDir, fetch: hubFetch() });
    const kept = readKeptLanHubSnapshot(standbyDir);
    const marker = fs.readFileSync(path.join(standbyDir, 'snapshot.json'));
    const response = new Response(
      `${JSON.stringify({
        type: 'snapshot',
        takenAt: '2026-10-19T00:00:00Z',
        sizeBytes: kept?.sizeBytes,
        blockBytes: kept?.blockBytes,
        blocks: kept?.blocks.map(() => crypto.createHash('sha256').update('missing').digest('hex')),
      })}\n{"type":"end"}\n`
    );
    await expect(
      pullLanHubSnapshot({
        hub,
        directory: standbyDir,
        fetch: (async () => response) as typeof fetch,
      })
    ).rejects.toThrow('did not send every changed block');
    expect(fs.readFileSync(path.join(standbyDir, 'snapshot.json'))).toEqual(marker);
    expect(rowsOf(readKeptLanHubSnapshot(standbyDir)?.path ?? '')).toBe(200);
  });
});
