import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LanHub } from '@lody/shared/node/lan-hub';
import { getLanHubMovedHookPath, runLanHubMovedHook, type LanHubMove } from './lan-hub-moved';

const hub: LanHub = {
  id: '0123456789abcdef0123456789abcdef',
  name: 'Home',
  url: 'http://10.0.0.2:8788',
  token: 'home-token',
};
const move: LanHubMove = {
  hub,
  previousUrl: 'http://10.0.0.1:8788',
  term: 3,
  hosting: true,
};

describe.skipIf(process.platform === 'win32')('LAN hub-moved hook', () => {
  let dataDir: string;
  let hookPath: string;
  let lines: string[];
  const logger = {
    info: (line: string) => lines.push(`info ${line}`),
    warn: (line: string) => lines.push(`warn ${line}`),
    debug: () => {},
  } as never;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-hook-'));
    hookPath = getLanHubMovedHookPath(dataDir);
    lines = [];
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const install = (script: string, mode = 0o700) => {
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, `#!/bin/sh\n${script}\n`, { mode });
  };

  it('does nothing on a machine without a hook', async () => {
    await expect(runLanHubMovedHook(move, { logger, hookPath })).resolves.toBe('absent');
    expect(lines).toEqual([]);
  });

  it('tells the hook where the hub is and was, and never the credential', async () => {
    install('env | grep -e "^LODY_" -e "^SECRET_" | sort > "$PWD/seen"');

    const result = await runLanHubMovedHook(move, {
      logger,
      hookPath,
      env: {
        PATH: process.env.PATH,
        SECRET_OF_THE_SERVICE: 'kept',
        // A `lody` the hook runs reads its LANs from the settings, as the service does.
        LODY_LAN_HUB_URL: 'http://10.0.0.1:8788',
        LODY_LAN_HUB_TOKEN: 'home-token',
      },
    });

    expect(result).toBe('ok');
    const seen = fs.readFileSync(path.join(path.dirname(hookPath), 'seen'), 'utf8');
    expect(seen.trim().split('\n')).toEqual([
      'LODY_HOOK_EVENT=lan-hub-moved',
      'LODY_HOOK_HUB_HOSTED_HERE=true',
      'LODY_HOOK_HUB_PREVIOUS_URL=http://10.0.0.1:8788',
      'LODY_HOOK_HUB_TERM=3',
      'LODY_HOOK_HUB_URL=http://10.0.0.2:8788',
      'LODY_HOOK_LAN_ID=0123456789abcdef0123456789abcdef',
      'LODY_HOOK_LAN_NAME=Home',
      'SECRET_OF_THE_SERVICE=kept',
    ]);
    expect(seen).not.toContain('home-token');
    expect(lines.join('\n')).not.toContain('home-token');
  });

  it('reports a hook that fails with what it said', async () => {
    install('echo "tunnel: no such ingress" >&2; exit 3');

    await expect(runLanHubMovedHook(move, { logger, hookPath })).resolves.toBe('failed');
    expect(lines).toEqual([
      `warn [lan] ${hookPath} exited with 3 for Home at http://10.0.0.2:8788: tunnel: no such ingress`,
    ]);
  });

  it('reports a hook that cannot be run', async () => {
    install('exit 0', 0o600);

    await expect(runLanHubMovedHook(move, { logger, hookPath })).resolves.toBe('failed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('could not start');
  });

  it('stops a hook that does not end, with what it started', async () => {
    install('sleep 600');

    await expect(runLanHubMovedHook(move, { logger, hookPath, timeoutMs: 50 })).resolves.toBe(
      'failed'
    );
    expect(lines).toEqual([
      `warn [lan] ${hookPath} was stopped after 50 ms for Home at http://10.0.0.2:8788`,
    ]);
  });

  it('does not wait for what a hook leaves running', async () => {
    // The process it leaves holds the hook's output open until the gate is opened.
    install('mkfifo "$PWD/gate"\ncat "$PWD/gate" &\necho started');

    const result = await runLanHubMovedHook(move, { logger, hookPath, outputGraceMs: 20 });
    fs.writeFileSync(path.join(path.dirname(hookPath), 'gate'), '');

    expect(result).toBe('ok');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ran for Home');
  });
});
