import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LAN_SERVICE_UNITS,
  LanServiceManager,
  getSystemdUserUnitDir,
  quoteSystemdArgument,
  renderLanServiceUnit,
  type CommandResult,
} from './service';

const command = { runtime: '/usr/bin/node', entry: '/opt/lody/dist/index.js' };

describe('service units', () => {
  it('runs the agent service with the build that installed it', () => {
    expect(renderLanServiceUnit('agent', { command, searchPath: '/usr/bin:/bin' })).toBe(
      [
        '# Written by `lody lan up`; changes are replaced the next time it runs.',
        '[Unit]',
        'Description=Lody agent service',
        'After=network-online.target lody-lan-hub.service',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        'ExecStart="/usr/bin/node" "/opt/lody/dist/index.js" "start"',
        'Environment="PATH=/usr/bin:/bin"',
        'Restart=on-failure',
        'RestartSec=2',
        'RestartPreventExitStatus=3 44 45',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n')
    );
  });

  it('hosts the LAN on the requested address and data directory', () => {
    const unit = renderLanServiceUnit('hub', {
      command,
      searchPath: '/usr/bin',
      hub: {
        host: '100.64.0.1',
        port: 8788,
        dataDir: '/home/me/.lody-lan-hub',
        publicUrl: 'https://hub.example.com',
      },
    });
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/opt/lody/dist/index.js" "lan" "hub" "--host" "100.64.0.1" ' +
        '"--port" "8788" "--data-dir" "/home/me/.lody-lan-hub" "--public-url" "https://hub.example.com"'
    );
    // A host that stops has nothing to gain from staying down.
    expect(unit).not.toContain('RestartPreventExitStatus');
    expect(() => renderLanServiceUnit('hub', { command, searchPath: '' })).toThrow(
      /needs the address/
    );
  });

  it('gives a service the data directory of the command that installed it', () => {
    const unit = renderLanServiceUnit('agent', {
      command,
      searchPath: '/usr/bin',
      dataDir: '/srv/lody data',
    });
    expect(unit).toContain('Environment="LODY_DATA_DIR=/srv/lody data"');
  });

  it('keeps systemd from reinterpreting a path', () => {
    expect(quoteSystemdArgument('/home/me/my apps/node')).toBe('"/home/me/my apps/node"');
    expect(quoteSystemdArgument('100%$HOME"\\')).toBe('"100%%$$HOME\\"\\\\"');
    expect(() => quoteSystemdArgument('a\nb')).toThrow(/line break/);
  });

  it('follows the configuration directory of the user', () => {
    expect(getSystemdUserUnitDir({}, '/home/me')).toBe('/home/me/.config/systemd/user');
    expect(getSystemdUserUnitDir({ XDG_CONFIG_HOME: '/cfg' }, '/home/me')).toBe(
      '/cfg/systemd/user'
    );
  });
});

describe('LanServiceManager', () => {
  let unitDir: string;
  let calls: string[];
  let answers: Map<string, CommandResult>;

  const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
  const manager = () =>
    new LanServiceManager({
      unitDir,
      run: async (program, args) => {
        const line = [program, ...args].join(' ');
        calls.push(line);
        return answers.get(line) ?? ok();
      },
    });

  beforeEach(() => {
    unitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-service-'));
    calls = [];
    answers = new Map();
  });

  afterEach(() => {
    fs.rmSync(unitDir, { recursive: true, force: true });
  });

  it('writes the unit, then enables and restarts the service with it', async () => {
    await manager().install('hub', 'unit-content');

    expect(fs.readFileSync(path.join(unitDir, LAN_SERVICE_UNITS.hub), 'utf8')).toBe('unit-content');
    expect(calls).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable lody-lan-hub.service',
      'systemctl --user restart lody-lan-hub.service',
    ]);
  });

  it('reports why a service could not be started', async () => {
    answers.set('systemctl --user restart lody-lan-agent.service', {
      code: 1,
      stdout: '',
      stderr: 'Job failed.\n',
    });
    await expect(manager().install('agent', 'unit-content')).rejects.toThrow(
      'systemctl --user restart lody-lan-agent.service failed: Job failed.'
    );
  });

  it('tells a running service from a failed and from a missing one', async () => {
    const services = manager();
    expect(await services.getState('hub')).toEqual({
      unit: 'lody-lan-hub.service',
      installed: false,
      active: false,
      state: 'unknown',
    });

    fs.writeFileSync(path.join(unitDir, LAN_SERVICE_UNITS.hub), 'unit-content');
    answers.set('systemctl --user is-active lody-lan-hub.service', ok('active\n'));
    expect(await services.getState('hub')).toMatchObject({ installed: true, active: true });

    answers.set('systemctl --user is-active lody-lan-hub.service', {
      code: 3,
      stdout: 'failed\n',
      stderr: '',
    });
    expect(await services.getState('hub')).toMatchObject({
      installed: true,
      active: false,
      state: 'failed',
    });
  });

  it('tells the process the service manager starts again from one a service started', async () => {
    const mainPid = 'systemctl --user show lody-lan-agent.service --property=MainPID --value';
    const services = manager();
    const onLinux = process.platform === 'linux';

    answers.set(mainPid, ok('4321\n'));
    expect(await services.isProcess('agent', 4321)).toBe(onLinux);
    expect(await services.isProcess('agent', 4322)).toBe(false);

    // A unit that does not run has no main process.
    answers.set(mainPid, ok('0\n'));
    expect(await services.isProcess('agent', 4321)).toBe(false);
    answers.set(mainPid, { code: 1, stdout: '', stderr: 'Failed to connect to bus' });
    expect(await services.isProcess('agent', 4321)).toBe(false);
  });

  it('starts a running service again and leaves a stopped one stopped', async () => {
    await manager().restartIfActive('hub');
    expect(calls).toEqual(['systemctl --user try-restart lody-lan-hub.service']);
  });

  it('removes a service and leaves one that was never installed alone', async () => {
    const services = manager();
    expect(await services.remove('agent')).toBe(false);
    expect(calls).toEqual([]);

    fs.writeFileSync(path.join(unitDir, LAN_SERVICE_UNITS.agent), 'unit-content');
    expect(await services.remove('agent')).toBe(true);
    expect(fs.existsSync(path.join(unitDir, LAN_SERVICE_UNITS.agent))).toBe(false);
    expect(calls).toEqual([
      'systemctl --user disable --now lody-lan-agent.service',
      'systemctl --user daemon-reload',
    ]);
  });

  it('only asks for lingering when the user does not have it', async () => {
    answers.set('loginctl show-user me --property=Linger', ok('Linger=yes\n'));
    expect(await manager().enableLinger('me')).toBe(true);
    expect(calls).toEqual(['loginctl show-user me --property=Linger']);

    calls = [];
    answers.set('loginctl show-user me --property=Linger', ok('Linger=no\n'));
    answers.set('loginctl enable-linger me', { code: 1, stdout: '', stderr: 'denied' });
    expect(await manager().enableLinger('me')).toBe(false);
    expect(calls).toEqual(['loginctl show-user me --property=Linger', 'loginctl enable-linger me']);
  });
});
