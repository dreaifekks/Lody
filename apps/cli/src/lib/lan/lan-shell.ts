// A shell of a machine of a LAN in this terminal. The command speaks to the
// agent service of this machine over its local terminal socket, as a desktop
// does; the agent service reaches the member over the connection members open
// to each other, so no credential leaves it.
import net from 'node:net';
import {
  createUtf8StreamDecoder,
  machineShellScope,
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
  type TerminalServerEvent,
  type TerminalSnapshot,
} from '@lody/shared';
import { getLocalTerminalSocketPath } from '@lody/shared/node/local-terminal';
import { DAEMON_NOT_RUNNING_MESSAGE } from '@/lib/command-runtime';
import type { RemoteTerminalLink } from '@/lib/terminal-services';
import { createTerminalLink } from './lan-terminal';

const CONNECT_TIMEOUT_MS = 5_000;

export async function connectLocalTerminals(
  socketPath = getLocalTerminalSocketPath()
): Promise<RemoteTerminalLink> {
  const socket = net.connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(DAEMON_NOT_RUNNING_MESSAGE));
    }, CONNECT_TIMEOUT_MS);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', () => {
      clearTimeout(timer);
      reject(new Error(DAEMON_NOT_RUNNING_MESSAGE));
    });
  });
  socket.pause();
  return createTerminalLink(socket);
}

/** Strips the code the agent service puts before what it says. */
export function describeTerminalError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match =
    /^(remote_unreachable|workdir_unavailable|terminal_limit_exceeded|terminal_not_found|session_[a-z_]+):(.*)$/s.exec(
      message
    );
  if (!match) return message;
  const [, code, rest] = match;
  if (code === 'terminal_limit_exceeded') {
    return 'The machine runs as many shells as it opens; close one (--list, --kill)';
  }
  if (code === 'terminal_not_found') return `No shell ${rest}`;
  if (code?.startsWith('session_')) return `The machine opens no shell: ${message}`;
  return rest?.trim() || message;
}

export async function listMachineShells(
  link: RemoteTerminalLink,
  machineId: string
): Promise<TerminalSnapshot[]> {
  return await link.list(machineShellScope(machineId));
}

/** A shell by its id, or by the start of it when only one shell has that. */
export function findMachineShell(
  shells: readonly TerminalSnapshot[],
  selector: string
): TerminalSnapshot {
  const exact = shells.find((shell) => shell.terminalId === selector);
  if (exact) return exact;
  const matching = shells.filter((shell) => shell.terminalId.startsWith(selector));
  if (matching.length === 1 && matching[0]) return matching[0];
  throw new Error(
    matching.length > 1
      ? `Several shells start with ${selector}; give more of the id`
      : `No shell ${selector}; the machine runs ${shells.map((shell) => shell.terminalId).join(', ') || 'none'}`
  );
}

/**
 * What ends piped input in a terminal: Ctrl-D at the start of a line. A last
 * line without its newline takes one Ctrl-D to be read and another to end.
 */
export function endOfInput(lastInput: string): string {
  return lastInput === '' || lastInput.endsWith('\n') ? '\u0004' : '\u0004\u0004';
}

/**
 * The status a shell's end gives this command: its exit code, or 128 plus
 * the signal that ended it, as a shell reports one.
 */
export function shellExitStatus(outcome: { exitCode: number; signal?: string }): number {
  const signal = Number(outcome.signal);
  if (Number.isInteger(signal) && signal > 0) return 128 + signal;
  return outcome.exitCode >= 0 && outcome.exitCode < 256 ? outcome.exitCode : 255;
}

/**
 * Typing Enter, `~` and `.` leaves a shell running and ends this command, as
 * it ends a connection in ssh; `~~` types one `~`.
 */
export function createDetachFilter(onDetach: () => void): (input: string) => string {
  let lineStart = true;
  let pendingTilde = false;
  return (input) => {
    let out = '';
    for (const char of input) {
      if (pendingTilde) {
        pendingTilde = false;
        if (char === '.') {
          onDetach();
          return out;
        }
        out += char === '~' ? '~' : `~${char}`;
        lineStart = char === '\r' || char === '\n';
        continue;
      }
      if (lineStart && char === '~') {
        pendingTilde = true;
        continue;
      }
      out += char;
      lineStart = char === '\r' || char === '\n';
    }
    return out;
  };
}

export type ShellOutcome =
  | { type: 'exited'; exitCode: number; signal?: string }
  | { type: 'detached'; terminalId: string }
  | { type: 'disconnected'; terminalId: string; reason: string };

export type ShellIo = {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
};

/**
 * Connects this terminal to a shell of a machine, opening one unless
 * `attach` names a running one, and returns when the shell ends, when it is
 * left running, or when the connection to it breaks.
 */
export async function runMachineShell(
  link: RemoteTerminalLink,
  options: {
    machineId: string;
    cwd?: string;
    command?: string;
    attach?: string;
    io?: ShellIo;
  }
): Promise<ShellOutcome> {
  const io = options.io ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
  const size = () => ({
    cols: io.stdout.columns || TERMINAL_DEFAULT_COLS,
    rows: io.stdout.rows || TERMINAL_DEFAULT_ROWS,
  });
  const scope = machineShellScope(options.machineId);

  // Listening starts before the open: a short command can end, and say so,
  // in the same breath as the answer that names its terminal.
  const before: TerminalServerEvent[] = [];
  let deliver: ((event: TerminalServerEvent) => void) | null = null;
  const stopListening = link.onEvent((event) => {
    if (deliver) deliver(event);
    else before.push(event);
  });

  let terminalId: string;
  let attached = false;
  try {
    if (options.attach) {
      terminalId = findMachineShell(await link.list(scope), options.attach).terminalId;
    } else {
      const opened = await link.open({
        sessionId: scope,
        ...size(),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.command ? { command: options.command } : {}),
        attach: true,
      });
      terminalId = opened.terminalId;
      // A machine of a build before `attach` on open needs the attach after it.
      attached = opened.attached === true;
    }
  } catch (error) {
    stopListening();
    throw error;
  }

  return await new Promise<ShellOutcome>((resolve, reject) => {
    const interactive = io.stdin.isTTY === true;
    let settled = false;
    const cleanups: Array<() => void> = [];
    const finish = (outcome: ShellOutcome | Error) => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups.reverse()) cleanup();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };

    // Events can arrive while the replay is under way; they are written after it.
    const early: TerminalServerEvent[] = [];
    let replayed = false;
    const handle = (event: TerminalServerEvent) => {
      if (!('terminalId' in event) || event.terminalId !== terminalId) return;
      if (event.type === 'data') io.stdout.write(event.data);
      else if (event.type === 'exit') {
        if (event.signal === 'disconnected') {
          finish({
            type: 'disconnected',
            terminalId,
            reason: 'the connection to the machine broke',
          });
        } else {
          finish({
            type: 'exited',
            exitCode: event.exitCode,
            ...(event.signal ? { signal: event.signal } : {}),
          });
        }
      } else if (event.type === 'error') {
        io.stderr.write(`\r\n${describeTerminalError(new Error(event.message))}\r\n`);
      }
    };
    deliver = (event) => {
      if (replayed) handle(event);
      else early.push(event);
    };
    cleanups.push(stopListening);
    cleanups.push(link.onClose((reason) => finish({ type: 'disconnected', terminalId, reason })));

    const filter = createDetachFilter(() => finish({ type: 'detached', terminalId }));
    let lastInput = '';
    // A character can be split between two chunks of input; one decoder keeps
    // its first bytes until the rest arrives.
    const decode = createUtf8StreamDecoder();
    const onInput = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : decode(chunk);
      const data = interactive ? filter(text) : text;
      if (!data) return;
      lastInput = data;
      link.send({ type: 'input', terminalId, data });
    };
    // A command given input from a pipe sees its end as an end of file.
    const onEnd = () => {
      if (interactive) return;
      link.send({ type: 'input', terminalId, data: endOfInput(lastInput) });
    };
    if (interactive) {
      io.stdin.setRawMode(true);
      cleanups.push(() => io.stdin.setRawMode(false));
    }
    io.stdin.on('data', onInput);
    io.stdin.on('end', onEnd);
    io.stdin.resume();
    cleanups.push(() => {
      io.stdin.off('data', onInput);
      io.stdin.off('end', onEnd);
      io.stdin.pause();
    });

    const onResize = () => link.send({ type: 'resize', terminalId, ...size() });
    io.stdout.on('resize', onResize);
    cleanups.push(() => io.stdout.off('resize', onResize));

    if (!interactive) {
      // Without a terminal of its own the command is interrupted by a signal,
      // not by a key the machine receives; the command it ran stops with it.
      const onSignal = () => {
        link.send({ type: 'close', terminalId });
        finish({ type: 'exited', exitCode: 130 });
      };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      cleanups.push(() => {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      });
    }

    if (attached) {
      // Everything the terminal did reached this connection, in order.
      replayed = true;
      for (const event of before.splice(0)) handle(event);
      return;
    }
    before.length = 0;
    link.attach(terminalId, size().cols, size().rows).then(
      (replay) => {
        if (replay.scrollback) io.stdout.write(replay.scrollback);
        replayed = true;
        for (const event of early.splice(0)) handle(event);
      },
      (error: unknown) => finish(new Error(describeTerminalError(error)))
    );
  });
}
