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

  it('drops a late answer of the hub of a workspace the window left', async () => {
    const OTHER = `lody-hub://${'b'.repeat(32)}`;
    let answerFormer: () => void = () => {};
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url);
      if (url.startsWith(LAN)) await new Promise<void>((resolve) => (answerFormer = resolve));
      const skew = url.startsWith(LAN) ? SKEW_MS : -30_000;
      // A body that is read without waiting for I/O, so the answer settles within this task.
      return { ok: true, json: async () => ({ serverTime: Date.now() + skew }) };
    });

    const stopFormer = startLanHubClock(LAN);
    await vi.waitFor(() => expect(asked).toEqual([`${LAN}/api/time`]));
    stopFormer();
    stop = startLanHubClock(OTHER);
    await vi.waitFor(() => expect(isTimeSynced()).toBe(true));
    answerFormer();
    // Everything the former answer sets off runs before the next task.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(Math.abs(getServerTimeOffset() + 30_000)).toBeLessThan(1_000);
  });
});
