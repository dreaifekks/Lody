import {
  formatSshDestination,
  isSshUrlHost,
  parseSshDestination,
  toSshDestination,
  type LanSshDestination,
  type SshDestination,
} from './lan-ssh';
import type { LaunchLocalPathInput, LocalPathCommandSpec } from './electron-ipc';
import { parseCustomAcpCommandLine } from './custom-acp-command';
export type PathLauncherPlatform = 'darwin' | 'win32' | 'linux' | 'unknown';
export type BuiltinPathLauncherId =
  | 'vscode'
  | 'cursor'
  | 'antigravity'
  | 'windsurf'
  | 'zed'
  | 'sublime'
  | 'warp'
  | 'delta'
  | 'xcode';
export type CustomPathLauncher = { id: string; label: string; commandTemplate: string };
export type PathLauncherOption =
  | { kind: 'builtin'; id: BuiltinPathLauncherId; label: string }
  | (CustomPathLauncher & { kind: 'custom'; launcherId: string });
export type CustomPathLauncherTemplateValidation =
  | { ok: true }
  | { ok: false; reason: 'empty' | 'missing_path' | 'invalid_syntax' | 'path_in_command' };
export type PathLauncherFileTarget = {
  /** Absolute path, or path relative to `targetPath` (worktree/project folder). */
  filePath?: string;
  /** 1-based line number. */
  line?: number;
  /** 1-based column number (applied only when `line` is set). */
  column?: number;
};
const PATH_LAUNCHER_PATH_PLACEHOLDER = '{path}';

function normalizePositiveInt(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

function formatLineColumnSuffix(fileTarget?: PathLauncherFileTarget): {
  readonly line?: number;
  readonly column?: number;
  readonly suffix: string;
} {
  const line = normalizePositiveInt(fileTarget?.line);
  if (line === undefined) return { suffix: '' };
  const column = normalizePositiveInt(fileTarget?.column);
  return {
    line,
    ...(column === undefined ? {} : { column }),
    suffix: column === undefined ? `:${line}` : `:${line}:${column}`,
  };
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\');
}

function normalizePosixPathSegments(rawPath: string): string {
  const segments: string[] = [];
  for (const part of rawPath.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return `/${segments.join('/')}`;
}

function resolvePosixFileTargetPath(folderPath: string, filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed || trimmed.includes('\0')) {
    throw new Error('Invalid file target path');
  }
  if (trimmed.startsWith('/')) {
    return normalizePosixPathSegments(trimmed);
  }
  const normalizedFolder = normalizePosixPathSegments(folderPath);
  const joined = normalizePosixPathSegments(`${normalizedFolder}/${trimmed}`);
  const prefix = normalizedFolder === '/' ? '/' : `${normalizedFolder}/`;
  if (joined !== normalizedFolder && !joined.startsWith(prefix)) {
    throw new Error('Relative file target escapes the workspace folder');
  }
  return joined;
}

function resolveLocalFileTargetPath(
  folderPath: string,
  filePath: string,
  platform: PathLauncherPlatform
): string {
  const trimmed = filePath.trim();
  if (!trimmed || trimmed.includes('\0')) {
    throw new Error('Invalid file target path');
  }
  if (platform === 'win32' || isWindowsAbsolutePath(folderPath)) {
    if (isWindowsAbsolutePath(trimmed)) return trimmed;
    const normalizedRel = trimmed.replaceAll('/', '\\');
    const parts = normalizedRel.split('\\').filter((segment) => segment && segment !== '.');
    if (parts.includes('..')) {
      throw new Error('Relative file target cannot traverse outside the workspace folder');
    }
    const base = folderPath.replace(/[\\/]+$/u, '');
    return parts.length > 0 ? `${base}\\${parts.join('\\')}` : base;
  }
  return resolvePosixFileTargetPath(folderPath, trimmed);
}

function hasFileTarget(fileTarget?: PathLauncherFileTarget): boolean {
  if (!fileTarget) return false;
  return (
    Boolean(fileTarget.filePath?.trim()) || normalizePositiveInt(fileTarget.line) !== undefined
  );
}
function normalizePlatform(platform?: string | null): PathLauncherPlatform {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux'
    ? platform
    : 'unknown';
}
export function validateCustomPathLauncherCommandTemplate(
  commandTemplate: string
): CustomPathLauncherTemplateValidation {
  const parsed = parseCustomPathLauncherCommandTemplate(commandTemplate, '/tmp/lody-path');
  return parsed.ok ? { ok: true } : parsed;
}

function parseCustomPathLauncherCommandTemplate(
  commandTemplate: string,
  targetPath: string
):
  | { ok: true; command: LocalPathCommandSpec }
  | Exclude<CustomPathLauncherTemplateValidation, { ok: true }> {
  const trimmed = commandTemplate.trim();
  if (!trimmed) {
    return { ok: false, reason: 'empty' };
  }
  if (!trimmed.includes(PATH_LAUNCHER_PATH_PLACEHOLDER)) {
    return { ok: false, reason: 'missing_path' };
  }

  const parsed = parseCustomAcpCommandLine(trimmed);
  if (!parsed) {
    return { ok: false, reason: 'invalid_syntax' };
  }
  if (parsed.command.includes(PATH_LAUNCHER_PATH_PLACEHOLDER)) {
    return { ok: false, reason: 'path_in_command' };
  }

  const args = (parsed.args ?? []).map((arg) =>
    arg.replaceAll(PATH_LAUNCHER_PATH_PLACEHOLDER, targetPath)
  );
  return {
    ok: true,
    command: {
      command: parsed.command,
      ...(args.length > 0 ? { args } : {}),
    },
  };
}

/**
 * Sublime Text ships a `subl` CLI but its location/availability differs per OS
 * (and the CLI is often not on PATH on macOS), so we pick a platform-specific
 * primary command with a few best-effort fallbacks. The native bridge tries the
 * primary, then each fallback in order (capped at 3 by LaunchLocalPathInput).
 */
function buildSublimePathLauncherInput(
  targetPath: string,
  platform: PathLauncherPlatform,
  label: string,
  fileTarget?: PathLauncherFileTarget
): LaunchLocalPathInput {
  const { line, suffix } = formatLineColumnSuffix(fileTarget);
  const resolvedFile = fileTarget?.filePath?.trim()
    ? resolveLocalFileTargetPath(targetPath, fileTarget.filePath, platform)
    : undefined;
  const sublArgs = resolvedFile
    ? [targetPath, `${resolvedFile}${suffix}`]
    : line !== undefined
      ? [`${targetPath}${suffix}`]
      : [targetPath];
  const subl = (command: string) => ({ command, args: sublArgs });
  const base = { kind: 'command' as const, targetPath, label };

  switch (platform) {
    case 'darwin':
      if (line !== undefined) {
        // `open -a` does not understand `:line[:col]`; try `subl` first, then open the file.
        return {
          ...base,
          command: subl('subl'),
          fallbackCommands: [
            subl('/usr/local/bin/subl'),
            { command: '/usr/bin/open', args: ['-a', 'Sublime Text', resolvedFile ?? targetPath] },
          ],
        };
      }
      // `open -a` is the only reliable entry point on macOS (subl is rarely on
      // PATH); fall back to the CLI if the user symlinked it.
      return {
        ...base,
        command: {
          command: '/usr/bin/open',
          args: resolvedFile
            ? ['-a', 'Sublime Text', targetPath, resolvedFile]
            : ['-a', 'Sublime Text', targetPath],
        },
        fallbackCommands: [subl('subl'), subl('/usr/local/bin/subl')],
      };
    case 'win32': {
      const exeFallbacks = [
        subl('C:\\Program Files\\Sublime Text\\subl.exe'),
        subl('C:\\Program Files\\Sublime Text\\sublime_text.exe'),
        subl('C:\\Program Files\\Sublime Text 3\\sublime_text.exe'),
      ];
      if (sublArgs.some((arg) => /\s/u.test(arg))) {
        return {
          ...base,
          command: exeFallbacks[0]!,
          fallbackCommands: exeFallbacks.slice(1),
        };
      }
      return {
        ...base,
        command: subl('subl'),
        fallbackCommands: exeFallbacks,
      };
    }
    case 'linux':
      return {
        ...base,
        command: subl('subl'),
        fallbackCommands: [
          subl('sublime_text'),
          subl('/opt/sublime_text/sublime_text'),
          subl('/usr/bin/subl'),
        ],
      };
    default:
      return {
        ...base,
        command: subl('subl'),
        fallbackCommands: [subl('sublime_text')],
      };
  }
}

/**
 * Editors are launched through their CLI before any URL fallback. A plain URL
 * handler routes the open into the most recently focused editor window and reuses
 * it, so opening different worktrees in a row clobbers each other. VS Code's final
 * fallback adds `windowId=_blank` to preserve the CLI's separate-window behavior.
 *
 * The VS Code family takes `-n` (`newWindowFlag`). `-n` there is "open in a new
 * window" but VS Code still de-dupes by folder, so re-opening a worktree that is
 * already open just focuses its existing window — it never spawns a duplicate.
 *
 * Zed gets NO flag: its `-n`/`--new` means "create a new workspace" and forces a
 * brand-new window every time, so re-opening an already-open worktree piled up
 * duplicate windows. Zed's default CLI behavior is exactly what we want — focus
 * the existing window for a worktree that is already open, otherwise open a new
 * window (it does not clobber other worktrees' windows; that is `-a`/`--add`).
 *
 * macOS GUI apps inherit a minimal launchd PATH (frequently without
 * `/usr/local/bin`), so we try the bare CLI name first, then absolute install
 * locations. Windows `.cmd` shims can't be spawned with `shell:false`, so we fall
 * back to the app `.exe`. The native bridge tries the primary command, then each
 * fallback in order (capped at 3 by LaunchLocalPathInput); after they all fail,
 * VS Code alone falls back to its deeplink.
 */
const EDITOR_CLI_LAUNCHERS: Record<
  'vscode' | 'cursor' | 'windsurf' | 'antigravity' | 'zed',
  {
    cli: string;
    darwinApp: string;
    darwinBundleCli: string;
    win: readonly string[];
    linux: readonly string[];
    /** Flag forcing a new window; omit when the editor's default already focuses-or-opens. */
    newWindowFlag?: string;
  }
> = {
  vscode: {
    cli: 'code',
    darwinApp: 'Visual Studio Code',
    darwinBundleCli: 'Contents/Resources/app/bin/code',
    win: ['C:\\Program Files\\Microsoft VS Code\\Code.exe'],
    linux: ['/usr/bin/code', '/snap/bin/code', '/usr/share/code/bin/code'],
    newWindowFlag: '-n',
  },
  cursor: {
    cli: 'cursor',
    darwinApp: 'Cursor',
    darwinBundleCli: 'Contents/Resources/app/bin/cursor',
    win: ['C:\\Program Files\\Cursor\\Cursor.exe'],
    linux: ['/usr/bin/cursor', '/opt/cursor/cursor'],
    newWindowFlag: '-n',
  },
  windsurf: {
    cli: 'windsurf',
    darwinApp: 'Windsurf',
    darwinBundleCli: 'Contents/Resources/app/bin/windsurf',
    win: ['C:\\Program Files\\Windsurf\\Windsurf.exe'],
    linux: ['/usr/bin/windsurf'],
    newWindowFlag: '-n',
  },
  antigravity: {
    cli: 'antigravity',
    darwinApp: 'Antigravity',
    darwinBundleCli: 'Contents/Resources/app/bin/antigravity',
    win: ['C:\\Program Files\\Antigravity\\Antigravity.exe'],
    linux: ['/usr/bin/antigravity'],
    newWindowFlag: '-n',
  },
  zed: {
    cli: 'zed',
    darwinApp: 'Zed',
    darwinBundleCli: 'Contents/MacOS/cli',
    win: [],
    linux: ['/usr/bin/zed', '/usr/local/bin/zed'],
    // No newWindowFlag: `zed <path>` focuses an already-open worktree, otherwise
    // opens a new window. `-n` would force a duplicate window every time.
  },
};

function isEditorCliLauncherId(id: string): id is keyof typeof EDITOR_CLI_LAUNCHERS {
  return Object.prototype.hasOwnProperty.call(EDITOR_CLI_LAUNCHERS, id);
}

function encodeEditorLocalUrlPath(targetPath: string, targetKind: 'file' | 'directory'): string {
  const normalizedPath = targetPath.replaceAll('\\', '/');
  const absolutePath = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
  const urlPath =
    targetKind === 'directory' && !absolutePath.endsWith('/') ? `${absolutePath}/` : absolutePath;
  return urlPath
    .split('/')
    .map((segment, index) =>
      index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)
    )
    .join('/');
}

export function buildVSCodePathLauncherFallbackUrl(
  targetPath: string,
  targetKind: 'file' | 'directory' = 'directory',
  fileTarget?: PathLauncherFileTarget
): string {
  return buildEditorLocalFallbackUrl('vscode', targetPath, targetKind, fileTarget);
}

function buildEditorLocalFallbackUrl(
  scheme: 'vscode' | 'cursor',
  targetPath: string,
  targetKind: 'file' | 'directory',
  fileTarget?: PathLauncherFileTarget
): string {
  const { suffix } = formatLineColumnSuffix(fileTarget);
  const filePath = fileTarget?.filePath?.trim();
  const effectivePath = filePath
    ? resolveLocalFileTargetPath(
        targetPath,
        filePath,
        isWindowsAbsolutePath(targetPath) ? 'win32' : 'unknown'
      )
    : targetPath;
  const effectiveKind: 'file' | 'directory' = filePath || suffix ? 'file' : targetKind;
  const encodedPath = encodeEditorLocalUrlPath(effectivePath, effectiveKind);
  return `${scheme}://file${encodedPath}${suffix}?windowId=_blank`;
}

/** The editor's CLI with `args`: by name first, then where each platform installs it. */
function buildEditorCliCommands(
  id: keyof typeof EDITOR_CLI_LAUNCHERS,
  platform: PathLauncherPlatform,
  args: string[]
): Pick<Extract<LaunchLocalPathInput, { kind: 'command' }>, 'command' | 'fallbackCommands'> {
  const spec = EDITOR_CLI_LAUNCHERS[id];
  const make = (command: string): LocalPathCommandSpec => ({ command, args });

  let absoluteFallbacks: readonly string[];
  switch (platform) {
    case 'darwin':
      absoluteFallbacks = [
        `/usr/local/bin/${spec.cli}`,
        `/Applications/${spec.darwinApp}.app/${spec.darwinBundleCli}`,
      ];
      break;
    case 'win32':
      absoluteFallbacks = spec.win;
      break;
    case 'linux':
      absoluteFallbacks = spec.linux;
      break;
    default:
      absoluteFallbacks = [];
  }

  const fallbackCommands = absoluteFallbacks.slice(0, 3).map(make);
  // On Windows, bare CLI names (e.g. `code`) resolve to `.cmd` shims spawned
  // via `cmd.exe`, where unquoted whitespace in arguments splits the path.
  // Prefer native `.exe` candidates that preserve exact argv without shell parsing.
  if (platform === 'win32' && fallbackCommands.length > 0 && args.some((arg) => /\s/u.test(arg))) {
    return {
      command: fallbackCommands[0]!,
      ...(fallbackCommands.length > 1 ? { fallbackCommands: fallbackCommands.slice(1) } : {}),
    };
  }
  return {
    command: make(spec.cli),
    ...(fallbackCommands.length > 0 ? { fallbackCommands } : {}),
  };
}

function buildEditorCliLauncherInput(
  id: keyof typeof EDITOR_CLI_LAUNCHERS,
  targetPath: string,
  platform: PathLauncherPlatform,
  label: string,
  targetKind: 'file' | 'directory',
  fileTarget?: PathLauncherFileTarget
): LaunchLocalPathInput {
  const { newWindowFlag } = EDITOR_CLI_LAUNCHERS[id];
  const targetRequested = hasFileTarget(fileTarget);
  const { line, suffix } = formatLineColumnSuffix(fileTarget);
  const resolvedFile = fileTarget?.filePath?.trim()
    ? resolveLocalFileTargetPath(targetPath, fileTarget.filePath, platform)
    : undefined;

  let args: string[];
  if (id === 'zed') {
    if (resolvedFile) {
      args = [targetPath, `${resolvedFile}${suffix}`];
    } else if (line !== undefined) {
      args = [`${targetPath}${suffix}`];
    } else {
      args = [targetPath];
    }
  } else if (resolvedFile) {
    args = [
      ...(newWindowFlag ? [newWindowFlag] : []),
      targetPath,
      ...(line !== undefined ? ['-g', `${resolvedFile}${suffix}`] : [resolvedFile]),
    ];
  } else if (line !== undefined) {
    args = [...(newWindowFlag ? [newWindowFlag] : []), '-g', `${targetPath}${suffix}`];
  } else {
    args = newWindowFlag ? [newWindowFlag, targetPath] : [targetPath];
  }

  const fallbackUrl =
    id === 'vscode'
      ? buildEditorLocalFallbackUrl('vscode', targetPath, targetKind, fileTarget)
      : id === 'cursor' && targetRequested
        ? buildEditorLocalFallbackUrl('cursor', targetPath, targetKind, fileTarget)
        : undefined;

  return {
    kind: 'command',
    ...buildEditorCliCommands(id, platform, args),
    ...(fallbackUrl ? { fallbackUrl } : {}),
    targetPath,
    label,
  };
}

export function buildPathLauncherLaunchInput(
  launcher: PathLauncherOption,
  targetPath: string,
  platform?: string | null,
  targetKind: 'file' | 'directory' = 'directory',
  fileTarget?: PathLauncherFileTarget
): LaunchLocalPathInput {
  const normalizedPlatform = normalizePlatform(platform);
  if (launcher.kind === 'custom') {
    const resolvedTarget = fileTarget?.filePath?.trim()
      ? resolveLocalFileTargetPath(targetPath, fileTarget.filePath, normalizedPlatform)
      : targetPath;
    const parsed = parseCustomPathLauncherCommandTemplate(launcher.commandTemplate, resolvedTarget);
    if (!parsed.ok) {
      throw new Error(`Invalid path launcher command template: ${parsed.reason}`);
    }
    return {
      kind: 'command',
      command: parsed.command,
      targetPath,
      label: launcher.label,
    };
  }

  if (isEditorCliLauncherId(launcher.id)) {
    return buildEditorCliLauncherInput(
      launcher.id,
      targetPath,
      normalizedPlatform,
      launcher.label,
      targetKind,
      fileTarget
    );
  }

  if (launcher.id === 'sublime') {
    return buildSublimePathLauncherInput(
      targetPath,
      normalizedPlatform,
      launcher.label,
      fileTarget
    );
  }

  if (launcher.id === 'delta') {
    return {
      kind: 'command',
      command: { command: 'delta', args: ['open', targetPath] },
      targetPath,
      label: launcher.label,
    };
  }

  if (launcher.id === 'xcode') {
    return {
      kind: 'command',
      command: { command: '/usr/bin/xed', args: [targetPath] },
      fallbackCommands: [{ command: 'xed', args: [targetPath] }],
      targetPath,
      label: launcher.label,
    };
  }

  if (launcher.id === 'warp') {
    // Warp is a terminal with no clean CLI to open a new tab at a path, but its
    // url scheme already opens a NEW tab (no window-reuse problem), so it stays on
    // the url launch path — handled by the desktop bridge via shell.openExternal.
    return {
      kind: 'url',
      url: `warp://action/new_tab?path=${encodeURIComponent(targetPath)}`,
      targetPath,
      label: launcher.label,
    };
  }

  throw new Error(`Path launcher ${launcher.id} cannot build a launch request`);
}

/**
 * Whether the launcher opens a folder of another machine. That takes an editor
 * that works over SSH; every other launcher hands the path to a program that
 * would look for it on this machine.
 */
export function canLaunchRemotePath(launcher: PathLauncherOption): boolean {
  return launcher.kind === 'builtin' && isEditorCliLauncherId(launcher.id);
}

/**
 * Whether the launcher is handed a machine as the host of an address, where
 * only some names fit. Zed is; the VS Code family has a way to write any.
 */
export function remotePathLauncherTakesUrlHost(launcher: PathLauncherOption): boolean {
  return launcher.kind === 'builtin' && launcher.id === 'zed';
}

/** An entry of this machine's SSH configuration, if the launcher can be handed it. */
export function resolveRemotePathEntry(
  launcher: PathLauncherOption,
  entry: unknown
): SshDestination | null {
  const parsed = parseSshDestination(entry);
  if (!parsed) return null;
  return !remotePathLauncherTakesUrlHost(launcher) || isSshUrlHost(parsed.host) ? parsed : null;
}

/**
 * What an editor is handed to reach a machine: the entry of this machine's SSH
 * configuration the user named for it, else the one found to lead there, which
 * is where its key is, and without one that the launcher can be handed, what
 * the machine says about itself.
 */
export function resolveRemotePathDestination(
  launcher: PathLauncherOption,
  ssh: LanSshDestination,
  entries: { named?: unknown; found?: unknown }
): SshDestination {
  return (
    resolveRemotePathEntry(launcher, entries.named) ??
    resolveRemotePathEntry(launcher, entries.found) ??
    toSshDestination(ssh)
  );
}

/**
 * The VS Code family writes the authority of an address in small letters and
 * reads a colon in it as the start of a port. A destination with capital
 * letters, a colon or a port is therefore handed over the way these editors
 * write one themselves: as the hexadecimal of its parts, which they read back
 * letter by letter.
 */
function formatVsCodeRemoteAuthority(destination: SshDestination): string {
  const { host, user, port } = destination;
  const written = formatSshDestination(destination);
  if (port === undefined && /^[a-z0-9_.@-]+$/u.test(written)) return `ssh-remote+${written}`;
  const parts = JSON.stringify({
    hostName: host,
    ...(user === undefined ? {} : { user }),
    ...(port === undefined ? {} : { port }),
  });
  const hexadecimal = Array.from(new TextEncoder().encode(parts), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return `ssh-remote+${hexadecimal}`;
}

/**
 * Opens a folder of another machine over SSH. The VS Code family takes it as a
 * `vscode-remote` address and Zed as an `ssh` one. It is named by address and
 * not as `--remote <destination> <path>`, because VS Code takes a remote path
 * with a dot in its last segment for a file. The address carries the path
 * encoded, so nothing in it reads as an option or as part of the destination.
 */
export function buildRemotePathLauncherLaunchInput(
  launcher: PathLauncherOption,
  targetPath: string,
  /** As `resolveRemotePathDestination` gives it for the launcher. */
  destination: SshDestination,
  platform?: string | null,
  fileTarget?: PathLauncherFileTarget
): LaunchLocalPathInput {
  if (launcher.kind !== 'builtin' || !isEditorCliLauncherId(launcher.id)) {
    throw new Error(
      `Path launcher ${launcher.kind === 'builtin' ? launcher.id : launcher.launcherId} cannot open a folder of another machine`
    );
  }
  if (!targetPath.startsWith('/')) {
    throw new Error('A folder of another machine is opened by its absolute POSIX path');
  }
  const reached = parseSshDestination(destination);
  if (!reached || (remotePathLauncherTakesUrlHost(launcher) && !isSshUrlHost(reached.host))) {
    throw new Error(`Path launcher ${launcher.id} cannot be handed that machine`);
  }

  const encodePosix = (posixPath: string) =>
    posixPath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');

  const folder = encodePosix(targetPath);
  const targetRequested = hasFileTarget(fileTarget);
  const { line, suffix } = formatLineColumnSuffix(fileTarget);
  const explicitFilePath = fileTarget?.filePath?.trim();
  const resolvedFile = explicitFilePath
    ? resolvePosixFileTargetPath(targetPath, explicitFilePath)
    : undefined;
  const encodedFile = resolvedFile ? encodePosix(resolvedFile) : folder;

  const { newWindowFlag } = EDITOR_CLI_LAUNCHERS[launcher.id];
  const authority = formatVsCodeRemoteAuthority(reached);

  let args: string[];
  if (launcher.id === 'zed') {
    const sshDest = formatSshDestination(reached);
    if (resolvedFile && encodedFile !== folder) {
      args = [`ssh://${sshDest}${folder}`, `ssh://${sshDest}${encodedFile}${suffix}`];
    } else {
      args = [`ssh://${sshDest}${encodedFile}${suffix}`];
    }
  } else if (resolvedFile) {
    args = [
      ...(newWindowFlag ? [newWindowFlag] : []),
      '--folder-uri',
      `vscode-remote://${authority}${folder}`,
      ...(line !== undefined ? ['-g'] : []),
      '--file-uri',
      `vscode-remote://${authority}${encodedFile}${suffix}`,
    ];
  } else if (line !== undefined) {
    args = [
      ...(newWindowFlag ? [newWindowFlag] : []),
      '-g',
      '--file-uri',
      `vscode-remote://${authority}${folder}${suffix}`,
    ];
  } else {
    args = [
      ...(newWindowFlag ? [newWindowFlag] : []),
      '--folder-uri',
      `vscode-remote://${authority}${folder}`,
    ];
  }

  const fallbackUrl =
    launcher.id === 'vscode'
      ? `vscode://vscode-remote/${authority}${encodedFile}${suffix}?windowId=_blank`
      : launcher.id === 'cursor' && targetRequested
        ? `cursor://vscode-remote/${authority}${encodedFile}${suffix}?windowId=_blank`
        : undefined;

  return {
    kind: 'command',
    ...buildEditorCliCommands(launcher.id, normalizePlatform(platform), args),
    ...(fallbackUrl ? { fallbackUrl } : {}),
    targetPath,
    label: launcher.label,
  };
}
