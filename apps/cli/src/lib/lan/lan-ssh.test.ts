import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { addLanHub, type LanHub } from '@lody/shared/node/lan-hub';
import type { Logger } from '@/utils/logger';
import {
  createLanSshDescriber,
  describeLanSsh,
  probeSshServer,
  resolveLanSshSetting,
  type LanSshProbes,
} from './lan-ssh';

const HUB_URL = 'http://10.0.0.1:8788';
const home: LanHub = addLanHub([], {
  name: 'Home',
  url: HUB_URL,
  token: 'home-token-0123456789',
}).hub;

/** Probes that answer what a test says, and remember what they were asked. */
function createProbes(answers: {
  address?: string | null;
  server?: boolean;
  user?: string | null;
  names?: string[];
}) {
  const asked: string[] = [];
  const probes: LanSshProbes = {
    address: async (hubUrl) => {
      asked.push(`address ${hubUrl}`);
      return answers.address ?? null;
    },
    server: async (host, port) => {
      asked.push(`server ${host}:${port}`);
      return answers.server ?? false;
    },
    user: () => (answers.user === undefined ? 'me' : answers.user),
    names: () => answers.names ?? [],
  };
  return { probes, asked };
}

function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger: Logger = {
    info: (message: string) => void lines.push(`info ${message}`),
    warn: (message: string) => void lines.push(`warn ${message}`),
    error: () => {},
    success: () => {},
    debug: () => {},
    trace: () => {},
    setLevel: () => {},
    setDebug: () => {},
    child: () => logger,
    close: async () => {},
  };
  return { logger, lines };
}

describe('LODY_LAN_SSH', () => {
  it('asks the machine unless it is told something', () => {
    expect(resolveLanSshSetting({})).toEqual({ kind: 'probe' });
    expect(resolveLanSshSetting({ LODY_LAN_SSH: '  ' })).toEqual({ kind: 'probe' });
    expect(resolveLanSshSetting({ LODY_LAN_SSH: 'OFF' })).toEqual({ kind: 'off' });
  });

  it('reads a destination with or without its user and port', () => {
    expect(resolveLanSshSetting({ LODY_LAN_SSH: 'me@server.lan:2222' })).toEqual({
      kind: 'fixed',
      user: 'me',
      host: 'server.lan',
      port: 2222,
    });
    expect(resolveLanSshSetting({ LODY_LAN_SSH: ' 100.64.0.7 ' })).toEqual({
      kind: 'fixed',
      user: null,
      host: '100.64.0.7',
      port: 22,
    });
  });

  it('refuses what an editor could not be handed', () => {
    for (const value of [
      '-oProxyCommand=id',
      'me@-server',
      'me@',
      '@server',
      'me@server:0',
      'me@server:70000',
      'me@server:ssh',
      'two words',
      'me@fd7a:115c:a1e0::7',
      'me@server/path',
    ]) {
      expect(() => resolveLanSshSetting({ LODY_LAN_SSH: value }), value).toThrow(/LODY_LAN_SSH/u);
    }
  });
});

describe('where the SSH server of a machine answers the members of a LAN', () => {
  it('is the address the machine has toward the hub, as the user of the agent service', async () => {
    const { probes, asked } = createProbes({ address: '10.0.0.7', server: true });

    expect(await describeLanSsh({ hubUrl: HUB_URL, setting: { kind: 'probe' }, probes })).toEqual({
      version: 1,
      user: 'me',
      host: '10.0.0.7',
      port: 22,
    });
    expect(asked).toEqual([`address ${HUB_URL}`, 'server 10.0.0.7:22']);
  });

  it('comes with what else the machine is called, to be found by', async () => {
    const { probes } = createProbes({
      address: '10.0.0.7',
      server: true,
      names: ['server', '192.168.1.5', '10.0.0.7', 'server', 'fe80::1', 'not a name'],
    });

    expect(await describeLanSsh({ hubUrl: HUB_URL, setting: { kind: 'probe' }, probes })).toEqual({
      version: 1,
      user: 'me',
      host: '10.0.0.7',
      port: 22,
      names: ['server', '192.168.1.5'],
    });
  });

  it('is nowhere on a machine no SSH server answers on', async () => {
    const { probes } = createProbes({ address: '10.0.0.7', server: false });
    expect(
      await describeLanSsh({ hubUrl: HUB_URL, setting: { kind: 'probe' }, probes })
    ).toBeNull();
  });

  it('cannot be told while the hub does not answer', async () => {
    const { probes, asked } = createProbes({ address: null, server: true });

    expect(
      await describeLanSsh({ hubUrl: HUB_URL, setting: { kind: 'probe' }, probes })
    ).toBeUndefined();
    expect(asked).toEqual([`address ${HUB_URL}`]);
  });

  it('is nowhere for an address only this machine reaches or no editor spells', async () => {
    for (const address of ['127.0.0.1', '::1', 'fd7a:115c:a1e0::7']) {
      const { probes } = createProbes({ address, server: true });
      expect(
        await describeLanSsh({ hubUrl: HUB_URL, setting: { kind: 'probe' }, probes }),
        address
      ).toBeNull();
    }
  });

  it('is nowhere for a user an editor could take for something else', async () => {
    for (const user of ['-oProxyCommand=id', 'two words', '', null]) {
      const { probes } = createProbes({ address: '10.0.0.7', server: true, user });
      expect(
        await describeLanSsh({ hubUrl: HUB_URL, setting: { kind: 'probe' }, probes }),
        String(user)
      ).toBeNull();
    }
  });

  it('is what the machine was told, without asking', async () => {
    const { probes, asked } = createProbes({
      address: '10.0.0.7',
      server: false,
      names: ['server'],
    });
    const fixed = { kind: 'fixed', host: 'server.lan', port: 2222 } as const;

    expect(
      await describeLanSsh({ hubUrl: HUB_URL, setting: { ...fixed, user: 'admin' }, probes })
    ).toEqual({ version: 1, user: 'admin', host: 'server.lan', port: 2222 });
    expect(
      await describeLanSsh({ hubUrl: HUB_URL, setting: { ...fixed, user: null }, probes })
    ).toEqual({ version: 1, user: 'me', host: 'server.lan', port: 2222 });
    expect(await describeLanSsh({ hubUrl: HUB_URL, setting: { kind: 'off' }, probes })).toBeNull();
    expect(asked).toEqual([]);
  });

  it('is logged when it changes, not every time it is told', async () => {
    const { logger, lines } = recordingLogger();
    const answers = { address: '10.0.0.7' as string | null, server: true };
    const say = createLanSshDescriber({
      logger,
      env: {},
      probes: {
        address: async () => answers.address,
        server: async () => answers.server,
        user: () => 'me',
        names: () => ['server'],
      },
    });

    expect(await say(home)).toMatchObject({ user: 'me', host: '10.0.0.7' });
    await say(home);
    answers.address = null;
    expect(await say(home)).toBeUndefined();
    answers.address = '10.0.0.7';
    answers.server = false;
    expect(await say(home)).toBeNull();
    await say(home);

    expect(lines).toEqual([
      'info [lan-ssh] Editors of the members of Home open folders of this machine as me@10.0.0.7',
      'info [lan-ssh] No SSH server of this machine is named to the members of Home',
    ]);
  });

  it('says nothing when it was told something it cannot read', async () => {
    const { logger, lines } = recordingLogger();
    const { probes, asked } = createProbes({ address: '10.0.0.7', server: true });
    const say = createLanSshDescriber({
      logger,
      env: { LODY_LAN_SSH: 'me@server:ssh' },
      probes,
    });

    expect(await say(home)).toBeNull();
    expect(asked).toEqual([]);
    expect(lines[0]).toBe(
      'warn [lan-ssh] LODY_LAN_SSH must be [user@]host[:port] or "off", not "me@server:ssh"'
    );
  });
});

describe('whether an SSH server answers', () => {
  const servers: net.Server[] = [];

  /** A server on this machine that says `greeting` to whoever connects, then hangs up. */
  const listen = async (greeting: string): Promise<number> => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end(greeting);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('the server has no port');
    return address.port;
  };

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
    );
  });

  it('takes the version an SSH server starts with for an answer', async () => {
    expect(await probeSshServer('127.0.0.1', await listen('SSH-2.0-OpenSSH_9.6\r\n'))).toBe(true);
    expect(
      await probeSshServer('127.0.0.1', await listen('Be welcome.\r\nSSH-2.0-OpenSSH_9.6\r\n'))
    ).toBe(true);
  });

  it('takes nothing else for one', async () => {
    expect(await probeSshServer('127.0.0.1', await listen('HTTP/1.1 400 Bad Request\r\n'))).toBe(
      false
    );
    expect(await probeSshServer('127.0.0.1', await listen('NOSSH-2.0\r\n'))).toBe(false);

    const port = await listen('');
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
    );
    expect(await probeSshServer('127.0.0.1', port)).toBe(false);
  });
});
