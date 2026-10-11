import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { machineShellScope, type TerminalServerEvent } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { setLanSessionCommand, writeLanSessionCommand } from './lan/lan-session-command';
import { endOfInput, shellExitStatus } from './lan/lan-shell';
import { makeTerminalPtyService, type TerminalPtyServiceApi } from './terminal-pty-service';

const silentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  setDebug: () => {},
  child: () => silentLogger(),
  close: async () => {},
});

const MACHINE = 'pty-machine';

/** A machine shell in a real terminal, as `lody-lan lan shell <machine> -- <command>` runs it. */
describe('a machine shell in a real terminal', () => {
  let directory: string;
  let pty: TerminalPtyServiceApi;
  const previousShell = process.env.SHELL;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-pty-'));
    // A plain shell: the login shell of whoever runs the suite may print anything.
    process.env.SHELL = '/bin/sh';
    pty = makeTerminalPtyService({
      logger: silentLogger(),
      resolveSessionWorkdir: async () => directory,
      resolveShellWorkdir: async () => directory,
    });
  });

  afterEach(() => {
    setLanSessionCommand(null);
    pty.closeAll();
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function run(command: string, input?: string) {
    let output = '';
    let resolveExit: (event: Extract<TerminalServerEvent, { type: 'exit' }>) => void = () => {};
    const exited = new Promise<Extract<TerminalServerEvent, { type: 'exit' }>>((resolve) => {
      resolveExit = resolve;
    });
    pty.onEvent((event) => {
      if (event.type === 'data') output += event.data;
      if (event.type === 'exit') resolveExit(event);
    });
    const { terminalId } = await pty.open({
      sessionId: machineShellScope(MACHINE),
      cols: 80,
      rows: 24,
      command,
    });
    if (input !== undefined) {
      if (input) pty.input(terminalId, input);
      pty.input(terminalId, endOfInput(input));
    }
    return { exit: await exited, output: () => output };
  }

  it('ends piped input whose last line has no newline', async () => {
    const { exit, output } = await run('cat', 'hello');

    expect(shellExitStatus(exit)).toBe(0);
    expect(output()).toContain('hello');
  });

  it('ends piped input that ends with a newline, and input that is empty', async () => {
    expect(shellExitStatus((await run('cat', 'one\ntwo\n')).exit)).toBe(0);
    expect(shellExitStatus((await run('cat', '')).exit)).toBe(0);
  });

  it('reports a command a signal ended as 128 plus the signal', async () => {
    const { exit } = await run('kill -TERM $$');

    expect(shellExitStatus(exit)).toBe(143);
    expect(shellExitStatus((await run('exit 3')).exit)).toBe(3);
  });

  it("runs the agent service's own command line as lody-lan", async () => {
    // Stands in for the CLI: says what it was started with.
    const entry = path.join(directory, 'entry.cjs');
    fs.writeFileSync(
      entry,
      'console.log(JSON.stringify([process.argv.slice(2), process.env.LODY_LAN_COMMAND, process.env.ELECTRON_RUN_AS_NODE]))'
    );
    // A profile may replace PATH, so the shell of this test reads none.
    const shell = path.join(directory, 'shell');
    fs.writeFileSync(shell, '#!/bin/sh\nexec /bin/sh -c "$3"\n', { mode: 0o755 });
    process.env.SHELL = shell;
    setLanSessionCommand({
      binDir: writeLanSessionCommand(
        // An embedded service runs as Node only when told to; a terminal's
        // environment does not say so, the command does.
        { execPath: process.execPath, entry, electronRunAsNode: '1' },
        { dataDir: path.join(directory, "it's data") }
      ),
      isLanMember: () => true,
    });

    const { exit, output } = await run('lody-lan lan shell mba -- "uname -a"');

    expect(shellExitStatus(exit)).toBe(0);
    expect(output()).toContain('[["lan","shell","mba","--","uname -a"],"lody-lan","1"]');
  });
});
