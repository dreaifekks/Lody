import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@/utils/logger';
import {
  BTW_CODEX_CONFIG_OVERLAY,
  BTW_NMEM_FAIL_CLOSED_ENV,
  createBtwPermissionHandler,
  extractCodexDisabledTableOverrides,
  filterAntigravityBtwLaunchArgs,
  isReadOnlyBtwPermissionRequest,
  prepareBtwIsolation,
  sanitizeBtwEnv,
  stripCodexConfigToml,
  supportsBtwNativeReadOnlyTools,
} from './btw-isolation';

const silentLogger: Logger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
} as Logger;

const makePermissionRequest = (
  overrides: Partial<RequestPermissionRequest['toolCall']> & {
    options?: RequestPermissionRequest['options'];
  }
): RequestPermissionRequest => {
  const { options, ...toolCall } = overrides;
  return {
    sessionId: 'acp-sess-1',
    toolCall: {
      toolCallId: 'tc-1',
      title: 'Tool',
      ...toolCall,
    },
    options: options ?? [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
  };
};

describe('btw-isolation', () => {
  const rootsToClean: string[] = [];

  const makeTempRoot = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-btw-iso-test-'));
    rootsToClean.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of rootsToClean.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips all inherited NMEM_* vars and applies Layer 3 fail-closed env', () => {
    const result = sanitizeBtwEnv({
      PATH: '/usr/bin',
      NMEM_AGENT_ID: 'lody',
      NMEM_API_KEY: 'real-secret',
      NMEM_SPACE: 'personal',
      NMEM_HOST_AGENT_ID: 'host',
      nmem_custom_flag: '1',
    });

    expect(result.LODY_BTW_AGENT).toBe('1');
    expect(result.NMEM_AGENT_ID).toBeUndefined();
    expect(result.NMEM_SPACE).toBeUndefined();
    expect(result.NMEM_HOST_AGENT_ID).toBeUndefined();
    expect(result.nmem_custom_flag).toBeUndefined();
    expect(result).toMatchObject(BTW_NMEM_FAIL_CLOSED_ENV);
  });

  it('strips [plugins.*], [hooks.*], and [mcp_servers.*] sections from Codex config.toml', () => {
    const raw = [
      'model = "gpt-6.2-astra"',
      'mcp_servers.inline = { command = "nmem" }',
      'plugins = { nmem = true }',
      '',
      '[model_providers.custom]',
      'base_url = "https://proxy.example.invalid/v1"',
      'note = """',
      '[hooks.not_a_real_header]',
      'inside multiline string',
      '"""',
      '',
      '[plugins.nowledge-mem]',
      'enabled = true',
      '',
      '[[hooks.post_tool_use]]',
      'command = "nmem-hook.sh"',
      '',
      '[mcp_servers.lody]',
      'command = "lody"',
      '',
      '["mcp_servers".other]',
      'url = "http://127.0.0.1:9999"',
      '',
      '[features]',
      'goals = false',
    ].join('\n');

    const cleaned = stripCodexConfigToml(raw);
    expect(cleaned).toContain('model = "gpt-6.2-astra"');
    expect(cleaned).toContain('[model_providers.custom]');
    expect(cleaned).toContain('base_url = "https://proxy.example.invalid/v1"');
    expect(cleaned).toContain('[hooks.not_a_real_header]');
    expect(cleaned).toContain('[features]');
    expect(cleaned).toContain('goals = false');
    expect(cleaned).not.toContain('mcp_servers.inline');
    expect(cleaned).not.toContain('plugins = { nmem = true }');
    expect(cleaned).not.toContain('[plugins.nowledge-mem]');
    expect(cleaned).not.toContain('[[hooks.post_tool_use]]');
    expect(cleaned).not.toContain('nmem-hook.sh');
    expect(cleaned).not.toContain('[mcp_servers.lody]');
    expect(cleaned).not.toContain('["mcp_servers".other]');
  });

  it('filters Antigravity launch args cleanly', () => {
    const args = filterAntigravityBtwLaunchArgs(
      [
        'acp',
        '--process-per-session',
        '--dangerously-skip-permissions',
        '--gemini-dir',
        '/old/dir',
        '--disable-telemetry',
        '--extra-flag',
      ],
      '/tmp/lody-btw-gemini-123'
    );

    expect(args).toEqual([
      'acp',
      '--extra-flag',
      '--gemini-dir',
      '/tmp/lody-btw-gemini-123',
      '--include-default-customizations=false',
      '--disable-telemetry',
    ]);
  });

  it('isolates Antigravity with copyFile (0o600, non-symlink) of only the 3 auth files', async () => {
    const root = makeTempRoot();
    const fakeHome = path.join(root, 'home');
    const fakeTmp = path.join(root, 'tmp');
    fs.mkdirSync(path.join(fakeHome, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.mkdirSync(path.join(fakeHome, '.gemini', 'config', 'plugins', 'nowledge-mem'), {
      recursive: true,
    });
    fs.mkdirSync(fakeTmp, { recursive: true });

    fs.writeFileSync(
      path.join(fakeHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
      'tok-a'
    );
    fs.writeFileSync(
      path.join(fakeHome, '.gemini', 'antigravity-cli', 'installation_id'),
      'install-1'
    );
    fs.writeFileSync(path.join(fakeHome, '.gemini', 'jetski-standalone-oauth-token'), 'tok-j');
    fs.writeFileSync(
      path.join(fakeHome, '.gemini', 'config', 'plugins', 'nowledge-mem', 'hook.sh'),
      '#!/bin/sh'
    );
    fs.writeFileSync(path.join(fakeHome, '.gemini', 'mcp_config.json'), '{}');

    const isolated = await prepareBtwIsolation({
      cliType: 'builtin',
      agentType: 'antigravity',
      readOnlyTools: false,
      baseEnv: { HOME: fakeHome, NMEM_AGENT_ID: 'lody' },
      logger: silentLogger,
      homeDir: fakeHome,
      tmpDir: fakeTmp,
    });

    const geminiDir = isolated.env.GEMINI_DIR!;
    expect(geminiDir.startsWith(fakeTmp)).toBe(true);
    expect(fs.statSync(geminiDir).mode & 0o777).toBe(0o700);

    for (const rel of [
      path.join('antigravity-cli', 'antigravity-oauth-token'),
      path.join('antigravity-cli', 'installation_id'),
      'jetski-standalone-oauth-token',
    ]) {
      const dst = path.join(geminiDir, rel);
      const lstat = fs.lstatSync(dst);
      expect(lstat.isSymbolicLink()).toBe(false);
      expect(lstat.isFile()).toBe(true);
      expect(lstat.mode & 0o777).toBe(0o600);
    }

    // Plugins & MCP configs must NOT be copied
    expect(fs.existsSync(path.join(geminiDir, 'config'))).toBe(false);
    expect(fs.existsSync(path.join(geminiDir, 'mcp_config.json'))).toBe(false);

    // Launch args stripped & redirected
    expect(
      isolated.launchArgFilter?.([
        'acp',
        '--process-per-session',
        '--dangerously-skip-permissions',
        '--disable-telemetry',
      ])
    ).toEqual([
      'acp',
      '--gemini-dir',
      geminiDir,
      '--include-default-customizations=false',
      '--disable-telemetry',
    ]);

    // envTransform strips login-shell re-injected NMEM_* too
    const remerged = isolated.envTransform({
      ...isolated.env,
      NMEM_AGENT_ID: 'reinjected-by-login-shell',
      NMEM_API_URL: 'https://evil.example',
    });
    expect(remerged.NMEM_AGENT_ID).toBeUndefined();
    expect(remerged).toMatchObject(BTW_NMEM_FAIL_CLOSED_ENV);

    // cleanup deletes all temporary directories
    const dirs = [...isolated.tempDirs];
    expect(dirs.length).toBe(2);
    isolated.cleanup();
    for (const dir of dirs) {
      expect(fs.existsSync(dir)).toBe(false);
    }
  });

  it('isolates Codex with temp CODEX_HOME, symlinked auth.json, cleaned config.toml, CODEX_CONFIG overlay, and git init', async () => {
    const root = makeTempRoot();
    const fakeHome = path.join(root, 'home');
    const fakeTmp = path.join(root, 'tmp');
    const realAuthPath = path.join(fakeHome, '.codex', 'auth.json');
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.mkdirSync(fakeTmp, { recursive: true });
    fs.writeFileSync(realAuthPath, '{"token":"synthetic-v1"}');
    fs.writeFileSync(
      path.join(fakeHome, '.codex', 'config.toml'),
      'model = "gpt-6-luna"\n[plugins.nmem]\nenabled = true\n[mcp_servers.x]\ncmd = "x"\n'
    );

    const initGitRepo = vi.fn(async () => true);
    const isolated = await prepareBtwIsolation({
      cliType: 'builtin',
      agentType: 'codex',
      readOnlyTools: false,
      baseEnv: { HOME: fakeHome, NMEM_API_KEY: 'secret' },
      logger: silentLogger,
      homeDir: fakeHome,
      tmpDir: fakeTmp,
      initGitRepo,
    });

    expect(initGitRepo).toHaveBeenCalledWith(isolated.workdir);
    const codexHome = isolated.env.CODEX_HOME!;
    expect(codexHome.startsWith(fakeTmp)).toBe(true);

    // auth.json MUST be symlinked to the real authoritative file so OAuth token refresh
    // writes back to the real store and cleanup removes only the symlink.
    const tmpAuthPath = path.join(codexHome, 'auth.json');
    expect(fs.lstatSync(tmpAuthPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(tmpAuthPath)).toBe(fs.realpathSync(realAuthPath));
    fs.writeFileSync(tmpAuthPath, '{"token":"refreshed-v2"}');
    expect(fs.readFileSync(realAuthPath, 'utf8')).toBe('{"token":"refreshed-v2"}');

    const cleanedToml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    expect(cleanedToml).toContain('model = "gpt-6-luna"');
    expect(cleanedToml).not.toContain('[plugins.nmem]');
    expect(cleanedToml).not.toContain('[mcp_servers.x]');

    const codexConfig = JSON.parse(isolated.env.CODEX_CONFIG!);
    expect(codexConfig).toMatchObject(BTW_CODEX_CONFIG_OVERLAY);

    // Overlay merges on top of existing CODEX_CONFIG and LODY_CODEX_PROFILE_CONFIG in envTransform
    const withExisting = isolated.envTransform({
      CODEX_CONFIG: JSON.stringify({ model_provider: 'lody', features: { fast_mode: true } }),
      LODY_CODEX_PROFILE_CONFIG: JSON.stringify({ model_provider: 'lody' }),
    });
    expect(JSON.parse(withExisting.CODEX_CONFIG!)).toMatchObject({
      model_provider: 'lody',
      ...BTW_CODEX_CONFIG_OVERLAY,
      features: { fast_mode: true, hooks: false, plugins: false },
    });
    expect(JSON.parse(withExisting.LODY_CODEX_PROFILE_CONFIG!)).toMatchObject({
      model_provider: 'lody',
      ...BTW_CODEX_CONFIG_OVERLAY,
    });

    isolated.cleanup();
    expect(fs.existsSync(codexHome)).toBe(false);
    expect(fs.existsSync(isolated.workdir)).toBe(false);
    // Authoritative auth.json survives cleanup with the refreshed token intact!
    expect(fs.existsSync(realAuthPath)).toBe(true);
    expect(fs.readFileSync(realAuthPath, 'utf8')).toBe('{"token":"refreshed-v2"}');
  });

  it('preserves managed file-backed Codex profile auth.json and processes directory via symlinks', async () => {
    const root = makeTempRoot();
    const profileDir = path.join(root, 'codex-profiles', 'prof-1');
    const profileHome = path.join(profileDir, 'home');
    const profileProcesses = path.join(profileDir, 'processes');
    const fakeTmp = path.join(root, 'tmp');
    fs.mkdirSync(profileHome, { recursive: true });
    fs.mkdirSync(profileProcesses, { recursive: true });
    fs.mkdirSync(fakeTmp, { recursive: true });
    fs.writeFileSync(path.join(profileHome, 'auth.json'), '{"refresh_token":"orig"}');
    fs.writeFileSync(path.join(profileProcesses, 'tok.json'), '{"version":1,"token":"tok"}');
    fs.writeFileSync(
      path.join(profileHome, 'config.toml'),
      'model = "gpt-6-luna"\n[hooks]\nSessionStart = []\n[mcp_servers.nmem]\ncommand = "nmem"\n'
    );

    const isolated = await prepareBtwIsolation({
      cliType: 'builtin',
      agentType: 'codex',
      readOnlyTools: false,
      baseEnv: {},
      codexProfile: {
        profile: {
          workspaceId: 'ws-1',
          machineId: 'm-1',
          configId: 'cfg-1',
          profile: { mode: 'chatgpt', profileId: 'prof-1' } as never,
          home: profileHome,
          authStore: 'codex-default',
        },
      },
      logger: silentLogger,
      tmpDir: fakeTmp,
      initGitRepo: vi.fn(async () => true),
    });

    const codexHome = isolated.env.CODEX_HOME!;
    expect(codexHome.startsWith(fakeTmp)).toBe(true);
    expect(fs.lstatSync(path.join(codexHome, 'auth.json')).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(codexHome, 'auth.json'))).toBe(
      fs.realpathSync(path.join(profileHome, 'auth.json'))
    );
    const linkedProcesses = path.join(codexHome, '..', 'processes');
    expect(fs.lstatSync(linkedProcesses).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(linkedProcesses, 'tok.json'), 'utf8')).toContain('"tok"');
    const cleaned = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    expect(cleaned).not.toContain('[hooks]');
    expect(cleaned).not.toContain('[mcp_servers.nmem]');

    isolated.cleanup();
    expect(fs.existsSync(path.join(profileHome, 'auth.json'))).toBe(true);
    expect(fs.existsSync(path.join(profileProcesses, 'tok.json'))).toBe(true);
  });

  it('keeps legacy keyring Codex CODEX_HOME intact while disabling hooks, plugins, and MCP servers via config overrides', async () => {
    const root = makeTempRoot();
    const profileHome = path.join(root, 'codex-profiles', 'legacy-keyring', 'home');
    const fakeTmp = path.join(root, 'tmp');
    fs.mkdirSync(profileHome, { recursive: true });
    fs.mkdirSync(fakeTmp, { recursive: true });
    fs.writeFileSync(
      path.join(profileHome, 'config.toml'),
      [
        'model = "gpt-6.2-astra"',
        '[hooks]',
        'SessionStart = [{ hooks = [{ type = "command", command = "nmem" }] }]',
        '[plugins.nowledge-mem]',
        'enabled = true',
        '[mcp_servers.nmem]',
        'command = "nmem"',
        '[mcp_servers."my.dotted-mcp"]',
        'url = "http://127.0.0.1:9999"',
      ].join('\n')
    );

    expect(
      extractCodexDisabledTableOverrides(
        fs.readFileSync(path.join(profileHome, 'config.toml'), 'utf8')
      )
    ).toEqual({
      mcpServerNames: ['nmem', 'my.dotted-mcp'],
      pluginNames: ['nowledge-mem'],
    });

    const isolated = await prepareBtwIsolation({
      cliType: 'builtin',
      agentType: 'codex',
      readOnlyTools: false,
      baseEnv: {
        CODEX_HOME: profileHome,
        CODEX_CONFIG: JSON.stringify({
          cli_auth_credentials_store: 'keyring',
          forced_login_method: 'chatgpt',
        }),
        LODY_CODEX_PROFILE_CONFIG: JSON.stringify({
          cli_auth_credentials_store: 'keyring',
          forced_login_method: 'chatgpt',
        }),
      },
      codexProfile: {
        profile: {
          workspaceId: 'ws-1',
          machineId: 'm-1',
          configId: 'cfg-1',
          profile: { mode: 'chatgpt', profileId: 'legacy-keyring' } as never,
          home: profileHome,
          authStore: 'keyring',
        },
      },
      logger: silentLogger,
      tmpDir: fakeTmp,
      initGitRepo: vi.fn(async () => true),
    });

    // Must keep original CODEX_HOME so OS keyring account resolution still succeeds.
    expect(isolated.env.CODEX_HOME).toBe(profileHome);

    for (const key of ['CODEX_CONFIG', 'LODY_CODEX_PROFILE_CONFIG'] as const) {
      const parsed = JSON.parse(isolated.env[key]!);
      expect(parsed).toMatchObject({
        cli_auth_credentials_store: 'keyring',
        forced_login_method: 'chatgpt',
        features: { hooks: false, plugins: false },
        mcp_servers: {
          nmem: { enabled: false },
          'my.dotted-mcp': { enabled: false },
        },
        plugins: {
          'nowledge-mem': { enabled: false },
        },
      });
    }

    isolated.cleanup();
    expect(fs.existsSync(profileHome)).toBe(true);
  });

  it('never hands real session workdir to providers without native read-only enforcement (e.g. pi)', async () => {
    const root = makeTempRoot();
    const fakeTmp = path.join(root, 'tmp');
    const sessionWorkdir = path.join(root, 'repo');
    fs.mkdirSync(fakeTmp, { recursive: true });
    fs.mkdirSync(sessionWorkdir, { recursive: true });

    expect(supportsBtwNativeReadOnlyTools('antigravity')).toBe(true);
    expect(supportsBtwNativeReadOnlyTools('antigravity-acp')).toBe(true);
    expect(supportsBtwNativeReadOnlyTools('claude')).toBe(true);
    expect(supportsBtwNativeReadOnlyTools('codex')).toBe(true);
    expect(supportsBtwNativeReadOnlyTools('pi')).toBe(false);
    expect(supportsBtwNativeReadOnlyTools('custom-agent')).toBe(false);

    const piIsolation = await prepareBtwIsolation({
      cliType: 'builtin',
      agentType: 'pi',
      readOnlyTools: true,
      sessionWorkdir,
      baseEnv: {},
      logger: silentLogger,
      tmpDir: fakeTmp,
    });

    expect(piIsolation.effectiveReadOnlyTools).toBe(false);
    expect(piIsolation.usedSessionWorkdir).toBe(false);
    expect(piIsolation.workdir).not.toBe(sessionWorkdir);
    expect(piIsolation.workdir.startsWith(fakeTmp)).toBe(true);
    // Permission handler must fail closed (cancel even read requests).
    const readReq = makePermissionRequest({ kind: 'read', title: 'Read src/app.ts' });
    expect(await piIsolation.onRequestPermission('r1', readReq)).toEqual({
      outcome: { outcome: 'cancelled' },
    });

    piIsolation.cleanup();
    expect(fs.existsSync(sessionWorkdir)).toBe(true);
  });

  it('sets CLAUDE_CODE_SAFE_MODE=1 for Claude and switches cwd only in readOnlyTools mode', async () => {
    const root = makeTempRoot();
    const fakeTmp = path.join(root, 'tmp');
    const sessionWorkdir = path.join(root, 'repo');
    fs.mkdirSync(fakeTmp, { recursive: true });
    fs.mkdirSync(sessionWorkdir, { recursive: true });

    const textOnly = await prepareBtwIsolation({
      cliType: 'builtin',
      agentType: 'claude',
      readOnlyTools: false,
      sessionWorkdir,
      baseEnv: {},
      logger: silentLogger,
      tmpDir: fakeTmp,
    });
    expect(textOnly.env.CLAUDE_CODE_SAFE_MODE).toBe('1');
    expect(textOnly.workdir).not.toBe(sessionWorkdir);
    expect(textOnly.workdir.startsWith(fakeTmp)).toBe(true);
    textOnly.cleanup();

    const readOnly = await prepareBtwIsolation({
      cliType: 'builtin',
      agentType: 'claude',
      readOnlyTools: true,
      sessionWorkdir,
      baseEnv: {},
      logger: silentLogger,
      tmpDir: fakeTmp,
    });
    expect(readOnly.env.CLAUDE_CODE_SAFE_MODE).toBe('1');
    expect(readOnly.workdir).toBe(sessionWorkdir);
    expect(readOnly.tempDirs).toHaveLength(0);
    readOnly.cleanup();
    expect(fs.existsSync(sessionWorkdir)).toBe(true);
  });

  it('enforces strict permission gates in both text-only and readOnlyTools modes', async () => {
    const readReq = makePermissionRequest({ kind: 'read', title: 'Read src/app.ts' });
    const searchReq = makePermissionRequest({ kind: 'search', title: 'Grep foo' });
    const editReq = makePermissionRequest({ kind: 'edit', title: 'Edit src/app.ts' });
    const execReq = makePermissionRequest({ kind: 'execute', title: 'Run bash' });
    const deleteReq = makePermissionRequest({ kind: 'delete', title: 'Delete file' });
    const disguisedShellReq = makePermissionRequest({
      kind: 'read',
      title: 'Read',
      rawInput: { command: 'rm -rf .' },
    });
    const unknownReq = makePermissionRequest({ kind: 'other', title: 'CustomSideEffectTool' });
    const noAllowOnceRead = makePermissionRequest({
      kind: 'read',
      title: 'Read',
      options: [{ optionId: 'always', name: 'Allow always', kind: 'allow_always' }],
    });

    // Text-only mode cancels everything
    const denyAll = createBtwPermissionHandler(false);
    expect(await denyAll('r1', readReq)).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(await denyAll('r2', searchReq)).toEqual({ outcome: { outcome: 'cancelled' } });

    // Read-only mode allows only read/search via allow_once and rejects all mutations/exec
    const readOnlyHandler = createBtwPermissionHandler(true);
    expect(isReadOnlyBtwPermissionRequest(readReq)).toBe(true);
    expect(isReadOnlyBtwPermissionRequest(searchReq)).toBe(true);
    expect(await readOnlyHandler('r1', readReq)).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(await readOnlyHandler('r2', searchReq)).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });

    expect(await readOnlyHandler('r3', editReq)).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(await readOnlyHandler('r4', execReq)).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(await readOnlyHandler('r5', deleteReq)).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(await readOnlyHandler('r6', disguisedShellReq)).toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(await readOnlyHandler('r7', unknownReq)).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(await readOnlyHandler('r8', noAllowOnceRead)).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });

  it('does not inject partial mcp_servers disable overrides from untrusted repo .codex/config.toml', async () => {
    const root = makeTempRoot();
    const fakeHome = path.join(root, 'home');
    const fakeTmp = path.join(root, 'tmp');
    const sessionWorkdir = path.join(root, 'repo');
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.mkdirSync(fakeTmp, { recursive: true });
    fs.mkdirSync(path.join(sessionWorkdir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.codex', 'auth.json'), '{"token":"ok"}');
    fs.writeFileSync(
      path.join(sessionWorkdir, '.codex', 'config.toml'),
      '[mcp_servers.repo_only]\ncommand = "npx"\n'
    );

    const isolated = await prepareBtwIsolation({
      cliType: 'builtin',
      agentType: 'codex',
      readOnlyTools: true,
      sessionWorkdir,
      baseEnv: { HOME: fakeHome },
      logger: silentLogger,
      tmpDir: fakeTmp,
      homeDir: fakeHome,
      initGitRepo: vi.fn(async () => true),
    });

    const codexConfig = JSON.parse(isolated.env.CODEX_CONFIG!);
    expect(codexConfig.mcp_servers).toBeUndefined();
    isolated.cleanup();
  });
});
