import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanHub } from '@lody/shared/node/lan-hub';
import { createLanNotificationsPort, LAN_LIVE_ACTIVITY_HEARTBEAT_MS } from './lan-push-notifier';

const WORKSPACE = 'lw_0123456789abcdef0123456789abcdef';
const USER = 'local:0123456789abcdef0123456789abcdef';
const ACTIVITY = `lody-conversations:v5:${WORKSPACE}:${USER}`;
const HUB: LanHub = { id: 'x'.repeat(32), name: 'Home', url: 'http://hub.test', token: 't' };

describe('LAN notifications port', () => {
  let reports: Record<string, unknown>[];
  /** What the hub answers; `null` while it cannot be reached. */
  let answer: number | null;

  beforeEach(() => {
    vi.useFakeTimers();
    reports = [];
    answer = null;
  });
  afterEach(() => vi.useRealTimers());

  const port = () =>
    createLanNotificationsPort({
      resolveHub: () => HUB,
      machineId: 'machine-1',
      logger: { debug: () => {} } as never,
      fetch: async (_url, init) => {
        reports.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (answer === null) throw new TypeError('fetch failed');
        return new Response(JSON.stringify({ sent: true, ended: false }), { status: answer });
      },
    });
  const summary = (updatedAt: number) => ({
    activityId: ACTIVITY,
    workspaceId: WORKSPACE as never,
    userId: USER,
    totalCount: 0,
    statusCounts: { permission: 0, question: 0, running: 0, unread: 0 },
    items: [],
    updatedAt,
  });
  const sentAt = () => reports.map((report) => report.updatedAt);

  it('asks for a summary every two minutes while work runs', () => {
    expect(port().liveActivityHeartbeatMs).toBe(LAN_LIVE_ACTIVITY_HEARTBEAT_MS);
    expect(LAN_LIVE_ACTIVITY_HEARTBEAT_MS).toBe(120_000);
  });

  it('sends the latest summary again until the hub takes it', async () => {
    const notifications = port();
    expect(await notifications.syncLiveActivitySummary(summary(1))).toEqual({
      sent: false,
      reason: 'hub_unavailable',
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sentAt()).toEqual([1, 1]);

    // A newer summary takes the place of the one waiting.
    await notifications.syncLiveActivitySummary(summary(2));
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sentAt()).toEqual([1, 1, 2, 2, 2]);

    answer = 200;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sentAt()).toEqual([1, 1, 2, 2, 2, 2]);
    // Taken: nothing more is sent.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(reports).toHaveLength(6);
  });

  it('backs off to the heartbeat and gives up after a while', async () => {
    const notifications = port();
    await notifications.syncLiveActivitySummary(summary(1));
    await vi.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000 + 40_000 + 80_000);
    expect(reports).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(LAN_LIVE_ACTIVITY_HEARTBEAT_MS);
    expect(reports).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(reports).toHaveLength(31);
  });

  it('retries a hub that is moving, not one without push', async () => {
    answer = 404;
    await port().syncLiveActivitySummary(summary(1));
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(reports).toHaveLength(1);

    answer = 503;
    await port().syncLiveActivitySummary(summary(2));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sentAt()).toEqual([1, 2, 2]);
  });

  it('tells the hub a permission request was answered', async () => {
    answer = 200;
    await port().resolvePermissionRequested({
      sessionId: 'session-1' as never,
      sessionTitle: 'Deploy',
      workspaceId: WORKSPACE as never,
      workspaceSlug: 'lan',
      userId: USER,
      requestId: 'req-1',
      toolCallId: 'tool-1',
    });
    expect(reports).toEqual([
      {
        type: 'permission-resolved',
        sessionId: 'session-1',
        requestId: 'req-1',
        sessionTitle: 'Deploy',
        workspaceId: WORKSPACE,
        workspaceSlug: 'lan',
        userId: USER,
        machineId: 'machine-1',
        machineName: null,
      },
    ]);
  });
});
