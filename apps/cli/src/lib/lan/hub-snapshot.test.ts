import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LAN_SHARES_COPY_PATH } from '@lody/shared/lan-share';
import { writeLanHubSharesCopy } from './hub-shares';
import { pullLanHubSnapshot, readKeptLanHubSnapshot, writeLanHubSnapshot } from './hub-snapshot';

const BLOCK = 64 * 1024;

describe('a standby copy of a hub', () => {
  let root: string;
  let hubDir: string;
  let standbyDir: string;
  let database: Database.Database;

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
  });

  afterEach(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function append(count: number): void {
    const insert = database.prepare('insert into entries (body) values (?)');
    for (let i = 0; i < count; i += 1) insert.run(Buffer.alloc(2048, i % 251));
  }

  /** The hub, as a standby reaches it: the request is answered with what the hub writes. */
  const hubFetch = (options: { damage?: boolean } = {}) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const { have } = JSON.parse(String(init?.body)) as { have: string[] };
      const stream = new PassThrough();
      if (String(url).endsWith(LAN_SHARES_COPY_PATH)) {
        void writeLanHubSharesCopy({ dataDir: hubDir, have }, stream).then(() => stream.end());
        return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200 });
      }
      const sending = writeLanHubSnapshot({ dataDir: hubDir, have, stream, blockBytes: BLOCK });
      void sending.then(() => stream.end());
      let body: Readable = stream;
      if (options.damage) {
        let flipped = false;
        body = stream.pipe(
          new PassThrough({
            transform(chunk: Buffer, _encoding, done) {
              // A byte of the first block that arrives after its header.
              if (!flipped && chunk.length > 4096) {
                flipped = true;
                chunk[chunk.length - 1] ^= 0xff;
              }
              done(null, chunk);
            },
          })
        );
      }
      return new Response(Readable.toWeb(body) as ReadableStream, { status: 200 });
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

    append(5);
    const second = await pullLanHubSnapshot({ hub, directory: standbyDir, fetch: hubFetch() });
    expect(second.received).toBeGreaterThan(0);
    expect(second.received).toBeLessThan(second.blocks.length / 2);
    expect(rowsOf(readKeptLanHubSnapshot(standbyDir)?.path ?? '')).toBe(205);
  });

  it('keeps the last good copy when a copy arrives damaged', async () => {
    await pullLanHubSnapshot({ hub, directory: standbyDir, fetch: hubFetch() });
    append(50);

    await expect(
      pullLanHubSnapshot({ hub, directory: standbyDir, fetch: hubFetch({ damage: true }) })
    ).rejects.toThrow(/does not match/);
    expect(rowsOf(readKeptLanHubSnapshot(standbyDir)?.path ?? '')).toBe(200);
  });
});
