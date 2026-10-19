// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_DIGEST_WATCH_BUSY_MS,
  FILE_DIGEST_WATCH_IDLE_MS,
  useSessionFileDigestWatch,
} from '../src/hooks/use-session-file-digest-watch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = { enabled: boolean; busy: boolean; check: () => Promise<void> };

function Watch(props: Props) {
  useSessionFileDigestWatch(props);
  return null;
}

describe('useSessionFileDigestWatch', () => {
  let root: Root;
  let checks: Array<() => void>;
  let started: number;
  // Each check stays open until the test settles it, as a slow machine would.
  const check = () =>
    new Promise<void>((resolve) => {
      started += 1;
      checks.push(resolve);
    });
  const render = (props: Partial<Props>) =>
    act(async () => {
      root.render(createElement(Watch, { enabled: true, busy: true, check, ...props }));
    });
  const settle = async () => {
    await act(async () => {
      checks.shift()?.();
    });
  };
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    checks = [];
    started = 0;
    root = createRoot(document.createElement('div'));
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it('rechecks every 5 s while the thread works and every 15 s while it is idle', async () => {
    await render({ busy: true });
    await advance(FILE_DIGEST_WATCH_BUSY_MS - 1);
    expect(started).toBe(0);
    await advance(1);
    expect(started).toBe(1);
    await settle();
    await advance(FILE_DIGEST_WATCH_BUSY_MS);
    expect(started).toBe(2);
    await settle();

    act(() => root.unmount());
    root = createRoot(document.createElement('div'));
    started = 0;
    await render({ busy: false });
    await advance(FILE_DIGEST_WATCH_BUSY_MS);
    expect(started).toBe(0);
    await advance(FILE_DIGEST_WATCH_IDLE_MS - FILE_DIGEST_WATCH_BUSY_MS);
    expect(started).toBe(1);
  });

  it('checks once more as soon as a turn ends, then slows down', async () => {
    await render({ busy: true });
    await advance(1_000);
    await render({ busy: false });
    expect(started).toBe(1);
    await settle();
    await advance(FILE_DIGEST_WATCH_IDLE_MS - 1);
    expect(started).toBe(1);
    await advance(1);
    expect(started).toBe(2);
  });

  it('never starts a check while the previous one is still out', async () => {
    await render({ busy: true });
    await advance(FILE_DIGEST_WATCH_BUSY_MS);
    expect(started).toBe(1);
    // The turn ends mid-check: the extra check waits for the first.
    await render({ busy: false });
    await advance(FILE_DIGEST_WATCH_IDLE_MS * 2);
    expect(started).toBe(1);
    await settle();
    expect(started).toBe(2);
  });

  it('stops for good when switched off or unmounted', async () => {
    await render({ busy: true });
    await advance(FILE_DIGEST_WATCH_BUSY_MS);
    await render({ enabled: false, busy: true });
    await settle();
    await advance(FILE_DIGEST_WATCH_IDLE_MS * 4);
    expect(started).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    await render({ enabled: true, busy: true });
    act(() => root.unmount());
    root = createRoot(document.createElement('div'));
    await advance(FILE_DIGEST_WATCH_IDLE_MS * 4);
    expect(started).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
