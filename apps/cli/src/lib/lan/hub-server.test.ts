import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAN_GITHUB_TOKEN_PATH, fetchLanHubGitHubCredential } from '@lody/shared/node/lan-github';
import { removeLanHubGitHubConfig, writeLanHubGitHubConfig } from './hub-github';
import {
  LAN_HUB_HANDOVER_ABORT_PATH,
  LAN_HUB_HANDOVER_COMPLETE_PATH,
  LAN_HUB_HANDOVER_PATH,
  LAN_HUB_WHERE_PATH,
  askWhereLanHubIs,
  readLanHubHandover,
  signLanHubMove,
} from './hub-handover';
import {
  LAN_HUB_STREAMS_GUARD_IMPORT,
  createLiveReadKeepalive,
  loadOrCreateLanHubToken,
  readLanHubToken,
  startLanHubServer,
  type LanHubServer,
  type LanHubUpstream,
} from './hub-server';

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

/** Stands in for the Streams server, which has no authentication of its own. */
async function startFakeStreamsServer() {
  const seen: Seen[] = [];
  const liveReads = new Set<http.ServerResponse>();
  let liveReadClosed: () => void = () => {};
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      });
      if (request.method === 'PUT' && request.url === '/ds/lody') {
        response.writeHead(201).end();
        return;
      }
      if (request.url?.includes('live=sse')) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('event: data\ndata: first\n\n');
        liveReads.add(response);
        response.once('close', () => {
          liveReads.delete(response);
          liveReadClosed();
        });
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Stream-Next-Offset': '5',
        // Like a stream whose start was compacted away.
        'Stream-Earliest-Offset': '00000000000000000100',
        'Access-Control-Allow-Origin': 'http://upstream.invalid',
      });
      response.end('hello');
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
  return {
    upstream,
    seen,
    liveReads,
    crash: () => {
      server.closeAllConnections();
      server.close(() => stopped(1));
    },
    whenLiveReadCloses: () => new Promise<void>((resolve) => (liveReadClosed = resolve)),
  };
}

describe('LAN host', () => {
  let dataDir: string;
  let streams: Awaited<ReturnType<typeof startFakeStreamsServer>>;
  let hub: LanHubServer;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-hub-server-'));
    streams = await startFakeStreamsServer();
    hub = await startLanHubServer({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      startUpstream: async () => streams.upstream,
    });
  });

  afterEach(async () => {
    await hub.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const request = (pathname: string, init: RequestInit = {}) =>
    fetch(`${hub.url}${pathname}`, init);
  const authorized = (extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${hub.token}`,
    ...extra,
  });

  it('prepares the bucket every device writes to', () => {
    expect(streams.seen[0]).toMatchObject({ method: 'PUT', url: '/ds/lody' });
  });

  it('turns away a request without the credential before it reaches the streams', async () => {
    const before = streams.seen.length;
    for (const headers of [
      {},
      { Authorization: 'Bearer wrong' },
      { Authorization: hub.token },
      { Authorization: `Bearer ${hub.token}x` },
    ]) {
      const response = await request('/ds/lody/room', { headers });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    }
    expect(streams.seen).toHaveLength(before);
  });

  it('forwards a request with the credential, and keeps the credential to itself', async () => {
    const response = await request('/ds/lody/room%3Ameta?offset=-1', {
      method: 'POST',
      headers: authorized({ 'Content-Type': 'application/octet-stream', Origin: 'lody-hub://x' }),
      body: 'payload',
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello');
    expect(response.headers.get('stream-next-offset')).toBe('5');
    // The gate answers for the origin that asked, not for the one upstream knows.
    expect(response.headers.get('access-control-allow-origin')).toBe('lody-hub://x');
    const forwarded = streams.seen.at(-1);
    expect(forwarded).toMatchObject({
      method: 'POST',
      url: '/ds/lody/room%3Ameta?offset=-1',
      body: 'payload',
    });
    expect(forwarded?.headers.authorization).toBeUndefined();
    expect(forwarded?.headers['content-type']).toBe('application/octet-stream');
  });

  it('answers a preflight without asking for the credential', async () => {
    const response = await request('/ds/lody/room', {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Headers': 'authorization,stream-seq' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-headers')).toBe('authorization,stream-seq');
  });

  it('releases the subscription of a live read its reader left', async () => {
    const controller = new AbortController();
    const response = await request('/ds/lody/room?live=sse', {
      headers: authorized(),
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toBe('event: data\ndata: first\n\n');
    expect(streams.liveReads.size).toBe(1);

    const closed = streams.whenLiveReadCloses();
    controller.abort();
    await closed;

    expect(streams.liveReads.size).toBe(0);
  });

  it('answers a live read below the retained range like a plain read, so the reader bootstraps', async () => {
    const response = await request('/ds/lody/room%3Ameta?offset=00000000000000000042&live=sse', {
      headers: authorized(),
    });

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: 'offset is outside the readable retained range',
    });
    expect(streams.seen.some((seen) => seen.url.includes('live=sse'))).toBe(false);
  });

  it('forwards a live read inside the retained range', async () => {
    const controller = new AbortController();
    const response = await request('/ds/lody/room%3Ameta?offset=00000000000000000100&live=sse', {
      headers: authorized(),
      signal: controller.signal,
    });
    const first = await response.body?.getReader().read();

    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(first?.value)).toBe('event: data\ndata: first\n\n');
    const closed = streams.whenLiveReadCloses();
    controller.abort();
    await closed;
  });

  it('stops when the streams behind it are gone', async () => {
    streams.crash();
    const { error } = await hub.stopped;
    expect(error?.message).toBe('Streams server exited unexpectedly (code=1)');
    await expect(request('/ds/lody/room', { headers: authorized() })).rejects.toThrow();
  });

  it('hands its GitHub credential only to members, from the moment it is saved', async () => {
    const before = streams.seen.length;
    expect((await request(LAN_GITHUB_TOKEN_PATH)).status).toBe(401);
    expect((await request(LAN_GITHUB_TOKEN_PATH, { headers: authorized() })).status).toBe(404);
    const member = { url: hub.url, token: hub.token };
    await expect(fetchLanHubGitHubCredential(member)).resolves.toBeNull();

    writeLanHubGitHubConfig(dataDir, {
      token: 'github_pat_example',
      login: 'octocat',
      userId: '583231',
      savedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(fs.statSync(path.join(dataDir, 'github.json')).mode & 0o777).toBe(0o600);
    await expect(fetchLanHubGitHubCredential(member)).resolves.toEqual({
      token: 'github_pat_example',
      login: 'octocat',
      userId: '583231',
    });

    removeLanHubGitHubConfig(dataDir);
    await expect(fetchLanHubGitHubCredential(member)).resolves.toBeNull();
    // None of it is a stream.
    expect(streams.seen).toHaveLength(before);
  });

  it('keeps its credential across restarts and away from other users', async () => {
    const tokenPath = path.join(dataDir, 'token');
    expect(fs.readFileSync(tokenPath, 'utf8').trim()).toBe(hub.token);
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(loadOrCreateLanHubToken(dataDir)).toBe(hub.token);
    expect(readLanHubToken(dataDir)).toBe(hub.token);
    expect(readLanHubToken(path.join(dataDir, 'never-started'))).toBeNull();
  });
});

describe('live read keepalive', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const create = () => {
    vi.useFakeTimers();
    const written: string[] = [];
    const keepalive = createLiveReadKeepalive({
      intervalMs: 15_000,
      write: (chunk) => written.push(chunk),
    });
    return { written, keepalive };
  };

  it('speaks up on a read that stays silent', () => {
    const { written } = create();
    vi.advanceTimersByTime(14_999);
    expect(written).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(written).toEqual([': keepalive\n\n']);
    vi.advanceTimersByTime(30_000);
    expect(written).toHaveLength(3);
  });

  it('waits for the silence to start over after every event', () => {
    const { written, keepalive } = create();
    vi.advanceTimersByTime(10_000);
    keepalive.observe(Buffer.from('event: data\ndata: x\n\n'));
    vi.advanceTimersByTime(14_999);
    expect(written).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(written).toEqual([': keepalive\n\n']);
  });

  it('never writes into the middle of an event', () => {
    const { written, keepalive } = create();
    keepalive.observe(Buffer.from('event: data\ndata: half'));
    vi.advanceTimersByTime(60_000);
    expect(written).toEqual([]);

    // The blank line that ends the event arrives as its own chunk.
    keepalive.observe(Buffer.from('\n'));
    keepalive.observe(Buffer.from('\n'));
    vi.advanceTimersByTime(15_000);
    expect(written).toEqual([': keepalive\n\n']);
  });

  it('is silent once the read ended', () => {
    const { written, keepalive } = create();
    keepalive.stop();
    vi.advanceTimersByTime(60_000);
    expect(written).toEqual([]);
  });
});

describe('Streams server guard', () => {
  // Answers failures the way the Streams server does: by setting headers from
  // an async handler nobody awaits.
  const STREAMS_LIKE_SERVER = `
import http from 'node:http';
async function handle(request, response) {
  try {
    if (request.url === '/late') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('event: data\\ndata: first\\n\\n');
      await Promise.resolve();
      throw new Error('offset is outside the readable retained range');
    }
    response.end('ok');
  } catch (error) {
    if (response.writableEnded) return;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ error: error.message }));
  }
}
const server = http.createServer((request, response) => { handle(request, response); });
server.listen(0, '127.0.0.1', () => process.stdout.write(server.address().port + '\\n'));
`;

  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });

  const start = (guarded: boolean) => {
    const child = spawn(
      process.execPath,
      [
        ...(guarded ? ['--import', LAN_HUB_STREAMS_GUARD_IMPORT] : []),
        '--input-type=module',
        '-e',
        STREAMS_LIKE_SERVER,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    children.push(child);
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    return {
      exited: new Promise<number | null>((resolve) => child.once('exit', resolve)),
      port: new Promise<number>((resolve) =>
        child.stdout?.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())))
      ),
      stderr: () => stderr,
    };
  };

  const get = (port: number, pathname: string) =>
    new Promise<{ complete: boolean; body: string }>((resolve) => {
      const request = http.get({ host: '127.0.0.1', port, path: pathname }, (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => (body += chunk.toString()));
        response.once('close', () => resolve({ complete: response.complete, body }));
        response.once('error', () => {});
      });
      request.once('error', () => resolve({ complete: false, body: '' }));
    });

  it('drops a live read that fails after its response started and keeps serving', async () => {
    const server = start(true);
    const port = await server.port;

    expect((await get(port, '/late')).complete).toBe(false);
    expect(await get(port, '/ok')).toEqual({ complete: true, body: 'ok' });
    expect(server.stderr()).toContain('Dropped GET /late, which failed after its response started');
  });

  it('is what keeps such a failure from ending the server', async () => {
    const server = start(false);
    const port = await server.port;

    await get(port, '/late');
    expect(await server.exited).toBe(1);
  });
});

describe('moving a LAN host', () => {
  let dataDir: string;
  let received: string;
  let started: Array<Awaited<ReturnType<typeof startFakeStreamsServer>>>;
  const running: LanHubServer[] = [];

  const start = async () => {
    const hub = await startLanHubServer({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      startUpstream: async () => {
        const streams = await startFakeStreamsServer();
        started.push(streams);
        return streams.upstream;
      },
    });
    running.push(hub);
    return hub;
  };
  const call = (
    hub: LanHubServer,
    pathname: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {}
  ) =>
    fetch(`${hub.url}${pathname}`, {
      ...init,
      headers: { Authorization: `Bearer ${hub.token}`, ...init.headers },
    });

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-hub-move-'));
    received = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-hub-received-'));
    started = [];
    fs.writeFileSync(path.join(dataDir, 'streams.sqlite'), 'the streams of the LAN');
  });

  afterEach(async () => {
    for (const hub of running.splice(0)) await hub.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(received, { recursive: true, force: true });
  });

  it('hands its data over, serves nothing meanwhile, and then points members to the new host', async () => {
    const hub = await start();
    writeLanHubGitHubConfig(dataDir, { token: 'ghp_x', login: 'me', userId: '1', savedAt: 'now' });

    const handover = await call(hub, LAN_HUB_HANDOVER_PATH, { method: 'POST' });
    expect(handover.status).toBe(200);
    const files = await readLanHubHandover(
      Readable.fromWeb(handover.body as WebReadableStream<Uint8Array>),
      received
    );
    expect(files.sort()).toEqual(['github.json', 'streams.sqlite', 'token']);
    expect(fs.readFileSync(path.join(received, 'streams.sqlite'), 'utf8')).toBe(
      'the streams of the LAN'
    );
    expect(readLanHubToken(received)).toBe(hub.token);

    // Nothing may change under the copy.
    expect((await call(hub, '/ds/lody/room')).status).toBe(503);
    expect((await call(hub, LAN_HUB_HANDOVER_PATH, { method: 'POST' })).status).toBe(409);

    const complete = await call(hub, LAN_HUB_HANDOVER_COMPLETE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://100.64.0.9:8788' }),
    });
    expect(complete.status).toBe(200);

    const moved = await call(hub, '/ds/lody/room');
    expect(moved.status).toBe(410);
    expect(await moved.json()).toMatchObject({ movedTo: 'http://100.64.0.9:8788' });
    expect((await askWhereLanHubIs({ url: hub.url, token: hub.token }))?.url).toBe(
      'http://100.64.0.9:8788'
    );
    // Only a member learns where the LAN went.
    expect((await fetch(`${hub.url}${LAN_HUB_WHERE_PATH}`)).status).toBe(401);
  });

  it('keeps pointing to the new host after it starts again', async () => {
    const first = await start();
    const handover = await call(first, LAN_HUB_HANDOVER_PATH, { method: 'POST' });
    await handover.arrayBuffer();
    await call(first, LAN_HUB_HANDOVER_COMPLETE_PATH, {
      method: 'POST',
      body: JSON.stringify({ url: 'http://100.64.0.9:8788' }),
    });
    await first.close();

    const again = await start();
    expect(started).toHaveLength(1);
    expect((await askWhereLanHubIs({ url: again.url, token: again.token }))?.url).toBe(
      'http://100.64.0.9:8788'
    );
  });

  it('serves the LAN again when the new host gives up', async () => {
    const hub = await start();
    await (await call(hub, LAN_HUB_HANDOVER_PATH, { method: 'POST' })).arrayBuffer();

    const abort = await call(hub, LAN_HUB_HANDOVER_ABORT_PATH, { method: 'POST' });
    expect(await abort.json()).toEqual({ resumed: true });
    expect(started).toHaveLength(2);
    const served = await call(hub, '/ds/lody/room');
    expect(served.status).toBe(200);
    expect(await served.text()).toBe('hello');
    expect(await askWhereLanHubIs({ url: hub.url, token: hub.token })).toBeNull();
  });

  it('is not followed where the move is not signed with the credential', async () => {
    const forged = async () =>
      new Response(
        JSON.stringify({
          movedTo: 'http://203.0.113.5:8788',
          signature: signLanHubMove('another-credential', 'http://203.0.113.5:8788'),
        }),
        { status: 410 }
      );
    expect(
      await askWhereLanHubIs(
        { url: 'http://100.64.0.1:8788', token: 'the-credential' },
        { fetch: forged }
      )
    ).toBeNull();
  });
});
