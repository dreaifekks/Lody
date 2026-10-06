import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildLiveActivityConversationItems,
  SessionStatusFactory,
  type MachineId,
  type SessionId,
  type SessionMeta,
  type SessionStatus,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { LoroDocumentManager } from './doc';
import { SessionActivePresenceController } from './session-active-presence';
import { captureCli } from '../analytics/posthog';

vi.mock('../analytics/posthog', () => ({
  captureCli: vi.fn(),
}));

const sessionId = 'session-active-presence-1' as SessionId;
const machineId = 'machine-active-presence-1' as MachineId;

const createLogger = (): Logger =>
  ({
    debug: vi.fn(),
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as Logger;

const createWorkspaceDocument = () =>
  ({
    publishSessionPresence: vi.fn(),
    clearSessionPresence: vi.fn(),
  }) as unknown as Pick<LoroDocumentManager, 'publishSessionPresence' | 'clearSessionPresence'>;

describe('SessionActivePresenceController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('publishes fallback thinking presence on start and clears on release', () => {
    const workspaceDocument = createWorkspaceDocument();
    const controller = new SessionActivePresenceController(
      workspaceDocument as LoroDocumentManager,
      machineId,
      createLogger(),
      { intervalMs: 1_000 }
    );

    controller.start(sessionId);

    expect(workspaceDocument.publishSessionPresence).toHaveBeenCalledWith(
      sessionId,
      machineId,
      SessionStatusFactory.running()
    );

    controller.clear(sessionId);

    expect(workspaceDocument.clearSessionPresence).toHaveBeenCalledWith(sessionId);
  });

  it('updates phase through the same owner without clearing between phases', () => {
    const workspaceDocument = createWorkspaceDocument();
    const controller = new SessionActivePresenceController(
      workspaceDocument as LoroDocumentManager,
      machineId,
      createLogger(),
      { intervalMs: 1_000 }
    );

    controller.start(sessionId, 'initializing');
    controller.setPhase(sessionId, 'acp');
    controller.start(sessionId, 'thinking');
    controller.setPhase(sessionId, 'requestPermission');
    controller.setPhase(sessionId, 'requestPermission');

    expect(workspaceDocument.clearSessionPresence).not.toHaveBeenCalled();
    expect(workspaceDocument.publishSessionPresence).toHaveBeenCalledTimes(4);
    expect(workspaceDocument.publishSessionPresence).toHaveBeenLastCalledWith(
      sessionId,
      machineId,
      SessionStatusFactory.requestPermission()
    );
  });

  it('publishes managed runtime progress as initializing presence detail', () => {
    const workspaceDocument = createWorkspaceDocument();
    const controller = new SessionActivePresenceController(
      workspaceDocument as LoroDocumentManager,
      machineId,
      createLogger(),
      { intervalMs: 1_000 }
    );

    controller.start(sessionId, 'managed-runtime', 'Downloading Codex runtime 42%');
    controller.setPhase(sessionId, 'managed-runtime', 'Downloading Codex runtime 43%');

    expect(workspaceDocument.publishSessionPresence).toHaveBeenLastCalledWith(
      sessionId,
      machineId,
      SessionStatusFactory.initializing('managed-runtime', 'Downloading Codex runtime 43%')
    );
  });

  it('refreshes active presence on the heartbeat interval and stops after clear', () => {
    const workspaceDocument = createWorkspaceDocument();
    const controller = new SessionActivePresenceController(
      workspaceDocument as LoroDocumentManager,
      machineId,
      createLogger(),
      { intervalMs: 1_000 }
    );

    controller.start(sessionId, 'image_generation');
    expect(workspaceDocument.publishSessionPresence).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    expect(workspaceDocument.publishSessionPresence).toHaveBeenCalledTimes(2);

    controller.clear(sessionId);
    vi.advanceTimersByTime(2_000);

    expect(workspaceDocument.publishSessionPresence).toHaveBeenCalledTimes(2);
    expect(workspaceDocument.clearSessionPresence).toHaveBeenCalledTimes(1);
  });

  it('does not emit active_ping on start but does on the first active minute', () => {
    const workspaceDocument = createWorkspaceDocument();
    const controller = new SessionActivePresenceController(
      workspaceDocument as LoroDocumentManager,
      machineId,
      createLogger(),
      { intervalMs: 1_000 }
    );

    controller.start(sessionId, 'thinking');

    expect(captureCli).not.toHaveBeenCalled();

    vi.advanceTimersByTime(59_000);
    expect(captureCli).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(captureCli).toHaveBeenCalledTimes(1);
    expect(captureCli).toHaveBeenCalledWith(
      'app/active_ping',
      expect.objectContaining({
        active_context: 'session_turn',
      }),
      { tier: 'C' }
    );
  });

  it('keeps one heartbeat timer when start is called for an already active session', () => {
    const workspaceDocument = createWorkspaceDocument();
    const controller = new SessionActivePresenceController(
      workspaceDocument as LoroDocumentManager,
      machineId,
      createLogger(),
      { intervalMs: 1_000 }
    );

    controller.start(sessionId, 'initializing');
    controller.start(sessionId, 'acp');
    expect(workspaceDocument.publishSessionPresence).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1_000);

    expect(workspaceDocument.publishSessionPresence).toHaveBeenCalledTimes(3);
    expect(workspaceDocument.publishSessionPresence).toHaveBeenLastCalledWith(
      sessionId,
      machineId,
      SessionStatusFactory.initializing('acp')
    );
  });

  it('tracks active sessions and clears all owned entries', () => {
    const workspaceDocument = createWorkspaceDocument();
    const controller = new SessionActivePresenceController(
      workspaceDocument as LoroDocumentManager,
      machineId,
      createLogger(),
      { intervalMs: 1_000 }
    );
    const otherSessionId = 'session-active-presence-2' as SessionId;

    controller.start(sessionId, 'initializing');
    controller.start(otherSessionId, 'thinking');

    expect(controller.has(sessionId)).toBe(true);
    expect(controller.getStatus(sessionId)).toEqual(SessionStatusFactory.initializing());
    expect(controller.getStatus('missing-session' as SessionId)).toBeNull();
    expect(controller.activeSessionCount()).toBe(2);

    controller.clearAll();

    expect(controller.has(sessionId)).toBe(false);
    expect(controller.activeSessionCount()).toBe(0);
    expect(workspaceDocument.clearSessionPresence).toHaveBeenCalledWith(sessionId);
    expect(workspaceDocument.clearSessionPresence).toHaveBeenCalledWith(otherSessionId);
  });
});

describe('SessionActivePresenceController lastRunningSeen', () => {
  const START = 1_800_000_000_000;
  const HEARTBEAT_TTL_MS = 180_000;

  beforeEach(() => {
    vi.useFakeTimers({ now: START });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  /** A workspace whose session meta lives in memory, written the way the repo writes it. */
  const createWorkspace = (status: SessionStatus) => {
    let meta: Partial<SessionMeta> = {
      id: sessionId,
      userId: 'owner',
      title: 'Long build',
      createdAt: START,
      status,
      lastRunningSeen: START,
    };
    const upserts: Partial<SessionMeta>[] = [];
    const repo = {
      getDocMeta: vi.fn(async () => ({ meta })),
      upsertDocMeta: vi.fn(async (_roomId: string, patch: Partial<SessionMeta>) => {
        upserts.push(patch);
        meta = { ...meta, ...patch };
      }),
    };
    const workspaceDocument = {
      publishSessionPresence: vi.fn(),
      clearSessionPresence: vi.fn(),
      refreshSessionRunningSeen: (id: SessionId, stillActive?: () => boolean) =>
        LoroDocumentManager.prototype.refreshSessionRunningSeen.call(
          { repo } as unknown as LoroDocumentManager,
          id,
          stillActive
        ),
    } as unknown as LoroDocumentManager;
    return {
      workspaceDocument,
      upserts,
      meta: () => meta,
      setStatus: (next: SessionStatus) => {
        meta = { ...meta, status: next, lastRunningSeen: Date.now() };
      },
    };
  };
  const liveActivityStatus = (meta: Partial<SessionMeta>) =>
    buildLiveActivityConversationItems({
      sessions: [meta as SessionMeta],
      currentUserId: 'owner',
      defaultTitle: 'New Task',
      statusLabels: {
        permission: 'Permission',
        question: 'Question',
        running: 'Running',
        unread: 'Completed',
      },
      formatUpdatedAt: () => '',
    })[0]?.status ?? null;

  it('re-stamps a running session every minute and stops once presence is released', async () => {
    const workspace = createWorkspace(SessionStatusFactory.running());
    const controller = new SessionActivePresenceController(
      workspace.workspaceDocument,
      machineId,
      createLogger()
    );
    controller.start(sessionId);
    // The status write at turn start stamped it already.
    expect(workspace.upserts).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(4 * HEARTBEAT_TTL_MS);
    expect(workspace.upserts).toHaveLength(12);
    // Only the stamp is written: never the status, never awaitingUserSince.
    for (const patch of workspace.upserts) expect(Object.keys(patch)).toEqual(['lastRunningSeen']);
    expect(Date.now() - workspace.meta().lastRunningSeen!).toBeLessThanOrEqual(60_000);
    // A turn that ran far past the heartbeat TTL without a status change still runs.
    expect(liveActivityStatus(workspace.meta())).toBe('running');

    controller.clear(sessionId);
    await vi.advanceTimersByTimeAsync(4 * HEARTBEAT_TTL_MS);
    expect(workspace.upserts).toHaveLength(12);
  });

  it('keeps a session waiting for permission a permission request', async () => {
    const workspace = createWorkspace(SessionStatusFactory.running());
    const controller = new SessionActivePresenceController(
      workspace.workspaceDocument,
      machineId,
      createLogger()
    );
    controller.start(sessionId);
    await vi.advanceTimersByTimeAsync(30_000);
    workspace.setStatus(SessionStatusFactory.requestPermission());
    controller.setPhase(sessionId, 'requestPermission');

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(workspace.meta().status).toEqual(SessionStatusFactory.requestPermission());
    expect(liveActivityStatus(workspace.meta())).toBe('permission');

    controller.clear(sessionId);
  });

  it('never writes once the session went idle, and leaves its status alone', async () => {
    const workspace = createWorkspace(SessionStatusFactory.running());
    const controller = new SessionActivePresenceController(
      workspace.workspaceDocument,
      machineId,
      createLogger()
    );
    controller.start(sessionId);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(workspace.upserts).toHaveLength(1);

    // The turn ended; its presence has not been released yet.
    workspace.setStatus(SessionStatusFactory.idle());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(workspace.upserts).toHaveLength(1);
    expect(workspace.meta().status).toEqual(SessionStatusFactory.idle());
    expect(liveActivityStatus(workspace.meta())).toBeNull();

    controller.clear(sessionId);
  });
});
