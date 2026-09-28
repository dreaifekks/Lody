import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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

  it('stops when the streams behind it are gone', async () => {
    streams.crash();
    const { error } = await hub.stopped;
    expect(error?.message).toBe('Streams server exited unexpectedly (code=1)');
    await expect(request('/ds/lody/room', { headers: authorized() })).rejects.toThrow();
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
