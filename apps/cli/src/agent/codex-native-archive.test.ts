import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfigMeta, SessionMeta } from '@lody/shared';
import { getSessionCodexThreadId, setCodexThreadArchived } from './codex-native-archive';

describe.skipIf(process.platform === 'win32')('Codex native archive', () => {
  let dir: string;
  let provider: AgentConfigMeta;
  const calls = () => fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n');

  beforeEach(() => {
    vi.stubEnv('LODY_DISABLE_SHELL_ENV', '1');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-codex-archive-'));
    // Stands in for the Codex CLI: records its arguments and the Codex home it ran with.
    const codexPath = path.join(dir, 'codex');
    fs.writeFileSync(
      codexPath,
      [
        '#!/bin/sh',
        'echo "$*|$CODEX_HOME" >> "$FAKE_CODEX_CALLS"',
        'if [ -n "$FAKE_CODEX_FAIL" ]; then echo "Error: failed to $1 session" >&2; exit 1; fi',
      ].join('\n'),
      { mode: 0o700 }
    );
    provider = {
      id: 'config-1',
      name: 'Codex',
      cliType: 'builtin',
      agentType: 'codex',
      env: { CODEX_HOME: path.join(dir, 'home'), FAKE_CODEX_CALLS: path.join(dir, 'calls') },
      runtimeOverrides: { codexPath },
    } as AgentConfigMeta;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('archives and unarchives the thread with the Provider binary and Codex home', async () => {
    const input = { workspaceId: 'workspace-1', provider, threadId: 'thread-1' };
    await setCodexThreadArchived({ ...input, archived: true });
    await setCodexThreadArchived({ ...input, archived: false });

    const home = path.join(dir, 'home');
    expect(calls()).toEqual([`archive thread-1|${home}`, `unarchive thread-1|${home}`]);
  });

  it('rejects with what Codex reported when the command fails', async () => {
    provider.env.FAKE_CODEX_FAIL = '1';
    await expect(
      setCodexThreadArchived({
        workspaceId: 'workspace-1',
        provider,
        threadId: 'thread-1',
        archived: true,
      })
    ).rejects.toThrow('failed to archive session');
  });

  it('maps only builtin Codex Sessions to a thread', () => {
    const codex = {
      cliType: 'builtin',
      agentType: 'codex',
      acpSessionId: 'thread-1',
    } as SessionMeta;
    expect(getSessionCodexThreadId(codex)).toBe('thread-1');
    expect(getSessionCodexThreadId({ ...codex, agentType: 'claude' })).toBeUndefined();
    expect(getSessionCodexThreadId({ ...codex, cliType: 'custom' })).toBeUndefined();
  });
});
