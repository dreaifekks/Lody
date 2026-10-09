import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerTimeOffset, isTimeSynced, resetTimeSync } from '@lody/shared';
import { startLanHubClock } from '../src/providers/lan-hub-clock';

const LAN = `lody-hub://${'a'.repeat(32)}`;
const SKEW_MS = 60_000;

describe('LAN hub clock in the renderer', () => {
  let asked: string[];
  let stop: () => void = () => {};

  beforeEach(() => {
    resetTimeSync();
    asked = [];
    // The shell's bridge answers for the hub, whose clock runs a minute ahead.
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ serverTime: Date.now() + SKEW_MS }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetTimeSync();
  });

  it('aligns to the hub its workspace syncs through, and again after every interval', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    stop = startLanHubClock(LAN, 60_000);

    await vi.waitFor(() => expect(isTimeSynced()).toBe(true));
    expect(asked).toEqual([`${LAN}/api/time`]);
    expect(Math.abs(getServerTimeOffset() - SKEW_MS)).toBeLessThan(1_000);

    vi.advanceTimersByTime(60_000);
    expect(asked).toHaveLength(2);
    stop();
    vi.advanceTimersByTime(600_000);
    expect(asked).toHaveLength(2);
  });

  it('leaves the clock alone for a workspace without a LAN', () => {
    stop = startLanHubClock(undefined);
    startLanHubClock('https://streams.example.invalid')();

    expect(asked).toEqual([]);
    expect(isTimeSynced()).toBe(false);
  });
});
