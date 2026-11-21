import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import type { ACPSessionId, AcpSessionNotification, SessionId } from '@lody/shared';
import type { NativeAgentWork } from './agent-client';

const mockState = vi.hoisted(() => ({
  abortController: new AbortController(),
  client: null as acp.Client | null,
  initialize: vi.fn(),
  newSession: vi.fn(),
  loadSession: vi.fn(),
  resumeSession: vi.fn(),
  listSessions: vi.fn(),
  prompt: vi.fn(),
  cancel: vi.fn(),
  closeSession: vi.fn(),
  setSessionConfigOption: vi.fn(),
}));

vi.mock('@agentclientprotocol/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentclientprotocol/sdk')>();
  return {
    ...actual,
    ClientSideConnection: class MockClientSideConnection {
      signal = mockState.abortController.signal;
      initialize = mockState.initialize;
      newSession = mockState.newSession;
      loadSession = mockState.loadSession;
      resumeSession = mockState.resumeSession;
      listSessions = mockState.listSessions;
      prompt = mockState.prompt;
      cancel = mockState.cancel;
      closeSession = mockState.closeSession;
      setSessionConfigOption = mockState.setSessionConfigOption;

      constructor(toClient: (agent: unknown) => acp.Client) {
        mockState.client = toClient(this);
      }
    },
  };
});

import { AgentClient } from './agent-client';
import {
  DEFAULT_ANTIGRAVITY_POLL_TIMINGS,
  type AntigravityPollTimings,
} from './antigravity-background';
import type { Logger } from '../utils/logger';

function createSilentLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
    debug: () => {},
    trace: () => {},
    setLevel: () => {},
    setDebug: () => {},
    child: () => createSilentLogger(),
    close: async () => {},
  };
}

function makeNotification(
  sessionId: string,
  update: Record<string, unknown>
): acp.SessionNotification {
  return {
    sessionId,
    update,
  } as unknown as acp.SessionNotification;
}

async function emitToLiveClient(notification: acp.SessionNotification): Promise<void> {
  if (!mockState.client) throw new Error('ACP client not connected');
  await mockState.client.sessionUpdate(notification);
}

function createHarness(options?: {
  agentConfig?: { cliType: 'builtin' | 'custom' | 'registry'; agentType: string; name?: string };
  timings?: Partial<AntigravityPollTimings>;
}) {
  const updates: AcpSessionNotification[] = [];
  const workChanges: NativeAgentWork[] = [];
  const usageUpdates: unknown[] = [];
  const permissionRequests: unknown[] = [];
  const contextUpdates: unknown[] = [];

  const client = new AgentClient({
    sessionId: 'ag-test-session' as SessionId,
    logger: createSilentLogger(),
    terminalManager: {} as never,
    agentConfig: options?.agentConfig ?? { cliType: 'builtin', agentType: 'antigravity' },
    antigravityPollTimings: options?.timings,
    onUpdateMessage: (msg) => {
      updates.push(msg);
    },
    onNativeWorkChanged: (work) => {
      workChanges.push(work);
    },
    onContextWindowUsageUpdate: (usage) => {
      contextUpdates.push(usage);
    },
    onUsageUpdate: (usage) => {
      usageUpdates.push(usage);
    },
    onRequestPermission: async (_requestId, params) => {
      permissionRequests.push(params);
      return { outcome: { outcome: 'cancelled' } };
    },
  });

  return { client, updates, workChanges, usageUpdates, permissionRequests, contextUpdates };
}

function defaultInitResponse(overrides?: Record<string, unknown>): acp.InitializeResponse {
  return {
    protocolVersion: 1,
    agentInfo: { name: 'Antigravity ACP Server', version: '1.5.9' },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: {
        load: {},
        list: {},
        resume: {},
        close: {},
      },
    },
    ...overrides,
  } as acp.InitializeResponse;
}

describe('Antigravity ACP v1 background lifecycle and GC protection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    vi.resetAllMocks();
    mockState.abortController = new AbortController();
    mockState.client = null;
    mockState.initialize.mockResolvedValue(defaultInitResponse());
    mockState.newSession.mockResolvedValue({
      sessionId: 'agy-sess-1',
      models: {
        currentModelId: 'gemini-3-pro',
        availableModels: [{ modelId: 'gemini-3-pro', name: 'Gemini 3 Pro' }],
      },
    });
    mockState.loadSession.mockResolvedValue({});
    mockState.resumeSession.mockResolvedValue({});
    mockState.listSessions.mockResolvedValue({ sessions: [] });
    mockState.prompt.mockResolvedValue({ stopReason: 'end_turn' });
    mockState.cancel.mockResolvedValue({});
    mockState.closeSession.mockResolvedValue({});
    mockState.setSessionConfigOption.mockResolvedValue({});
  });

  afterEach(() => {
    // Ends any post-turn monitor through the connection's own abort signal.
    mockState.abortController.abort();
    vi.useRealTimers();
  });

  it('enables parity for builtin antigravity and custom Antigravity ACP Server while excluding legacy antigravity-acp', async () => {
    const elicitationParams: acp.CreateElicitationRequest = {
      sessionId: 'agy-sess-1',
      mode: 'form',
      message: 'Choose an option',
      requestedSchema: {
        type: 'object',
        properties: {
          q1: {
            type: 'string',
            title: 'Which mode?',
            oneOf: [
              { const: '1', title: 'Fast' },
              { const: '2', title: 'Safe' },
            ],
          },
          q1_other: {
            type: 'string',
            title: 'Other',
          },
        },
        required: ['q1'],
      },
    } as unknown as acp.CreateElicitationRequest;

    const builtin = createHarness({
      agentConfig: { cliType: 'builtin', agentType: 'antigravity' },
    });
    await builtin.client.startSession({} as never, '/synthetic/project');
    expect(builtin.client.reportsSessionActivity()).toBe(true);
    expect(builtin.client.getNativeActivityObservation()).toBe('idle');

    const customModern = createHarness({
      agentConfig: { cliType: 'custom', agentType: 'my-agy' },
    });
    await customModern.client.startSession({} as never, '/synthetic/project');
    expect(customModern.client.reportsSessionActivity()).toBe(true);
    expect(customModern.client.getNativeActivityObservation()).toBe('idle');

    // Tool normalization (`update.name` -> `_meta.lody.toolName`), elicitation bridge, and prompt usage all work on custom modern server.
    mockState.prompt.mockResolvedValueOnce({
      stopReason: 'end_turn',
      usage: { inputTokens: 20, outputTokens: 10, thoughtTokens: 4, totalTokens: 34 },
    });
    await emitToLiveClient(
      makeNotification('agy-sess-1', {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-custom-1',
        name: 'run_command',
        status: 'completed',
        title: 'Run echo',
        rawInput: { CommandLine: 'echo ok' },
      })
    );
    expect(customModern.updates[0]?.update).toMatchObject({
      sessionUpdate: 'tool_call',
      _meta: { lody: { toolName: 'run_command' } },
    });
    await customModern.client.unstable_createElicitation(elicitationParams);
    expect(customModern.permissionRequests).toHaveLength(1);
    const customModernQuestions = (
      customModern.permissionRequests[0] as {
        _meta?: { lody?: { elicitation?: { questions?: Array<Record<string, unknown>> } } };
      }
    )._meta?.lody?.elicitation?.questions;
    expect(customModernQuestions?.[0]).toMatchObject({
      id: 'q1',
      header: '',
      question: 'Which mode?',
    });
    await customModern.client.prompt('agy-sess-1' as ACPSessionId, [{ type: 'text', text: 'hi' }]);
    await Promise.resolve();
    expect(customModern.usageUpdates).toHaveLength(1);

    // Legacy `antigravity-acp` (1.4.5) must stay completely untouched.
    mockState.initialize.mockResolvedValueOnce(
      defaultInitResponse({
        agentInfo: { name: 'antigravity-acp', version: '1.4.5' },
      })
    );
    const customLegacy = createHarness({
      agentConfig: { cliType: 'custom', agentType: 'legacy-agy' },
    });
    await customLegacy.client.startSession({} as never, '/synthetic/project');
    expect(customLegacy.client.reportsSessionActivity()).toBe(false);
    expect(customLegacy.client.getNativeActivityObservation()).toBe('unknown');
    await expect(
      customLegacy.client.unstable_createElicitation(elicitationParams)
    ).resolves.toEqual({ action: 'cancel' });
    const customLegacyQuestions = (
      customLegacy.permissionRequests[0] as {
        _meta?: { lody?: { elicitation?: { questions?: Array<Record<string, unknown>> } } };
      }
    )._meta?.lody?.elicitation?.questions;
    expect(customLegacyQuestions?.[0]).toMatchObject({
      header: 'Which mode?',
      question: 'Choose an option',
    });
    expect(customLegacyQuestions?.[0]?.id).toBeUndefined();
    await emitToLiveClient(
      makeNotification('agy-sess-1', {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-legacy-1',
        name: 'run_command',
        status: 'completed',
        title: 'Legacy run',
      })
    );
    expect((customLegacy.updates[0]?.update as { _meta?: unknown })._meta).toBeUndefined();
  });

  /** A fake agy session: `session/list` reports `updatedAt`; Lody must never call `session/load`. */
  function installTranscript() {
    const transcript = { updatedAt: '2026-01-01T00:00:00Z' };
    mockState.listSessions.mockImplementation(async () => ({
      sessions: [
        { sessionId: 'agy-sess-1', cwd: '/synthetic/project', updatedAt: transcript.updatedAt },
      ],
    }));
    let wakeups = 0;
    /** agy wakes the model: `updatedAt` moves, then stays still. */
    const wakeUp = () => {
      wakeups += 1;
      transcript.updatedAt = `2026-01-01T01:00:${String(wakeups).padStart(2, '0')}Z`;
    };
    return { wakeUp };
  }

  const n = (update: Record<string, unknown>) => makeNotification('agy-sess-1', update);
  const say = (text: string) =>
    n({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  const tool = (
    toolCallId: string,
    name: string,
    status: string,
    extra: Record<string, unknown> = {}
  ) => n({ sessionUpdate: 'tool_call', toolCallId, name, status, title: name, ...extra });
  const toolUpdate = (toolCallId: string, status: string, extra: Record<string, unknown> = {}) =>
    n({ sessionUpdate: 'tool_call_update', toolCallId, status, ...extra });

  function promptOnce(live: acp.SessionNotification[]) {
    mockState.prompt.mockImplementationOnce(async () => {
      for (const item of live) await emitToLiveClient(item);
      return { stopReason: 'end_turn' };
    });
  }

  function send(harness: ReturnType<typeof createHarness>, text: string) {
    return harness.client.prompt('agy-sess-1' as ACPSessionId, [{ type: 'text', text }]);
  }

  const { listPollIntervalMs, wakeupQuietMs } = DEFAULT_ANTIGRAVITY_POLL_TIMINGS;
  /** Long enough for a wakeup to be seen by `session/list` and then go quiet. */
  const WAKEUP_DONE = listPollIntervalMs * 2 + wakeupQuietMs;

  it('ends the turn at end_turn and keeps the process protected until the background work has woken agy', async () => {
    const harness = createHarness();
    const { wakeUp } = installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    // A turn with only foreground tools never polls.
    promptOnce([tool('cmd-1', 'run_command', 'completed', { rawOutput: { Stdout: 'v22' } })]);
    await send(harness, 'Check version');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockState.listSessions).not.toHaveBeenCalled();
    expect(harness.client.getNativeWork()).toBeNull();

    // The command still runs when agy ends the prompt; the turn ends anyway.
    promptOnce([
      tool('cmd-2', 'run_command', 'in_progress', { rawInput: { CommandLine: 'pnpm test' } }),
    ]);
    await expect(send(harness, 'Run suite')).resolves.toEqual({ stopReason: 'end_turn' });
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    // A long silent command stays protected well past the idle GC timeout.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    // It finishes and agy wakes the model: running while the transcript moves, then released.
    wakeUp();
    await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'running', backgroundTaskCount: 1 });
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(harness.client.getNativeWork()).toBeNull();
    expect(harness.workChanges).toEqual([
      { kind: 'background', backgroundTaskCount: 1 },
      { kind: 'running', backgroundTaskCount: 1 },
      { kind: 'background', backgroundTaskCount: 1 },
      null,
    ]);

    const listCalls = mockState.listSessions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockState.listSessions.mock.calls.length).toBe(listCalls);
    // agy restarts the session's MCP servers on every load.
    expect(mockState.loadSession).not.toHaveBeenCalled();
  });

  it('waits for one wakeup per pending item, counting dispatched subagents', async () => {
    const harness = createHarness();
    const { wakeUp } = installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    // invoke_subagent completes on dispatch; each result arrives only by waking the model.
    promptOnce([
      tool('sub-1', 'invoke_subagent', 'completed', { rawOutput: { ok: true } }),
      tool('sub-2', 'invoke_subagent', 'completed', { rawOutput: { ok: true } }),
      say('Dispatched.'),
    ]);
    await send(harness, 'Research');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 2 });

    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(harness.client.getNativeWork()).toBeNull();
    expect(harness.workChanges).toEqual([
      { kind: 'background', backgroundTaskCount: 2 },
      { kind: 'running', backgroundTaskCount: 2 },
      { kind: 'background', backgroundTaskCount: 2 },
      { kind: 'background', backgroundTaskCount: 1 },
      { kind: 'running', backgroundTaskCount: 1 },
      { kind: 'background', backgroundTaskCount: 1 },
      null,
    ]);
  });

  it('protects a pending schedule until the 24-hour cap when it never wakes agy', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    // agy keeps a timer in_progress until it fires.
    promptOnce([
      tool('sched-1', 'schedule', 'in_progress', { rawInput: { DurationSeconds: 86_400 * 2 } }),
    ]);
    await send(harness, 'Remind me in two days');
    await vi.advanceTimersByTimeAsync(23 * 60 * 60_000);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });
    await vi.advanceTimersByTimeAsync(60 * 60_000 + listPollIntervalMs);
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('keeps protecting when session/list keeps failing rather than releasing early', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');
    mockState.listSessions.mockRejectedValue(new Error('transport hiccup'));

    promptOnce([tool('cmd-1', 'run_command', 'in_progress')]);
    await send(harness, 'Run');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });
  });

  it('does not protect daemon processes or failed tools', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');
    promptOnce([
      tool('dev-1', 'run_command', 'in_progress', { rawInput: { IsDaemon: true } }),
      tool('sub-1', 'invoke_subagent', 'failed'),
    ]);
    await send(harness, 'Start the dev server');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockState.listSessions).not.toHaveBeenCalled();
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('keeps protecting earlier background work after the user sends another message', async () => {
    const harness = createHarness();
    const { wakeUp } = installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([tool('cmd-1', 'run_command', 'in_progress')]);
    await send(harness, 'Run suite');
    await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);

    // The next turn has no background work of its own; the command is still running.
    promptOnce([say('README read.')]);
    await send(harness, 'Read the README');
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(harness.client.getNativeWork()).toBeNull();

    // Once released, a later turn inherits nothing.
    promptOnce([say('Welcome')]);
    await send(harness, 'Thanks');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('negotiates the realpath of a symlinked workdir with Antigravity only', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-agy-symlink-test-'));
    const realTarget = path.join(tempRoot, 'real-ws');
    const symlinkWs = path.join(tempRoot, 'symlink-ws');
    fs.mkdirSync(realTarget, { recursive: true });
    fs.symlinkSync(realTarget, symlinkWs);
    const canonicalWs = fs.realpathSync(symlinkWs);
    const cwds = { new: [] as string[], list: [] as string[] };
    mockState.newSession.mockImplementation(async (params: { cwd: string }) => {
      cwds.new.push(params.cwd);
      return { sessionId: 'agy-sess-1' };
    });
    mockState.listSessions.mockImplementation(async (params: { cwd: string }) => {
      cwds.list.push(params.cwd);
      return { sessions: [{ sessionId: 'agy-sess-1', cwd: params.cwd, updatedAt: 'x' }] };
    });

    try {
      const agy = createHarness();
      await agy.client.startSession({} as never, symlinkWs);
      promptOnce([tool('sched-1', 'schedule', 'in_progress')]);
      await send(agy, 'Schedule');
      await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);
      expect(cwds.new[0]).toBe(canonicalWs);
      expect(cwds.list[0]).toBe(canonicalWs);

      // A missing workdir is passed through unchanged.
      await createHarness().client.startSession({} as never, '/synthetic/does-not-exist');
      expect(cwds.new[1]).toBe('/synthetic/does-not-exist');

      // Other agents keep the path they were given.
      mockState.initialize.mockResolvedValueOnce(
        defaultInitResponse({ agentInfo: { name: 'Other ACP Server', version: '1.0.0' } })
      );
      const other = createHarness({ agentConfig: { cliType: 'builtin', agentType: 'claude' } });
      await other.client.startSession({} as never, symlinkWs);
      expect(cwds.new[2]).toBe(symlinkWs);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('preserves unsettled native work on closeSession and connection abort instead of flipping to idle', async () => {
    const closeHarness = createHarness();
    installTranscript();
    await closeHarness.client.startSession({} as never, '/synthetic/project');
    promptOnce([tool('cmd-1', 'run_command', 'in_progress')]);
    await send(closeHarness, 'Run');
    expect(closeHarness.client.getNativeWork()).toEqual({
      kind: 'background',
      backgroundTaskCount: 1,
    });
    expect(closeHarness.client.hasUnsettledNativeWork()).toBe(true);

    await closeHarness.client.closeSession('agy-sess-1' as ACPSessionId);
    await Promise.resolve();
    expect(closeHarness.client.getNativeWork()).toEqual({
      kind: 'background',
      backgroundTaskCount: 1,
    });
    expect(closeHarness.client.hasUnsettledNativeWork()).toBe(true);
    expect(closeHarness.workChanges).toEqual([{ kind: 'background', backgroundTaskCount: 1 }]);

    mockState.abortController = new AbortController();
    const abortHarness = createHarness();
    installTranscript();
    await abortHarness.client.startSession({} as never, '/synthetic/project');
    promptOnce([tool('cmd-2', 'run_command', 'in_progress')]);
    await send(abortHarness, 'Run');
    expect(abortHarness.client.getNativeWork()).toEqual({
      kind: 'background',
      backgroundTaskCount: 1,
    });

    mockState.abortController.abort();
    await Promise.resolve();
    expect(abortHarness.client.getNativeWork()).toEqual({
      kind: 'background',
      backgroundTaskCount: 1,
    });
    expect(abortHarness.client.hasUnsettledNativeWork()).toBe(true);
    expect(abortHarness.workChanges).toEqual([{ kind: 'background', backgroundTaskCount: 1 }]);
  });

  it('injects _meta.lody.backgroundTaskId from placeholder output and normalizes run_command CommandLine', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      n({
        sessionUpdate: 'tool_call',
        toolCallId: 'bg-cmd-1',
        name: 'run_command',
        title: 'Run tests',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'pnpm test', Cwd: '/synthetic/project' },
      }),
      n({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'bg-cmd-1',
        status: 'completed',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: 'Tool is running as a background task with task id: task-abc_123.',
            },
          },
        ],
      }),
    ]);

    await send(harness, 'Run tests');
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    const initialUpdate = harness.updates.find(
      (msg) => msg.update.sessionUpdate === 'tool_call' && msg.update.toolCallId === 'bg-cmd-1'
    );
    expect(initialUpdate?.update).toMatchObject({
      rawInput: {
        CommandLine: 'pnpm test',
        Cwd: '/synthetic/project',
        command: 'pnpm test',
        cwd: '/synthetic/project',
      },
      _meta: { lody: { toolName: 'run_command' } },
    });

    const bgUpdate = harness.updates.find(
      (msg) =>
        msg.update.sessionUpdate === 'tool_call_update' && msg.update.toolCallId === 'bg-cmd-1'
    );
    expect(bgUpdate?.update).toMatchObject({
      _meta: { lody: { backgroundTaskId: 'task-abc_123' } },
    });
  });

  it('ignores placeholder phrases in read/edit/multi-line/multi-block/failed outputs and rejects oversized task ids', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    const oversizedId = 'task-' + 'x'.repeat(130);

    promptOnce([
      // Read tool whose content quotes the exact placeholder line must not be tagged or counted.
      n({
        sessionUpdate: 'tool_call',
        toolCallId: 'read-1',
        name: 'read_file',
        title: 'Read antigravity-background.ts',
        kind: 'read',
        status: 'in_progress',
      }),
      n({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'read-1',
        status: 'completed',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: 'Tool is running as a background task with task id: quoted-from-read.',
            },
          },
        ],
      }),
      // Command tool returning multi-line file contents quoting the phrase must not be tagged or counted.
      n({
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-multiline',
        name: 'run_command',
        title: 'Run cat file.txt',
        kind: 'execute',
        status: 'completed',
        rawOutput:
          'line 1\nTool is running as a background task with task id: quoted-multiline\nline 3',
      }),
      // Command tool returning multi-block content with a placeholder line must not be tagged or counted.
      n({
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-multiblock',
        name: 'run_command',
        title: 'Run inspect',
        kind: 'execute',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'Header' } },
          {
            type: 'content',
            content: {
              type: 'text',
              text: 'Tool is running as a background task with task id: quoted-multiblock.',
            },
          },
        ],
      }),
      // Failed tool emitting a placeholder line must not be tagged or counted.
      n({
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-failed',
        name: 'run_command',
        title: 'Run failing command',
        kind: 'execute',
        status: 'failed',
        rawOutput: 'Tool is running as a background task with task id: failed-task.',
      }),
      // Command tool with an oversized (>128 chars) task id is rejected for metadata (no silent truncation)
      // while still counting toward background protection.
      n({
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-oversized',
        name: 'run_command',
        title: 'Run long job',
        kind: 'execute',
        status: 'in_progress',
      }),
      n({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'cmd-oversized',
        status: 'completed',
        rawOutput: `Tool is running as a background task with task id: ${oversizedId}.`,
      }),
    ]);

    await send(harness, 'Inspect files and run job');

    // Only cmd-oversized counted as background work; read-1, cmd-multiline, cmd-multiblock, cmd-failed did not.
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    for (const [sessionUpdate, toolCallId] of [
      ['tool_call_update', 'read-1'],
      ['tool_call', 'cmd-multiline'],
      ['tool_call', 'cmd-multiblock'],
      ['tool_call', 'cmd-failed'],
      ['tool_call_update', 'cmd-oversized'],
    ] as const) {
      const matched = harness.updates.find(
        (msg) => msg.update.sessionUpdate === sessionUpdate && msg.update.toolCallId === toolCallId
      );
      expect(
        (matched?.update as { _meta?: { lody?: { backgroundTaskId?: string } } })?._meta?.lody
          ?.backgroundTaskId
      ).toBeUndefined();
    }
  });

  it('retains unsettled marker when the 24-hour protection cap releases GC until a new turn starts', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('sched-1', 'schedule', 'in_progress', { rawInput: { DurationSeconds: 86_400 * 2 } }),
    ]);
    await send(harness, 'Remind me in two days');
    await vi.advanceTimersByTimeAsync(
      DEFAULT_ANTIGRAVITY_POLL_TIMINGS.maxDurationMs + listPollIntervalMs
    );
    expect(harness.client.getNativeWork()).toBeNull();
    expect(harness.client.hasUnsettledNativeWork()).toBe(true);

    promptOnce([say('Done.')]);
    await send(harness, 'Status');
    expect(harness.client.hasUnsettledNativeWork()).toBe(false);
  });

  it('ignores non-placeholder matches in command output or non-background tools while keeping strict single-line placeholders protected', async () => {
    const harness = createHarness();
    const { wakeUp } = installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      // Multi-line stdout quoting the placeholder phrase in prose (18fea9f4).
      tool('cmd-quote', 'run_command', 'completed', {
        rawOutput:
          'Summary:\n匹配 `Tool is running as a background task with task id:` 以及其他日志\nDone.',
      }),
      // Source regex matching the placeholder phrase (6d6cc698).
      tool('cmd-regex', 'run_command', 'completed', {
        rawOutput:
          'const BG_TASK_PLACEHOLDER_PATTERN = /Tool is running as a background task with task id:\\s*\\S+/i;',
      }),
      // Unit-test literal line containing quotes and trailing comma (f334318e).
      tool('cmd-test-line', 'run_command', 'completed', {
        rawOutput: "'Tool is running as a background task with task id: task-abc_123.',",
      }),
      // Single-line real placeholder returned by a read tool must never be treated as background work.
      tool('read-1', 'read_file', 'completed', {
        kind: 'read',
        rawOutput: 'Tool is running as a background task with task id: task-abc_123.',
      }),
      // Single-line output with extra trailing text after the task id.
      tool('cmd-extra', 'run_command', 'completed', {
        rawOutput: 'Tool is running as a background task with task id: task-abc_123. trailing text',
      }),
    ]);
    await send(harness, 'Inspect logs and files');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.client.getNativeWork()).toBeNull();
    expect(mockState.listSessions).not.toHaveBeenCalled();

    // A genuine single-line placeholder from run_command is still recognized and protected.
    promptOnce([
      tool('cmd-real-bg', 'run_command', 'completed', {
        rawOutput: 'Tool is running as a background task with task id: task-abc_123.',
      }),
    ]);
    await send(harness, 'Start background build');
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });
    await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);

    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('does not start the monitor when tools transition out of in_progress before end_turn', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('cmd-1', 'run_command', 'in_progress'),
      toolUpdate('cmd-1', 'completed', { rawOutput: 'finished output' }),
      tool('cmd-2', 'run_command', 'in_progress', {
        rawOutput: 'Tool is running as a background task with task id: task-42.',
      }),
      toolUpdate('cmd-2', 'completed', { rawOutput: 'real output' }),
      tool('cmd-3', 'run_command', 'in_progress'),
      toolUpdate('cmd-3', 'failed', { rawOutput: 'exit code 1' }),
    ]);
    await send(harness, 'Run commands');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.client.getNativeWork()).toBeNull();
    expect(mockState.listSessions).not.toHaveBeenCalled();
  });

  it('settles a cross-turn pending tool when its terminal update arrives during the next turn', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    // Turn 1 leaves cmd-1 running in the background.
    promptOnce([tool('cmd-1', 'run_command', 'in_progress')]);
    await send(harness, 'Run long task');
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });
    await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);

    // Turn 2 receives cmd-1's completion mid-turn and finishes cleanly.
    promptOnce([toolUpdate('cmd-1', 'completed', { rawOutput: 'done' }), say('Task completed.')]);
    await send(harness, 'Check status');
    expect(harness.client.getNativeWork()).toBeNull();

    const listCallsAfterTurn2 = mockState.listSessions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.client.getNativeWork()).toBeNull();
    expect(mockState.listSessions.mock.calls.length).toBe(listCallsAfterTurn2);
  });

  it('keeps unresolved cross-turn tools protected and does not double-count async dispatch updates', async () => {
    const toolHarness = createHarness();
    installTranscript();
    await toolHarness.client.startSession({} as never, '/synthetic/project');

    promptOnce([tool('cmd-1', 'run_command', 'in_progress')]);
    await send(toolHarness, 'Start job');
    expect(toolHarness.client.getNativeWork()).toEqual({
      kind: 'background',
      backgroundTaskCount: 1,
    });

    promptOnce([say('Still running.')]);
    await send(toolHarness, 'Anything else?');
    expect(toolHarness.client.getNativeWork()).toEqual({
      kind: 'background',
      backgroundTaskCount: 1,
    });

    // A repeated update for the same async-dispatch toolCallId in a later turn must not increment pendingWakeups twice.
    const subHarness = createHarness();
    const { wakeUp } = installTranscript();
    await subHarness.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('sub-1', 'invoke_subagent', 'completed', { rawOutput: { ok: true } }),
      say('Dispatched.'),
    ]);
    await send(subHarness, 'Launch subagent');
    expect(subHarness.client.getNativeWork()).toEqual({
      kind: 'background',
      backgroundTaskCount: 1,
    });

    promptOnce([
      toolUpdate('sub-1', 'completed', { _meta: { lody: { toolName: 'invoke_subagent' } } }),
      say('Checked.'),
    ]);
    await send(subHarness, 'Check subagent');
    expect(subHarness.client.getNativeWork()).toEqual({
      kind: 'background',
      backgroundTaskCount: 1,
    });
    await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);

    // Only one wakeup is required to settle sub-1.
    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(subHarness.client.getNativeWork()).toBeNull();
  });

  it('handles agy 1.5.10 post-end_turn live completions for single, merged, and staggered tasks', async () => {
    // 1. Single task completes live post-turn: stays running during reply, settles after wakeupQuietMs.
    const single = createHarness();
    installTranscript();
    await single.client.startSession({} as never, '/synthetic/project');

    promptOnce([tool('cmd-1', 'run_command', 'in_progress')]);
    await send(single, 'Run build');
    expect(single.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    await vi.advanceTimersByTimeAsync(10_000);
    await emitToLiveClient(toolUpdate('cmd-1', 'completed', { rawOutput: 'ok' }));
    await vi.advanceTimersByTimeAsync(listPollIntervalMs);
    expect(single.client.getNativeWork()).toEqual({ kind: 'running', backgroundTaskCount: 1 });

    await emitToLiveClient(say('Build succeeded.'));
    await vi.advanceTimersByTimeAsync(DEFAULT_ANTIGRAVITY_POLL_TIMINGS.runningGraceMs / 2);
    expect(single.client.getNativeWork()).toEqual({ kind: 'running', backgroundTaskCount: 1 });

    // Still within wakeupQuietMs: must not settle prematurely.
    await vi.advanceTimersByTimeAsync(DEFAULT_ANTIGRAVITY_POLL_TIMINGS.runningGraceMs);
    expect(single.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    await vi.advanceTimersByTimeAsync(wakeupQuietMs);
    expect(single.client.getNativeWork()).toBeNull();

    // 2. Two tasks complete in the same wakeup burst: settles directly after wakeupQuietMs.
    const merged = createHarness();
    installTranscript();
    await merged.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('cmd-1', 'run_command', 'in_progress'),
      tool('cmd-2', 'run_command', 'in_progress'),
    ]);
    await send(merged, 'Run two jobs');
    expect(merged.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 2 });

    await vi.advanceTimersByTimeAsync(10_000);
    await emitToLiveClient(toolUpdate('cmd-1', 'completed', { rawOutput: 'ok 1' }));
    await emitToLiveClient(toolUpdate('cmd-2', 'completed', { rawOutput: 'ok 2' }));
    await emitToLiveClient(say('Both jobs finished.'));
    await vi.advanceTimersByTimeAsync(listPollIntervalMs);
    expect(merged.client.getNativeWork()).toEqual({ kind: 'running', backgroundTaskCount: 1 });

    await vi.advanceTimersByTimeAsync(wakeupQuietMs + listPollIntervalMs);
    expect(merged.client.getNativeWork()).toBeNull();

    // 3. Staggered live completions: settling cmd-1 does not prematurely decrement cmd-2.
    const staggered = createHarness();
    installTranscript();
    await staggered.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('cmd-1', 'run_command', 'in_progress'),
      tool('cmd-2', 'run_command', 'in_progress'),
    ]);
    await send(staggered, 'Run staggered jobs');
    expect(staggered.client.getNativeWork()).toEqual({
      kind: 'background',
      backgroundTaskCount: 2,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await emitToLiveClient(toolUpdate('cmd-1', 'completed', { rawOutput: 'ok 1' }));
    await emitToLiveClient(say('First job finished.'));
    await vi.advanceTimersByTimeAsync(wakeupQuietMs + listPollIntervalMs);
    expect(staggered.client.getNativeWork()).toEqual({
      kind: 'background',
      backgroundTaskCount: 1,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(staggered.client.getNativeWork()).toEqual({
      kind: 'background',
      backgroundTaskCount: 1,
    });

    await emitToLiveClient(toolUpdate('cmd-2', 'completed', { rawOutput: 'ok 2' }));
    await emitToLiveClient(say('Second job finished.'));
    await vi.advanceTimersByTimeAsync(wakeupQuietMs + listPollIntervalMs);
    expect(staggered.client.getNativeWork()).toBeNull();
  });

  it('reconciles an agy 1.5.9 poll-inferred completion when the next turn replays the second tool terminal update', async () => {
    const harness = createHarness();
    const { wakeUp } = installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('cmd-a', 'run_command', 'in_progress'),
      tool('cmd-b', 'run_command', 'in_progress'),
    ]);
    await send(harness, 'Run A and B');
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 2 });
    await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);

    // One anonymous poll wakeup completes while the other command is still running.
    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    // Turn 2 replays cmd-b's completion; this must reconcile the prior inferred completion rather than decrementing cmd-a.
    promptOnce([toolUpdate('cmd-b', 'completed', { rawOutput: 'B done' }), say('Checked.')]);
    await send(harness, 'Status?');
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });
    await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);

    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('reconciles an agy 1.5.9 poll-inferred completion without decrementing a mixed invoke_subagent dispatch', async () => {
    const harness = createHarness();
    const { wakeUp } = installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('cmd-a', 'run_command', 'in_progress'),
      tool('sub-1', 'invoke_subagent', 'completed', { rawOutput: { ok: true } }),
    ]);
    await send(harness, 'Run command and subagent');
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 2 });
    await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);

    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    // Turn 2 replays cmd-a's completion; sub-1 must remain protected until its own wakeup settles.
    promptOnce([toolUpdate('cmd-a', 'completed', { rawOutput: 'A done' }), say('Command done.')]);
    await send(harness, 'Any update?');
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });
    await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);

    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('keeps protecting a long tool started during an agy 1.5.10 post-end_turn wakeup', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([tool('cmd-a', 'run_command', 'in_progress')]);
    await send(harness, 'Run A');
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    await vi.advanceTimersByTimeAsync(10_000);
    await emitToLiveClient(toolUpdate('cmd-a', 'completed', { rawOutput: 'A done' }));
    await emitToLiveClient(say('A finished, starting B.'));
    await emitToLiveClient(tool('cmd-b', 'run_command', 'in_progress'));

    // After wakeup stillness, cmd-b must remain tracked and protected.
    await vi.advanceTimersByTimeAsync(wakeupQuietMs + listPollIntervalMs);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    await emitToLiveClient(toolUpdate('cmd-b', 'completed', { rawOutput: 'B done' }));
    await emitToLiveClient(say('B finished.'));
    await vi.advanceTimersByTimeAsync(wakeupQuietMs + listPollIntervalMs);
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('does not infer completion from live in_progress updates even when session/list updatedAt advances', async () => {
    const harness = createHarness();
    const { wakeUp } = installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([tool('cmd-a', 'run_command', 'in_progress')]);
    await send(harness, 'Run progress job');
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });
    await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);

    await emitToLiveClient(toolUpdate('cmd-a', 'in_progress', { rawOutput: '50%' }));
    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });
  });

  it('settles an invoke_subagent wakeup even when the wakeup invokes a synchronous helper tool', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('sub-1', 'invoke_subagent', 'completed', { rawOutput: { ok: true } }),
      say('Dispatched subagent.'),
    ]);
    await send(harness, 'Research');
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    await vi.advanceTimersByTimeAsync(10_000);
    await emitToLiveClient(tool('read-1', 'read_file', 'in_progress', { kind: 'read' }));
    await emitToLiveClient(toolUpdate('read-1', 'completed', { rawOutput: 'README contents' }));
    await emitToLiveClient(say('Subagent summary ready.'));

    await vi.advanceTimersByTimeAsync(wakeupQuietMs + listPollIntervalMs);
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('clears stale placeholders on output-less completed updates and migrates pending tools to wakeups exclusively', async () => {
    // 1. Same-turn: in_progress with placeholder followed by output-less completed.
    const sameTurn = createHarness();
    installTranscript();
    await sameTurn.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('cmd-1', 'run_command', 'in_progress', {
        rawOutput: 'Tool is running as a background task with task id: task-1.',
      }),
      toolUpdate('cmd-1', 'completed'),
    ]);
    await send(sameTurn, 'Run and finish');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sameTurn.client.getNativeWork()).toBeNull();
    expect(mockState.listSessions).not.toHaveBeenCalled();

    // 2. Cross-turn: Turn 1 leaves in_progress with placeholder; Turn 2 sends output-less completed.
    const crossTurn = createHarness();
    installTranscript();
    await crossTurn.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('cmd-1', 'run_command', 'in_progress', {
        rawOutput: 'Tool is running as a background task with task id: task-2.',
      }),
    ]);
    await send(crossTurn, 'Start command');
    expect(crossTurn.client.getNativeWork()).toEqual({
      kind: 'background',
      backgroundTaskCount: 1,
    });

    promptOnce([toolUpdate('cmd-1', 'completed'), say('Done.')]);
    await send(crossTurn, 'Check command');
    expect(crossTurn.client.getNativeWork()).toBeNull();

    // 3. Cross-turn exclusive migration: pending tool transitions to placeholder completed and settles in one wakeup.
    const migrated = createHarness();
    const { wakeUp } = installTranscript();
    await migrated.client.startSession({} as never, '/synthetic/project');

    promptOnce([tool('cmd-1', 'run_command', 'in_progress')]);
    await send(migrated, 'Start job');
    expect(migrated.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    promptOnce([
      toolUpdate('cmd-1', 'completed', {
        rawOutput: 'Tool is running as a background task with task id: task-3.',
      }),
      say('Still running in background.'),
    ]);
    await send(migrated, 'Check job');
    expect(migrated.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });
    await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);

    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(migrated.client.getNativeWork()).toBeNull();
  });

  it('ignores multi-block content outputs that contain a placeholder line among other blocks', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('cmd-multi-block', 'run_command', 'completed', {
        content: [
          { type: 'content', content: { type: 'text', text: 'Header output' } },
          {
            type: 'content',
            content: {
              type: 'text',
              text: 'Tool is running as a background task with task id: task-abc_123.',
            },
          },
          { type: 'content', content: { type: 'text', text: 'Footer output' } },
        ],
      }),
    ]);
    await send(harness, 'Inspect multi-block output');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.client.getNativeWork()).toBeNull();
    expect(mockState.listSessions).not.toHaveBeenCalled();
  });

  it('defaults a tool_call with omitted status to pending so it stays protected after end_turn', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      n({
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-no-status',
        name: 'run_command',
        title: 'run_command',
      }),
    ]);
    await send(harness, 'Run command without status');
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });
  });

  it('permanently settles a live-replied anonymous wakeup so a later cross-turn tool completion does not revive it', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('cmd-a', 'run_command', 'in_progress'),
      tool('sub-1', 'invoke_subagent', 'completed', { rawOutput: { ok: true } }),
    ]);
    await send(harness, 'Run command and subagent');
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 2 });

    // sub-1 completes via live model reply post-turn while cmd-a keeps running.
    await vi.advanceTimersByTimeAsync(10_000);
    await emitToLiveClient(say('Subagent finished its report.'));
    await vi.advanceTimersByTimeAsync(wakeupQuietMs + listPollIntervalMs);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    // Turn 2 receives cmd-a's completion; sub-1 must stay settled so the turn ends idle.
    promptOnce([toolUpdate('cmd-a', 'completed', { rawOutput: 'A done' }), say('All done.')]);
    await send(harness, 'Check status');
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('settles an anonymous wakeup when a helper tool runs silently past wakeupQuietMs before the final reply', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('sub-1', 'invoke_subagent', 'completed', { rawOutput: { ok: true } }),
      say('Dispatched subagent.'),
    ]);
    await send(harness, 'Research');
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    await vi.advanceTimersByTimeAsync(10_000);
    await emitToLiveClient(tool('cmd-helper', 'run_command', 'in_progress'));

    // Helper tool runs silently for 45s (> wakeupQuietMs) without settling sub-1 prematurely.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 2 });

    await emitToLiveClient(toolUpdate('cmd-helper', 'completed', { rawOutput: 'helper output' }));
    await emitToLiveClient(say('Final subagent summary.'));
    await vi.advanceTimersByTimeAsync(wakeupQuietMs + listPollIntervalMs);
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('does not decrement a sibling long tool started during a tool-settled wakeup after >wakeupQuietMs silence', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([tool('cmd-a', 'run_command', 'in_progress')]);
    await send(harness, 'Run A');
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    await vi.advanceTimersByTimeAsync(10_000);
    await emitToLiveClient(toolUpdate('cmd-a', 'completed', { rawOutput: 'A done' }));
    await emitToLiveClient(tool('cmd-b', 'run_command', 'in_progress'));
    await emitToLiveClient(tool('cmd-c', 'run_command', 'in_progress'));

    // Both follow-up tools run silently for 45s (> wakeupQuietMs).
    await vi.advanceTimersByTimeAsync(45_000);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 2 });

    // cmd-b finishes with a reply; cmd-c must remain protected until its own completion.
    await emitToLiveClient(toolUpdate('cmd-b', 'completed', { rawOutput: 'B done' }));
    await emitToLiveClient(say('B finished, waiting on C.'));
    await vi.advanceTimersByTimeAsync(wakeupQuietMs + listPollIntervalMs);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    await emitToLiveClient(toolUpdate('cmd-c', 'completed', { rawOutput: 'C done' }));
    await emitToLiveClient(say('C finished.'));
    await vi.advanceTimersByTimeAsync(wakeupQuietMs + listPollIntervalMs);
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('falls back to content when rawOutput is empty and rejects mismatched multi-block content alongside a placeholder rawOutput', async () => {
    // 1. Empty rawOutput falls back to a valid single-block content placeholder.
    const fallback = createHarness();
    const { wakeUp } = installTranscript();
    await fallback.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('cmd-empty-raw', 'run_command', 'completed', {
        rawOutput: '',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: 'Tool is running as a background task with task id: task-abc_123.',
            },
          },
        ],
      }),
    ]);
    await send(fallback, 'Start background task');
    expect(fallback.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });
    await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);

    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(fallback.client.getNativeWork()).toBeNull();

    // 2. Placeholder rawOutput paired with multi-block content must not be treated as a placeholder.
    mockState.listSessions.mockClear();
    const mismatched = createHarness();
    installTranscript();
    await mismatched.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('cmd-mismatched', 'run_command', 'completed', {
        rawOutput: 'Tool is running as a background task with task id: task-abc_123.',
        content: [
          { type: 'content', content: { type: 'text', text: 'Header line' } },
          {
            type: 'content',
            content: {
              type: 'text',
              text: 'Tool is running as a background task with task id: task-abc_123.',
            },
          },
          { type: 'content', content: { type: 'text', text: 'Footer line' } },
        ],
      }),
    ]);
    await send(mismatched, 'Inspect mismatched output');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mismatched.client.getNativeWork()).toBeNull();
    expect(mockState.listSessions).not.toHaveBeenCalled();
  });

  it('does not decrement a still-running tracked tool when a delayed wakeup reply arrives after wakeupQuietMs', async () => {
    const harness = createHarness();
    const { wakeUp } = installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('cmd-a', 'run_command', 'in_progress'),
      tool('cmd-b', 'run_command', 'in_progress'),
    ]);
    await send(harness, 'Run A and B');
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 2 });
    await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);

    // cmd-a finishes live on agy 1.5.10+; the model thinks quietly for 43s (> wakeupQuietMs) before replying.
    await emitToLiveClient(toolUpdate('cmd-a', 'completed', { rawOutput: 'A done' }));
    await vi.advanceTimersByTimeAsync(43_000);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    // Delayed reply + updatedAt bump must not decrement cmd-b.
    await emitToLiveClient(say('A finished.'));
    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    await emitToLiveClient(toolUpdate('cmd-b', 'completed', { rawOutput: 'B done' }));
    await vi.advanceTimersByTimeAsync(wakeupQuietMs + listPollIntervalMs);
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('settles an anonymous wakeup when it only runs helper tools without emitting model text', async () => {
    // 1. Two-step helper tool (in_progress -> completed) with updatedAt bump and no model text.
    const twoStep = createHarness();
    const { wakeUp: wakeTwoStep } = installTranscript();
    await twoStep.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('sub-1', 'invoke_subagent', 'completed', { rawOutput: { ok: true } }),
      say('Dispatched subagent.'),
    ]);
    await send(twoStep, 'Research');
    expect(twoStep.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });
    await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);

    await emitToLiveClient(tool('helper-1', 'run_command', 'in_progress'));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(twoStep.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 2 });

    await emitToLiveClient(toolUpdate('helper-1', 'completed', { rawOutput: 'saved result' }));
    wakeTwoStep();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(twoStep.client.getNativeWork()).toBeNull();

    // 2. One-shot helper tool arriving directly as completed with no model text.
    const oneShot = createHarness();
    const { wakeUp: wakeOneShot } = installTranscript();
    await oneShot.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('sub-2', 'invoke_subagent', 'completed', { rawOutput: { ok: true } }),
      say('Dispatched second subagent.'),
    ]);
    await send(oneShot, 'Research again');
    expect(oneShot.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });
    await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);

    await emitToLiveClient(
      tool('helper-2', 'read_file', 'completed', { kind: 'read', rawOutput: 'contents' })
    );
    wakeOneShot();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(oneShot.client.getNativeWork()).toBeNull();
  });

  it('does not decrement a parallel anonymous wakeup when a settled tracked tool gets a delayed reply', async () => {
    const harness = createHarness();
    const { wakeUp } = installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('cmd-a', 'run_command', 'in_progress'),
      tool('sub-1', 'invoke_subagent', 'completed', { rawOutput: { ok: true } }),
    ]);
    await send(harness, 'Run command and subagent');
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 2 });
    await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);

    // cmd-a finishes live, and the model stays quiet past wakeupQuietMs before replying.
    await emitToLiveClient(toolUpdate('cmd-a', 'completed', { rawOutput: 'A done' }));
    await vi.advanceTimersByTimeAsync(43_000);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    // Delayed reply for cmd-a + updatedAt bump must consume awaitingReplyForSettledTool rather than sub-1.
    await emitToLiveClient(say('A finished.'));
    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    // sub-1's own wakeup reply later settles cleanly.
    await emitToLiveClient(say('Subagent finished.'));
    await vi.advanceTimersByTimeAsync(wakeupQuietMs + listPollIntervalMs);
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('does not treat a late content-only tool_call_update on an already-settled tool as a helper completion', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('cmd-a', 'run_command', 'in_progress'),
      tool('sub-1', 'invoke_subagent', 'completed', { rawOutput: { ok: true } }),
    ]);
    await send(harness, 'Run command and subagent');
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 2 });

    // cmd-a settles with a reply in the same wakeup burst.
    await vi.advanceTimersByTimeAsync(10_000);
    await emitToLiveClient(toolUpdate('cmd-a', 'completed', { rawOutput: 'A done' }));
    await emitToLiveClient(say('A finished.'));
    await vi.advanceTimersByTimeAsync(wakeupQuietMs + listPollIntervalMs);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    // A late content-only update on already-settled cmd-a must not settle sub-1.
    await emitToLiveClient(
      n({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'cmd-a',
        content: [{ type: 'content', content: { type: 'text', text: 'late stdout tail' } }],
      })
    );
    await vi.advanceTimersByTimeAsync(wakeupQuietMs + listPollIntervalMs);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });
  });

  it('settles a parallel anonymous wakeup when a settled tracked tool already advanced updatedAt without model text', async () => {
    const harness = createHarness();
    const { wakeUp } = installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('cmd-a', 'run_command', 'in_progress'),
      tool('sub-1', 'invoke_subagent', 'completed', { rawOutput: { ok: true } }),
    ]);
    await send(harness, 'Run command and subagent');
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 2 });
    await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);

    // Flow Y: cmd-a finishes with updatedAt moving but no text reply; its wakeup closes cleanly.
    await emitToLiveClient(toolUpdate('cmd-a', 'completed', { rawOutput: 'A done' }));
    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    // sub-1's independent wakeup reply must settle directly without being swallowed.
    await emitToLiveClient(say('Subagent finished.'));
    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('keeps absorbing a delayed reply after an intermediate poll-only updatedAt bump following a quiet tool settlement', async () => {
    const harness = createHarness();
    const { wakeUp } = installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('cmd-a', 'run_command', 'in_progress'),
      tool('sub-1', 'invoke_subagent', 'completed', { rawOutput: { ok: true } }),
    ]);
    await send(harness, 'Run command and subagent');
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 2 });
    await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);

    // Flow X variant: cmd-a completes with neither model text nor updatedAt change.
    await emitToLiveClient(toolUpdate('cmd-a', 'completed', { rawOutput: 'A done' }));
    await vi.advanceTimersByTimeAsync(wakeupQuietMs + listPollIntervalMs);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    // An intermediate poll-only updatedAt bump must neither clear awaitingReplyForSettledTool nor decrement sub-1.
    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    // The subsequent delayed reply for cmd-a is still absorbed rather than decrementing sub-1.
    await emitToLiveClient(say('A finished.'));
    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(harness.client.getNativeWork()).toEqual({ kind: 'background', backgroundTaskCount: 1 });

    // Finally sub-1's own reply settles to idle.
    await emitToLiveClient(say('Subagent finished.'));
    await vi.advanceTimersByTimeAsync(wakeupQuietMs + listPollIntervalMs);
    expect(harness.client.getNativeWork()).toBeNull();
  });
});
