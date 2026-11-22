import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { ContentBlock, SessionConfigOption } from '@agentclientprotocol/sdk';
import type {
  ACPSessionId,
  AcpSessionNotification,
  SessionBtwProgress,
  SessionId,
} from '@lody/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StartLocalAcpAgentOptions } from '@/agent/acp-runner';
import type { Logger } from '@/utils/logger';
import type { PrepareBtwIsolationOptions, PreparedBtwIsolation } from './btw-isolation';
import { BtwService } from './btw-service';

const silentLogger: Logger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
} as Logger;

const makeAntigravityConfigOptions = (): SessionConfigOption[] => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'gemini-4-neon',
    options: [
      { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
      { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
    ],
  },
  {
    id: 'thought_level',
    name: 'Thought Level',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
    ],
  },
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'plan', name: 'Plan' },
    ],
  },
];

type FakeAgentInstance = {
  readonly id: string;
  readonly startOptions: StartLocalAcpAgentOptions;
  readonly process: EventEmitter & ChildProcess;
  readonly cleanupSpy: ReturnType<typeof vi.fn>;
  readonly prompts: string[];
  readonly setConfigCalls: Array<{ key: string; value: unknown }>;
  readonly cancelCalls: ACPSessionId[];
  pendingPromptCompletion: Promise<void> | null;
  emitChunk: (text: string) => void;
};

const createHarness = (overrides?: {
  agentType?: string;
  maxActive?: number;
  idleTtlMs?: number;
  sweepIntervalMs?: number;
  deltaThrottleMs?: number;
  maxConcurrentStarts?: number;
  configTimeoutMs?: number;
  configOptions?: () => SessionConfigOption[];
  onStart?: (
    instance: FakeAgentInstance,
    options: StartLocalAcpAgentOptions
  ) => Promise<void> | void;
  onSetConfigOption?: (
    instance: FakeAgentInstance,
    key: string,
    value: unknown
  ) => Promise<SessionConfigOption[] | undefined>;
  onPrompt?: (
    instance: FakeAgentInstance,
    text: string,
    signal?: AbortSignal
  ) => Promise<{ stopReason: string }>;
  onShutdown?: (instance: FakeAgentInstance) => Promise<void> | void;
}) => {
  const agents: FakeAgentInstance[] = [];
  const shutdownIds: string[] = [];
  const isolationModes: boolean[] = [];
  const isolationWorkdirs: Array<string | null | undefined> = [];
  let seq = 0;

  const prepareIsolation = vi.fn(
    async (options: PrepareBtwIsolationOptions): Promise<PreparedBtwIsolation> => {
      isolationModes.push(options.readOnlyTools);
      isolationWorkdirs.push(options.sessionWorkdir);
      const cleanup = vi.fn();
      const usedSessionWorkdir = Boolean(options.readOnlyTools && options.sessionWorkdir);
      return {
        workdir: usedSessionWorkdir ? options.sessionWorkdir! : `/tmp/lody-btw-empty-${seq + 1}`,
        effectiveReadOnlyTools: options.readOnlyTools,
        usedSessionWorkdir,
        env: { LODY_BTW_AGENT: '1' },
        envTransform: (env) => env,
        onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        terminalManager: {
          createTerminal: async () => {
            throw new Error('disabled');
          },
          terminalOutput: async () => {
            throw new Error('disabled');
          },
          releaseTerminal: async () => {},
          waitForTerminalExit: async () => ({ exitCode: null }),
          killTerminal: async () => {},
        },
        tempDirs: usedSessionWorkdir ? [] : [`/tmp/lody-btw-empty-${seq + 1}`],
        cleanup,
      };
    }
  );

  const startAgent = vi.fn(async (options: StartLocalAcpAgentOptions) => {
    seq += 1;
    const id = `agent-${seq}`;
    const proc = Object.assign(new EventEmitter(), { pid: 1000 + seq }) as EventEmitter &
      ChildProcess;
    const acpSessionId = `acp-${seq}` as ACPSessionId;
    const prompts: string[] = [];
    const setConfigCalls: Array<{ key: string; value: unknown }> = [];
    const cancelCalls: ACPSessionId[] = [];
    const lastCleanup = prepareIsolation.mock.results.at(-1)?.value as
      | Promise<PreparedBtwIsolation>
      | undefined;
    const cleanupSpy = ((await lastCleanup)?.cleanup ?? vi.fn()) as ReturnType<typeof vi.fn>;

    const emitChunk = (text: string) => {
      options.onUpdateMessage({
        sessionId: acpSessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        },
      } as AcpSessionNotification);
    };

    const instance: FakeAgentInstance = {
      id,
      startOptions: options,
      process: proc,
      cleanupSpy,
      prompts,
      setConfigCalls,
      cancelCalls,
      pendingPromptCompletion: null,
      emitChunk,
    };
    agents.push(instance);

    if (overrides?.onStart) {
      await overrides.onStart(instance, options);
    }

    // Emit an out-of-turn banner chunk during startup to prove it is ignored.
    emitChunk('STARTUP_BANNER_SHOULD_NOT_LEAK');

    let configOptions = overrides?.configOptions
      ? overrides.configOptions()
      : makeAntigravityConfigOptions();
    const client = {
      get pendingPromptCompletion(): Promise<void> | null {
        return instance.pendingPromptCompletion;
      },
      setSessionConfigOption: vi.fn(async (_sid: ACPSessionId, key: string, value: unknown) => {
        setConfigCalls.push({ key, value });
        if (overrides?.onSetConfigOption) {
          return await overrides.onSetConfigOption(instance, key, value);
        }
        configOptions = configOptions.map((opt) =>
          opt.id === key ? ({ ...opt, currentValue: value } as SessionConfigOption) : opt
        );
        return configOptions;
      }),
      unstable_setSessionModel: vi.fn(async () => {}),
      setSessionMode: vi.fn(async () => {}),
      prompt: vi.fn(
        async (
          _sid: ACPSessionId,
          blocks: ContentBlock[],
          promptOpts?: { signal?: AbortSignal }
        ) => {
          const text = blocks
            .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
          prompts.push(text);
          if (overrides?.onPrompt) {
            return await overrides.onPrompt(instance, text, promptOpts?.signal);
          }
          emitChunk(`reply:${id}:${prompts.length}`);
          return { stopReason: 'end_turn' };
        }
      ),
      cancel: vi.fn(async (sid: ACPSessionId) => {
        cancelCalls.push(sid);
      }),
      closeSession: vi.fn(async () => true),
    };

    return {
      agentProcess: proc,
      client: client as never,
      acpSessionId,
      sessionResponse: {
        sessionId: acpSessionId,
        configOptions,
      } as never,
      capabilitySourceVersion: 'test',
    };
  });

  const shutdownAgent = vi.fn(async (opts: { agentProcess: ChildProcess }) => {
    const match = agents.find((a) => a.process === opts.agentProcess);
    if (match) {
      shutdownIds.push(match.id);
      if (overrides?.onShutdown) {
        await overrides.onShutdown(match);
      }
    }
  });

  const service = new BtwService({
    logger: silentLogger,
    resolveSessionTarget: async () => ({
      cliType: 'builtin',
      agentType: overrides?.agentType ?? 'antigravity',
      sessionWorkdir: '/session/repo',
      env: {},
    }),
    readMainHistoryTail: async () => '=== Previous Conversation Context ===\n[User]\nMain context',
    maxActive: overrides?.maxActive,
    idleTtlMs: overrides?.idleTtlMs,
    sweepIntervalMs: overrides?.sweepIntervalMs,
    deltaThrottleMs: overrides?.deltaThrottleMs,
    maxConcurrentStarts: overrides?.maxConcurrentStarts,
    configTimeoutMs: overrides?.configTimeoutMs,
    prepareIsolation,
    startAgent,
    shutdownAgent,
  });

  return {
    service,
    agents,
    shutdownIds,
    isolationModes,
    isolationWorkdirs,
    prepareIsolation,
    startAgent,
    shutdownAgent,
  };
};

describe('BtwService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes first chunk immediately, coalesces subsequent chunks at 90ms, and flushes tail before response', async () => {
    vi.useFakeTimers();
    let finishPrompt!: () => void;
    let activeInstance!: FakeAgentInstance;

    const harness = createHarness({
      deltaThrottleMs: 90,
      onPrompt: async (instance) => {
        activeInstance = instance;
        await new Promise<void>((resolve) => {
          finishPrompt = resolve;
        });
        return { stopReason: 'end_turn' };
      },
    });

    const frames: SessionBtwProgress[] = [];
    const askPromise = harness.service.handleRequest(
      {
        action: 'ask',
        sessionId: 'sess-1',
        btwId: 'btw-stream',
        question: 'Explain this',
      },
      { onProgress: (frame) => frames.push(frame) }
    );

    // Wait for cold start + prompt invocation
    await vi.waitFor(() => expect(activeInstance).toBeDefined());

    expect(frames).toEqual([
      { btwId: 'btw-stream', kind: 'status', status: 'starting' },
      {
        btwId: 'btw-stream',
        kind: 'status',
        status: 'streaming',
        modelId: 'gemini-4-hydrogen',
        modelLabel: 'Hydrogen · Low',
      },
    ]);

    // Verify startAgent always passes isolation & independent start gate flags
    expect(activeInstance.startOptions).toMatchObject({
      terminalEnabled: false,
      readOnlyFs: true,
      disableReadTextFile: true,
      disableBuiltinMcp: true,
      skipStartGate: true,
    });
    expect(activeInstance.setConfigCalls).toEqual([
      { key: 'model', value: 'gemini-4-hydrogen' },
      { key: 'thought_level', value: 'low' },
      { key: 'mode', value: 'plan' },
    ]);

    // First chunk flushes immediately (0ms)
    activeInstance.emitChunk('Hello');
    expect(frames.at(-1)).toEqual({
      btwId: 'btw-stream',
      kind: 'delta',
      delta: 'Hello',
      modelId: 'gemini-4-hydrogen',
      modelLabel: 'Hydrogen · Low',
    });

    // Subsequent chunks within 90ms coalesce
    activeInstance.emitChunk(' ');
    activeInstance.emitChunk('world');
    expect(frames.filter((f) => f.kind === 'delta')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(89);
    expect(frames.filter((f) => f.kind === 'delta')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(frames.filter((f) => f.kind === 'delta').map((f) => f.delta)).toEqual([
      'Hello',
      ' world',
    ]);

    // Tail chunk emitted right before completion flushes before final response
    activeInstance.emitChunk('!');
    finishPrompt();
    const response = await askPromise;

    expect(frames.filter((f) => f.kind === 'delta').map((f) => f.delta)).toEqual([
      'Hello',
      ' world',
      '!',
    ]);
    expect(response).toEqual({
      btwId: 'btw-stream',
      text: 'Hello world!',
      modelId: 'gemini-4-hydrogen',
      modelLabel: 'Hydrogen · Low',
      readOnlyTools: false,
    });

    await harness.service.dispose();
  });

  it('reuses warm handle on follow-up and rebuilds with priorTurns when readOnlyTools toggles', async () => {
    const harness = createHarness({ deltaThrottleMs: 0 });

    const first = await harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-1',
      question: 'Initial question',
      articleContext: { path: 'docs/a.md', selection: 'sel 1', excerpt: 'full doc' },
    });
    expect(first.text).toBe('reply:agent-1:1');
    expect(harness.startAgent).toHaveBeenCalledTimes(1);
    expect(harness.agents[0]!.prompts[0]).toContain('Previous Conversation Context');
    expect(harness.agents[0]!.prompts[0]).toContain('full doc');

    // Follow-up on same btwId with unchanged article reuses warm handle and sends only question
    const second = await harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-1',
      question: 'Follow up question',
      articleContext: { path: 'docs/a.md', selection: 'sel 1', excerpt: 'full doc' },
    });
    expect(second.text).toBe('reply:agent-1:2');
    expect(harness.startAgent).toHaveBeenCalledTimes(1);
    expect(harness.agents[0]!.prompts[1]).toBe('Follow up question');

    // Switching readOnlyTools from false -> true tears down old handle & rebuilds with priorTurns
    const upgraded = await harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-1',
      question: 'Inspect repo now',
      readOnlyTools: true,
      priorTurns: [
        { role: 'user', text: 'Initial question' },
        { role: 'assistant', text: 'reply:agent-1:1' },
      ],
    });
    expect(upgraded.text).toBe('reply:agent-2:1');
    expect(upgraded.readOnlyTools).toBe(true);
    expect(harness.shutdownIds).toEqual(['agent-1']);
    expect(harness.agents[0]!.cleanupSpy).toHaveBeenCalledTimes(1);
    expect(harness.isolationModes).toEqual([false, true]);
    expect(harness.agents[1]!.prompts[0]).toContain('=== Prior /btw Conversation ===');
    expect(harness.agents[1]!.prompts[0]).toContain('Initial question');

    await harness.service.dispose();
  });

  it('evicts the LRU idle handle when exceeding maxActive=2 and cleans up its temp dirs', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ maxActive: 2, deltaThrottleMs: 0 });

    await harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-a',
      question: 'q1',
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-b',
      question: 'q2',
    });
    await vi.advanceTimersByTimeAsync(1_000);

    // Touch btw-a so btw-b becomes the LRU idle handle
    await harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-a',
      question: 'q3',
    });
    await vi.advanceTimersByTimeAsync(1_000);

    // 3rd handle evicts btw-b (agent-2), NOT btw-a (agent-1)
    await harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-c',
      question: 'q4',
    });

    expect(harness.shutdownIds).toEqual(['agent-2']);
    expect(harness.agents[1]!.cleanupSpy).toHaveBeenCalledTimes(1);
    expect(harness.agents[0]!.cleanupSpy).not.toHaveBeenCalled();
    expect(harness.service.activeHandleCount).toBe(2);

    await harness.service.dispose();
  });

  it('reclaims idle handles after the 4-minute TTL sweep while preserving active turns', async () => {
    vi.useFakeTimers();
    let releaseBusyTurn!: () => void;

    const harness = createHarness({
      idleTtlMs: 4 * 60_000,
      sweepIntervalMs: 60_000,
      deltaThrottleMs: 0,
      onPrompt: async (instance, text) => {
        if (text.includes('stay-busy')) {
          await new Promise<void>((resolve) => {
            releaseBusyTurn = resolve;
          });
        }
        instance.emitChunk('ok');
        return { stopReason: 'end_turn' };
      },
    });

    await harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-idle',
      question: 'quick',
    });
    const busyPromise = harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-busy',
      question: 'stay-busy',
    });
    await vi.waitFor(() => expect(releaseBusyTurn).toBeDefined());

    // Advance 4 minutes -> sweep runs, evicts btw-idle, keeps btw-busy alive
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(harness.shutdownIds).toEqual(['agent-1']);
    expect(harness.agents[0]!.cleanupSpy).toHaveBeenCalledTimes(1);
    expect(harness.service.activeHandleCount).toBe(1);

    releaseBusyTurn();
    expect((await busyPromise).text).toBe('ok');

    await harness.service.dispose();
  });

  it('bounds concurrent cold starts through its dedicated 2-slot startup gate', async () => {
    const startReleases: Array<() => void> = [];
    let concurrentStarts = 0;
    let peakStarts = 0;

    const harness = createHarness({
      maxActive: 3,
      maxConcurrentStarts: 2,
      deltaThrottleMs: 0,
      onStart: async () => {
        concurrentStarts += 1;
        peakStarts = Math.max(peakStarts, concurrentStarts);
        await new Promise<void>((resolve) => {
          startReleases.push(() => {
            concurrentStarts -= 1;
            resolve();
          });
        });
      },
    });

    const p1 = harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-1',
      question: 'q1',
    });
    const p2 = harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-2',
      question: 'q2',
    });
    const p3 = harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-3',
      question: 'q3',
    });

    await vi.waitFor(() => expect(startReleases).toHaveLength(2));
    expect(peakStarts).toBe(2);

    startReleases.shift()!();
    await vi.waitFor(() => expect(startReleases).toHaveLength(2));
    expect(peakStarts).toBe(2);

    while (startReleases.length > 0) {
      startReleases.shift()!();
    }
    const results = await Promise.all([p1, p2, p3]);
    expect(results.every((r) => !r.error)).toBe(true);

    await harness.service.dispose();
  });

  it('cancels an active turn without destroying the warm handle, and closes cleanly on close/dispose', async () => {
    let abortObserved = false;
    const harness = createHarness({
      deltaThrottleMs: 0,
      onPrompt: async (instance, text, signal) => {
        if (text.includes('long-running')) {
          instance.emitChunk('partial');
          await new Promise<void>((_, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                abortObserved = true;
                reject(new Error('Agent prompt aborted'));
              },
              { once: true }
            );
          });
        }
        instance.emitChunk('warm-followup');
        return { stopReason: 'end_turn' };
      },
    });

    const askPromise = harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-c',
      question: 'long-running question',
    });

    await vi.waitFor(() => expect(harness.agents[0]?.prompts).toHaveLength(1));

    const cancelResp = await harness.service.handleRequest({
      action: 'cancel',
      sessionId: 'sess-1',
      btwId: 'btw-c',
    });
    expect(cancelResp.cancelled).toBe(true);
    expect(abortObserved).toBe(true);
    expect(harness.agents[0]!.cancelCalls).toEqual(['acp-1']);

    const cancelledAsk = await askPromise;
    expect(cancelledAsk.cancelled).toBe(true);
    expect(cancelledAsk.text).toBe('partial');

    // Warm handle was NOT destroyed by cancel — next ask reuses agent-1!
    expect(harness.shutdownIds).toEqual([]);
    const followUp = await harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-c',
      question: 'quick followup',
    });
    expect(followUp.text).toBe('warm-followup');
    expect(harness.startAgent).toHaveBeenCalledTimes(1);

    // Explicit close destroys handle and cleans up temp dirs
    await harness.service.handleRequest({
      action: 'close',
      sessionId: 'sess-1',
      btwId: 'btw-c',
    });
    expect(harness.shutdownIds).toEqual(['agent-1']);
    expect(harness.agents[0]!.cleanupSpy).toHaveBeenCalledTimes(1);
    expect(harness.service.activeHandleCount).toBe(0);

    // Unexpected child exit removes dead handle so next ask recovers with fresh agent
    await harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-crash',
      question: 'before crash',
    });
    expect(harness.service.activeHandleCount).toBe(1);
    harness.agents[1]!.process.emit('exit', 1, null);
    expect(harness.service.activeHandleCount).toBe(0);
    expect(harness.agents[1]!.cleanupSpy).toHaveBeenCalledTimes(1);

    await harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-crash',
      question: 'after crash',
    });
    expect(harness.startAgent).toHaveBeenCalledTimes(3);

    // dispose tears down all remaining handles
    await harness.service.dispose();
    expect(harness.shutdownIds).toContain('agent-3');
    expect(harness.agents[2]!.cleanupSpy).toHaveBeenCalledTimes(1);
    expect(harness.service.activeHandleCount).toBe(0);
  });

  it('degrades unsupported providers (e.g. pi) to text-only empty workdir even when readOnlyTools=true', async () => {
    const harness = createHarness({
      agentType: 'pi',
      deltaThrottleMs: 0,
      configOptions: () => [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'pi-fast',
          options: [{ value: 'pi-fast', name: 'Pi Fast' }],
        },
      ],
    });

    const response = await harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-pi',
      btwId: 'btw-pi',
      question: 'Check repo',
      readOnlyTools: true,
    });

    expect(response.error).toBeUndefined();
    expect(response.readOnlyTools).toBe(false);
    expect(harness.isolationModes).toEqual([false]);
    expect(harness.isolationWorkdirs).toEqual([null]);
    expect(harness.agents[0]!.startOptions).toMatchObject({
      readOnlyFs: true,
      disableReadTextFile: true,
      terminalEnabled: false,
      disableBuiltinMcp: true,
    });
    expect(harness.agents[0]!.startOptions.workdir).not.toBe('/session/repo');

    await harness.service.dispose();
  });

  it('refuses to run inside real worktree if a supported provider fails to confirm native read-only mode', async () => {
    const harness = createHarness({
      agentType: 'antigravity',
      deltaThrottleMs: 0,
      onSetConfigOption: async (_instance, key) => {
        if (key === 'mode') {
          throw new Error('mode switch rejected');
        }
        return undefined;
      },
    });

    const response = await harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-ro-fail',
      btwId: 'btw-ro-fail',
      question: 'Inspect files',
      readOnlyTools: true,
    });

    expect(response.error).toMatch(/read-only mode/i);
    expect(harness.shutdownIds).toEqual(['agent-1']);
    expect(harness.agents[0]!.cleanupSpy).toHaveBeenCalledTimes(1);
    expect(harness.agents[0]!.prompts).toHaveLength(0);
    expect(harness.service.activeHandleCount).toBe(0);

    await harness.service.dispose();
  });

  it('does not start a replacement process when cancel/close arrives during readOnlyTools switch teardown', async () => {
    let releaseTeardown!: () => void;
    let teardownStarted = false;

    const harness = createHarness({
      deltaThrottleMs: 0,
      onShutdown: async (instance) => {
        if (instance.id === 'agent-1') {
          teardownStarted = true;
          await new Promise<void>((resolve) => {
            releaseTeardown = resolve;
          });
        }
      },
    });

    // Establish warm handle in text-only mode
    const first = await harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-switch',
      question: 'Initial',
      readOnlyTools: false,
    });
    expect(first.text).toBe('reply:agent-1:1');
    expect(harness.startAgent).toHaveBeenCalledTimes(1);

    // Start toggling to readOnlyTools=true -> enters async teardown of agent-1
    const switchAsk = harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-switch',
      question: 'Inspect code',
      readOnlyTools: true,
    });
    await vi.waitFor(() => expect(teardownStarted).toBe(true));

    // User cancels and closes drawer while old handle is still tearing down
    const cancelPromise = harness.service.handleRequest({
      action: 'cancel',
      sessionId: 'sess-1',
      btwId: 'btw-switch',
    });
    const closePromise = harness.service.handleRequest({
      action: 'close',
      sessionId: 'sess-1',
      btwId: 'btw-switch',
    });

    releaseTeardown();

    const [switchResp, cancelResp] = await Promise.all([switchAsk, cancelPromise, closePromise]);
    expect(cancelResp.cancelled).toBe(true);
    expect(switchResp.cancelled).toBe(true);
    expect(switchResp.text).toBe('');
    expect(harness.startAgent).toHaveBeenCalledTimes(1);
    expect(harness.service.activeHandleCount).toBe(0);

    await harness.service.dispose();
  });

  it('evicts a cancelled handle whose raw ACP prompt is still pending so late chunks never contaminate the next turn', async () => {
    let resolveRawPrompt1!: () => void;

    const harness = createHarness({
      deltaThrottleMs: 0,
      onPrompt: async (instance, text, signal) => {
        if (instance.id === 'agent-1' && text.includes('first-question')) {
          instance.emitChunk('turn1-start');
          // Mirror real AgentClient: local abort rejects prompt() while pendingPromptCompletion stays pending.
          instance.pendingPromptCompletion = new Promise<void>((resolve) => {
            resolveRawPrompt1 = () => {
              instance.pendingPromptCompletion = null;
              resolve();
            };
          });
          await new Promise<void>((_, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('Agent prompt aborted')), {
              once: true,
            });
          });
        }
        instance.emitChunk('turn2-clean');
        return { stopReason: 'end_turn' };
      },
    });

    const ask1 = harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-late',
      question: 'first-question',
    });
    await vi.waitFor(() => expect(harness.agents[0]?.prompts).toHaveLength(1));

    await harness.service.handleRequest({
      action: 'cancel',
      sessionId: 'sess-1',
      btwId: 'btw-late',
    });
    const res1 = await ask1;
    expect(res1.cancelled).toBe(true);
    expect(res1.text).toBe('turn1-start');

    // Immediately follow up while raw ACP prompt 1 is still unresolved
    const ask2Promise = harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-late',
      question: 'second-question',
      priorTurns: [
        { role: 'user', text: 'first-question' },
        { role: 'assistant', text: 'turn1-start' },
      ],
    });

    // Late frame from agent-1 arrives after second ask has begun
    harness.agents[0]!.emitChunk('LATE_TURN1_LEAK');

    const res2 = await ask2Promise;
    expect(res2.text).toBe('turn2-clean');
    expect(res2.text).not.toContain('LATE_TURN1_LEAK');
    expect(harness.startAgent).toHaveBeenCalledTimes(2);
    expect(harness.shutdownIds).toContain('agent-1');
    expect(harness.agents[1]!.prompts[0]).toContain('first-question');

    resolveRawPrompt1();
    await harness.service.dispose();
  });

  it('aborts hung config RPC immediately on close, dispose, and bounded timeout while freeing slots and temp dirs', async () => {
    vi.useFakeTimers();
    let enteredConfig = 0;

    const harness = createHarness({
      maxActive: 2,
      maxConcurrentStarts: 2,
      configTimeoutMs: 5_000,
      deltaThrottleMs: 0,
      onSetConfigOption: async () => {
        enteredConfig += 1;
        // Hang forever unless aborted/timed out
        return await new Promise<never>(() => {});
      },
    });

    // Case 1: close() immediately aborts hung config RPC and cleans up process + temp dir
    const ask1 = harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-hang-close',
      question: 'q1',
    });
    await vi.waitFor(() => expect(enteredConfig).toBe(1));

    const closeRes = await harness.service.handleRequest({
      action: 'close',
      sessionId: 'sess-1',
      btwId: 'btw-hang-close',
    });
    expect(closeRes.error).toBeUndefined();
    const res1 = await ask1;
    expect(res1.cancelled).toBe(true);
    expect(harness.shutdownIds).toEqual(['agent-1']);
    expect(harness.agents[0]!.cleanupSpy).toHaveBeenCalledTimes(1);
    expect(harness.service.activeHandleCount).toBe(0);
    expect(harness.service.reservedSlotCount).toBe(0);

    // Case 2: bounded config timeout aborts hung config RPC and releases slot
    const ask2 = harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-hang-timeout',
      question: 'q2',
    });
    await vi.waitFor(() => expect(enteredConfig).toBe(2));
    await vi.advanceTimersByTimeAsync(5_000);
    const res2 = await ask2;
    expect(res2.error).toMatch(/timed out/i);
    expect(harness.shutdownIds).toEqual(['agent-1', 'agent-2']);
    expect(harness.agents[1]!.cleanupSpy).toHaveBeenCalledTimes(1);
    expect(harness.service.activeHandleCount).toBe(0);
    expect(harness.service.reservedSlotCount).toBe(0);

    // Case 3: dispose() does not hang on an in-flight hung config RPC
    const ask3 = harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-hang-dispose',
      question: 'q3',
    });
    await vi.waitFor(() => expect(enteredConfig).toBe(3));
    await harness.service.dispose();
    await ask3;
    expect(harness.shutdownIds).toEqual(['agent-1', 'agent-2', 'agent-3']);
    expect(harness.agents[2]!.cleanupSpy).toHaveBeenCalledTimes(1);
    expect(harness.service.activeHandleCount).toBe(0);
    expect(harness.service.reservedSlotCount).toBe(0);
  });

  it('strictly enforces maxActive=2 under concurrent cold starts when 1 warm handle already exists', async () => {
    const startReleases: Array<() => void> = [];
    let peakCommittedSlots = 0;

    const harness = createHarness({
      maxActive: 2,
      maxConcurrentStarts: 2,
      deltaThrottleMs: 0,
      onStart: async (instance) => {
        if (instance.id === 'agent-1') return;
        await new Promise<void>((resolve) => {
          startReleases.push(resolve);
        });
      },
    });

    const recordPeak = () => {
      peakCommittedSlots = Math.max(
        peakCommittedSlots,
        harness.service.activeHandleCount + harness.service.reservedSlotCount
      );
    };

    // Seed 1 warm idle handle (btw-a)
    await harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-a',
      question: 'warm',
    });
    expect(harness.service.activeHandleCount).toBe(1);

    // Launch 2 concurrent cold starts (btw-b & btw-c) at the exact same tick
    const pB = harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-b',
      question: 'cold-b',
    });
    const pC = harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-c',
      question: 'cold-c',
    });

    await vi.waitFor(() => expect(startReleases).toHaveLength(2));
    recordPeak();
    // btw-a must have been evicted before btw-c reserved the 2nd slot
    expect(harness.shutdownIds).toEqual(['agent-1']);
    expect(harness.service.activeHandleCount).toBe(0);
    expect(harness.service.reservedSlotCount).toBe(2);

    // While both slots are reserved, a 3rd concurrent cold start must be rejected without spawning
    const pD = await harness.service.handleRequest({
      action: 'ask',
      sessionId: 'sess-1',
      btwId: 'btw-d',
      question: 'overflow',
    });
    expect(pD.error).toMatch(/too many concurrent/i);
    recordPeak();

    // Release both cold starts -> activeHandleCount lands at exactly 2 (never 3!)
    startReleases.shift()!();
    startReleases.shift()!();
    const [resB, resC] = await Promise.all([pB, pC]);
    recordPeak();

    expect(resB.error).toBeUndefined();
    expect(resC.error).toBeUndefined();
    expect(harness.service.activeHandleCount).toBe(2);
    expect(harness.service.reservedSlotCount).toBe(0);
    expect(peakCommittedSlots).toBeLessThanOrEqual(2);

    await harness.service.dispose();
  });
});
