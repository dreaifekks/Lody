import { describe, expect, it } from 'vitest';
import type { AgentConfigMeta, MachineId } from '@lody/shared';
import type {
  LanMachineBuild,
  LanReleaseManifest,
  LanReleaseSource,
} from '@lody/shared/lan-release';
import type { ManagedRuntimeStatus } from '@/agent/managed-agent-runtime';
import type { Logger } from '@/utils/logger';
import {
  LanControlRefused,
  LanMachineControl,
  readLanMachineUpdate,
  settleLanMachineUpdate,
  type LanMachineControlOptions,
} from './lan-machine-control';
import { LanSelfUpdateError } from './lan-self-update';

const silentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  setDebug: () => {},
  child: () => silentLogger(),
  close: async () => {},
});

const source: LanReleaseSource = { repository: 'someone/Lody', tag: 'lan-latest' };
const RUNNING = '0.100.0-lan.3';
const NEWEST = '0.100.0-lan.4';

const manifest = (version = NEWEST): LanReleaseManifest => ({
  version,
  commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  repository: source.repository,
  tag: source.tag,
  builtAt: '2026-09-29T00:00:00.000Z',
  assets: [],
});

const build = (overrides: Partial<LanMachineBuild> = {}): LanMachineBuild => ({
  version: RUNNING,
  update: 'service',
  source,
  ...overrides,
});

const provider = (overrides: Partial<AgentConfigMeta> & { agentType: string }): AgentConfigMeta =>
  ({
    id: `config-${overrides.agentType}`,
    machineId: 'machine' as MachineId,
    name: overrides.agentType,
    cliType: 'builtin',
    env: {},
    ...overrides,
  }) as AgentConfigMeta;

/** Resolves when the promise it guards is settled by the test. */
function gate() {
  let open: () => void = () => {};
  const passed = new Promise<void>((resolve) => (open = resolve));
  return { passed, open };
}

function createControl(overrides: Partial<LanMachineControlOptions> = {}) {
  const events: string[] = [];
  let clock = 1_000;
  const statuses = new Map<string, ManagedRuntimeStatus>();
  const control = new LanMachineControl({
    logger: silentLogger(),
    build: build(),
    installation: { kind: 'installer', root: '/opt/lan', runtime: 'node', entry: 'index.js' },
    runtimes: () => ({
      getRuntimeStatus: async (name) =>
        statuses.get(name) ?? {
          kind: 'not-installed',
          platformArch: 'linux-x64',
          version: '1.0.0',
        },
      ensureCurrentRuntime: async (name) => {
        events.push(`install:${name}`);
      },
      pruneSupersededVersions: async (name) => {
        events.push(`prune:${name}`);
      },
    }),
    restart: (reason) => events.push(`restart:${reason}`),
    restartCompanions: async () => {
      events.push('companions');
    },
    readNewest: async () => manifest(),
    applyUpdate: async (options) => {
      options.onPhase?.('downloading', manifest());
      options.onPhase?.('installing', manifest());
    },
    now: () => (clock += 1),
    settle: async () => {},
    ...overrides,
  });
  const reports: string[] = [];
  control.onChange(() => {
    if (control.update) reports.push(control.update.phase);
  });
  return { control, events, reports, statuses };
}

const refusal = async (run: Promise<unknown>): Promise<LanControlRefused> => {
  const error = await run.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(LanControlRefused);
  return error as LanControlRefused;
};

describe('a machine that a member asks to update', () => {
  it('answers before it is done, reports where it stands, and starts again', async () => {
    const restarted = gate();
    const { control, events, reports } = createControl({
      restart: (reason) => {
        events.push(`restart:${reason}`);
        restarted.open();
      },
    });

    await expect(control.startUpdate()).resolves.toEqual({ outcome: 'started', version: NEWEST });
    await restarted.passed;

    expect(reports).toEqual(['downloading', 'downloading', 'installing', 'restarting']);
    expect(events).toEqual(['companions', `restart:updated to ${NEWEST}`]);
    expect(control.update).toMatchObject({ phase: 'restarting', version: NEWEST });
  });

  it('reports the failure and stays what it was', async () => {
    const failed = gate();
    const { control, events } = createControl({
      applyUpdate: async () => {
        throw new LanSelfUpdateError('install_failed', 'npm could not install the build');
      },
    });
    control.onChange(() => {
      if (control.update?.phase === 'failed') failed.open();
    });

    await control.startUpdate();
    await failed.passed;

    expect(control.update).toMatchObject({
      phase: 'failed',
      version: NEWEST,
      error: 'npm could not install the build',
    });
    expect(events).toEqual([]);
    // A failed update is over: the next request starts another.
    await expect(control.startUpdate()).resolves.toMatchObject({ outcome: 'started' });
  });

  it('does nothing when it runs the newest build', async () => {
    const { control, reports } = createControl({ readNewest: async () => manifest(RUNNING) });

    await expect(control.startUpdate()).resolves.toEqual({ outcome: 'current', version: RUNNING });
    expect(reports).toEqual([]);
    expect(control.update).toBeNull();
  });

  it('refuses what it cannot carry out, and says why', async () => {
    const desktop = createControl({ build: build({ update: 'desktop' }) }).control;
    expect((await refusal(desktop.startUpdate())).reason).toBe('desktop');

    const manual = createControl({ build: build({ update: 'manual' }) }).control;
    expect((await refusal(manual.startUpdate())).reason).toBe('manual');

    const unstamped = createControl({ build: { version: RUNNING, update: 'service' } }).control;
    expect((await refusal(unstamped.startUpdate())).reason).toBe('manual');

    const unreachable = createControl({
      readNewest: async () => {
        throw new LanSelfUpdateError('release', 'The release did not answer');
      },
    }).control;
    expect((await refusal(unreachable.startUpdate())).reason).toBe('release');
  });

  it('refuses a second update while one is under way', async () => {
    const installing = gate();
    const { control } = createControl({
      applyUpdate: async () => {
        await installing.passed;
      },
    });

    await control.startUpdate();
    expect((await refusal(control.startUpdate())).reason).toBe('busy');
    installing.open();
  });
});

describe('the newest build a machine knows of', () => {
  it('reads the release once for a while, and again soon after it could not', async () => {
    let reads = 0;
    let reachable = true;
    let clock = 0;
    const { control } = createControl({
      now: () => clock,
      readNewest: async () => {
        reads += 1;
        if (!reachable) throw new Error('offline');
        return manifest();
      },
    });

    expect(await control.readNewestRelease()).toMatchObject({ version: NEWEST });
    clock += 9 * 60_000;
    expect(await control.readNewestRelease()).toMatchObject({ version: NEWEST });
    expect(reads).toBe(1);

    reachable = false;
    clock += 2 * 60_000;
    expect(await control.readNewestRelease()).toBeNull();
    clock += 30_000;
    expect(await control.readNewestRelease()).toBeNull();
    expect(reads).toBe(2);

    reachable = true;
    clock += 60_000;
    expect(await control.readNewestRelease()).toMatchObject({ version: NEWEST });
  });

  it('knows of none for a build that follows no release', async () => {
    const { control } = createControl({ build: { version: '0.100.0', update: 'manual' } });
    expect(await control.readNewestRelease()).toBeNull();
  });
});

describe('the runtimes of the agents of a machine', () => {
  it('tells of the runtimes its providers run, and of nothing else', async () => {
    const { control, statuses } = createControl();
    statuses.set('claude-code', {
      kind: 'installed',
      platformArch: 'linux-x64',
      version: '2.1.280',
      targetVersion: '2.1.280',
      command: '/data/claude',
      updateAvailable: false,
    });
    statuses.set('codex', {
      kind: 'installed',
      platformArch: 'linux-x64',
      version: '0.155.0',
      targetVersion: '0.156.0',
      command: '/data/codex',
      updateAvailable: true,
    });
    statuses.set('kimi-code', {
      kind: 'incompatible-host',
      reason: 'node-version',
      current: '22.14.0',
      required: '22.19.0',
    });

    const agents = await control.describeAgents([
      provider({ agentType: 'claude' }),
      provider({ agentType: 'codex' }),
      provider({ agentType: 'grok' }),
      provider({ agentType: 'kimi' }),
      // Runs from a path of its own, so the managed runtime is not what it uses.
      provider({ agentType: 'pi', cliType: 'custom' }),
      provider({ agentType: 'deepseek' }),
    ]);

    expect(agents).toEqual([
      { agentType: 'kimi', name: 'Kimi Code', state: 'unsupported' },
      { agentType: 'grok', name: 'Grok', target: '1.0.0', state: 'missing' },
      {
        agentType: 'claude',
        name: 'Claude Code',
        version: '2.1.280',
        target: '2.1.280',
        state: 'current',
      },
      {
        agentType: 'codex',
        name: 'Codex',
        version: '0.155.0',
        target: '0.156.0',
        state: 'outdated',
      },
    ]);
  });

  it('leaves out an agent every provider runs from a path of its own', async () => {
    const { control } = createControl();
    const own = provider({
      agentType: 'claude',
      runtimeOverrides: { claudeCodeExecutable: '/usr/local/bin/claude' },
    });

    expect(await control.describeAgents([own])).toEqual([]);
    expect(await control.describeAgents([own, provider({ agentType: 'claude' })])).toHaveLength(1);
  });

  it('installs the runtime a member asks for and says when it is done', async () => {
    const downloading = gate();
    const installed = gate();
    const events: string[] = [];
    const statuses = new Map<string, ManagedRuntimeStatus>();
    const { control } = createControl({
      runtimes: () => ({
        getRuntimeStatus: async (name) =>
          statuses.get(name) ?? {
            kind: 'not-installed',
            platformArch: 'linux-x64',
            version: '0.156.0',
          },
        ensureCurrentRuntime: async (name) => {
          events.push(`install:${name}`);
          await downloading.passed;
        },
        pruneSupersededVersions: async (name) => {
          events.push(`prune:${name}`);
        },
      }),
    });
    const changes: number[] = [];
    control.onChange(() => {
      changes.push(changes.length);
      if (changes.length === 2) installed.open();
    });

    await expect(control.installAgent('codex')).resolves.toEqual({
      agentType: 'codex',
      outcome: 'started',
    });
    // Asking again while it downloads starts nothing else.
    await expect(control.installAgent('codex')).resolves.toMatchObject({ outcome: 'started' });
    expect(await control.describeAgents([provider({ agentType: 'codex' })])).toEqual([
      { agentType: 'codex', name: 'Codex', target: '0.156.0', state: 'updating' },
    ]);

    statuses.set('codex', {
      kind: 'installed',
      platformArch: 'linux-x64',
      version: '0.156.0',
      targetVersion: '0.156.0',
      command: '/data/codex',
      updateAvailable: false,
    });
    downloading.open();
    await installed.passed;

    expect(events).toEqual(['install:codex', 'prune:codex']);
    expect(await control.describeAgents([provider({ agentType: 'codex' })])).toMatchObject([
      { version: '0.156.0', state: 'current' },
    ]);
    await expect(control.installAgent('codex')).resolves.toEqual({
      agentType: 'codex',
      outcome: 'current',
    });
  });

  it('refuses a runtime it does not install', async () => {
    const { control, statuses } = createControl();
    expect((await refusal(control.installAgent('deepseek'))).reason).toBe('unknown_agent');

    statuses.set('pi', { kind: 'unsupported-platform', platformArch: 'linux-arm' });
    expect((await refusal(control.installAgent('pi'))).reason).toBe('unknown_agent');
  });
});

describe('an update a machine reported before it started again', () => {
  const reported = { phase: 'restarting', version: NEWEST, at: 10 } as const;

  it('is over when the machine runs what it installed', () => {
    expect(settleLanMachineUpdate(reported, NEWEST, 99)).toBeNull();
    expect(settleLanMachineUpdate({ ...reported, phase: 'failed' }, NEWEST, 99)).toBeNull();
    expect(settleLanMachineUpdate(null, RUNNING, 99)).toBeNull();
  });

  it('did not happen when the machine runs what it ran', () => {
    for (const phase of ['downloading', 'installing', 'restarting'] as const) {
      expect(settleLanMachineUpdate({ ...reported, phase }, RUNNING, 99)).toMatchObject({
        phase: 'failed',
        version: NEWEST,
        at: 99,
      });
    }
  });

  it('keeps a failure until another update replaces it', () => {
    const failed = { ...reported, phase: 'failed', error: 'no npm' } as const;
    expect(settleLanMachineUpdate(failed, RUNNING, 99)).toEqual(failed);
  });
});

describe('an update another machine reported', () => {
  const MINUTE = 60_000;
  const reported = { phase: 'installing', version: NEWEST, at: 100 * MINUTE } as const;

  it('is over once the machine registered with the version it installed', () => {
    // A build that does not know of reports leaves its last one behind.
    expect(readLanMachineUpdate({ ...reported, phase: 'restarting' }, NEWEST, 0)).toBeNull();
    expect(readLanMachineUpdate(null, RUNNING, 0)).toBeNull();
  });

  it('stands as the machine reported it while that is recent', () => {
    expect(readLanMachineUpdate(reported, RUNNING, 129 * MINUTE)).toEqual(reported);
    expect(readLanMachineUpdate(reported, null, 101 * MINUTE)).toEqual(reported);
  });

  it('failed when the machine never said how it ended', () => {
    expect(readLanMachineUpdate(reported, RUNNING, 131 * MINUTE)).toMatchObject({
      phase: 'failed',
      version: NEWEST,
      at: reported.at,
    });
    const failed = { ...reported, phase: 'failed', error: 'no npm' } as const;
    expect(readLanMachineUpdate(failed, RUNNING, 900 * MINUTE)).toEqual(failed);
  });
});
