import { describe, expect, it } from 'vitest';
import type { LanSshDestination } from '@lody/shared/lan-ssh';
import { pathLauncherPreferenceSchema } from '../src/lib/local-storage-cache';
import {
  resolveSessionOpenInIdeHost,
  resolveSessionOpenInIdePathTarget,
} from '../src/lib/session-open-in-ide-path';
import {
  buildPathLauncherLaunchInput,
  buildPathLauncherProbes,
  buildRemotePathLauncherLaunchInput,
  buildVSCodePathLauncherFallbackUrl,
  canLaunchRemotePath,
  resolveRemotePathDestination,
  getAvailablePathLauncherOptions,
  getCustomPathLauncherOptionId,
  validateCustomPathLauncherCommandTemplate,
  type CustomPathLauncher,
} from '../src/lib/session-path-launchers';

describe('path launcher preferences', () => {
  it('parses a stored preference and defaults missing custom launchers', () => {
    expect(pathLauncherPreferenceSchema.parse({ selectedLauncherId: 'cursor' })).toEqual({
      selectedLauncherId: 'cursor',
      customLaunchers: [],
    });
  });
});

describe('getAvailablePathLauncherOptions', () => {
  it('shows Xcode only in Electron on macOS', () => {
    expect(
      getAvailablePathLauncherOptions({
        customLaunchers: [],
        isElectron: true,
        platform: 'darwin',
      }).some((launcher) => launcher.kind === 'builtin' && launcher.id === 'xcode')
    ).toBe(true);

    expect(
      getAvailablePathLauncherOptions({
        customLaunchers: [],
        isElectron: true,
        platform: 'linux',
      }).some((launcher) => launcher.kind === 'builtin' && launcher.id === 'xcode')
    ).toBe(false);
  });

  it('shows Sublime Text on every desktop OS but not on the web', () => {
    const hasSublime = (platform: string, isElectron: boolean) =>
      getAvailablePathLauncherOptions({ customLaunchers: [], isElectron, platform }).some(
        (launcher) => launcher.kind === 'builtin' && launcher.id === 'sublime'
      );

    expect(hasSublime('darwin', true)).toBe(true);
    expect(hasSublime('win32', true)).toBe(true);
    expect(hasSublime('linux', true)).toBe(true);
    expect(hasSublime('darwin', false)).toBe(false);
  });

  it('shows custom command launchers only in Electron', () => {
    const customLaunchers: CustomPathLauncher[] = [
      { id: 'phpstorm', label: 'PhpStorm', commandTemplate: 'open -a "PhpStorm" {path}' },
    ];

    expect(
      getAvailablePathLauncherOptions({
        customLaunchers,
        isElectron: true,
        platform: 'darwin',
      }).some((launcher) => launcher.kind === 'custom' && launcher.label === 'PhpStorm')
    ).toBe(true);

    expect(
      getAvailablePathLauncherOptions({
        customLaunchers,
        isElectron: false,
        platform: 'darwin',
      }).some((launcher) => launcher.kind === 'custom')
    ).toBe(false);
  });
});

describe('custom path launcher command templates', () => {
  it('requires the path placeholder', () => {
    expect(validateCustomPathLauncherCommandTemplate('code-insiders .')).toEqual({
      ok: false,
      reason: 'missing_path',
    });
  });

  it('rejects invalid quoting', () => {
    expect(validateCustomPathLauncherCommandTemplate('code "{path}')).toEqual({
      ok: false,
      reason: 'invalid_syntax',
    });
  });

  it('builds command launch inputs without shell splitting the path', () => {
    const launcher: CustomPathLauncher = {
      id: 'code-insiders',
      label: 'Code Insiders',
      commandTemplate: 'code-insiders --reuse-window {path}',
    };

    expect(
      buildPathLauncherLaunchInput(
        {
          ...launcher,
          kind: 'custom',
          launcherId: getCustomPathLauncherOptionId(launcher.id),
        },
        '/Users/me/My Project'
      )
    ).toEqual({
      kind: 'command',
      command: {
        command: 'code-insiders',
        args: ['--reuse-window', '/Users/me/My Project'],
      },
      targetPath: '/Users/me/My Project',
      label: 'Code Insiders',
    });
  });

  it('skips invalid stored custom launchers during availability checks', () => {
    expect(
      buildPathLauncherProbes(
        [
          {
            id: 'broken',
            kind: 'custom',
            launcherId: getCustomPathLauncherOptionId('broken'),
            label: 'Broken',
            commandTemplate: 'broken-without-a-path',
          },
        ],
        '/Users/me/project'
      )
    ).toEqual([]);
  });
});

describe('built-in path launchers', () => {
  it('builds an xed launch request for Xcode', () => {
    const xcode = getAvailablePathLauncherOptions({
      customLaunchers: [],
      isElectron: true,
      platform: 'darwin',
    }).find((launcher) => launcher.kind === 'builtin' && launcher.id === 'xcode');

    expect(xcode).toBeDefined();
    expect(buildPathLauncherLaunchInput(xcode!, '/Users/me/project')).toEqual({
      kind: 'command',
      command: { command: '/usr/bin/xed', args: ['/Users/me/project'] },
      fallbackCommands: [{ command: 'xed', args: ['/Users/me/project'] }],
      targetPath: '/Users/me/project',
      label: 'Xcode',
    });
  });

  it('builds platform-specific Sublime Text launch requests', () => {
    const getSublime = (platform: string) =>
      getAvailablePathLauncherOptions({ customLaunchers: [], isElectron: true, platform }).find(
        (launcher) => launcher.kind === 'builtin' && launcher.id === 'sublime'
      );

    const mac = getSublime('darwin');
    expect(mac).toBeDefined();
    expect(buildPathLauncherLaunchInput(mac!, '/Users/me/project', 'darwin')).toEqual({
      kind: 'command',
      command: { command: '/usr/bin/open', args: ['-a', 'Sublime Text', '/Users/me/project'] },
      fallbackCommands: [
        { command: 'subl', args: ['/Users/me/project'] },
        { command: '/usr/local/bin/subl', args: ['/Users/me/project'] },
      ],
      targetPath: '/Users/me/project',
      label: 'Sublime Text',
    });

    const windows = getSublime('win32');
    expect(buildPathLauncherLaunchInput(windows!, 'C:\\code\\app', 'win32')).toEqual({
      kind: 'command',
      command: { command: 'subl', args: ['C:\\code\\app'] },
      fallbackCommands: [
        { command: 'C:\\Program Files\\Sublime Text\\subl.exe', args: ['C:\\code\\app'] },
        { command: 'C:\\Program Files\\Sublime Text\\sublime_text.exe', args: ['C:\\code\\app'] },
        { command: 'C:\\Program Files\\Sublime Text 3\\sublime_text.exe', args: ['C:\\code\\app'] },
      ],
      targetPath: 'C:\\code\\app',
      label: 'Sublime Text',
    });

    const linux = getSublime('linux');
    expect(buildPathLauncherLaunchInput(linux!, '/home/me/project', 'linux').command).toEqual({
      command: 'subl',
      args: ['/home/me/project'],
    });
  });

  const getEditor = (id: string, platform: string) =>
    getAvailablePathLauncherOptions({ customLaunchers: [], isElectron: true, platform }).find(
      (launcher) => launcher.kind === 'builtin' && launcher.id === id
    );

  it('opens VS Code in a new window via its CLI on macOS', () => {
    const vscode = getEditor('vscode', 'darwin');
    expect(vscode).toBeDefined();
    expect(buildPathLauncherLaunchInput(vscode!, '/Users/me/My Project', 'darwin')).toEqual({
      kind: 'command',
      command: { command: 'code', args: ['-n', '/Users/me/My Project'] },
      fallbackCommands: [
        { command: '/usr/local/bin/code', args: ['-n', '/Users/me/My Project'] },
        {
          command: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
          args: ['-n', '/Users/me/My Project'],
        },
      ],
      fallbackUrl: 'vscode://file/Users/me/My%20Project/?windowId=_blank',
      targetPath: '/Users/me/My Project',
      label: 'VS Code',
    });
  });

  it('keeps a DMG file URL distinct from a directory URL', () => {
    const vscode = getEditor('vscode', 'darwin');
    expect(
      buildPathLauncherLaunchInput(vscode!, '/tmp/My Build/Lody.dmg', 'darwin', 'file')
    ).toMatchObject({
      fallbackUrl: 'vscode://file/tmp/My%20Build/Lody.dmg?windowId=_blank',
    });
  });

  it('encodes a Windows workspace path for the VS Code new-window deeplink', () => {
    expect(buildVSCodePathLauncherFallbackUrl('C:\\Users\\me\\My #Project?')).toBe(
      'vscode://file/C:/Users/me/My%20%23Project%3F/?windowId=_blank'
    );
  });

  it('opens Cursor in a new window via its CLI on Linux', () => {
    const cursor = getEditor('cursor', 'linux');
    expect(buildPathLauncherLaunchInput(cursor!, '/home/me/project', 'linux')).toEqual({
      kind: 'command',
      command: { command: 'cursor', args: ['-n', '/home/me/project'] },
      fallbackCommands: [
        { command: '/usr/bin/cursor', args: ['-n', '/home/me/project'] },
        { command: '/opt/cursor/cursor', args: ['-n', '/home/me/project'] },
      ],
      targetPath: '/home/me/project',
      label: 'Cursor',
    });
  });

  it('opens Zed without a new-window flag so it focuses an already-open worktree', () => {
    const zed = getEditor('zed', 'linux');
    expect(zed).toBeDefined();
    expect(buildPathLauncherLaunchInput(zed!, '/home/me/project', 'linux')).toEqual({
      kind: 'command',
      command: { command: 'zed', args: ['/home/me/project'] },
      fallbackCommands: [
        { command: '/usr/bin/zed', args: ['/home/me/project'] },
        { command: '/usr/local/bin/zed', args: ['/home/me/project'] },
      ],
      targetPath: '/home/me/project',
      label: 'Zed',
    });
  });

  it('keeps Warp on the url launch path opening a new tab', () => {
    const warp = getEditor('warp', 'darwin');
    expect(buildPathLauncherLaunchInput(warp!, '/Users/me/My Project', 'darwin')).toEqual({
      kind: 'url',
      url: 'warp://action/new_tab?path=%2FUsers%2Fme%2FMy%20Project',
      targetPath: '/Users/me/My Project',
      label: 'Warp',
    });
  });

  it('exposes no built-in launchers on the web (desktop bridge only)', () => {
    expect(
      getAvailablePathLauncherOptions({
        customLaunchers: [],
        isElectron: false,
        platform: 'darwin',
      })
    ).toEqual([]);
  });
});

describe('a folder of another machine', () => {
  const ssh: LanSshDestination = { version: 1, user: 'me', host: '10.0.0.7', port: 22 };
  const custom: CustomPathLauncher = {
    id: 'phpstorm',
    label: 'PhpStorm',
    commandTemplate: 'open -a "PhpStorm" {path}',
  };
  const launchers = (platform: string) =>
    getAvailablePathLauncherOptions({ customLaunchers: [custom], isElectron: true, platform });
  const getLauncher = (id: string, platform: string) => {
    const launcher = launchers(platform).find(
      (candidate) => candidate.kind === 'builtin' && candidate.id === id
    );
    if (!launcher) throw new Error(`no launcher ${id} on ${platform}`);
    return launcher;
  };

  it('opens in VS Code as a remote folder, whatever its name looks like', () => {
    expect(
      buildRemotePathLauncherLaunchInput(
        getLauncher('vscode', 'darwin'),
        '/home/me/My Project/site.v2',
        'me@10.0.0.7',
        'darwin'
      )
    ).toEqual({
      kind: 'command',
      command: {
        command: 'code',
        args: [
          '-n',
          '--folder-uri',
          'vscode-remote://ssh-remote+me@10.0.0.7/home/me/My%20Project/site.v2',
        ],
      },
      fallbackCommands: [
        {
          command: '/usr/local/bin/code',
          args: [
            '-n',
            '--folder-uri',
            'vscode-remote://ssh-remote+me@10.0.0.7/home/me/My%20Project/site.v2',
          ],
        },
        {
          command: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
          args: [
            '-n',
            '--folder-uri',
            'vscode-remote://ssh-remote+me@10.0.0.7/home/me/My%20Project/site.v2',
          ],
        },
      ],
      fallbackUrl:
        'vscode://vscode-remote/ssh-remote+me@10.0.0.7/home/me/My%20Project/site.v2?windowId=_blank',
      targetPath: '/home/me/My Project/site.v2',
      label: 'VS Code',
    });
  });

  it('opens in the editors built on VS Code the same way, without its deeplink', () => {
    for (const [id, cli] of [
      ['cursor', 'cursor'],
      ['windsurf', 'windsurf'],
      ['antigravity', 'antigravity'],
    ] as const) {
      const input = buildRemotePathLauncherLaunchInput(
        getLauncher(id, 'linux'),
        '/srv/app',
        'me@10.0.0.7',
        'linux'
      );
      expect(input, id).toMatchObject({
        kind: 'command',
        command: {
          command: cli,
          args: ['-n', '--folder-uri', 'vscode-remote://ssh-remote+me@10.0.0.7/srv/app'],
        },
        targetPath: '/srv/app',
      });
      expect(input, id).not.toHaveProperty('fallbackUrl');
    }
  });

  it('opens in Zed by its SSH address, with the port SSH does not assume', () => {
    expect(
      buildRemotePathLauncherLaunchInput(
        getLauncher('zed', 'linux'),
        '/srv/my app',
        'me@server.lan:2222',
        'linux'
      )
    ).toEqual({
      kind: 'command',
      command: { command: 'zed', args: ['ssh://me@server.lan:2222/srv/my%20app'] },
      fallbackCommands: [
        { command: '/usr/bin/zed', args: ['ssh://me@server.lan:2222/srv/my%20app'] },
        { command: '/usr/local/bin/zed', args: ['ssh://me@server.lan:2222/srv/my%20app'] },
      ],
      targetPath: '/srv/my app',
      label: 'Zed',
    });
  });

  it('carries nothing of a path that an editor or a shell would read as its own', () => {
    const input = buildRemotePathLauncherLaunchInput(
      getLauncher('cursor', 'win32'),
      '/srv/a&b | c?d#e/--remote',
      'me@10.0.0.7',
      'win32'
    );
    expect(input.kind === 'command' && input.command.args).toEqual([
      '-n',
      '--folder-uri',
      'vscode-remote://ssh-remote+me@10.0.0.7/srv/a%26b%20%7C%20c%3Fd%23e/--remote',
    ]);
  });

  it('is asked of the editors that open it there, and of nothing else', () => {
    const all = launchers('darwin');

    expect(all.filter(canLaunchRemotePath).map((launcher) => launcher.label)).toEqual([
      'VS Code',
      'Cursor',
      'Antigravity',
      'Windsurf',
      'Zed',
    ]);
    expect(
      buildPathLauncherProbes(all, '/srv/app', 'darwin', ssh).map(({ launcherId }) => launcherId)
    ).toEqual(['vscode', 'cursor', 'antigravity', 'windsurf', 'zed']);
    expect(buildPathLauncherProbes(all, '/srv/app', 'darwin', ssh)[4]?.input).toMatchObject({
      command: { command: 'zed', args: ['ssh://me@10.0.0.7/srv/app'] },
    });
    // The same launchers asked about a folder of this machine.
    expect(buildPathLauncherProbes(all, '/srv/app', 'darwin')).toHaveLength(all.length);
  });

  it('is refused by a launcher that would look for it on this machine', () => {
    for (const launcher of launchers('darwin').filter(
      (candidate) => !canLaunchRemotePath(candidate)
    )) {
      expect(
        () => buildRemotePathLauncherLaunchInput(launcher, '/srv/app', 'me@10.0.0.7', 'darwin'),
        launcher.label
      ).toThrow(/another machine/u);
    }
    expect(() =>
      buildRemotePathLauncherLaunchInput(
        getLauncher('vscode', 'darwin'),
        'C:\\code\\app',
        'me@10.0.0.7'
      )
    ).toThrow(/POSIX/u);
  });

  it('opens through the entry of this machine’s SSH configuration that reaches it', () => {
    expect(resolveRemotePathDestination(ssh, 'nuc')).toBe('nuc');
    expect(resolveRemotePathDestination(ssh, 'me@nuc')).toBe('me@nuc');
    expect(
      buildRemotePathLauncherLaunchInput(
        getLauncher('vscode', 'darwin'),
        '/srv/app',
        resolveRemotePathDestination(ssh, 'nuc'),
        'darwin'
      )
    ).toMatchObject({
      command: {
        command: 'code',
        args: ['-n', '--folder-uri', 'vscode-remote://ssh-remote+nuc/srv/app'],
      },
      fallbackUrl: 'vscode://vscode-remote/ssh-remote+nuc/srv/app?windowId=_blank',
    });
    expect(
      buildRemotePathLauncherLaunchInput(getLauncher('zed', 'darwin'), '/srv/app', 'nuc', 'darwin')
    ).toMatchObject({ command: { command: 'zed', args: ['ssh://nuc/srv/app'] } });
  });

  it('opens as the machine says where the configuration names no entry for it', () => {
    expect(resolveRemotePathDestination(ssh, null)).toBe('me@10.0.0.7');
    expect(resolveRemotePathDestination(ssh, undefined)).toBe('me@10.0.0.7');
    expect(resolveRemotePathDestination({ ...ssh, port: 2222, names: ['server'] }, null)).toBe(
      'me@10.0.0.7:2222'
    );
    // Nor an entry an editor could read as something else.
    for (const configured of ['-oProxyCommand=id', 'nuc/../x', 'two words', '']) {
      expect(resolveRemotePathDestination(ssh, configured), configured).toBe('me@10.0.0.7');
      expect(
        () =>
          buildRemotePathLauncherLaunchInput(
            getLauncher('vscode', 'darwin'),
            '/srv/app',
            configured
          ),
        configured
      ).toThrow(/reached as/u);
    }
  });
});

describe('the folder a session opens in an editor', () => {
  const ssh: LanSshDestination = { version: 1, user: 'me', host: '10.0.0.7', port: 22 };

  it('is its worktree before its project, on this machine', () => {
    expect(
      resolveSessionOpenInIdePathTarget({
        worktreePath: ' /data/worktrees/one ',
        localProjectRootPath: '/code/app',
        host: { kind: 'local' },
      })
    ).toEqual({ path: '/data/worktrees/one', source: 'worktree' });
    expect(
      resolveSessionOpenInIdePathTarget({
        worktreePath: null,
        localProjectRootPath: 'C:\\code\\app',
        host: { kind: 'local' },
      })
    ).toEqual({ path: 'C:\\code\\app', source: 'local_project' });
    expect(
      resolveSessionOpenInIdePathTarget({
        worktreePath: ' ',
        localProjectRootPath: undefined,
        host: { kind: 'local' },
      })
    ).toBeNull();
  });

  it('is reached over SSH on a machine that named its SSH server', () => {
    expect(
      resolveSessionOpenInIdePathTarget({
        worktreePath: null,
        localProjectRootPath: '/home/me/app',
        host: { kind: 'remote', ssh },
      })
    ).toEqual({ path: '/home/me/app', source: 'local_project', ssh });
  });

  it('is none on a machine that named no SSH server, or for a path no address takes', () => {
    expect(
      resolveSessionOpenInIdePathTarget({
        worktreePath: '/data/worktrees/one',
        localProjectRootPath: '/home/me/app',
        host: { kind: 'remote', ssh: null },
      })
    ).toBeNull();
    expect(
      resolveSessionOpenInIdePathTarget({
        worktreePath: null,
        localProjectRootPath: 'C:\\code\\app',
        host: { kind: 'remote', ssh },
      })
    ).toBeNull();
  });
});

describe('the machine that has the folder of a session', () => {
  const ssh: LanSshDestination = { version: 1, user: 'me', host: '10.0.0.7', port: 22 };
  const another = {
    sessionMachineId: 'machine-server',
    localMachineId: 'machine-desk',
    currentUserId: 'local:home',
    machineOwnerUserId: 'local:home',
    machineSsh: ssh,
  };

  it('is this one for its own sessions, whatever it says about SSH', () => {
    expect(resolveSessionOpenInIdeHost({ ...another, sessionMachineId: 'machine-desk' })).toEqual({
      kind: 'local',
    });
    expect(
      resolveSessionOpenInIdeHost({
        ...another,
        sessionMachineId: 'machine-desk',
        currentUserId: null,
        machineOwnerUserId: undefined,
        machineSsh: undefined,
      })
    ).toEqual({ kind: 'local' });
  });

  it('is another one of the same user, reached where it named its SSH server', () => {
    expect(resolveSessionOpenInIdeHost(another)).toEqual({ kind: 'remote', ssh });
    expect(resolveSessionOpenInIdeHost({ ...another, machineSsh: undefined })).toEqual({
      kind: 'remote',
      ssh: null,
    });
    expect(
      resolveSessionOpenInIdeHost({
        ...another,
        machineSsh: { ...ssh, host: '-oProxyCommand=id' },
      })
    ).toEqual({ kind: 'remote', ssh: null });
  });

  it('is not followed to an SSH server when it is someone else’s machine', () => {
    for (const owner of ['user-teammate', '', null, undefined]) {
      expect(
        resolveSessionOpenInIdeHost({ ...another, machineOwnerUserId: owner }),
        String(owner)
      ).toEqual({ kind: 'remote', ssh: null });
    }
    expect(
      resolveSessionOpenInIdeHost({
        ...another,
        currentUserId: undefined,
        machineOwnerUserId: undefined,
      })
    ).toEqual({ kind: 'remote', ssh: null });
  });

  it('is not known before this machine knows which one it is', () => {
    expect(resolveSessionOpenInIdeHost({ ...another, localMachineId: null })).toEqual({
      kind: 'remote',
      ssh: null,
    });
    expect(
      resolveSessionOpenInIdeHost({ ...another, sessionMachineId: undefined, localMachineId: null })
    ).toEqual({ kind: 'remote', ssh: null });
  });
});
