// The `lody-lan` command the sessions of this machine find on their PATH. It
// runs the CLI of the agent service that started them, so it is there on a
// machine that only has the desktop application, and it is always the build
// that serves the sockets it connects to.
import fs from 'node:fs';
import path from 'node:path';
import { ensureLodyDataDir } from '@lody/shared/node/installation-profile';
import { getGhShimSessionBinRoot } from '@/lib/gh-shim-script';
import { toSingleQuotedShellString, writeIfChanged } from '@/lib/shell-file-utils';
import { formatErrorMessage } from '@/utils/format-error';
import type { Logger } from '@/utils/logger';

/** Not `lody`: a machine may have the hosted command under that name. */
export const LAN_SESSION_COMMAND_NAME = 'lody-lan';
const BIN_DIRECTORY_NAME = 'session-bin';
/** Where the `.cmd` of Windows finds the runtime and the entry. */
const RUNTIME_ENV = 'LODY_LAN_COMMAND_RUNTIME';
const ENTRY_ENV = 'LODY_LAN_COMMAND_ENTRY';

export type LanSessionCommandRuntime = {
  /** What runs the CLI: Node, or a desktop application that acts as it. */
  execPath: string;
  /** The entry of the CLI the agent service runs. */
  entry: string;
  /** `ELECTRON_RUN_AS_NODE` of the agent service; a terminal's environment drops it. */
  electronRunAsNode?: string | undefined;
};

type WrittenLanSessionCommand = {
  /** The directory that goes on a session's PATH. */
  binDir: string;
  /** What the command reads from the environment of a session; Windows only. */
  env: Readonly<Record<string, string>>;
};

type LanSessionCommand = WrittenLanSessionCommand & {
  /** Whether this machine belongs to a LAN right now. */
  isLanMember: () => boolean;
};

let current: LanSessionCommand | null = null;

function renderPosixLauncher(runtime: LanSessionCommandRuntime): string {
  return [
    '#!/bin/sh',
    '# Written by the Lody agent service of this machine: its own command line.',
    `export LODY_LAN_COMMAND=${toSingleQuotedShellString(LAN_SESSION_COMMAND_NAME)}`,
    ...(runtime.electronRunAsNode
      ? [`export ELECTRON_RUN_AS_NODE=${toSingleQuotedShellString(runtime.electronRunAsNode)}`]
      : []),
    `exec ${toSingleQuotedShellString(runtime.execPath)} ${toSingleQuotedShellString(runtime.entry)} "$@"`,
    '',
  ].join('\n');
}

/**
 * cmd reads a batch file in the code page of its console, so a path written
 * into the file breaks once it holds a character outside that page. The two
 * paths come from the environment instead, which Windows keeps in Unicode.
 */
function renderWindowsLauncher(runtime: LanSessionCommandRuntime): string {
  return [
    '@echo off',
    'rem Written by the Lody agent service of this machine: its own command line.',
    'setlocal DisableDelayedExpansion',
    `set "LODY_LAN_COMMAND=${LAN_SESSION_COMMAND_NAME}"`,
    ...(runtime.electronRunAsNode
      ? [`set "ELECTRON_RUN_AS_NODE=${runtime.electronRunAsNode}"`]
      : []),
    `"%${RUNTIME_ENV}%" "%${ENTRY_ENV}%" %*`,
    '',
  ].join('\r\n');
}

/**
 * Writes the command into the data directory. Windows gets a `.cmd` beside
 * the script, and its sessions the two paths the `.cmd` reads; a POSIX shell
 * there (Git Bash) runs the script, which names the paths itself.
 */
export function writeLanSessionCommand(
  runtime: LanSessionCommandRuntime,
  options: { dataDir?: string; platform?: NodeJS.Platform } = {}
): WrittenLanSessionCommand {
  const binDir = path.join(options.dataDir ?? ensureLodyDataDir(), BIN_DIRECTORY_NAME);
  fs.mkdirSync(binDir, { recursive: true });
  const launcher = path.join(binDir, LAN_SESSION_COMMAND_NAME);
  writeIfChanged(launcher, renderPosixLauncher(runtime), 0o755);
  if ((options.platform ?? process.platform) !== 'win32') return { binDir, env: {} };
  writeIfChanged(`${launcher}.cmd`, renderWindowsLauncher(runtime));
  return { binDir, env: { [RUNTIME_ENV]: runtime.execPath, [ENTRY_ENV]: runtime.entry } };
}

/**
 * Set once by an agent service of the local platform, and by nothing on the
 * hosted one: without it no session's PATH or prompt changes.
 */
export function setLanSessionCommand(command: LanSessionCommand | null): void {
  current = command;
}

/**
 * Writes the command and offers it to the sessions of this agent service. A
 * command that cannot be written is offered to none, so no agent is told of
 * one that is not there, and the service starts all the same.
 */
export function installLanSessionCommand(options: {
  runtime: LanSessionCommandRuntime;
  isLanMember: () => boolean;
  logger: Pick<Logger, 'warn'>;
  dataDir?: string;
  platform?: NodeJS.Platform;
}): void {
  const { runtime, isLanMember, logger, ...location } = options;
  try {
    setLanSessionCommand({ ...writeLanSessionCommand(runtime, location), isLanMember });
  } catch (error) {
    logger.warn(
      `[lan] Sessions get no ${LAN_SESSION_COMMAND_NAME} command: ${formatErrorMessage(error)}`
    );
  }
}

const isPathKey = (key: string): boolean =>
  process.platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH';

/**
 * Puts the command at the head of the PATH of an environment a session's
 * agent or terminal starts with: first, or second behind a `gh` shim dir that
 * leads it, which PATH merges keep first. Windows may carry the variable
 * under two spellings, of which a child process gets one, so each of them is
 * extended.
 */
export function exposeLanSessionCommand(env: NodeJS.ProcessEnv): void {
  if (!current) return;
  const { binDir } = current;
  Object.assign(env, current.env);
  const keys = Object.keys(env).filter(isPathKey);
  for (const key of keys.length > 0 ? keys : ['PATH']) {
    const rest = (env[key] ?? '')
      .split(path.delimiter)
      .filter((entry) => entry && entry !== binDir);
    const shim =
      rest[0] !== undefined && path.dirname(rest[0]) === getGhShimSessionBinRoot() ? [rest[0]] : [];
    env[key] = [...shim, binDir, ...rest.slice(shim.length)].join(path.delimiter);
  }
}

/**
 * What every turn tells the agent while this machine belongs to a LAN; empty
 * otherwise. Kept short: it travels with each prompt, and it is the one place
 * every agent reads.
 */
export function getLanSessionCommandReminder(): string {
  if (!current?.isLanMember()) return '';
  return (
    '\n\nThis machine is a member of a Lody LAN. `lody-lan lan machines` lists the other machines, ' +
    '`lody-lan lan shell <machine> -- <command>` runs a command on one, ' +
    '`lody-lan lan cp [-r] <src> <machine>:<dst>` copies files either way (use it for files, ' +
    'not pipes into `lan shell`), and ' +
    '`lody-lan lan forward <machine> <port>` reaches a port there; see `lody-lan lan --help`.'
  );
}
