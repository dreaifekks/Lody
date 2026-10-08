import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareSharePackage, type PreparedSharePackage } from '@lody/shared/session-sharing';
import {
  LAN_HUB_HANDOVER_COMPLETE_PATH,
  LAN_HUB_HANDOVER_PATH,
  readLanHubHandover,
} from './hub-handover';
import { startLanHubServer, type LanHubServer, type LanHubUpstream } from './hub-server';
import {
  createLanHubShares,
  listLanHubShareObjects,
  readLanHubSharesCopy,
  writeLanHubSharesCopy,
} from './hub-shares';
import { listLanSharedConversations, publishLanShare, revokeLanShare } from './lan-shares';

/** Stands in for the Streams server; it records what reached it. */
async function startFakeStreams() {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    request.resume();
    request.once('end', () => {
      response.writeHead(request.method === 'PUT' ? 201 : 200, {
        'Content-Type': 'application/octet-stream',
      });
      response.end('stream bytes');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let stopped: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => (stopped = resolve));
  const upstream: LanHubUpstream = {
    port: (server.address() as AddressInfo).port,
    exited,
    stop: () => {
      server.closeAllConnections();
      server.close(() => stopped(0));
    },
  };
  return { upstream, seen };
}

const READER = { script: Buffer.from('/* reader */'), style: Buffer.from('/* style */') };

async function capture(text: string, extra: string[] = []): Promise<PreparedSharePackage> {
  const history = (body: string) => [
    { id: 'u1', role: 'user', items: [{ type: 'text', text: 'Question?' }] },
    { id: 'a1', role: 'assistant', items: [{ type: 'text', text: body }] },
  ];
  return await prepareSharePackage({
    rootSourceId: 'session-root',
    conversations: [
      { sourceId: 'session-root', title: 'A discussion', history: history(text) },
      ...extra.map((body, index) => ({
        sourceId: `session-child-${index}`,
        title: `Child ${index}`,
        history: history(body),
        parentSourceId: 'session-root',
      })),
    ],
    capturedAt: '2026-10-08T00:00:00.000Z',
    readAttachment: () => Promise.reject(new Error('no attachments here')),
  });
}

/** What the shell writes for the agent service. */
function writePackage(root: string, prepared: PreparedSharePackage): string {
  const directory = fs.mkdtempSync(path.join(root, 'package-'));
  fs.writeFileSync(path.join(directory, 'manifest.json'), prepared.manifestBytes);
  fs.mkdirSync(path.join(directory, 'objects'));
  for (const [id, bytes] of prepared.objects) {
    fs.writeFileSync(path.join(directory, 'objects', id), bytes);
  }
  return directory;
}

describe('conversations a LAN shares', () => {
  let root: string;
  let dataDir: string;
  let streams: Awaited<ReturnType<typeof startFakeStreams>>;
  let hub: LanHubServer;
  const servers: LanHubServer[] = [];

  const start = async (directory: string, upstream = streams.upstream) => {
    const started = await startLanHubServer({
      host: '127.0.0.1',
      port: 0,
      sharePort: 0,
      dataDir: directory,
      startUpstream: async () => upstream,
      shareReaderAssets: () => READER,
    });
    servers.push(started);
    return started;
  };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-hub-shares-'));
    dataDir = path.join(root, 'hub');
    streams = await startFakeStreams();
    hub = await start(dataDir);
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const publish = async (
    prepared: PreparedSharePackage,
    update?: { shareId: string; expectedRevision?: number }
  ) =>
    await publishLanShare(hub, {
      directory: writePackage(root, prepared),
      rootSourceId: 'session-root',
      sources: prepared.sourceIds,
      ...update,
    });

  const read = (pathname: string, init?: RequestInit) => fetch(`${hub.shareUrl}${pathname}`, init);

  /** The history of the root conversation, as a reader of the link gets it. */
  const readRoot = async (shareId: string) => {
    const share = (await (await read(`/s/${shareId}/share.json`)).json()) as {
      deployment: string;
      manifest: PreparedSharePackage['manifest'];
    };
    const conversation = share.manifest.conversations.find(
      (entry) => entry.id === share.manifest.rootConversationId
    );
    const history = await read(
      `/s/${shareId}/d/${share.deployment}/${conversation?.historyObjectId}`
    );
    return { share, history: (await history.json()) as Array<{ items: Array<{ text: string }> }> };
  };

  it('publishes a conversation that a reader opens by its link alone', async () => {
    const share = await publish(await capture('First answer.'));

    expect(share.shareId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(share.url).toBe(`${hub.shareUrl}/s/${share.shareId}`);
    expect(share).toMatchObject({ title: 'A discussion', revision: 1, conversationCount: 1 });

    const page = await read(`/s/${share.shareId}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toContain('/_lody/share-reader.js');
    expect(await (await read('/_lody/share-reader.js')).text()).toBe('/* reader */');

    const { share: json, history } = await readRoot(share.shareId);
    expect(json.deployment).toBe(share.deployment);
    expect(history[1]?.items[0]?.text).toBe('First answer.');
    expect(await listLanSharedConversations(hub)).toEqual([share]);
  });

  it('keeps the link through an update and serves the new copy under it', async () => {
    const first = await publish(await capture('First answer.'));
    const { share: before } = await readRoot(first.shareId);
    const updated = await publish(await capture('Second answer.', ['A child.']), {
      shareId: first.shareId,
      expectedRevision: first.revision,
    });

    expect(updated).toMatchObject({ shareId: first.shareId, revision: 2, conversationCount: 2 });
    expect(updated.url).toBe(first.url);
    const { history, share } = await readRoot(first.shareId);
    expect(history[1]?.items[0]?.text).toBe('Second answer.');
    expect(share.manifest.conversations).toHaveLength(2);

    // A reader that opened the first copy finishes reading it, never a mix.
    const pinned = await read(
      `/s/${first.shareId}/d/${before.deployment}/${before.manifest.conversations[0]?.historyObjectId}`
    );
    expect(
      ((await pinned.json()) as Array<{ items: Array<{ text: string }> }>)[1]?.items[0]?.text
    ).toBe('First answer.');

    // An update that did not see the last one is refused.
    await expect(
      publish(await capture('Stale answer.'), {
        shareId: first.shareId,
        expectedRevision: first.revision,
      })
    ).rejects.toThrow(/changed meanwhile/);
  });

  it('serves nothing of a share once it is revoked', async () => {
    const share = await publish(await capture('First answer.'));
    const { share: json } = await readRoot(share.shareId);
    const objectPath = `/s/${share.shareId}/d/${json.deployment}/${json.manifest.objects[0]?.id}`;
    expect((await read(objectPath)).status).toBe(200);

    expect(await revokeLanShare(hub, share.shareId)).toBe(true);

    for (const pathname of [`/s/${share.shareId}`, `/s/${share.shareId}/share.json`, objectPath]) {
      expect((await read(pathname)).status).toBe(404);
    }
    expect(await listLanSharedConversations(hub)).toEqual([]);
    expect(await revokeLanShare(hub, share.shareId)).toBe(false);
  });

  it('reaches nothing but the shares on the share port, credential or not', async () => {
    const share = await publish(await capture('First answer.'));
    const before = streams.seen.length;
    const credential = { Authorization: `Bearer ${hub.token}` };
    for (const pathname of [
      '/',
      '/ds/lody/room',
      '/ds/lody/room?offset=-1&live=sse',
      '/lan/where',
      '/lan/shares',
      '/lan/snapshot',
      '/lan/credentials',
      '/push/devices',
      `/s/${share.shareId}/../../ds/lody/room`,
      `/s/${'x'.repeat(32)}`,
    ]) {
      const answer = await read(pathname, { headers: credential });
      expect([pathname, answer.status]).toEqual([pathname, 404]);
      expect(answer.headers.get('access-control-allow-origin')).toBeNull();
    }
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect((await read(`/s/${share.shareId}`, { method, headers: credential })).status).toBe(405);
    }
    expect(streams.seen).toHaveLength(before);

    // And the gate serves no share: without the credential it says no.
    expect((await fetch(`${hub.url}/s/${share.shareId}`)).status).toBe(401);
    expect((await fetch(`${hub.url}/lan/shares`)).status).toBe(401);
  });

  it('refuses a package whose objects never arrived or that the reader cannot read', async () => {
    const prepared = await capture('First answer.');
    const commit = (manifest: unknown) =>
      fetch(`${hub.url}/lan/shares`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${hub.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rootSourceId: 'session-root',
          sources: prepared.sourceIds,
          manifest,
        }),
      });
    expect((await commit(prepared.manifest)).status).toBe(409);

    const compressed = await prepareSharePackage({
      rootSourceId: 'session-root',
      conversations: [{ sourceId: 'session-root', title: 't', history: [] }],
      capturedAt: '2026-10-08T00:00:00.000Z',
      readAttachment: () => Promise.reject(new Error('none')),
      compressHistory: async () => new Uint8Array([1]),
    });
    expect((await commit(compressed.manifest)).status).toBe(400);
    expect(await listLanSharedConversations(hub)).toEqual([]);
  });

  it('hands its shares to a new host, and serves them no more once it moved', async () => {
    const share = await publish(await capture('First answer.'));
    const credential = { Authorization: `Bearer ${hub.token}` };
    const handover = await fetch(`${hub.url}${LAN_HUB_HANDOVER_PATH}?shares=1`, {
      method: 'POST',
      headers: credential,
    });
    const incoming = path.join(root, 'incoming');
    fs.mkdirSync(incoming);
    const files = await readLanHubHandover(
      Readable.fromWeb(handover.body as WebReadableStream<Uint8Array>),
      incoming
    );
    expect(files).toContain('shares/index.json');

    // While it hands over, the old host serves no share.
    expect((await read(`/s/${share.shareId}`)).status).toBe(503);
    await fetch(`${hub.url}${LAN_HUB_HANDOVER_COMPLETE_PATH}`, {
      method: 'POST',
      headers: { ...credential, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:1', term: 1 }),
    });
    expect((await read(`/s/${share.shareId}`)).status).toBe(404);

    // The handover stopped the old host's Streams server; the new host runs its own.
    const moved = await start(incoming, (await startFakeStreams()).upstream);
    const reread = await fetch(`${moved.shareUrl}/s/${share.shareId}/share.json`);
    expect(((await reread.json()) as { deployment: string }).deployment).toBe(share.deployment);
  });

  it('copies the shares to a standby, sending only the objects it lacks', async () => {
    await publish(await capture('First answer.'));
    const copy = async (target: string, previous: string | null) => {
      const stream = new PassThrough();
      const sending = writeLanHubSharesCopy(
        { dataDir, have: previous ? listLanHubShareObjects(previous) : [] },
        stream
      ).then(() => stream.end());
      const result = await readLanHubSharesCopy(stream, target, previous);
      await sending;
      return result;
    };
    const first = path.join(root, 'standby-1');
    expect(await copy(first, null)).toMatchObject({ objects: 2, received: 3 });

    const second = await publish(await capture('First answer.', ['A child.']));
    expect(second.conversationCount).toBe(2);
    const next = path.join(root, 'standby-2');
    // The index, the new manifest and the new histories; the old history is kept.
    const pulled = await copy(next, first);
    expect(pulled.received).toBeLessThan(pulled.objects + 1);

    const promoted = await start(next);
    const reread = await fetch(`${promoted.shareUrl}/s/${second.shareId}/share.json`);
    expect(reread.status).toBe(200);
  });
});

describe('the objects of shares', () => {
  it('serves a retired deployment for its grace only, and collects what nothing needs', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-hub-shares-clock-'));
    let now = Date.parse('2026-10-08T00:00:00Z');
    const shares = createLanHubShares({
      dataDir,
      sharePort: () => null,
      readerAssets: () => READER,
      now: () => now,
    });
    const server = http.createServer((request, response) => {
      if (request.url?.startsWith('/lan/')) void shares.handle(request, response);
      else shares.read(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const hub = { url: base, token: 'unused' };
    try {
      const write = async (text: string) => {
        const prepared = await capture(text);
        const directory = fs.mkdtempSync(path.join(dataDir, 'package-'));
        fs.writeFileSync(path.join(directory, 'manifest.json'), prepared.manifestBytes);
        fs.mkdirSync(path.join(directory, 'objects'));
        for (const [id, bytes] of prepared.objects) {
          fs.writeFileSync(path.join(directory, 'objects', id), bytes);
        }
        return { directory, sources: prepared.sourceIds };
      };
      const first = await publishLanShare(hub, {
        ...(await write('First answer.')),
        rootSourceId: 'session-root',
      });
      const second = await publishLanShare(hub, {
        ...(await write('Second answer.')),
        rootSourceId: 'session-root',
        shareId: first.shareId,
      });
      const old = `${base}/s/${first.shareId}/d/${first.deployment}/h1`;
      expect((await fetch(old)).status).toBe(200);

      now += 11 * 60_000;
      expect((await fetch(old)).status).toBe(404);
      expect((await fetch(`${base}/s/${second.shareId}/d/${second.deployment}/h1`)).status).toBe(
        200
      );

      // Uploads younger than an hour are spared; after that only what a share names stays.
      const objects = () => listLanHubShareObjects(dataDir).length;
      const before = objects();
      await shares.collect();
      expect(objects()).toBe(before);
      now += 2 * 60 * 60_000;
      for (const name of listLanHubShareObjects(dataDir)) {
        const file = path.join(dataDir, 'shares', 'objects', name);
        fs.utimesSync(file, new Date(now - 2 * 60 * 60_000), new Date(now - 2 * 60 * 60_000));
      }
      await shares.collect();
      expect(objects()).toBe(2);
      await revokeLanShare(hub, first.shareId);
      await shares.collect();
      expect(objects()).toBe(0);
    } finally {
      shares.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
