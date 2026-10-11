import { describe, expect, it } from 'vitest';
import type { MessageContent } from '@lody/shared';
import {
  buildFileLinkFallbackPaths,
  classifyFileLinkProbe,
  collectFileLinkContext,
  isRelativeFileLinkPath,
  resolveMissingFileLink,
  type FileLinkContext,
  type FileLinkProbeResult,
} from '../src/lib/session-file-link-fallback';

const context = (mentions: string[], outputs: string[] = []): FileLinkContext => ({
  mentions,
  outputs,
});

const bash = (command: string, output?: string): MessageContent => ({
  type: 'tool_call',
  toolCallId: command,
  status: 'completed',
  kind: 'execute',
  content: [
    { type: 'terminal_command', command },
    ...(output === undefined ? [] : [{ type: 'terminal_output' as const, output }]),
  ],
});

/**
 * A machine that holds exactly `files`; everything else is missing. It reports
 * a found file the way a real one does: home expanded to an absolute path.
 */
const machineWith = (files: readonly string[]) => {
  const asked: string[] = [];
  const probe = async (path: string): Promise<FileLinkProbeResult> => {
    asked.push(path);
    return files.includes(path)
      ? { state: 'found', path: path.replace(/^~/, '/home/me') }
      : { state: 'missing' };
  };
  return { asked, probe };
};

describe('isRelativeFileLinkPath', () => {
  it.each(['pending.md', 'docs/a.md', './a.md', '../a.md'])('%s is relative', (path) => {
    expect(isRelativeFileLinkPath(path)).toBe(true);
  });
  it.each(['/tmp/a.md', '~/a.md', 'C:/a.md', 'c:\\a.md', '\\\\host\\share\\a.md', ' '])(
    '%s is not',
    (path) => {
      expect(isRelativeFileLinkPath(path)).toBe(false);
    }
  );
});

describe('collectFileLinkContext', () => {
  it('reads prompts, prose and tool inputs as mentions and tool output apart', () => {
    const collected = collectFileLinkContext([
      {
        items: [
          bash('cat ~/state/pending.md', 'origin/main:apps/a/edit.ts:3: hit'),
          {
            type: 'tool_call',
            toolCallId: 'read',
            status: 'completed',
            kind: 'read',
            locations: [{ path: '/repo/src/schema.ts' }],
            rawInput: { file_path: '/repo/src/schema.ts', limit: 20 },
          },
          { type: 'text', text: 'Updated `pending.md`.' },
        ],
      },
      {
        items: [{ type: 'text', text: 'ignored duplicate of the prompt' }],
        inputConfig: { prompt: 'keep notes in ~/state/' },
      },
      undefined,
    ]);

    expect(collected.mentions).toEqual([
      'Updated `pending.md`.',
      '/repo/src/schema.ts',
      '/repo/src/schema.ts',
      'cat ~/state/pending.md',
      'ignored duplicate of the prompt',
      'keep notes in ~/state/',
    ]);
    expect(collected.outputs).toEqual(['origin/main:apps/a/edit.ts:3: hit']);
  });

  it('keeps only the head of an oversized tool input', () => {
    const collected = collectFileLinkContext([
      {
        items: [
          {
            type: 'tool_call',
            toolCallId: 'write',
            status: 'completed',
            rawInput: { content: `/head/dir ${'x'.repeat(10_000)}` },
          },
        ],
      },
    ]);
    expect(collected.mentions[0]).toHaveLength(4_000);
  });
});

describe('buildFileLinkFallbackPaths', () => {
  it('finds a longer mentioned path that ends in the link', () => {
    expect(
      buildFileLinkFallbackPaths(
        'data-runtime/edit-session.ts',
        context([], ['origin/lan-mode:apps/mobile/kit/data-runtime/edit-session.ts:40: x'])
      )
    ).toEqual(['apps/mobile/kit/data-runtime/edit-session.ts']);
  });

  it('places a bare name under a directory a command named', () => {
    expect(
      buildFileLinkFallbackPaths(
        'pending.md',
        context(['d=~/.local/state/watch; cat $d/pending.md'])
      )
    ).toEqual(['~/.local/state/watch/pending.md', '~/.local/state/pending.md']);
  });

  it('tries the folder of a mentioned file, and joins a shared folder once', () => {
    expect(
      buildFileLinkFallbackPaths(
        'data-runtime/edit-session.ts',
        context(['/repo/kit/data-runtime/agent-roles.ts'])
      )
    ).toEqual(['/repo/kit/data-runtime/edit-session.ts']);
  });

  it('ranks an exact mention first, then outside directories, then workspace folders', () => {
    expect(
      buildFileLinkFallbackPaths(
        'notes.md',
        context(['see packages/shared/src', 'wrote /var/data/out', 'kept /srv/reports/notes.md'])
      )
    ).toEqual([
      '/srv/reports/notes.md',
      '/var/data/out/notes.md',
      '/var/data/notes.md',
      'packages/shared/src/notes.md',
      'packages/shared/notes.md',
    ]);
  });

  it('does not take a URL, a longer file name or a shell variable for a location', () => {
    expect(
      buildFileLinkFallbackPaths(
        'pending.md',
        context([
          'https://github.com/o/r/blob/main/pending.md',
          'cat ${dir}/pending.md $d/pending.md',
          '/data/pending.mdx',
        ])
      )
    ).toEqual(['/data/pending.md']);
  });

  it('offers nothing for a path that already says where it is', () => {
    expect(buildFileLinkFallbackPaths('/tmp/a.md', context(['/var/x']))).toEqual([]);
  });

  it('stops at the probe limit', () => {
    const mentions = Array.from({ length: 40 }, (_, index) => `/roots/r${index}/dir`);
    expect(buildFileLinkFallbackPaths('a.md', context(mentions), 5)).toHaveLength(5);
  });
});

describe('classifyFileLinkProbe', () => {
  it.each([
    [
      { status: 'ok', path: 'a.md' },
      { state: 'found', path: 'a.md' },
    ],
    [
      { status: 'resource', path: '/tmp/a.md' },
      { state: 'found', path: '/tmp/a.md' },
    ],
    [
      { status: 'error', code: 'too_large', path: '/home/me/a.md' },
      { state: 'found', path: '/home/me/a.md' },
    ],
    [{ status: 'error', code: 'too_large' }, { state: 'found' }],
    [{ status: 'error', code: 'file_not_found', path: 'a.md' }, { state: 'missing' }],
    [{ status: 'error', code: 'path_not_allowed' }, { state: 'unknown' }],
    [{ status: 'error', code: 'transient_io' }, { state: 'unknown' }],
    [null, { state: 'unknown' }],
  ] as const)('%o reads as %o', (result, expected) => {
    expect(classifyFileLinkProbe(result)).toEqual(expected);
  });
});

describe('resolveMissingFileLink', () => {
  const state = context(['d=~/.local/state/watch']);

  it('leaves a link the machine finds exactly as written', async () => {
    const machine = machineWith(['pending.md', '~/.local/state/watch/pending.md']);
    await expect(
      resolveMissingFileLink({ path: 'pending.md', probe: machine.probe, context: () => state })
    ).resolves.toBe('pending.md');
    expect(machine.asked).toEqual(['pending.md']);
  });

  it('opens the file where the conversation says it is, under the path the machine reports', async () => {
    const machine = machineWith(['~/.local/state/watch/pending.md']);
    await expect(
      resolveMissingFileLink({ path: 'pending.md', probe: machine.probe, context: () => state })
    ).resolves.toBe('/home/me/.local/state/watch/pending.md');
  });

  it('takes the highest-ranked candidate that exists', async () => {
    const machine = machineWith(['~/.local/state/pending.md', '~/.local/state/watch/pending.md']);
    await expect(
      resolveMissingFileLink({ path: 'pending.md', probe: machine.probe, context: () => state })
    ).resolves.toBe('/home/me/.local/state/watch/pending.md');
  });

  it('keeps the candidate as asked when the machine names no path for it', async () => {
    await expect(
      resolveMissingFileLink({
        path: 'pending.md',
        probe: async (path) => ({ state: path === 'pending.md' ? 'missing' : 'found' }),
        context: () => context(['/srv/reports/pending.md']),
      })
    ).resolves.toBe('/srv/reports/pending.md');
  });

  it('keeps the link when nothing the conversation names exists', async () => {
    const machine = machineWith([]);
    await expect(
      resolveMissingFileLink({ path: 'pending.md', probe: machine.probe, context: () => state })
    ).resolves.toBe('pending.md');
  });

  it('does not guess when the machine could not answer', async () => {
    let contextRead = false;
    const path = await resolveMissingFileLink({
      path: 'pending.md',
      probe: async () => {
        throw new Error('offline');
      },
      context: () => {
        contextRead = true;
        return state;
      },
    });
    expect(path).toBe('pending.md');
    expect(contextRead).toBe(false);
  });

  it('never probes for an absolute link', async () => {
    const machine = machineWith([]);
    await expect(
      resolveMissingFileLink({ path: '/tmp/a.md', probe: machine.probe, context: () => state })
    ).resolves.toBe('/tmp/a.md');
    expect(machine.asked).toEqual([]);
  });
});
