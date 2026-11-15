import fs from 'node:fs';
import http from 'node:http';
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

  const streamUrl = (hub: LanHubServer, suffix = '') =>
    `${hub.url}/ds/lody/${encodeURIComponent(STREAM)}${suffix}`;

  const client = (hub: LanHubServer) => {
    const send = (method: string, suffix = '', body?: Buffer) =>
      fetch(streamUrl(hub, suffix), {
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
    };
  };

  /** A bootstrap whose reader stops after the first bytes, and reads the rest when asked. */
  const pausedBootstrap = (hub: LanHubServer) =>
    new Promise<{ snapshotOffset: unknown; rest: () => Promise<Buffer> }>((resolve, reject) => {
      const request = http.get(
        streamUrl(hub, '/bootstrap'),
        { headers: { Authorization: `Bearer ${hub.token}` } },
        (response) => {
          const chunks: Buffer[] = [];
          response.once('data', (chunk: Buffer) => {
            response.pause();
            chunks.push(chunk);
            resolve({
              snapshotOffset: response.headers['stream-snapshot-offset'],
              rest: () =>
                new Promise<Buffer>((done, fail) => {
                  response.on('data', (more: Buffer) => chunks.push(more));
                  response.once('end', () => done(Buffer.concat(chunks)));
                  response.once('error', fail);
                  response.resume();
                }),
            });
          });
        }
      );
      request.once('error', reject);
    });

  const entriesOf = (dataDir: string) => {
    const database = new Database(path.join(dataDir, 'streams.sqlite'), { readonly: true });
    try {
      return database
        .prepare('SELECT end_offset AS end FROM entries ORDER BY start_offset')
        .all()
        .map((row) => (row as { end: number }).end);
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

  /** A stopped hub whose one stream holds `count` entries of 64 KB and a snapshot after `replaced` of them. */
  const stoppedWithReplaced = async (count: number, replaced: number) => {
    const setup = setUp();
    const hub = await setup.start();
    const stream = client(hub);
    expect((await stream.create()).status).toBe(201);
    const ends: number[] = [];
    for (let i = 0; i < count; i += 1) {
      ends.push(await stream.append(Buffer.alloc(64 * 1024, i)));
    }
    const at = ends[replaced] ?? 0;
    expect((await stream.snapshot(at, Buffer.from('snapshot'))).status).toBe(204);
    // Nothing is deleted while the hub serves.
    expect(entriesOf(setup.dataDir)).toEqual(ends);
    await hub.close();
    return { ...setup, ends, at, before: databaseBytes(setup.dataDir) };
  };

  it('sends a bootstrap every entry after its snapshot, though a newer snapshot arrives while it sends', async () => {
    const { start } = setUp();
    const hub = await start();
    const stream = client(hub);
    expect((await stream.create()).status).toBe(201);
    const ends: number[] = [];
    for (const letter of 'abcd') ends.push(await stream.append(Buffer.alloc(100, letter)));
    // Far more than the sockets between the server and the reader hold: the
    // server is still sending it when the reader stops reading.
    const snapshot = Buffer.alloc(64 * 1024 * 1024, 's');
    expect((await stream.snapshot(ends[0] ?? 0, snapshot)).status).toBe(204);

    const bootstrap = await pausedBootstrap(hub);
    expect(bootstrap.snapshotOffset).toBe(offset(ends[0] ?? 0));
    // Another member records a newer snapshot meanwhile.
    expect((await stream.snapshot(ends[2] ?? 0, Buffer.from('newer'))).status).toBe(204);

    const body = await bootstrap.rest();
    expect(body.length).toBeGreaterThan(snapshot.length);
    expect(body.includes(Buffer.alloc(100, 'a'))).toBe(false);
    for (const letter of 'bcd') expect(body.includes(Buffer.alloc(100, letter))).toBe(true);
  }, 30_000);

  it('deletes on start what snapshots replaced and gives a quarter or more back to the file system', async () => {
    const { dataDir, log, start, ends, at, before } = await stoppedWithReplaced(40, 37);

    const hub = await start();
    // The entry that ends at the snapshot stays: offsets are checked against stored edges.
    expect(entriesOf(dataDir)).toEqual(ends.slice(37));
    expect(fs.statSync(path.join(dataDir, 'streams.sqlite')).size).toBeLessThan(before / 4);
    expect(log).toContainEqual(
      expect.stringMatching(/^\[storage\] Deleted 37 entries that snapshots replaced: /u)
    );
    const read = await client(hub).read(at);
    expect(Buffer.from(await read.arrayBuffer())).toEqual(
      Buffer.concat([Buffer.alloc(64 * 1024, 38), Buffer.alloc(64 * 1024, 39)])
    );
  }, 30_000);

  it('leaves less than a quarter free for the server to reuse instead of rewriting the file', async () => {
    const { dataDir, log, start, ends, before } = await stoppedWithReplaced(40, 4);

    await start();
    expect(entriesOf(dataDir)).toEqual(ends.slice(4));
    expect(fs.statSync(path.join(dataDir, 'streams.sqlite')).size).toBe(before);
    expect(log).toContainEqual(
      expect.stringContaining(
        `[storage] Deleted 4 entries that snapshots replaced: ${before} -> ${before} bytes in `
      )
    );
  }, 30_000);
});
