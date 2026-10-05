import { Command } from 'commander';
import { printJson, runOneShotCommand, type CommonCommandOptions } from '@/lib/command-runtime';
import {
  findLanMachine,
  listLanMachinesOfThisMachine,
  resolveLocalMachineId,
} from '@/lib/lan/lan-control-client';
import {
  connectLocalTerminals,
  describeTerminalError,
  findMachineShell,
  listMachineShells,
  runMachineShell,
  shellExitStatus,
} from '@/lib/lan/lan-shell';
import { renderTerminalTable } from '@/lib/terminal-table';

const KILL_CHECKS = 10;
const KILL_CHECK_MS = 300;

type ShellOptions = Pick<CommonCommandOptions, 'json' | 'debug'> & {
  cwd?: string;
  attach?: string;
  list?: boolean;
  kill?: string;
};

/** Ends the command with the exit code of the shell, saying nothing more. */
class ShellExit extends Error {
  readonly suppressCommandErrorOutput = true;
  constructor(readonly exitCode: number) {
    super(`exit ${exitCode}`);
  }
}

async function resolveMachine(selector: string | undefined) {
  const localMachineId = await resolveLocalMachineId();
  if (!selector?.trim()) return { machineId: localMachineId as string, name: 'this machine' };
  const { machines } = await listLanMachinesOfThisMachine(localMachineId);
  const machine = findLanMachine(machines, selector);
  if (!machine.self && machine.online === false) {
    throw new Error(`${machine.alias ?? machine.name} is offline`);
  }
  return { machineId: machine.machineId, name: machine.alias ?? machine.name };
}

export const shellCommand = new Command('shell')
  .description('Open a shell on a machine of a LAN, over the connection members open to each other')
  .argument('[machine]', 'Name, short name or id of a member; this machine when left out')
  .argument('[command...]', 'Run this instead of an interactive shell (put -- before it)')
  .option(
    '--cwd <dir>',
    'Where the shell starts (absolute or ~/...); the home directory by default'
  )
  .option('--attach <id>', 'Connect to a shell that runs there already (an id or its start)')
  .option('--list', 'List the shells that run there')
  .option('--kill <id>', 'Close a shell that runs there')
  .option('--json', 'Print JSON output (with --list and --kill)')
  .option('--debug', 'Enable debug output')
  .addHelpText(
    'after',
    [
      '',
      'Enter, then ~ and . leaves the shell running and ends this command;',
      '--attach brings it back. Typing exit ends the shell.',
      '',
      'A command runs in a terminal there, as with ssh -t: what a pipe gives it is',
      'echoed, and it is no way to move binary data.',
    ].join('\n')
  )
  .action(async (selector: string | undefined, words: string[], options: ShellOptions) => {
    await runOneShotCommand('lan', options, async () => {
      const machine = await resolveMachine(selector);
      const link = await connectLocalTerminals();
      try {
        if (options.list) {
          const shells = await listMachineShells(link, machine.machineId).catch((error) => {
            throw new Error(describeTerminalError(error));
          });
          if (options.json) {
            printJson({ ok: true, machineId: machine.machineId, shells });
          } else if (shells.length === 0) {
            console.log(`No shell runs on ${machine.name}.`);
          } else {
            console.log(
              renderTerminalTable(
                [{ header: 'ID' }, { header: 'Title' }, { header: 'Directory' }],
                shells.map((shell) => [shell.terminalId, shell.title, shell.cwd ?? ''])
              )
            );
          }
          return;
        }
        if (options.kill) {
          const shells = await listMachineShells(link, machine.machineId).catch((error) => {
            throw new Error(describeTerminalError(error));
          });
          const shell = findMachineShell(shells, options.kill);
          link.send({ type: 'close', terminalId: shell.terminalId });
          // The machine says nothing to a connection that never attached the
          // shell, so the list tells when it is gone.
          for (let attempt = 0; attempt < KILL_CHECKS; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, KILL_CHECK_MS));
            const left = await listMachineShells(link, machine.machineId);
            if (!left.some((entry) => entry.terminalId === shell.terminalId)) break;
            if (attempt === KILL_CHECKS - 1) {
              throw new Error(`${shell.terminalId} still runs on ${machine.name}`);
            }
          }
          if (options.json) printJson({ ok: true, closed: shell.terminalId });
          else console.log(`Closed ${shell.terminalId} on ${machine.name}.`);
          return;
        }

        const command = words.join(' ').trim();
        if (options.attach && command) throw new Error('--attach takes no command');
        if (!process.stdin.isTTY && !command) {
          throw new Error('An interactive shell needs a terminal; give a command to run instead');
        }
        const outcome = await runMachineShell(link, {
          machineId: machine.machineId,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(command ? { command } : {}),
          ...(options.attach ? { attach: options.attach } : {}),
        }).catch((error: unknown) => {
          throw new Error(describeTerminalError(error));
        });
        if (outcome.type === 'exited') {
          const status = shellExitStatus(outcome);
          if (status === 0) return;
          throw new ShellExit(status);
        }
        const again = ['lody-lan lan shell', selector?.trim(), '--attach', outcome.terminalId]
          .filter(Boolean)
          .join(' ');
        if (outcome.type === 'detached') {
          process.stderr.write(`\r\nLeft the shell running on ${machine.name}: ${again}\n`);
          return;
        }
        if (outcome.type === 'disconnected') {
          process.stderr.write(
            `\r\nLost the shell on ${machine.name} (${outcome.reason}); it may still run: ${again}\n`
          );
          throw new ShellExit(255);
        }
      } finally {
        link.close();
      }
    });
  });
