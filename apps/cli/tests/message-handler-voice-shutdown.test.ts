import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfigMeta, MachineId, SessionId, WorkspaceId } from '@lody/shared';
import { MessageHandler } from '../src/lib/message-handler';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { SessionManager } from '../src/session/session-manager';
import type { Logger } from '../src/utils/logger';
import { createTestCloudPort } from './test-cloud-port';

// A voice start stuck preparing the Codex runtime (e.g. a slow first download).
const launch = vi.hoisted(() => ({ pending: 0 }));
vi.mock('@/agent/setting', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/setting')>();
  return {
    ...actual,
    resolveACPProcessLaunchAsync: (input: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        launch.pending += 1;
        input.signal?.addEventListener('abort', () => reject(input.signal?.reason), {
          once: true,
        });
      }),
  };
});

/** What `start-shutdown.ts` allows cleanup before it forces the process out. */
const SHUTDOWN_DEADLINE_MS = 15_000;

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

afterEach(() => {
  vi.useRealTimers();
  launch.pending = 0;
});

describe('MessageHandler cleanup with a voice call still starting', () => {
  it('finalizes running turns well before the shutdown deadline', async () => {
    const sessionManager = {
      on: vi.fn(),
      setRequestPermissionHandler: vi.fn(),
      getSession: vi.fn(),
      finishSession: vi.fn(),
      cleanUp: vi.fn(async () => {}),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      hasSession: vi.fn(),
      initialize: vi.fn(),
      createSession: vi.fn(),
      releaseGitHubRepoOwner: vi.fn(),
    };
    const workspaceDocument = {
      sessions: new Map<SessionId, unknown>(),
      restoreMachineDocument: vi.fn(async () => {}),
      watchMachineDocumentExistence: vi.fn(() => {}),
      registerMachine: vi.fn(async () => {}),
      repo: {
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        getDocMeta: vi.fn(async () => undefined),
      },
      getAgentConfigForMachineLaunch: vi.fn(
        async () =>
          ({
            id: 'codex-1',
            machineId: 'machine-1',
            name: 'Codex',
            cliType: 'builtin',
            agentType: 'codex',
            env: {},
          }) as unknown as AgentConfigMeta
      ),
    };
    const handler = new MessageHandler(
      sessionManager as unknown as SessionManager,
      workspaceDocument as unknown as LoroDocumentManager,
      createSilentLogger(),
      {
        token: 'token',
        workspaceId: 'workspace-1' as WorkspaceId,
        userId: 'user-1',
        machineId: 'machine-1' as MachineId,
        machineName: 'machine',
        cliVersion: '1.2.3',
        cloudPort: createTestCloudPort(),
      }
    );
    const internals = handler as unknown as {
      voiceHost: { handle: (request: unknown) => Promise<{ success: boolean }> };
      executionService: {
        getActiveTurnIds: () => Array<{ sessionId: SessionId; turnId: string }>;
        waitForTurnRelease: (sessionId: SessionId, turnId: string) => Promise<void>;
      };
      interruptedSessionSync: { record: (ids: SessionId[]) => Promise<void> } | null;
    };
    // A Claude turn is running while the daemon stops.
    const runningTurn = { sessionId: 'session-1' as SessionId, turnId: 'turn-1' };
    vi.spyOn(internals.executionService, 'getActiveTurnIds').mockReturnValue([runningTurn]);
    const released = vi
      .spyOn(internals.executionService, 'waitForTurnRelease')
      .mockResolvedValue(undefined);
    const recorded: SessionId[][] = [];
    internals.interruptedSessionSync = {
      record: async (ids) => {
        recorded.push(ids);
      },
    };

    const voiceStart = internals.voiceHost.handle({
      action: 'start',
      configId: 'codex-1',
      mode: 'conversation',
      sdp: 'offer',
    });
    await vi.waitFor(() => expect(launch.pending).toBe(1));

    vi.useFakeTimers();
    const shutdown = { finished: false };
    void handler.cleanup().then(() => {
      shutdown.finished = true;
    });
    let elapsed = 0;
    while (!shutdown.finished && elapsed < SHUTDOWN_DEADLINE_MS) {
      await vi.advanceTimersByTimeAsync(100);
      elapsed += 100;
    }

    expect(shutdown.finished).toBe(true);
    expect(elapsed).toBeLessThan(SHUTDOWN_DEADLINE_MS);
    expect(recorded).toEqual([['session-1']]);
    expect(released).toHaveBeenCalledWith('session-1', 'turn-1');
    expect(sessionManager.cleanUp).toHaveBeenCalledWith({ keepWorkspaceDocumentOpen: true });
    await expect(voiceStart).resolves.toMatchObject({ success: false });
  });
});
