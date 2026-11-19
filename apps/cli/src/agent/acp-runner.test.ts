import { AgentSideConnection, PROTOCOL_VERSION, type Stream } from '@agentclientprotocol/sdk';
import {
  initializeAndReadAcpRateLimits,
  initializeAndRunSorbetCredentials,
  queryLocalAcpRateLimits,
  runLocalSorbetCredentials,
} from './acp-runner';
import { spawn } from 'node:child_process';
import * as loginShell from './login-shell-env';
import * as setting from './setting';
import { getLodyNpmCacheDir } from './npx-cache';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __test__,
  prepareAcpProcessEnvironmentLegacy,
  shutdownLocalAcpAgent,
  spawnAcpProcess,
} from './acp-runner';
import type { Logger } from '@/utils/logger';
import { FakeProcessTable } from '@lody/shared/node/process-testing';

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

function createFakeChildProcess(options?: {
  exitOnSigterm?: boolean;
  exitOnSigkill?: boolean;
  pid?: number;
}): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.exitCode = null;
  child.pid = options?.pid;
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    if (signal === 'SIGTERM' && options?.exitOnSigterm !== false) {
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0, signal));
    }
    if (signal === 'SIGKILL' && options?.exitOnSigkill !== false) {
      child.exitCode = 137;
      queueMicrotask(() => child.emit('exit', 137, signal));
    }
    return true;
  });
  return child;
}

describe('spawnAcpProcess', () => {
  it('spawns ACP agents in a detached process group on POSIX', () => {
    const child = createFakeChildProcess();
    const spawnImpl = vi.fn(() => child);

    const result = spawnAcpProcess({
      cliType: 'builtin',
      agentType: 'codex',
      workdir: '/tmp',
      env: process.env,
      command: 'test-command',
      args: ['--test'],
      spawnImpl: spawnImpl as never,
    });

    expect(result).toBe(child);
    expect(spawnImpl).toHaveBeenCalledWith('test-command', ['--test'], {
      cwd: '/tmp',
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  });
});

describe('Codex title-agent environment', () => {
  it('isolates the title agent in the workdir Codex home', () => {
    const baseEnv = { LODY_TITLE_AGENT: '1', LODY_E2E: '1' };

    const prepared = __test__.prepareCodexHomeEnv(
      { cliType: 'builtin', agentType: 'codex', workdir: '/tmp/title-agent' },
      baseEnv
    );

    expect(prepared.isTitleAgentCodexRun).toBe(true);
    expect(prepared.shouldUseWorkdirCodexHome).toBe(true);
    expect(prepared.env.CODEX_HOME).toBe(path.join('/tmp/title-agent', '.codex'));
  });

  it('merges title isolation into existing Codex session config', () => {
    const env = __test__.withTitleAgentCodexConfig({
      CODEX_CONFIG: JSON.stringify({
        model_provider: 'gateway',
        model_providers: { gateway: { base_url: 'https://gateway.example/v1' } },
        skills: { include_instructions: true },
      }),
    });

    expect(JSON.parse(env.CODEX_CONFIG ?? '')).toEqual({
      model_provider: 'gateway',
      model_providers: { gateway: { base_url: 'https://gateway.example/v1' } },
      project_doc_max_bytes: 0,
      include_environment_context: false,
      skills: {
        include_instructions: false,
        bundled: { enabled: false },
      },
    });
  });

  it('copies custom provider config into the isolated Codex home', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-title-config-test-'));
    const sourcePath = path.join(tempDir, 'source.toml');
    const destinationPath = path.join(tempDir, 'isolated', 'config.toml');
    const config = `model_provider = "gateway"

[model_providers.gateway]
base_url = "https://gateway.example/v1"
`;
    fs.writeFileSync(sourcePath, config);
    fs.mkdirSync(path.dirname(destinationPath));

    try {
      __test__.copyTitleAgentCodexConfig(sourcePath, destinationPath);

      expect(fs.readFileSync(destinationPath, 'utf8')).toBe(config);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('still isolates non-title Codex E2E runs in the workdir', () => {
    const prepared = __test__.prepareCodexHomeEnv(
      { cliType: 'builtin', agentType: 'codex', workdir: '/tmp/codex-e2e' },
      { LODY_E2E: '1' }
    );

    expect(prepared.isTitleAgentCodexRun).toBe(false);
    expect(prepared.shouldUseWorkdirCodexHome).toBe(true);
    expect(prepared.env.CODEX_HOME).toBe(path.join('/tmp/codex-e2e', '.codex'));
  });
});

describe('shutdownLocalAcpAgent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const spawnAgent = (table: FakeProcessTable): ChildProcess =>
    table.api.spawn('agent', [], { detached: true });

  it('closes the ACP session before terminating the agent process group', async () => {
    const table = new FakeProcessTable('linux');
    const child = spawnAgent(table);
    const leader = child.pid ?? -1;
    const descendant = table.addDescendant(leader);
    const signalsAtClose: unknown[] = [];
    const client = {
      closeSession: vi.fn(async () => {
        signalsAtClose.push(...table.delivered);
        return true;
      }),
    };

    await shutdownLocalAcpAgent({
      agentProcess: child,
      client: client as never,
      acpSessionId: 'acp-1' as never,
      logger: createSilentLogger(),
      sessionLabel: 'test-local-agent',
      nodeProcess: table.api,
    });

    expect(client.closeSession).toHaveBeenCalledWith('acp-1', 5000);
    expect(signalsAtClose).toEqual([]);
    expect(table.delivered).toEqual([{ target: -leader, signal: 'SIGTERM' }]);
    expect(table.isAlive(descendant)).toBe(false);
  });

  it('escalates to SIGKILL when the agent ignores SIGTERM', async () => {
    vi.useFakeTimers();
    const table = new FakeProcessTable('linux');
    table.queueSpawn({ ignores: ['SIGTERM'] });
    const child = spawnAgent(table);
    const leader = child.pid ?? -1;

    const shutdown = shutdownLocalAcpAgent({
      agentProcess: child,
      logger: createSilentLogger(),
      sessionLabel: 'test-local-agent',
      exitTimeoutMs: 10,
      nodeProcess: table.api,
    });
    await vi.advanceTimersByTimeAsync(20);
    await shutdown;

    expect(table.delivered).toEqual([
      { target: -leader, signal: 'SIGTERM' },
      { target: -leader, signal: 'SIGKILL' },
    ]);
    expect(table.isAlive(leader)).toBe(false);
  });

  // Probe, title, and login agents are never reused, so a survivor is logged
  // as a leak instead of failing a caller whose real work already finished.
  it('reports an agent that survives termination without rejecting', async () => {
    vi.useFakeTimers();
    const table = new FakeProcessTable('linux');
    table.queueSpawn({ ignores: ['SIGTERM', 'SIGKILL'] });
    const warnings: string[] = [];
    const logger = {
      ...createSilentLogger(),
      warn: (message: unknown) => warnings.push(String(message)),
    };

    const shutdown = shutdownLocalAcpAgent({
      agentProcess: spawnAgent(table),
      logger,
      sessionLabel: 'test-local-agent',
      exitTimeoutMs: 10,
      nodeProcess: table.api,
    });
    await vi.advanceTimersByTimeAsync(30);

    await expect(shutdown).resolves.toBeUndefined();
    expect(warnings.join('\n')).toContain(
      '[test-local-agent] ACP agent process could not be terminated'
    );
  });
});

describe('read-only quota ACP handshake', () => {
  it.each([true, false])(
    'queries only when advertised (query=%s), without creating a session',
    async (query) => {
      const outbound = new TransformStream();
      const inbound = new TransformStream();
      const limits = {
        rateLimits: [
          {
            limitId: 'account',
            scope: { providerId: 'example' },
            windows: [
              { usedPercent: 37, windowDurationSeconds: 18000, resetsAtEpochSeconds: null },
            ],
          },
        ],
        fetchedAtEpochSeconds: 123,
      };
      let sessions = 0;
      let initialization: unknown;
      const _server = new AgentSideConnection(
        () => ({
          initialize: async (params) => {
            initialization = params.clientCapabilities;
            return {
              protocolVersion: PROTOCOL_VERSION,
              agentCapabilities: {
                _meta: { lody: { rateLimits: { version: 1, ...(query ? { query: true } : {}) } } },
              },
            };
          },
          newSession: async () => {
            sessions++;
            throw new Error('Unexpected session');
          },
          authenticate: async () => {
            throw new Error('Unexpected login');
          },
          prompt: async () => {
            throw new Error('Unexpected prompt');
          },
          cancel: async () => {},
          extMethod: async (method) => {
            if (method !== '_lody/rate_limits/get' && method !== 'lody/rate_limits/get')
              throw new Error(method);
            return limits;
          },
        }),
        { readable: outbound.readable, writable: inbound.writable } as Stream
      );
      const result = initializeAndReadAcpRateLimits({
        readable: inbound.readable,
        writable: outbound.writable,
      } as Stream);
      if (query) await expect(result).resolves.toEqual(limits);
      else await expect(result).rejects.toThrow('unsupported');
      expect(sessions).toBe(0);
      expect(initialization).toMatchObject({
        terminal: false,
        fs: { readTextFile: false, writeTextFile: false },
      });
    }
  );
});

describe('Sorbet credentials ACP handshake', () => {
  it('recovers a failed npm startup before running logout exactly once', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-sorbet-credentials-offline-'));
    vi.stubEnv('LODY_DATA_DIR', root);
    vi.spyOn(loginShell, 'getLoginShellEnvLegacy').mockResolvedValue({});
    const install = path.join(getLodyNpmCacheDir(), '_npx', 'aa11');
    const pkg = path.join(install, 'node_modules', '@sorbetai', 'acp');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(install, 'package.json'),
      JSON.stringify({ _npx: { packages: ['@sorbetai/acp@alpha'] } })
    );
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ version: '0.1.0', bin: 'index.js' })
    );
    fs.writeFileSync(path.join(pkg, 'index.js'), '');
    const marker = path.join(root, 'logout');
    const attempts: string[][] = [];
    const script = `
      const readline = require('node:readline');
      const fs = require('node:fs');
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        if (request.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: { _meta: { 'sorbet.dev': { credentials: { version: 1 } } } } } }) + '\\n');
        } else if (request.method === '_sorbet/auth/credentials/logout') {
          fs.appendFileSync(process.env.TEST_MARKER, 'logout\\n');
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
        }
      });`;
    try {
      const result = await runLocalSorbetCredentials(
        createSilentLogger(),
        { type: 'logout', providerId: 'example' },
        undefined,
        {
          spawnImpl: ((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
            attempts.push([...args]);
            const code =
              attempts.length === 1
                ? "console.error('npm error code ENOTFOUND'); process.exit(1)"
                : script;
            return spawn(process.execPath, ['-e', code], {
              ...options,
              env: { ...options.env, TEST_MARKER: marker },
            });
          }) as never,
        }
      );
      expect(result).toEqual({ kind: 'credentials', credentials: [] });
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toContain('--offline');
      expect(fs.readFileSync(marker, 'utf8')).toBe('logout\n');
      attempts.length = 0;
      const failingScript = script.replace(
        "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })",
        "console.error('npm error code ENOTFOUND'); process.exit(1); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })"
      );
      await expect(
        runLocalSorbetCredentials(
          createSilentLogger(),
          { type: 'logout', providerId: 'example' },
          undefined,
          {
            spawnImpl: ((
              _command: string,
              args: string[],
              options: { env?: NodeJS.ProcessEnv }
            ) => {
              attempts.push([...args]);
              return spawn(process.execPath, ['-e', failingScript], {
                ...options,
                env: { ...options.env, TEST_MARKER: marker },
              });
            }) as never,
          }
        )
      ).rejects.toThrow();
      expect(attempts).toHaveLength(1);
      expect(fs.readFileSync(marker, 'utf8')).toBe('logout\nlogout\n');
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['list', 'logout'] as const)(
    'initializes without session capabilities and executes %s',
    async (operation) => {
      const outbound = new TransformStream();
      const inbound = new TransformStream();
      let initialization: unknown;
      const received: Array<{ method: string; params: unknown }> = [];
      const server = new AgentSideConnection(
        () => ({
          initialize: async (params) => {
            initialization = params.clientCapabilities;
            return {
              protocolVersion: PROTOCOL_VERSION,
              agentCapabilities: { _meta: { 'sorbet.dev': { credentials: { version: 1 } } } },
            };
          },
          newSession: async () => {
            throw new Error('Unexpected session');
          },
          authenticate: async () => {
            throw new Error('Unexpected authentication');
          },
          prompt: async () => {
            throw new Error('Unexpected prompt');
          },
          cancel: async () => {},
          extMethod: async (method, params) => {
            received.push({ method, params });
            return method.endsWith('/list')
              ? { credentials: [{ providerId: 'example', type: 'oauth' }] }
              : {};
          },
        }),
        { readable: outbound.readable, writable: inbound.writable } as Stream
      );
      void server;
      const result = await initializeAndRunSorbetCredentials(
        { readable: inbound.readable, writable: outbound.writable } as Stream,
        new AbortController().signal,
        operation === 'list' ? { type: 'list' } : { type: 'logout', providerId: 'example' }
      );
      expect(initialization).toMatchObject({
        terminal: false,
        fs: { readTextFile: false, writeTextFile: false },
      });
      expect(received).toEqual([
        {
          method: `_sorbet/auth/credentials/${operation}`,
          params: operation === 'list' ? {} : { providerId: 'example' },
        },
      ]);
      expect(result).toEqual(
        operation === 'list' ? [{ providerId: 'example', type: 'oauth' }] : []
      );
    }
  );
});

describe('ACP system Node prerequisites', () => {
  it('leaves other launch environments unchanged even if inherited fields resemble DSH', async () => {
    const env = { PATH: '', ELECTRON_RUN_AS_NODE: '1', LODY_DSH_NODE_ARGS: 'inherited' };
    expect(
      await prepareAcpProcessEnvironmentLegacy({ command: 'other-agent', args: [] }, env)
    ).toBe(env);
  });

  it('reports Node missing before starting a builtin DSH process', async () => {
    const launch = { command: 'npx', args: [], env: { LODY_DSH_NODE_ARGS: 'synthetic' } };
    await expect(prepareAcpProcessEnvironmentLegacy(launch, { PATH: '' })).rejects.toThrow(
      '[DSH_NODE_NOT_FOUND]'
    );
  });
});

describe('builtin agy quota command', () => {
  const quota = {
    status: 'SUCCESS',
    num_turns: 0,
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              {
                id: 'gemini-weekly',
                window: 'weekly',
                remaining_fraction: 0.25,
                reset_time: '2030-01-08T12:00:00Z',
              },
              { id: 'gemini-5h', window: '5h', remaining_fraction: 0 },
            ],
          },
          {
            name: 'Other models',
            buckets: [{ id: 'other-weekly', window: 'weekly', remaining_fraction: 1 }],
          },
        ],
      },
    },
  };
  it.each([
    ['builtin', 'antigravity'],
    ['registry', 'antigravity-acp'],
  ] as const)('queries %s/%s without creating a model turn', async (cliType, agentType) => {
    vi.spyOn(loginShell, 'getLoginShellEnvLegacy').mockResolvedValue({});
    vi.spyOn(setting, 'resolveACPProcessLaunchAsync').mockResolvedValue({
      command: '/selected/agy',
      args: ['acp'],
      env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
    });
    try {
      const snapshot = await queryLocalAcpRateLimits({
        cliType,
        agentType,
        workdir: os.tmpdir(),
        env: { AGY_TEST_ACCOUNT: 'chosen' },
        logger: createSilentLogger(),
        terminalManager: {} as never,
        onUpdateMessage: () => {},
        onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        spawnImpl: ((command, args, options) =>
          spawn(
            process.execPath,
            [
              '-e',
              `
          if (${JSON.stringify('/selected/agy')} !== ${JSON.stringify(command)} || process.env.AGY_TEST_ACCOUNT !== 'chosen' || process.env.AGY_CLI_DISABLE_AUTO_UPDATE !== 'true') process.exit(2);
          if (JSON.stringify(process.argv.slice(1)) !== JSON.stringify(['--print','/usage','--output-format','json'])) process.exit(3);
          console.log(${JSON.stringify(JSON.stringify(quota))});
        `,
              '--',
              ...args,
            ],
            options
          )) as NonNullable<Parameters<typeof queryLocalAcpRateLimits>[0]['spawnImpl']>,
      });
      expect(snapshot.rateLimits[0]).toEqual({
        limitId: 'antigravity',
        scope: { providerId: 'antigravity' },
        windows: [
          {
            label: 'Gemini Models',
            usedPercent: 75,
            windowDurationSeconds: 604800,
            resetsAtEpochSeconds: Date.parse('2030-01-08T12:00:00Z') / 1000,
          },
          {
            label: 'Gemini Models',
            usedPercent: 100,
            windowDurationSeconds: 18000,
            resetsAtEpochSeconds: null,
          },
          {
            label: 'Other models',
            usedPercent: 0,
            windowDurationSeconds: 604800,
            resetsAtEpochSeconds: null,
          },
        ],
      });
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('agy quota failure isolation', () => {
  const options = () => ({
    cliType: 'builtin' as const,
    agentType: 'antigravity',
    workdir: os.tmpdir(),
    env: {},
    logger: createSilentLogger(),
    terminalManager: {} as never,
    onUpdateMessage: () => {},
    onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
  });
  it.each([
    'invalid json',
    JSON.stringify({
      status: 'SUCCESS',
      num_turns: 1,
      command: { name: 'usage', data: { groups: [] } },
    }),
    JSON.stringify({
      status: 'SUCCESS',
      num_turns: 0,
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini',
              buckets: [{ id: 'weekly', window: 'weekly', remaining_fraction: 2 }],
            },
          ],
        },
      },
    }),
  ])(
    'rejects unavailable or malformed quota without returning a fabricated reading: %#',
    async (payload) => {
      vi.spyOn(loginShell, 'getLoginShellEnvLegacy').mockResolvedValue({});
      vi.spyOn(setting, 'resolveACPProcessLaunchAsync').mockResolvedValue({
        command: '/selected/agy',
        args: ['acp'],
      });
      try {
        await expect(
          queryLocalAcpRateLimits({
            ...options(),
            spawnImpl: ((_cmd, _args, opts) =>
              spawn(
                process.execPath,
                ['-e', `console.log(${JSON.stringify(payload)})`],
                opts
              )) as never,
          })
        ).rejects.toThrow();
      } finally {
        vi.restoreAllMocks();
      }
    }
  );
  it('cancels the owned quota child and waits for its exit before allowing a retry', async () => {
    vi.spyOn(loginShell, 'getLoginShellEnvLegacy').mockResolvedValue({});
    vi.spyOn(setting, 'resolveACPProcessLaunchAsync').mockResolvedValue({
      command: '/selected/agy',
      args: ['acp'],
    });
    const controller = new AbortController();
    let ready = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let child: ChildProcess | undefined;
    try {
      const outcome = queryLocalAcpRateLimits({
        ...options(),
        signal: controller.signal,
        spawnImpl: ((_cmd, _args, opts) => {
          child = spawn(
            process.execPath,
            ['-e', "console.error('ready'); setInterval(()=>{}, 10000);"],
            opts
          );
          child.stderr?.on('data', (chunk) => {
            if (String(chunk).includes('ready')) ready();
          });
          return child;
        }) as never,
      });
      const rejected = expect(outcome).rejects.toThrow();
      await started;
      controller.abort();
      await rejected;
      expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
