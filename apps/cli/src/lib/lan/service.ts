// Keeps a LAN host and its agent service running across logins and reboots as
// systemd user services. Servers are the machines that need this: a desktop
// starts its own agent service.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LanServiceKind = 'hub' | 'agent';

export const LAN_SERVICE_UNITS: Record<LanServiceKind, string> = {
  hub: 'lody-lan-hub.service',
  agent: 'lody-lan-agent.service',
};

/**
 * Exit codes after which starting again cannot help: another agent service
 * owns this machine (3), or the credential or the supervisor contract was
 * rejected (44, 45).
 */
const AGENT_FINAL_EXIT_CODES = [3, 44, 45];

export type CommandResult = { code: number | null; stdout: string; stderr: string };
export type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', (error) => resolve({ code: null, stdout, stderr: String(error) }));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });

/**
 * systemd splits a command line on whitespace, expands `$VARIABLE` and `%`
 * specifiers, and reads `\` as an escape inside quotes.
 */
export function quoteSystemdArgument(value: string): string {
  if (/[\n\r]/.test(value)) {
    throw new Error('A service command cannot contain a line break');
  }
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')
    .replaceAll('$', '$$$$');
  return `"${escaped}"`;
}

export function renderSystemdUnit(options: {
  description: string;
  command: readonly string[];
  environment?: Readonly<Record<string, string>>;
  after?: readonly string[];
  finalExitCodes?: readonly number[];
}): string {
  if (options.command.length === 0) throw new Error('A service needs a command');
  const after = ['network-online.target', ...(options.after ?? [])];
  const lines = [
    '# Written by `lody lan up`; changes are replaced the next time it runs.',
    '[Unit]',
    `Description=${options.description}`,
    `After=${after.join(' ')}`,
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${options.command.map(quoteSystemdArgument).join(' ')}`,
    ...Object.entries(options.environment ?? {}).map(
      ([name, value]) => `Environment=${quoteSystemdArgument(`${name}=${value}`)}`
    ),
    'Restart=on-failure',
    'RestartSec=2',
    ...(options.finalExitCodes?.length
      ? [`RestartPreventExitStatus=${options.finalExitCodes.join(' ')}`]
      : []),
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ];
  return lines.join('\n');
}

export function getSystemdUserUnitDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir()
): string {
  const configHome = env.XDG_CONFIG_HOME?.trim();
  return path.join(configHome ? configHome : path.join(homeDir, '.config'), 'systemd', 'user');
}

export type LanServiceCommand = {
  /** The runtime and entry of this CLI, so the service runs the same build. */
  runtime: string;
  entry: string;
};

export function resolveLanServiceCommand(
  runtime: string = process.execPath,
  entry: string | undefined = process.argv[1]
): LanServiceCommand {
  if (!entry) throw new Error('Cannot locate the CLI entry to run as a service');
  // A package manager's `bin` link may be replaced; the file it points at is
  // what this installation consists of.
  return { runtime, entry: fs.realpathSync(entry) };
}

export function renderLanServiceUnit(
  kind: LanServiceKind,
  options: {
    command: LanServiceCommand;
    searchPath: string;
    /**
     * A data directory chosen for the command that installs the service. The
     * service has to read the settings that command wrote.
     */
    dataDir?: string | null;
    hub?: { host: string; port: number; dataDir: string; publicUrl?: string | null };
  }
): string {
  const environment = {
    PATH: options.searchPath,
    ...(options.dataDir ? { LODY_DATA_DIR: options.dataDir } : {}),
  };
  if (kind === 'agent') {
    return renderSystemdUnit({
      description: 'Lody agent service',
      command: [options.command.runtime, options.command.entry, 'start'],
      environment,
      after: [LAN_SERVICE_UNITS.hub],
      finalExitCodes: AGENT_FINAL_EXIT_CODES,
    });
  }
  if (!options.hub) throw new Error('A LAN host service needs the address it listens on');
  return renderSystemdUnit({
    description: 'Lody LAN host',
    command: [
      options.command.runtime,
      options.command.entry,
      'lan',
      'hub',
      '--host',
      options.hub.host,
      '--port',
      String(options.hub.port),
      '--data-dir',
      options.hub.dataDir,
      ...(options.hub.publicUrl ? ['--public-url', options.hub.publicUrl] : []),
    ],
    environment,
  });
}

export type LanServiceState = {
  unit: string;
  installed: boolean;
  active: boolean;
  /** `active`, `failed`, `inactive`, … as systemd reports it. */
  state: string;
};

export class LanServiceManager {
  private readonly run: CommandRunner;
  private readonly unitDir: string;

  constructor(options: { run?: CommandRunner; unitDir?: string } = {}) {
    this.run = options.run ?? runCommand;
    this.unitDir = options.unitDir ?? getSystemdUserUnitDir();
  }

  /** Whether this session can manage user services at all. */
  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    const result = await this.run('systemctl', ['--user', 'show-environment']);
    return result.code === 0;
  }

  getUnitPath(kind: LanServiceKind): string {
    return path.join(this.unitDir, LAN_SERVICE_UNITS[kind]);
  }

  /** Writes the unit and (re)starts the service with it. */
  async install(kind: LanServiceKind, unit: string): Promise<void> {
    fs.mkdirSync(this.unitDir, { recursive: true });
    fs.writeFileSync(this.getUnitPath(kind), unit);
    await this.systemctl('daemon-reload');
    await this.systemctl('enable', LAN_SERVICE_UNITS[kind]);
    await this.systemctl('restart', LAN_SERVICE_UNITS[kind]);
  }

  async restart(kind: LanServiceKind): Promise<void> {
    await this.systemctl('restart', LAN_SERVICE_UNITS[kind]);
  }

  async remove(kind: LanServiceKind): Promise<boolean> {
    const unitPath = this.getUnitPath(kind);
    if (!fs.existsSync(unitPath)) return false;
    await this.run('systemctl', ['--user', 'disable', '--now', LAN_SERVICE_UNITS[kind]]);
    fs.rmSync(unitPath, { force: true });
    await this.systemctl('daemon-reload');
    return true;
  }

  async getState(kind: LanServiceKind): Promise<LanServiceState> {
    const unit = LAN_SERVICE_UNITS[kind];
    const result = await this.run('systemctl', ['--user', 'is-active', unit]);
    const state = result.stdout.trim() || 'unknown';
    return {
      unit,
      installed: fs.existsSync(this.getUnitPath(kind)),
      active: state === 'active',
      state,
    };
  }

  /**
   * Without lingering the services stop when the user logs out and only start
   * at the next login. Returns whether they now survive both.
   */
  async enableLinger(user: string = os.userInfo().username): Promise<boolean> {
    const current = await this.run('loginctl', ['show-user', user, '--property=Linger']);
    if (current.stdout.trim() === 'Linger=yes') return true;
    const enabled = await this.run('loginctl', ['enable-linger', user]);
    return enabled.code === 0;
  }

  async readRecentLog(kind: LanServiceKind, lines = 20): Promise<string> {
    const result = await this.run('journalctl', [
      '--user',
      '--unit',
      LAN_SERVICE_UNITS[kind],
      '--no-pager',
      '--lines',
      String(lines),
      '--output',
      'cat',
    ]);
    return result.stdout.trim();
  }

  private async systemctl(...args: string[]): Promise<void> {
    const result = await this.run('systemctl', ['--user', ...args]);
    if (result.code !== 0) {
      throw new Error(
        `systemctl --user ${args.join(' ')} failed: ${result.stderr.trim() || `exit ${String(result.code)}`}`
      );
    }
  }
}
