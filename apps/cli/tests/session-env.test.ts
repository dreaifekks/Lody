import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path, { delimiter } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId, WorkspaceId } from '@lody/shared';

// Control the login-shell overlay so we can simulate a `~/.zshrc` that exports
// ANTHROPIC_* (the second auth source the scrub must still see). Defaults to {}
// so every other test behaves as if the cache is cold.
const loginShellOverlay = vi.hoisted(() => ({ value: {} as NodeJS.ProcessEnv }));
const resolvedLoginShellOverlay = vi.hoisted(() => ({ value: {} as NodeJS.ProcessEnv }));
vi.mock('@/agent/login-shell-env', () => ({
  getCachedLoginShellEnvSync: () => loginShellOverlay.value,
  getLoginShellEnv: async () => resolvedLoginShellOverlay.value,
  resetLoginShellEnvCache: () => {
    loginShellOverlay.value = {};
    resolvedLoginShellOverlay.value = {};
  },
}));

import { installLanSessionCommand, setLanSessionCommand } from '../src/lib/lan/lan-session-command';
import { buildPrompt } from '../src/session/session-execution-helpers';
import { Session } from '../src/session/session';
import type { CreateAgentConfig } from '../src/session/session-manager';
import type { SessionSandbox } from '../src/session/session-sandbox';
import type { SessionConfig } from '../src/session/types';
import type { Logger } from '../src/utils/logger';

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

const createConfig = (overrides: Partial<SessionConfig> = {}): SessionConfig => ({
  workspaceId: 'workspace-1' as WorkspaceId,
  requesterUserId: 'user-1',
  machineId: 'machine-1',
  agentCliType: 'builtin',
  agentType: 'codex',
  sessionId: 'session-1' as SessionId,
  userName: 'Test User',
  userEmail: 'test@example.com',
  ...overrides,
});

describe('Session buildShellEnv', () => {
  afterEach(() => {
    loginShellOverlay.value = {};
    resolvedLoginShellOverlay.value = {};
  });

  it('exposes the workspace owner session id for child sessions', () => {
    const session = new Session(
      createConfig({
        sessionId: 'child-session-2' as SessionId,
        parentSessionId: 'parent-session-1' as SessionId,
      }),
      createSilentLogger()
    );

    const env = (session as unknown as { buildShellEnv(): NodeJS.ProcessEnv }).buildShellEnv();

    expect(env.LODY_SESSION_ID).toBe('child-session-2');
    expect(env.LODY_WORKSPACE_SESSION_ID).toBe('parent-session-1');
  });

  it('falls back to its own session id when no parent session exists', () => {
    const session = new Session(createConfig(), createSilentLogger());

    const env = (session as unknown as { buildShellEnv(): NodeJS.ProcessEnv }).buildShellEnv();

    expect(env.LODY_SESSION_ID).toBe('session-1');
    expect(env.LODY_WORKSPACE_SESSION_ID).toBe('session-1');
  });

  it('allows updateEnv to remove stale session environment keys', () => {
    const session = new Session(
      createConfig({
        env: {
          GH_TOKEN: 'old-token',
          LODY_MANAGED_GH_TOKEN_SHA256: 'old-marker',
        },
      }),
      createSilentLogger()
    );

    session.updateEnv({
      GH_TOKEN: undefined,
      LODY_MANAGED_GH_TOKEN_SHA256: undefined,
      LODY_GIT_CRED_CONTEXT_TOKEN: 'next-context',
    });

    const env = (session as unknown as { buildShellEnv(): NodeJS.ProcessEnv }).buildShellEnv();

    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.LODY_MANAGED_GH_TOKEN_SHA256).toBeUndefined();
    expect(env.LODY_GIT_CRED_CONTEXT_TOKEN).toBe('next-context');
  });

  it('scrubs inherited Anthropic auth when claude session has explicit ANTHROPIC_AUTH_TOKEN', () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-from-shell';
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    try {
      const session = new Session(
        createConfig({
          agentType: 'claude',
          env: {
            ANTHROPIC_AUTH_TOKEN: 'sk-from-config',
            ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          },
        }),
        createSilentLogger()
      );

      const env = (session as unknown as { buildShellEnv(): NodeJS.ProcessEnv }).buildShellEnv();

      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-from-config');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    } finally {
      if (original === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = original;
      }
      delete process.env.CLAUDE_CODE_USE_BEDROCK;
    }
  });

  it('does not scrub inherited Anthropic env for non-claude agents', () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-from-shell';
    try {
      const session = new Session(
        createConfig({
          agentType: 'codex',
          env: { ANTHROPIC_AUTH_TOKEN: 'sk-from-config' },
        }),
        createSilentLogger()
      );

      const env = (session as unknown as { buildShellEnv(): NodeJS.ProcessEnv }).buildShellEnv();

      expect(env.ANTHROPIC_API_KEY).toBe('sk-from-shell');
    } finally {
      if (original === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = original;
      }
    }
  });

  it('preserves inherited Anthropic env when claude session has no explicit auth/routing', () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-from-shell';
    try {
      const session = new Session(
        createConfig({
          agentType: 'claude',
        }),
        createSilentLogger()
      );

      const env = (session as unknown as { buildShellEnv(): NodeJS.ProcessEnv }).buildShellEnv();

      // Subscription / OAuth / shell-set users should still see their inherited credentials.
      expect(env.ANTHROPIC_API_KEY).toBe('sk-from-shell');
    } finally {
      if (original === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = original;
      }
    }
  });

  it('scrubs Anthropic auth that the login-shell env reintroduces (regression)', () => {
    // Regression: the login profile (~/.zshrc) is a *second* source of ANTHROPIC_*.
    // buildShellEnv must overlay the login-shell env BEFORE scrubbing — otherwise a
    // stray `ANTHROPIC_API_KEY` from the shell silently overrides the configured
    // `ANTHROPIC_AUTH_TOKEN`, defeating the scrub.
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY; // isolate: the login shell is the only source
    loginShellOverlay.value = {
      ANTHROPIC_API_KEY: 'sk-from-login-shell',
      PATH: '/opt/homebrew/bin',
    };
    try {
      const session = new Session(
        createConfig({
          agentType: 'claude',
          env: {
            ANTHROPIC_AUTH_TOKEN: 'sk-from-config',
            ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          },
        }),
        createSilentLogger()
      );

      const env = (session as unknown as { buildShellEnv(): NodeJS.ProcessEnv }).buildShellEnv();

      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-from-config');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
      // The ENOENT fix is preserved: the login-shell PATH still reaches the agent.
      expect((env.PATH ?? '').split(delimiter)).toContain('/opt/homebrew/bin');
    } finally {
      if (original === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = original;
      }
    }
  });

  it.each([undefined, { providerId: 'nowledge-mem', memoryId: 'reviewer' }])(
    'awaits the shell and injects the frozen memory at ACP spawn: %j',
    async (memory) => {
      loginShellOverlay.value = { PATH: '/usr/bin' };
      resolvedLoginShellOverlay.value = {
        PATH: ['/opt/homebrew/bin', '/usr/bin'].join(delimiter),
      };

      let spawnedEnv: NodeJS.ProcessEnv | undefined;
      const stopAfterCapture = new Error('stop after capturing ACP spawn environment');
      const spawn: SessionSandbox['spawn'] = vi.fn(async (_command, _args, options) => {
        spawnedEnv = options.env;
        throw stopAfterCapture;
      });
      const sandbox: SessionSandbox = {
        enabled: false,
        description: 'test',
        applyLimits: async () => {},
        readResourceAccounting: async () => ({ kind: 'unavailable', reason: 'test' }),
        spawn,
        terminate: async () => {},
        cleanup: async () => {},
      };
      const session = new Session(
        createConfig({ memory }),
        createSilentLogger(),
        process.cwd(),
        sandbox
      );
      const callbacks = {
        cliType: 'registry',
        agentType: 'opencode',
        command: 'opencode',
        args: ['acp'],
      } as CreateAgentConfig;

      await expect(session.createAgent(callbacks)).rejects.toBe(stopAfterCapture);
      if (memory) expect(spawnedEnv?.NMEM_AGENT_ID).toBe(memory.memoryId);
      expect((spawnedEnv?.PATH ?? '').split(delimiter)).toEqual(
        expect.arrayContaining(['/opt/homebrew/bin', '/usr/bin'])
      );
      expect((spawnedEnv?.PATH ?? '').split(delimiter).indexOf('/opt/homebrew/bin')).toBeLessThan(
        (spawnedEnv?.PATH ?? '').split(delimiter).indexOf('/usr/bin')
      );
    }
  );
});

describe('the lody-lan command of a session', () => {
  let directory: string;
  let warnings: string[];

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-session-command-'));
    warnings = [];
  });

  afterEach(() => {
    setLanSessionCommand(null);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  // A PATH of its own: the one the suite runs with may lead with a gh shim.
  const buildEnv = (overrides: Partial<SessionConfig> = {}): NodeJS.ProcessEnv =>
    (
      new Session(
        createConfig({ env: { PATH: '/usr/bin' }, ...overrides }),
        createSilentLogger()
      ) as unknown as { buildShellEnv(): NodeJS.ProcessEnv }
    ).buildShellEnv();

  /** Stands in for the CLI: says what it was started with. */
  const writeEntry = (): string => {
    const entry = path.join(directory, 'entry.cjs');
    fs.writeFileSync(
      entry,
      'console.log(JSON.stringify([process.argv.slice(2), process.env.LODY_LAN_COMMAND]))'
    );
    return entry;
  };

  const install = (
    options: Partial<Parameters<typeof installLanSessionCommand>[0]> = {}
  ): string => {
    installLanSessionCommand({
      runtime: { execPath: process.execPath, entry: writeEntry() },
      isLanMember: () => true,
      logger: { warn: (...args: unknown[]) => warnings.push(args.join(' ')) },
      dataDir: directory,
      ...options,
    });
    return path.join(directory, 'session-bin');
  };

  it('leads the PATH of an agent and runs the CLI of the agent service that started it', () => {
    const withoutCommand = buildEnv();
    const binDir = install();

    const env = buildEnv();

    // Nothing else changes, and without the command nothing is added.
    expect(env).toEqual({ ...withoutCommand, PATH: [binDir, withoutCommand.PATH].join(delimiter) });
    expect(
      execFileSync('lody-lan', ['lan', 'shell', 'mba', '--', 'uname -a'], {
        env,
        encoding: 'utf8',
      }).trim()
    ).toBe('[["lan","shell","mba","--","uname -a"],"lody-lan"]');
    expect(warnings).toEqual([]);
  });

  it('follows the gh shim of a session, which stays first', () => {
    const binDir = install();

    const entries = (
      buildEnv({
        githubCredentialPolicy: {
          allowLocalAuth: true,
          stateFilePath: path.join(directory, 'broker.json'),
        },
      }).PATH ?? ''
    ).split(delimiter);

    expect(path.basename(path.dirname(entries[0] ?? ''))).toBe('gh-session-bin');
    expect(entries[1]).toBe(binDir);
  });

  it('offers no command it could not write, and tells no agent of one', () => {
    const withoutCommand = buildEnv();
    const promptWithoutCommand = buildPrompt('ship the patch');
    // The directory of the command cannot be made: a file has its name.
    fs.writeFileSync(path.join(directory, 'session-bin'), '');

    install();

    expect(buildEnv()).toEqual(withoutCommand);
    expect(buildPrompt('ship the patch')).toBe(promptWithoutCommand);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Sessions get no lody-lan command');
  });

  it('gives Windows a .cmd that takes its paths from the environment of the session', () => {
    const runtime = {
      execPath: 'C:\\Users\\张三\\Lody OSS\\Lody OSS.exe',
      entry: 'C:\\Users\\张三\\100%!\\cli\\index.js',
      electronRunAsNode: '1',
    };
    const binDir = install({ runtime, platform: 'win32' });

    const env = buildEnv();

    // The file holds no path: cmd would read one in the code page of its console.
    expect(fs.readFileSync(path.join(binDir, 'lody-lan.cmd'), 'utf8').split('\r\n')).toEqual([
      '@echo off',
      'rem Written by the Lody agent service of this machine: its own command line.',
      'setlocal DisableDelayedExpansion',
      'set "LODY_LAN_COMMAND=lody-lan"',
      'set "ELECTRON_RUN_AS_NODE=1"',
      '"%LODY_LAN_COMMAND_RUNTIME%" "%LODY_LAN_COMMAND_ENTRY%" %*',
      '',
    ]);
    expect(env.LODY_LAN_COMMAND_RUNTIME).toBe(runtime.execPath);
    expect(env.LODY_LAN_COMMAND_ENTRY).toBe(runtime.entry);
    // Git Bash on Windows runs the script beside it.
    expect(fs.existsSync(path.join(binDir, 'lody-lan'))).toBe(true);
  });
});
