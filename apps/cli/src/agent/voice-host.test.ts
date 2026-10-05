import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfigId, AgentConfigMeta } from '@lody/shared';

const launchGate = vi.hoisted(() => ({
  /** Settles the pending runtime resolution as if the download finished. */
  finish: null as null | (() => void),
  sawSignal: null as AbortSignal | null,
  respectSignal: true,
  spawned: 0,
  /** When set, spawning returns this child instead of failing. */
  child: null as null | (() => unknown),
}));

vi.mock('@/agent/setting', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/setting')>();
  return {
    ...actual,
    // A managed-runtime download that has not finished; it honours the abort
    // only when `respectSignal` is set, like a download stuck in a slow read.
    resolveACPProcessLaunchAsync: (input: { signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        launchGate.sawSignal = input.signal ?? null;
        launchGate.finish = () => resolve({ command: 'codex-acp', args: [] });
        if (launchGate.respectSignal) {
          input.signal?.addEventListener('abort', () => reject(input.signal?.reason), {
            once: true,
          });
        }
      }),
  };
});

vi.mock('@/agent/acp-runner', () => ({
  spawnAcpProcess: () => {
    launchGate.spawned += 1;
    if (launchGate.child) return launchGate.child();
    throw new Error('spawned after shutdown');
  },
}));

vi.mock('@/agent/login-shell-env', () => ({ getLoginShellEnv: async () => ({}) }));

/** An adapter process that starts but never answers `initialize`. */
class SilentAdapter extends EventEmitter {
  readonly pid = undefined;
  exitCode: number | null = null;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kill(signal?: NodeJS.Signals): boolean {
    if (this.exitCode !== null) return false;
    this.exitCode = 0;
    this.stdout.end();
    this.emit('exit', 0, signal ?? null);
    return true;
  }
}

const { VoiceHost } = await import('./voice-host');

const codexConfig = {
  id: 'config-1',
  machineId: 'machine-1',
  name: 'Codex',
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
} as unknown as AgentConfigMeta;

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  trace() {},
  child() {
    return logger;
  },
} as never;

const createHost = () =>
  new VoiceHost({
    workspaceId: 'workspace-1',
    machineId: 'machine-1',
    logger,
    getAgentConfig: async () => codexConfig,
  });

const startRequest = {
  action: 'start' as const,
  configId: 'config-1' as AgentConfigId,
  mode: 'dictation' as const,
  sdp: 'offer',
};

afterEach(() => {
  launchGate.finish = null;
  launchGate.sawSignal = null;
  launchGate.respectSignal = true;
  launchGate.spawned = 0;
  launchGate.child = null;
});

describe('VoiceHost shutdown', () => {
  it('does not wait for a start that is still preparing the runtime', async () => {
    const host = createHost();
    const started = host.handle(startRequest);
    await vi.waitFor(() => expect(launchGate.sawSignal).not.toBeNull());

    await host.dispose();

    expect(launchGate.sawSignal?.aborted).toBe(true);
    await expect(started).resolves.toMatchObject({ success: false });
    expect(launchGate.spawned).toBe(0);
  });

  it('never spawns when the runtime resolves after shutdown', async () => {
    launchGate.respectSignal = false;
    const host = createHost();
    const started = host.handle(startRequest);
    await vi.waitFor(() => expect(launchGate.finish).not.toBeNull());
    const finishLate = launchGate.finish;

    await host.dispose();
    finishLate?.();

    await expect(started).resolves.toMatchObject({ success: false });
    expect(launchGate.spawned).toBe(0);
  });

  it('ends an adapter still in its handshake instead of waiting for it', async () => {
    const adapters: SilentAdapter[] = [];
    launchGate.child = () => {
      const adapter = new SilentAdapter();
      adapters.push(adapter);
      return adapter;
    };
    const host = createHost();
    const started = host.handle(startRequest);
    await vi.waitFor(() => expect(launchGate.finish).not.toBeNull());
    launchGate.finish?.();
    await vi.waitFor(() => expect(adapters).toHaveLength(1));

    await host.dispose();

    expect(adapters[0]?.exitCode).not.toBeNull();
    await expect(started).resolves.toMatchObject({ success: false });
    expect(launchGate.spawned).toBe(1);
  });

  it('refuses new calls once shut down', async () => {
    const host = createHost();
    await host.dispose();

    await expect(host.handle(startRequest)).resolves.toEqual({
      success: false,
      error: 'The machine is shutting down',
    });
    expect(launchGate.sawSignal).toBeNull();
  });
});
