import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { SessionId } from '@lody/shared';

import { createInterruptedSessionSync } from '../src/lib/interrupted-session-sync';
import type { Logger } from '../src/utils/logger';

const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => logger,
  close: async () => {},
};

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const createSync = async (pushSession: (sessionId: SessionId) => Promise<boolean>) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lody-interrupted-sessions-'));
  directories.push(directory);
  const filePath = path.join(directory, 'nested', 'workspace.json');
  const readRecorded = async (): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    } catch {
      return null;
    }
  };
  return { sync: createInterruptedSessionSync({ filePath, logger, pushSession }), readRecorded };
};

const a = 'session-a' as SessionId;
const b = 'session-b' as SessionId;

describe('interrupted session sync', () => {
  it('pushes the sessions the last shutdown cut off and then forgets them', async () => {
    const pushed: SessionId[] = [];
    const { sync, readRecorded } = await createSync(async (sessionId) => {
      pushed.push(sessionId);
      return true;
    });

    await sync.record([a, b]);
    await sync.record([a]);
    expect(await readRecorded()).toEqual([a, b]);

    await sync.flush();
    expect(pushed).toEqual([a, b]);
    expect(await readRecorded()).toBeNull();

    // Nothing left: a later "online again" pushes nothing.
    await sync.flush();
    expect(pushed).toEqual([a, b]);
  });

  it('keeps a session whose push the hub has not confirmed for the next try', async () => {
    let hubBack = false;
    const { sync, readRecorded } = await createSync(async (sessionId) => {
      if (sessionId === b) throw new Error('room is reconnecting');
      return hubBack;
    });

    await sync.record([a, b]);
    await sync.flush();
    expect(await readRecorded()).toEqual([a, b]);

    hubBack = true;
    await sync.flush();
    expect(await readRecorded()).toEqual([b]);
  });

  it('shares one pass between overlapping triggers', async () => {
    let release: () => void = () => {};
    let calls = 0;
    const { sync, readRecorded } = await createSync(async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return true;
    });

    await sync.record([a]);
    const first = sync.flush();
    const second = sync.flush();
    await expect.poll(() => calls).toBe(1);
    release();
    await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(await readRecorded()).toBeNull();
  });
});
