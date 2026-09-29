import { describe, expect, it } from 'vitest';
import {
  formatLanSshDestination,
  isSshConfiguredHost,
  parseLanSshDestination,
  parseSshDestinationText,
  sameLanSshDestination,
  type LanSshDestination,
} from '../src/lan-ssh';

const reached: LanSshDestination = { version: 1, user: 'me', host: '10.0.0.7', port: 22 };

describe('where the SSH server of a LAN member answers', () => {
  it('is read from what the machine published, and nothing more', () => {
    expect(parseLanSshDestination({ ...reached, note: 'kept out' })).toEqual(reached);
    expect(
      parseLanSshDestination({ version: 1, user: 'dev_1.x-y', host: 'Server-1.lan', port: 2222 })
    ).toEqual({ version: 1, user: 'dev_1.x-y', host: 'Server-1.lan', port: 2222 });
  });

  it('is not read from another version or another shape', () => {
    for (const value of [
      undefined,
      null,
      'me@10.0.0.7',
      [reached],
      { ...reached, version: 2 },
      { user: 'me', host: '10.0.0.7', port: 22 },
      { ...reached, port: '22' },
      { ...reached, port: 0 },
      { ...reached, port: 65_536 },
      { ...reached, port: 22.5 },
    ]) {
      expect(parseLanSshDestination(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('is not read when an editor could take a part of it for something else', () => {
    for (const user of ['', '-oProxyCommand=id', '.hidden', 'two words', 'me@there', 'a/b', 'é']) {
      expect(parseLanSshDestination({ ...reached, user }), user).toBeNull();
    }
    for (const host of [
      '',
      '-oProxyCommand=id',
      'server-',
      '.lan',
      'server..lan',
      'server.lan/path',
      'server:22',
      'me@server',
      'two words',
      'fd7a:115c:a1e0::7',
      '[fd7a::7]',
      `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`,
      'a'.repeat(64),
    ]) {
      expect(parseLanSshDestination({ ...reached, host }), host).toBeNull();
    }
  });

  it('keeps what else the machine is called, as far as it can be read', () => {
    expect(
      parseLanSshDestination({
        ...reached,
        names: ['server', '192.168.1.5', 'server', '10.0.0.7', '-oProxyCommand=id', 7, 'fd7a::7'],
      })
    ).toEqual({ ...reached, names: ['server', '192.168.1.5'] });
    expect(parseLanSshDestination({ ...reached, names: 'server' })).toEqual(reached);
    expect(parseLanSshDestination({ ...reached, names: ['10.0.0.7'] })).toEqual(reached);
    expect(
      parseLanSshDestination({
        ...reached,
        names: Array.from({ length: 40 }, (_, index) => `host-${index}`),
      })?.names
    ).toHaveLength(16);
  });

  it('is the same while user, host, port and names are', () => {
    expect(sameLanSshDestination(reached, { ...reached })).toBe(true);
    expect(sameLanSshDestination(null, undefined)).toBe(true);
    expect(sameLanSshDestination(reached, null)).toBe(false);
    expect(sameLanSshDestination(reached, { ...reached, user: 'you' })).toBe(false);
    expect(sameLanSshDestination(reached, { ...reached, host: '10.0.0.8' })).toBe(false);
    expect(sameLanSshDestination(reached, { ...reached, port: 2222 })).toBe(false);

    const named = { ...reached, names: ['server', '192.168.1.5'] };
    expect(sameLanSshDestination(named, { ...reached, names: ['192.168.1.5', 'server'] })).toBe(
      true
    );
    expect(sameLanSshDestination(named, reached)).toBe(false);
    expect(sameLanSshDestination(named, { ...reached, names: ['server'] })).toBe(false);
    expect(sameLanSshDestination(reached, { ...reached, names: [] })).toBe(true);
  });

  it('is written with its port only when SSH would assume another', () => {
    expect(formatLanSshDestination(reached)).toBe('me@10.0.0.7');
    expect(formatLanSshDestination({ ...reached, host: 'server.lan', port: 2222 })).toBe(
      'me@server.lan:2222'
    );
    expect(formatLanSshDestination({ ...reached, names: ['server'] })).toBe('me@10.0.0.7');
  });
});

describe('what an editor is handed to reach a machine', () => {
  it('is a host, with or without the user and the port', () => {
    for (const value of [
      'server',
      'my_server-2.lan',
      '10.0.0.7',
      'me@server',
      'me@10.0.0.7:2222',
      'server:65535',
    ]) {
      expect(parseSshDestinationText(value), value).toBe(value);
    }
  });

  it('is nothing an editor could read as something else', () => {
    for (const value of [
      '',
      ' server',
      'server ',
      '-oProxyCommand=id',
      'me@-server',
      '-me@server',
      'me@',
      '@server',
      'you@me@server',
      'server/path',
      'server:0',
      'server:65536',
      'server:ssh',
      'server?x=1',
      'server#x',
      'fd7a::7',
      'two words',
      `${'a'.repeat(254)}`,
      7,
      null,
      undefined,
    ]) {
      expect(parseSshDestinationText(value), String(value)).toBeNull();
    }
  });

  it('knows the name of an entry from what only looks like one', () => {
    expect(isSshConfiguredHost('my_server-2.lan')).toBe(true);
    expect(isSshConfiguredHost('10.0.0.7')).toBe(true);
    for (const value of ['*', 'dev*', '!server', '-server', 'me@server', 'server:22', '', 7]) {
      expect(isSshConfiguredHost(value), String(value)).toBe(false);
    }
  });
});
