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

function createHandler(alertGraceMs: number | undefined) {
  let meta: Record<string, unknown> = { title: 'Fix the build', lastMessageAt: 1_000 };
  const sessionDoc = { getMetaState: vi.fn(async () => meta) };
  const notifySessionCompleted = vi.fn(async () => {});
  const notifications: CloudNotificationsPort = {
    ...(alertGraceMs ? { alertGraceMs } : {}),
    notifySessionCompleted,
    notifyPermissionRequested: async () => {},
    recordPermissionRequested: async () => {},
    resolvePermissionRequested: async () => {},
    syncLiveActivitySummary: async () => ({ sent: false }),
  };
  const workspaceDocument = {
    sessions: new Map<SessionId, unknown>(),
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
  const complete = () =>
    (
      handler as unknown as {
        notifySessionCompleted: (id: SessionId, userId: string, turn: string) => Promise<void>;
      }
    ).notifySessionCompleted(sessionId, 'owner', 'turn-1');
  return {
    complete,
    notifySessionCompleted,
    readOnAnotherDevice: (at: number) => {
      meta = { ...meta, lastReadAt: at };
    },
  };
}

describe('MessageHandler held completion alerts', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a completion at once without a grace period', async () => {
    const { complete, notifySessionCompleted } = createHandler(undefined);
    await complete();
    expect(notifySessionCompleted).toHaveBeenCalledTimes(1);
  });

  it('drops a held completion when another device reads the reply meanwhile', async () => {
    const { complete, notifySessionCompleted, readOnAnotherDevice } = createHandler(10_000);
    await complete();
    expect(notifySessionCompleted).not.toHaveBeenCalled();
    readOnAnotherDevice(1_500);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(notifySessionCompleted).not.toHaveBeenCalled();
  });

  it('sends a held completion nobody read', async () => {
    const { complete, notifySessionCompleted, readOnAnotherDevice } = createHandler(10_000);
    await complete();
    // Read before this reply arrived: still unread.
    readOnAnotherDevice(500);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(notifySessionCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, sessionTitle: 'Fix the build', occurrenceId: 'turn-1' })
    );
  });
});
