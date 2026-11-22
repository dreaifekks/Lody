import { describe, expect, it } from 'vitest';
import {
  buildPathLauncherLaunchInput,
  buildRemotePathLauncherLaunchInput,
  buildVSCodePathLauncherFallbackUrl,
  type PathLauncherOption,
} from '../src/path-launchers';
import { PathLauncherRequestSchema } from '../src/electron-ipc';

const builtin = (
  id: 'vscode' | 'cursor' | 'windsurf' | 'antigravity' | 'zed' | 'sublime',
  label: string
): PathLauncherOption => ({ kind: 'builtin', id, label });

describe('path-launchers file:line support', () => {
  it('preserves folder-only launch output for backward compatibility', () => {
    const vscode = builtin('vscode', 'VS Code');
    const cursor = builtin('cursor', 'Cursor');
    const zed = builtin('zed', 'Zed');

    expect(buildPathLauncherLaunchInput(vscode, '/repo/wt', 'darwin')).toMatchObject({
      command: { command: 'code', args: ['-n', '/repo/wt'] },
      fallbackUrl: 'vscode://file/repo/wt/?windowId=_blank',
    });
    expect(buildPathLauncherLaunchInput(cursor, '/repo/wt', 'linux')).not.toHaveProperty(
      'fallbackUrl'
    );
    expect(
      buildRemotePathLauncherLaunchInput(vscode, '/srv/wt', { host: 'nuc', user: 'me' }, 'darwin')
    ).toMatchObject({
      command: {
        command: 'code',
        args: ['-n', '--folder-uri', 'vscode-remote://ssh-remote+me@nuc/srv/wt'],
      },
      fallbackUrl: 'vscode://vscode-remote/ssh-remote+me@nuc/srv/wt?windowId=_blank',
    });
    expect(
      buildRemotePathLauncherLaunchInput(cursor, '/srv/wt', { host: 'nuc', user: 'me' }, 'darwin')
    ).not.toHaveProperty('fallbackUrl');
    expect(
      buildRemotePathLauncherLaunchInput(zed, '/srv/wt', { host: 'nuc', user: 'me' }, 'darwin')
    ).toMatchObject({
      command: { command: 'zed', args: ['ssh://me@nuc/srv/wt'] },
    });
  });

  it('opens a local worktree folder directly at file:line:column in VS Code family and Zed', () => {
    const vscode = builtin('vscode', 'VS Code');
    const cursor = builtin('cursor', 'Cursor');
    const zed = builtin('zed', 'Zed');

    expect(
      buildPathLauncherLaunchInput(vscode, '/Users/me/worktrees/wt-1', 'darwin', 'directory', {
        filePath: 'src/lib/code nav.ts',
        line: 42,
        column: 7,
      })
    ).toMatchObject({
      command: {
        command: 'code',
        args: [
          '-n',
          '/Users/me/worktrees/wt-1',
          '-g',
          '/Users/me/worktrees/wt-1/src/lib/code nav.ts:42:7',
        ],
      },
      fallbackUrl:
        'vscode://file/Users/me/worktrees/wt-1/src/lib/code%20nav.ts:42:7?windowId=_blank',
    });

    expect(
      buildPathLauncherLaunchInput(cursor, '/Users/me/worktrees/wt-1', 'darwin', 'directory', {
        filePath: 'src/app.ts',
        line: 18,
      })
    ).toMatchObject({
      command: {
        command: 'cursor',
        args: ['-n', '/Users/me/worktrees/wt-1', '-g', '/Users/me/worktrees/wt-1/src/app.ts:18'],
      },
      fallbackUrl: 'cursor://file/Users/me/worktrees/wt-1/src/app.ts:18?windowId=_blank',
    });

    expect(
      buildPathLauncherLaunchInput(zed, '/home/me/wt', 'linux', 'directory', {
        filePath: 'src/index.ts',
        line: 99,
        column: 3,
      })
    ).toMatchObject({
      command: {
        command: 'zed',
        args: ['/home/me/wt', '/home/me/wt/src/index.ts:99:3'],
      },
    });

    // Direct file target with line only (no separate filePath).
    expect(
      buildPathLauncherLaunchInput(vscode, '/home/me/wt/src/a.ts', 'linux', 'file', { line: 12 })
    ).toMatchObject({
      command: {
        command: 'code',
        args: ['-n', '-g', '/home/me/wt/src/a.ts:12'],
      },
      fallbackUrl: 'vscode://file/home/me/wt/src/a.ts:12?windowId=_blank',
    });

    expect(
      buildVSCodePathLauncherFallbackUrl('C:\\work\\wt', 'directory', {
        filePath: 'src/a.ts',
        line: 5,
      })
    ).toBe('vscode://file/C:/work/wt/src/a.ts:5?windowId=_blank');
  });

  it('prefers native Windows .exe candidates over bare .cmd shims when file arguments contain spaces', () => {
    const vscodeWin = buildPathLauncherLaunchInput(
      builtin('vscode', 'VS Code'),
      'C:\\repo',
      'win32',
      'directory',
      { filePath: 'src/My File.ts', line: 42, column: 3 }
    );
    expect(vscodeWin.kind).toBe('command');
    if (vscodeWin.kind !== 'command') throw new Error('expected command');
    expect(vscodeWin.command.command.endsWith('Code.exe')).toBe(true);
    expect(vscodeWin.command.args).toEqual([
      '-n',
      'C:\\repo',
      '-g',
      'C:\\repo\\src\\My File.ts:42:3',
    ]);
    expect(
      [vscodeWin.command, ...(vscodeWin.fallbackCommands ?? [])].map((c) => c.command)
    ).not.toContain('code');
    expect(vscodeWin.fallbackUrl).toBe(
      'vscode://file/C:/repo/src/My%20File.ts:42:3?windowId=_blank'
    );

    const cursorWin = buildPathLauncherLaunchInput(
      builtin('cursor', 'Cursor'),
      'C:\\repo',
      'win32',
      'directory',
      { filePath: 'src/My File.ts', line: 10 }
    );
    expect(cursorWin.kind).toBe('command');
    if (cursorWin.kind !== 'command') throw new Error('expected command');
    expect(cursorWin.command.command.endsWith('Cursor.exe')).toBe(true);
    expect(cursorWin.fallbackUrl).toBe('cursor://file/C:/repo/src/My%20File.ts:10?windowId=_blank');

    const sublimeWin = buildPathLauncherLaunchInput(
      builtin('sublime', 'Sublime Text'),
      'C:\\repo',
      'win32',
      'directory',
      { filePath: 'src/My File.ts', line: 12 }
    );
    expect(sublimeWin.kind).toBe('command');
    if (sublimeWin.kind !== 'command') throw new Error('expected command');
    expect(sublimeWin.command.command.endsWith('subl.exe')).toBe(true);
  });

  it('opens a remote SSH worktree folder directly at file:line across VS Code, Cursor, Windsurf, Antigravity, and Zed', () => {
    const dest = { host: 'ts:home-devNuc', user: 'dreaife' };
    const expectedHexAuthority =
      'ssh-remote+7b22686f73744e616d65223a2274733a686f6d652d6465764e7563222c2275736572223a2264726561696665227d';

    const vscodeInput = buildRemotePathLauncherLaunchInput(
      builtin('vscode', 'VS Code'),
      '/home/dreaife/wt.v1',
      dest,
      'darwin',
      { filePath: 'apps/cli/src/my file.ts', line: 128, column: 4 }
    );
    expect(vscodeInput).toMatchObject({
      kind: 'command',
      command: {
        command: 'code',
        args: [
          '-n',
          '--folder-uri',
          `vscode-remote://${expectedHexAuthority}/home/dreaife/wt.v1`,
          '-g',
          '--file-uri',
          `vscode-remote://${expectedHexAuthority}/home/dreaife/wt.v1/apps/cli/src/my%20file.ts:128:4`,
        ],
      },
      fallbackUrl: `vscode://vscode-remote/${expectedHexAuthority}/home/dreaife/wt.v1/apps/cli/src/my%20file.ts:128:4?windowId=_blank`,
    });

    const cursorInput = buildRemotePathLauncherLaunchInput(
      builtin('cursor', 'Cursor'),
      '/srv/wt',
      { host: 'nuc', user: 'me' },
      'darwin',
      { filePath: '/srv/wt/src/foo.ts', line: 77 }
    );
    expect(cursorInput).toMatchObject({
      command: {
        command: 'cursor',
        args: [
          '-n',
          '--folder-uri',
          'vscode-remote://ssh-remote+me@nuc/srv/wt',
          '-g',
          '--file-uri',
          'vscode-remote://ssh-remote+me@nuc/srv/wt/src/foo.ts:77',
        ],
      },
      fallbackUrl: 'cursor://vscode-remote/ssh-remote+me@nuc/srv/wt/src/foo.ts:77?windowId=_blank',
    });

    for (const [id, cli] of [
      ['windsurf', 'windsurf'],
      ['antigravity', 'antigravity'],
    ] as const) {
      const input = buildRemotePathLauncherLaunchInput(
        builtin(id, id),
        '/srv/wt',
        { host: 'nuc' },
        'linux',
        { filePath: 'src/a.ts' }
      );
      expect(input).toMatchObject({
        command: {
          command: cli,
          args: [
            '-n',
            '--folder-uri',
            'vscode-remote://ssh-remote+nuc/srv/wt',
            '--file-uri',
            'vscode-remote://ssh-remote+nuc/srv/wt/src/a.ts',
          ],
        },
      });
      expect(input).not.toHaveProperty('fallbackUrl');
    }

    const zedInput = buildRemotePathLauncherLaunchInput(
      builtin('zed', 'Zed'),
      '/srv/my wt',
      { host: 'server.lan', user: 'me', port: 2222 },
      'linux',
      { filePath: 'src/file.ts', line: 33, column: 2 }
    );
    expect(zedInput).toMatchObject({
      command: {
        command: 'zed',
        args: [
          'ssh://me@server.lan:2222/srv/my%20wt',
          'ssh://me@server.lan:2222/srv/my%20wt/src/file.ts:33:2',
        ],
      },
    });
  });

  it('rejects relative filePath escaping the workspace folder and validates PathLauncherRequestSchema', () => {
    expect(() =>
      buildRemotePathLauncherLaunchInput(
        builtin('vscode', 'VS Code'),
        '/srv/wt',
        { host: 'nuc' },
        'linux',
        { filePath: '../../etc/passwd', line: 1 }
      )
    ).toThrow(/escapes/u);

    expect(() =>
      buildPathLauncherLaunchInput(builtin('vscode', 'VS Code'), '/srv/wt', 'linux', 'directory', {
        filePath: '../secret.ts',
        line: 1,
      })
    ).toThrow(/escapes/u);

    expect(
      PathLauncherRequestSchema.parse({
        launcherId: 'vscode',
        targetPath: '/srv/wt',
        targetKind: 'directory',
        sshDestination: { host: 'nuc' },
        filePath: 'src/index.ts',
        line: 42,
        column: 3,
      })
    ).toMatchObject({
      filePath: 'src/index.ts',
      line: 42,
      column: 3,
    });

    expect(
      PathLauncherRequestSchema.safeParse({
        launcherId: 'vscode',
        targetPath: '/srv/wt',
        line: 0,
      }).success
    ).toBe(false);
  });
});
