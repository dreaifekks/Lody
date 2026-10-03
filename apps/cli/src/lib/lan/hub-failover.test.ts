import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { LoroDoc } from 'loro-crdt';
import { InMemoryRemoteCursorStore, StreamsCrdt } from '@loro-dev/streams-crdt';
import { createLoroDocAdapter } from '@loro-dev/streams-crdt/loro';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareLanHubFailover, readLanHubEpoch, readsBeforeLanHubEpoch } from './hub-failover';
import { startLanHubServer, type LanHubServer } from './hub-server';

describe('readsBeforeLanHubEpoch', () => {
  const epoch = { base: 2_000_000_000_000, streams: new Set(['lw_a:s:doc']) };
  const read = (offset: string, stream = 'lw_a%3As%3Adoc') =>
    readsBeforeLanHubEpoch(epoch, 'GET', `/ds/lody/${stream}?offset=${offset}&live=sse`);

  it('turns away a read of a copied stream from an offset of an earlier hub', () => {
    expect(read('00000000000000012345')).toBe(true);
    expect(read('00000002000000000000')).toBe(false);
  });

  it('lets bootstraps, reads from the start or the tail, new streams and writes pass', () => {
    expect(read('-1')).toBe(false);
    expect(read('now')).toBe(false);
    expect(read('00000000000000012345', 'lw_a%3Arpc%3Areq')).toBe(false);
    expect(readsBeforeLanHubEpoch(epoch, 'GET', '/ds/lody/lw_a%3As%3Adoc/bootstrap')).toBe(false);
    expect(
      readsBeforeLanHubEpoch(epoch, 'POST', '/ds/lody/lw_a%3As%3Adoc?offset=00000000000000000001')
    ).toBe(false);
  });
});

/**
 * Against the real Streams server: a member writes after the standby's copy
 * was taken, the hub goes away, and another member moves the new hub's tail
 * past where the first one had read before it comes back.
 */
describe('a hub started from a standby copy', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it('gets back what only a member and the lost hub had, from that member', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-hub-failover-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const lost = path.join(root, 'lost');
    const copy = path.join(root, 'copy');
    const start = async (dataDir: string, port = 0): Promise<LanHubServer> => {
      const hub = await startLanHubServer({ host: '127.0.0.1', port, dataDir });
      cleanups.push(() => hub.close());
      return hub;
    };

    const first = await start(lost);
    // Members keep their cursors keyed by the address, as the desktop does
    // with an address that stays when the hub moves.
    const { port, token } = first;
    const streamUrl = `http://127.0.0.1:${port}/ds/lody/${encodeURIComponent('lw_test:s:doc')}`;
    const tail = async () => {
      const response = await fetch(streamUrl, {
        method: 'HEAD',
        headers: { Authorization: `Bearer ${token}` },
      });
      return Number(response.headers.get('stream-next-offset'));
    };
    const until = async (check: () => boolean | Promise<boolean>) => {
      // eslint-disable-next-line no-await-in-loop -- polling the observable state
      while (!(await check())) await new Promise((resolve) => setImmediate(resolve));
    };

    type Member = { doc: LoroDoc; cursors: InMemoryRemoteCursorStore; room: StreamsCrdt | null };
    const member = (peer: bigint): Member => {
      const doc = new LoroDoc();
      doc.setPeerId(peer);
      return { doc, cursors: new InMemoryRemoteCursorStore(), room: null };
    };
    const join = async (m: Member) => {
      m.room = new StreamsCrdt({
        streamUrl,
        adapter: createLoroDocAdapter(m.doc),
        auth: token,
        remoteCursorStore: m.cursors,
        createStreamIfMissing: true,
      });
      const joined = await m.room.join();
      expect(joined.ok).toBe(true);
    };
    const leave = async (m: Member) => {
      await m.room?.close();
      m.room = null;
    };
    cleanups.push(async () => {
      for (const m of everyone) await leave(m);
    });
    const write = (m: Member, text: string) => {
      m.doc.getList('items').push(text);
      m.doc.commit();
    };
    const items = (m: Member) => m.doc.getList('items').toJSON() as string[];

    const x = member(1n);
    const y = member(2n);
    const everyone = [x, y];
    await join(x);
    await join(y);
    write(x, 'before the copy');
    await until(() => items(y).includes('before the copy'));
    await leave(x);

    fs.mkdirSync(copy);
    fs.copyFileSync(path.join(lost, 'token'), path.join(copy, 'token'));
    const source = new Database(path.join(lost, 'streams.sqlite'), { readonly: true });
    await source.backup(path.join(copy, 'streams.sqlite'));
    source.close();
    const copied = await tail();

    write(y, 'after the copy');
    await until(async () => (await tail()) > copied);
    await leave(y);
    await first.close();

    const { base, streams } = prepareLanHubFailover(copy);
    expect(streams).toBe(1);
    expect(readLanHubEpoch(copy)?.streams.has('lw_test:s:doc')).toBe(true);
    await start(copy, port);

    await join(x);
    for (let i = 0; i < 40; i += 1) write(x, `after the failover ${i} ${'x'.repeat(200)}`);
    // The new hub's tail is now past where y had read, which is what a copy alone would serve wrongly.
    await until(async () => (await tail()) > base);
    await join(y);

    const z = member(3n);
    everyone.push(z);
    await join(z);
    await until(() => items(z).length === 42);
    expect(items(z)).toContain('after the copy');
    await until(() => items(y).length === 42 && items(x).length === 42);
  }, 30_000);
});
