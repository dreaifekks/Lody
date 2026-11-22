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
  emitChunk: (text: string) => void;
};

const createHarness = (overrides?: {
  maxActive?: number;
  idleTtlMs?: number;
  sweepIntervalMs?: number;
  deltaThrottleMs?: number;
  maxConcurrentStarts?: number;
  onStart?: (
    instance: FakeAgentInstance,
    options: StartLocalAcpAgentOptions
  ) => Promise<void> | void;
  onPrompt?: (
    instance: FakeAgentInstance,
    text: string,
    signal?: AbortSignal
  ) => Promise<{ stopReason: string }>;
}) => {
  const agents: FakeAgentInstance[] = [];
  const shutdownIds: string[] = [];
  const isolationModes: boolean[] = [];
  let seq = 0;

  const prepareIsolation = vi.fn(
    async (options: PrepareBtwIsolationOptions): Promise<PreparedBtwIsolation> => {
      isolationModes.push(options.readOnlyTools);
      const cleanup = vi.fn();
      return {
        workdir: options.readOnlyTools ? '/session/repo' : `/tmp/lody-btw-empty-${seq + 1}`,
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
        tempDirs: options.readOnlyTools ? [] : [`/tmp/lody-btw-empty-${seq + 1}`],
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
      emitChunk,
    };
    agents.push(instance);

    if (overrides?.onStart) {
      await overrides.onStart(instance, options);
    }

    // Emit an out-of-turn banner chunk during startup to prove it is ignored.
    emitChunk('STARTUP_BANNER_SHOULD_NOT_LEAK');

    let configOptions = makeAntigravityConfigOptions();
    const client = {
      setSessionConfigOption: vi.fn(async (_sid: ACPSessionId, key: string, value: unknown) => {
        setConfigCalls.push({ key, value });
        configOptions = configOptions.map((opt) =>
          opt.id === key ? ({ ...opt, currentValue: value } as SessionConfigOption) : opt
        );
        return configOptions;
      }),
      unstable_setSessionModel: vi.fn(async () => {}),
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
    if (match) shutdownIds.push(match.id);
  });

  const service = new BtwService({
    logger: silentLogger,
    resolveSessionTarget: async () => ({
      cliType: 'builtin',
      agentType: 'antigravity',
      sessionWorkdir: '/session/repo',
      env: {},
    }),
    readMainHistoryTail: async () => '=== Previous Conversation Context ===\n[User]\nMain context',
    maxActive: overrides?.maxActive,
    idleTtlMs: overrides?.idleTtlMs,
    sweepIntervalMs: overrides?.sweepIntervalMs,
    deltaThrottleMs: overrides?.deltaThrottleMs,
    maxConcurrentStarts: overrides?.maxConcurrentStarts,
    prepareIsolation,
    startAgent,
    shutdownAgent,
  });

  return {
    service,
    agents,
    shutdownIds,
    isolationModes,
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
});
