import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getServerTimeOffset, isTimeSynced, resetTimeSync } from '@lody/shared';
import type { LanHub } from '@lody/shared/node/lan-hub';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanHubClock } from './lan-clock';

const SKEW_MS = 60_000;

/** A hub whose clock runs a minute ahead of this machine's. */
async function startHub(token: string) {
  const asked: Array<() => void> = [];
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    asked.shift()?.();
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== 'GET' || request.url !== '/api/time') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ serverTime: Date.now() + SKEW_MS }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests: () => requests,
    nextRequest: () => new Promise<void>((resolve) => asked.push(resolve)),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('LAN hub clock', () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  const lan = (token: string, name = 'Home'): LanHub => ({
    id: 'a'.repeat(32),
    name,
    url: hub.url,
    token,
  });

  beforeEach(async () => {
    hub = await startHub('secret');
  });

  afterEach(async () => {
    vi.useRealTimers();
    resetTimeSync();
    await hub.close();
  });

  it('aligns this process to the hub of the first LAN', async () => {
    const clock = new LanHubClock({
      hubs: () => [lan('secret'), lan('other', 'Office')],
      log: () => {},
    });

    await clock.sync();

    expect(isTimeSynced()).toBe(true);
    expect(Math.abs(getServerTimeOffset() - SKEW_MS)).toBeLessThan(1_000);
  });

  it('keeps the clock it had when the hub does not answer, and says why', async () => {
    const lines: string[] = [];
    const clock = new LanHubClock({ hubs: () => [lan('wrong')], log: (line) => lines.push(line) });

    await clock.sync();

    expect(isTimeSynced()).toBe(false);
    expect(getServerTimeOffset()).toBe(0);
    expect(lines).toEqual([expect.stringMatching(/clock of Home: .*401/)]);
  });

  it('asks at once when it starts and again after every interval', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const clock = new LanHubClock({
      hubs: () => [lan('secret')],
      log: () => {},
      intervalMs: 60_000,
    });

    const first = hub.nextRequest();
    clock.start();
    await first;
    expect(hub.requests()).toBe(1);

    const second = hub.nextRequest();
    vi.advanceTimersByTime(60_000);
    await second;
    expect(hub.requests()).toBe(2);

    clock.stop();
    vi.advanceTimersByTime(60_000 * 10);
    expect(hub.requests()).toBe(2);
  });
});
