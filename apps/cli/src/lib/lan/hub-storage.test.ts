import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { startLanHubServer, type LanHubServer } from './hub-server';

const STREAM = 'lw_test:s:doc';
const offset = (value: number) => String(value).padStart(20, '0');

/** Against the real Streams server, through the hub's gate. */
describe('what a hub keeps of its streams', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const setUp = () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-hub-storage-'));
    cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const log: string[] = [];
    const start = async (): Promise<LanHubServer> => {
      const hub = await startLanHubServer({
        host: '127.0.0.1',
        port: 0,
        dataDir,
        sharePort: null,
        log: (line) => log.push(line),
      });
      cleanups.push(() => hub.close());
      return hub;
    };
    return { dataDir, log, start };
  };

  const client = (hub: LanHubServer) => {
    const streamPath = `/ds/lody/${encodeURIComponent(STREAM)}`;
    const send = (method: string, suffix = '', body?: Buffer) =>
      fetch(`${hub.url}${streamPath}${suffix}`, {
        method,
        headers: {
          Authorization: `Bearer ${hub.token}`,
          ...(body ? { 'Content-Type': 'application/octet-stream' } : {}),
        },
        body: body && new Uint8Array(body),
      });
    return {
      create: () => send('PUT', '', Buffer.alloc(0)),
      /** Appends one entry; the offset where it ends. */
      append: async (body: Buffer) => {
        const response = await send('POST', '', body);
        expect(response.ok).toBe(true);
        return Number(response.headers.get('stream-next-offset'));
      },
      snapshot: (at: number, body: Buffer) => send('PUT', `/snapshot/${offset(at)}`, body),
      read: (from: number) => send('GET', `?offset=${offset(from)}`),
      bootstrap: () => send('GET', '/bootstrap'),
    };
  };

  const entriesOf = (dataDir: string) => {
    const database = new Database(path.join(dataDir, 'streams.sqlite'), { readonly: true });
    try {
      return database
        .prepare(
          'SELECT start_offset AS start, end_offset AS end FROM entries ORDER BY start_offset'
        )
        .all() as Array<{ start: number; end: number }>;
    } finally {
      database.close();
    }
  };
  /** What the database holds, the part still in its write-ahead log included. */
  const databaseBytes = (dataDir: string) => {
    const database = new Database(path.join(dataDir, 'streams.sqlite'), { readonly: true });
    try {
      return (
        Number(database.pragma('page_count', { simple: true })) *
        Number(database.pragma('page_size', { simple: true }))
      );
    } finally {
      database.close();
    }
  };

  it('deletes the entries a snapshot replaces, and serves what follows it as before', async () => {
    const { dataDir, start } = setUp();
    const hub = await start();
    const stream = client(hub);
    expect((await stream.create()).status).toBe(201);
    const ends: number[] = [];
    for (const letter of 'abcde') ends.push(await stream.append(Buffer.alloc(100, letter)));
    const at = ends[2] ?? 0;

    expect((await stream.snapshot(at, Buffer.from('snapshot'))).status).toBe(204);
    // The entry that ends at the snapshot stays: offsets are checked against stored edges.
    expect(entriesOf(dataDir)).toEqual([
      { start: ends[1], end: at },
      { start: at, end: ends[3] },
      { start: ends[3], end: ends[4] },
    ]);

    const read = await stream.read(at);
    expect(read.status).toBe(200);
    expect(Buffer.from(await read.arrayBuffer())).toEqual(
      Buffer.concat([Buffer.alloc(100, 'd'), Buffer.alloc(100, 'e')])
    );
    const bootstrap = await stream.bootstrap();
    expect(bootstrap.headers.get('stream-snapshot-offset')).toBe(offset(at));
    const parts = Buffer.from(await bootstrap.arrayBuffer()).toString('latin1');
    expect(parts).toContain('snapshot');
    expect(parts).not.toContain('c'.repeat(100));
    expect(parts).toContain('d'.repeat(100));
    expect((await stream.read(ends[0] ?? 0)).status).toBe(410);

    // Again at the same offset, as a second member that saw the same tail does.
    expect((await stream.snapshot(at, Buffer.from('snapshot again'))).status).toBe(204);
    // Behind the kept entry nothing is stored to start from any more.
    expect((await stream.snapshot(ends[0] ?? 0, Buffer.from('older'))).status).toBe(400);
    expect((await stream.read(at)).status).toBe(200);
    expect((await stream.append(Buffer.alloc(100, 'f'))) - at).toBe(300);
  }, 30_000);

  it('starts on a database that kept what snapshots replaced by deleting it and shrinking the file', async () => {
    const { dataDir, log, start } = setUp();
    const first = await start();
    const stream = client(first);
    expect((await stream.create()).status).toBe(201);
    // Recorded the way a hub of an earlier build did, without the trigger.
    const database = new Database(path.join(dataDir, 'streams.sqlite'));
    database.exec('DROP TRIGGER lody_trim_replaced_entries');
    database.close();
    const ends: number[] = [];
    for (let i = 0; i < 40; i += 1) ends.push(await stream.append(Buffer.alloc(64 * 1024, i)));
    const at = ends[37] ?? 0;
    expect((await stream.snapshot(at, Buffer.from('snapshot'))).status).toBe(204);
    expect(entriesOf(dataDir)).toHaveLength(40);
    await first.close();
    const before = databaseBytes(dataDir);

    const second = await start();
    expect(entriesOf(dataDir).map((entry) => entry.end)).toEqual(ends.slice(37));
    expect(fs.statSync(path.join(dataDir, 'streams.sqlite')).size).toBeLessThan(before / 4);
    expect(
      log.some((line) =>
        line.startsWith('[storage] Deleted what snapshots replaced in 1 stream(s)')
      )
    ).toBe(true);
    const read = await client(second).read(at);
    expect(Buffer.from(await read.arrayBuffer())).toEqual(
      Buffer.concat([Buffer.alloc(64 * 1024, 38), Buffer.alloc(64 * 1024, 39)])
    );

    // The trigger is back: the next snapshot trims without another start.
    const next = await client(second).append(Buffer.alloc(100, 'z'));
    expect((await client(second).snapshot(next, Buffer.from('later'))).status).toBe(204);
    expect(entriesOf(dataDir).map((entry) => entry.end)).toEqual([next]);
  }, 30_000);
});
