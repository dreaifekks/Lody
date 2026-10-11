// The `lody-lan` command the sessions of this machine find on their PATH. It
// runs the CLI of the agent service that started them, so it is there on a
// machine that only has the desktop application, and it is always the build
// that serves the sockets it connects to.
import fs from 'node:fs';
import path from 'node:path';
import { ensureLodyDataDir } from '@lody/shared/node/installation-profile';
import { toSingleQuotedShellString, writeIfChanged } from '@/lib/shell-file-utils';

/** Not `lody`: a machine may have the hosted command under that name. */
export const LAN_SESSION_COMMAND_NAME = 'lody-lan';
const BIN_DIRECTORY_NAME = 'session-bin';

export type LanSessionCommandRuntime = {
  /** What runs the CLI: Node, or a desktop application that acts as it. */
  execPath: string;
  /** The entry of the CLI the agent service runs. */
  entry: string;
  /** `ELECTRON_RUN_AS_NODE` of the agent service; a terminal's environment drops it. */
  electronRunAsNode?: string | undefined;
};

type LanSessionCommand = {
  binDir: string;
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

const quoteForCmd = (value: string): string => `"${value.replace(/%/g, '%%')}"`;

function renderWindowsLauncher(runtime: LanSessionCommandRuntime): string {
  return [
    '@echo off',
    'rem Written by the Lody agent service of this machine: its own command line.',
    'setlocal',
    `set "LODY_LAN_COMMAND=${LAN_SESSION_COMMAND_NAME}"`,
    ...(runtime.electronRunAsNode
      ? [`set "ELECTRON_RUN_AS_NODE=${runtime.electronRunAsNode}"`]
      : []),
    `${quoteForCmd(runtime.execPath)} ${quoteForCmd(runtime.entry)} %*`,
    '',
  ].join('\r\n');
}

/**
 * Writes the command into the data directory and returns the directory that
 * goes on a session's PATH. Windows gets a `.cmd` beside the script; a POSIX
 * shell there (Git Bash) runs the script.
 */
export function writeLanSessionCommand(
  runtime: LanSessionCommandRuntime,
  options: { dataDir?: string; platform?: NodeJS.Platform } = {}
): string {
  const binDir = path.join(options.dataDir ?? ensureLodyDataDir(), BIN_DIRECTORY_NAME);
  fs.mkdirSync(binDir, { recursive: true });
  const launcher = path.join(binDir, LAN_SESSION_COMMAND_NAME);
  writeIfChanged(launcher, renderPosixLauncher(runtime), 0o755);
  if ((options.platform ?? process.platform) === 'win32') {
    writeIfChanged(`${launcher}.cmd`, renderWindowsLauncher(runtime));
  }
  return binDir;
}

/**
 * Set once by an agent service of the local platform, and by nothing on the
 * hosted one: without it no session's PATH or prompt changes.
 */
export function setLanSessionCommand(command: LanSessionCommand | null): void {
  current = command;
}

const isPathKey = (key: string): boolean =>
  process.platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH';

/**
 * Puts the command first on the PATH of an environment a session's agent or
 * terminal starts with. Windows may carry the variable under two spellings,
 * of which a child process gets one, so each of them is extended.
 */
export function exposeLanSessionCommand(env: NodeJS.ProcessEnv): void {
  if (!current) return;
  const { binDir } = current;
  const keys = Object.keys(env).filter(isPathKey);
  for (const key of keys.length > 0 ? keys : ['PATH']) {
    const rest = (env[key] ?? '')
      .split(path.delimiter)
      .filter((entry) => entry && entry !== binDir);
    env[key] = [binDir, ...rest].join(path.delimiter);
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
    '`lody-lan lan shell <machine> -- <command>` runs a command on one, and ' +
    '`lody-lan lan forward <machine> <port>` reaches a port there; see `lody-lan lan --help`.'
  );
}
