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
  filterAntigravityBtwLaunchArgs,
  isReadOnlyBtwPermissionRequest,
  prepareBtwIsolation,
  sanitizeBtwEnv,
  stripCodexConfigToml,
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

  it('isolates Codex with temp CODEX_HOME, cleaned config.toml, CODEX_CONFIG overlay, and git init', async () => {
    const root = makeTempRoot();
    const fakeHome = path.join(root, 'home');
    const fakeTmp = path.join(root, 'tmp');
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.mkdirSync(fakeTmp, { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.codex', 'auth.json'), '{"token":"synthetic"}');
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
    expect(fs.lstatSync(path.join(codexHome, 'auth.json')).isSymbolicLink()).toBe(false);
    expect(fs.statSync(path.join(codexHome, 'auth.json')).mode & 0o777).toBe(0o600);
    const cleanedToml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    expect(cleanedToml).toContain('model = "gpt-6-luna"');
    expect(cleanedToml).not.toContain('[plugins.nmem]');
    expect(cleanedToml).not.toContain('[mcp_servers.x]');

    const codexConfig = JSON.parse(isolated.env.CODEX_CONFIG!);
    expect(codexConfig).toMatchObject(BTW_CODEX_CONFIG_OVERLAY);

    // Overlay merges on top of existing CODEX_CONFIG in envTransform
    const withExisting = isolated.envTransform({
      CODEX_CONFIG: JSON.stringify({ model_provider: 'lody' }),
    });
    expect(JSON.parse(withExisting.CODEX_CONFIG!)).toMatchObject({
      model_provider: 'lody',
      ...BTW_CODEX_CONFIG_OVERLAY,
    });

    isolated.cleanup();
    expect(fs.existsSync(codexHome)).toBe(false);
    expect(fs.existsSync(isolated.workdir)).toBe(false);
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
});
