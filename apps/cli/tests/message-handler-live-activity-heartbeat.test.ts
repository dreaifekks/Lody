import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionId, WorkspaceId } from '@lody/shared';
import type { CloudNotificationsPort } from '@lody/platform';

import { MessageHandler } from '../src/lib/message-handler';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { SessionManager } from '../src/session/session-manager';
import type { Logger } from '../src/utils/logger';
import { createTestCloudPort } from './test-cloud-port';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

const sessionId = 's-1' as SessionId;
const HEARTBEAT_MS = 120_000;

function createHandler(liveActivityHeartbeatMs: number | undefined) {
  let running = true;
  const meta = () => ({
    id: sessionId,
    userId: 'owner',
    title: 'Fix the build',
    createdAt: 1_000,
    ...(running
      ? { status: { type: 'running' }, lastRunningSeen: Date.now() }
      : { status: { type: 'idle' }, lastMessageAt: 1_000, lastReadAt: 2_000 }),
  });
  const sessionDoc = { getMetaState: vi.fn(async () => meta()) };
  const syncLiveActivitySummary = vi.fn<CloudNotificationsPort['syncLiveActivitySummary']>(
    async () => ({ sent: true, ended: false })
  );
  const notifications: CloudNotificationsPort = {
    ...(liveActivityHeartbeatMs ? { liveActivityHeartbeatMs } : {}),
    notifySessionCompleted: async () => {},
    notifyPermissionRequested: async () => {},
    recordPermissionRequested: async () => {},
    resolvePermissionRequested: async () => {},
    syncLiveActivitySummary,
  };
  const workspaceDocument = {
    sessions: new Map<SessionId, unknown>([[sessionId, sessionDoc]]),
    repo: { watch: vi.fn(() => ({ unsubscribe: vi.fn() })) },
    getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
    isTransportConnected: vi.fn(() => true),
  };
  const sessionManager = {
    on: vi.fn(),
    setRequestPermissionHandler: vi.fn(),
    hasSession: vi.fn(() => false),
    cleanUp: vi.fn(),
  };
  const handler = new MessageHandler(
    sessionManager as unknown as SessionManager,
    workspaceDocument as unknown as LoroDocumentManager,
    createSilentLogger(),
    {
      token: 't',
      workspaceId: 'ws-1' as WorkspaceId,
      workspaceSlug: 'ws-slug',
      userId: 'owner',
      machineId: 'm-1',
      machineName: 'machine',
      cliVersion: '0.0.0',
      cloudPort: createTestCloudPort({ notifications }),
    }
  );
  const sync = () =>
    (
      handler as unknown as { syncLiveActivitySummary: (userId: string) => Promise<unknown> }
    ).syncLiveActivitySummary('owner');
  const runningCount = (call: number) =>
    syncLiveActivitySummary.mock.calls[call]?.[0].statusCounts.running;
  return {
    sync,
    syncLiveActivitySummary,
    runningCount,
    stop: () => {
      running = false;
    },
  };
}

describe('MessageHandler Live Activity heartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('repeats a fresh summary while work runs and stops once it ends', async () => {
    const { sync, syncLiveActivitySummary, runningCount, stop } = createHandler(HEARTBEAT_MS);
    await sync();
    expect(syncLiveActivitySummary).toHaveBeenCalledTimes(1);
    expect(runningCount(0)).toBe(1);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(syncLiveActivitySummary).toHaveBeenCalledTimes(2);
    expect(runningCount(1)).toBe(1);

    // The turn ended without a report reaching anyone: the next beat says so.
    stop();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(syncLiveActivitySummary).toHaveBeenCalledTimes(3);
    expect(runningCount(2)).toBe(0);

    // Nothing runs, so nothing more is repeated.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(syncLiveActivitySummary).toHaveBeenCalledTimes(3);
  });

  it('keeps one beat per user however often the summary changes', async () => {
    const { sync, syncLiveActivitySummary } = createHandler(HEARTBEAT_MS);
    await sync();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS / 2);
    await sync();
    expect(syncLiveActivitySummary).toHaveBeenCalledTimes(2);
    // The beat restarted with the second summary.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS / 2);
    expect(syncLiveActivitySummary).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS / 2);
    expect(syncLiveActivitySummary).toHaveBeenCalledTimes(3);
  });

  it('does not repeat for a port without a heartbeat', async () => {
    const { sync, syncLiveActivitySummary } = createHandler(undefined);
    await sync();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(syncLiveActivitySummary).toHaveBeenCalledTimes(1);
  });
});
