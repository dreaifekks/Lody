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
import type { LoroRepo } from 'loro-repo';
import { LoroDocumentManager, SessionDocument } from './doc';
import { SessionActivePresenceController } from './session-active-presence';
import { captureCli } from '../analytics/posthog';
import { composeTestSessionDoc } from '../../../tests/session-doc-fixture';

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

  it('publishes finalizing once and keeps ownership until clear', () => {
    const workspaceDocument = createWorkspaceDocument();
    const controller = new SessionActivePresenceController(
      workspaceDocument as LoroDocumentManager,
      machineId,
      createLogger(),
      { intervalMs: 1_000 }
    );
    controller.start(sessionId, 'thinking');
    controller.setPhase(sessionId, 'finalizing');
    controller.setPhase(sessionId, 'finalizing');
    expect(controller.getStatus(sessionId)).toEqual({ type: 'running', phase: 'finalizing' });
    expect(workspaceDocument.publishSessionPresence).toHaveBeenCalledTimes(2);
    expect(workspaceDocument.publishSessionPresence).toHaveBeenLastCalledWith(
      sessionId,
      machineId,
      { type: 'running', phase: 'finalizing' }
    );
    expect(controller.has(sessionId)).toBe(true);
    controller.setPhase(sessionId, 'thinking');
    expect(controller.getStatus(sessionId)).toEqual({ type: 'running' });
    controller.clear(sessionId);
    expect(controller.getStatus(sessionId)).toBeNull();
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

  /**
   * A workspace whose session meta lives in memory, written the way the repo
   * writes it. The session document is real: the turn's status writes go
   * through it, as they do in the execution service.
   */
  const createWorkspace = async (status: SessionStatus) => {
    let meta: Partial<SessionMeta> = {
      id: sessionId,
      machineId,
      userId: 'owner',
      title: 'Long build',
      createdAt: START,
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
    const sessionDoc = new SessionDocument(
      repo as unknown as LoroRepo,
      sessionId,
      async () => {},
      createLogger()
    );
    composeTestSessionDoc(sessionDoc);
    // The turn starts the way the execution service starts it.
    await sessionDoc.setStatus(status);
    upserts.length = 0;
    const manager = {
      repo,
      logger: createLogger(),
      sessions: new Map([[sessionId, sessionDoc]]),
    };
    const workspaceDocument = {
      publishSessionPresence: vi.fn(),
      clearSessionPresence: vi.fn(),
      refreshSessionRunningSeen: (
        id: SessionId,
        options: Parameters<LoroDocumentManager['refreshSessionRunningSeen']>[1]
      ) =>
        LoroDocumentManager.prototype.refreshSessionRunningSeen.call(
          manager as unknown as LoroDocumentManager,
          id,
          options
        ),
    } as unknown as LoroDocumentManager;
    return {
      workspaceDocument,
      sessionDoc,
      upserts,
      meta: () => meta,
      /** Another LAN member writes the session meta. */
      writeElsewhere: (patch: Partial<SessionMeta>) => {
        meta = { ...meta, ...patch };
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
    const workspace = await createWorkspace(SessionStatusFactory.running());
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
    const workspace = await createWorkspace(SessionStatusFactory.running());
    const controller = new SessionActivePresenceController(
      workspace.workspaceDocument,
      machineId,
      createLogger()
    );
    controller.start(sessionId);
    await vi.advanceTimersByTimeAsync(30_000);
    await workspace.sessionDoc.setStatus(SessionStatusFactory.requestPermission());
    controller.setPhase(sessionId, 'requestPermission');

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(workspace.meta().status).toEqual(SessionStatusFactory.requestPermission());
    expect(liveActivityStatus(workspace.meta())).toBe('permission');

    controller.clear(sessionId);
  });

  it('leaves an idle this machine wrote alone while its presence is still being released', async () => {
    const workspace = await createWorkspace(SessionStatusFactory.running());
    const controller = new SessionActivePresenceController(
      workspace.workspaceDocument,
      machineId,
      createLogger()
    );
    controller.start(sessionId);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(workspace.upserts).toHaveLength(1);

    // The turn ended here; its presence has not been released yet.
    await workspace.sessionDoc.setStatus(SessionStatusFactory.idle());
    workspace.upserts.length = 0;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(workspace.upserts).toHaveLength(0);
    expect(workspace.meta().status).toEqual(SessionStatusFactory.idle());
    expect(liveActivityStatus(workspace.meta())).toBeNull();

    controller.clear(sessionId);
  });

  it('restores a running turn another member set idle on the next tick, and keeps stamping it', async () => {
    const workspace = await createWorkspace(SessionStatusFactory.running());
    const controller = new SessionActivePresenceController(
      workspace.workspaceDocument,
      machineId,
      createLogger()
    );
    controller.start(sessionId);
    await vi.advanceTimersByTimeAsync(60_000);

    // A member that only viewed the session quits and ends it.
    workspace.writeElsewhere({ status: SessionStatusFactory.idle() });
    expect(liveActivityStatus(workspace.meta())).toBeNull();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(workspace.meta().status).toEqual(SessionStatusFactory.running());
    expect(Date.now() - workspace.meta().lastRunningSeen!).toBeLessThanOrEqual(30_000);
    expect(liveActivityStatus(workspace.meta())).toBe('running');

    // The heartbeat carries on long past the TTL.
    await vi.advanceTimersByTimeAsync(4 * HEARTBEAT_TTL_MS);
    expect(Date.now() - workspace.meta().lastRunningSeen!).toBeLessThanOrEqual(60_000);
    expect(liveActivityStatus(workspace.meta())).toBe('running');

    // Once this turn ends here, its idle stands.
    await workspace.sessionDoc.setStatus(SessionStatusFactory.idle());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(workspace.meta().status).toEqual(SessionStatusFactory.idle());
    controller.clear(sessionId);
  });

  it('restores a permission wait as a permission wait', async () => {
    const workspace = await createWorkspace(SessionStatusFactory.running());
    const controller = new SessionActivePresenceController(
      workspace.workspaceDocument,
      machineId,
      createLogger()
    );
    controller.start(sessionId);
    await workspace.sessionDoc.setStatus(SessionStatusFactory.requestPermission());
    controller.setPhase(sessionId, 'requestPermission');

    workspace.writeElsewhere({ status: SessionStatusFactory.idle() });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(workspace.meta().status).toEqual(SessionStatusFactory.requestPermission());
    expect(liveActivityStatus(workspace.meta())).toBe('permission');
    controller.clear(sessionId);
  });

  it('restores nothing once presence was released, or for an archived session', async () => {
    const released = await createWorkspace(SessionStatusFactory.running());
    const releasedController = new SessionActivePresenceController(
      released.workspaceDocument,
      machineId,
      createLogger()
    );
    releasedController.start(sessionId);
    released.writeElsewhere({ status: SessionStatusFactory.idle() });
    releasedController.clear(sessionId);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(released.meta().status).toEqual(SessionStatusFactory.idle());

    const archived = await createWorkspace(SessionStatusFactory.running());
    const archivedController = new SessionActivePresenceController(
      archived.workspaceDocument,
      machineId,
      createLogger()
    );
    archivedController.start(sessionId);
    archived.writeElsewhere({ status: SessionStatusFactory.idle(), isArchived: true });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(archived.meta().status).toEqual(SessionStatusFactory.idle());
    archivedController.clear(sessionId);
  });
});
