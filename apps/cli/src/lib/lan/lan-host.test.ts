import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseLanInvite } from '@lody/shared/lan-hub';
import {
  addLanHub,
  deriveLanHubId,
  type LanHub,
  probeLanHub,
  readLanHubSettings,
  writeLanHubSettings,
} from '@lody/shared/node/lan-hub';
import { askWhereLanHubIs } from './hub-handover';
import {
  readLanHubToken,
  startLanHubServer,
  type LanHubServer,
  type LanHubUpstream,
} from './hub-server';
import { hostLan, pickLanHostAddress, takeOverLan, type HostLanDependencies } from './lan-host';
import { LanServiceManager, type CommandResult } from './service';

const address = (value: string, internal = false) => ({
  address: value,
  netmask: '255.255.255.0',
  family: 'IPv4' as const,
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${value}/24`,
});

describe('pickLanHostAddress', () => {
  it('prefers an overlay network over the local segment', () => {
    expect(
      pickLanHostAddress({
        lo: [address('127.0.0.1', true)],
        eth0: [address('192.168.1.5')],
        tailscale0: [address('100.92.194.31')],
      })
    ).toBe('100.92.194.31');
  });

  it('uses the local segment when there is no overlay network', () => {
    expect(pickLanHostAddress({ eth0: [address('203.0.113.7'), address('10.1.2.3')] })).toBe(
      '10.1.2.3'
    );
    expect(pickLanHostAddress({ eth0: [address('172.31.0.9')] })).toBe('172.31.0.9');
  });

  it('never picks a public or a loopback address', () => {
    expect(
      pickLanHostAddress({
        lo: [address('127.0.0.1', true)],
        eth0: [address('203.0.113.7'), address('172.32.0.1'), address('100.128.0.1')],
      })
    ).toBeNull();
    expect(pickLanHostAddress({})).toBeNull();
  });
});

describe('probeLanHub', () => {
  const hub = { url: 'http://10.0.0.1:8788', token: 'secret', id: deriveLanHubId('secret') };
  const answering = (status: number) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`http://10.0.0.1:8788/ds/lody/lw_${hub.id}%3Ameta`);
      expect(init?.method).toBe('HEAD');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
      return new Response(null, { status });
    }) as typeof fetch;

  it('counts any answer of the hub as reachable, a missing workspace included', async () => {
    expect(await probeLanHub(hub, { fetch: answering(200) })).toBe('reachable');
    expect(await probeLanHub(hub, { fetch: answering(404) })).toBe('reachable');
  });

  it('tells a rejected credential from a hub that is down', async () => {
    expect(await probeLanHub(hub, { fetch: answering(401) })).toBe('unauthorized');
    expect(await probeLanHub(hub, { fetch: answering(502) })).toBe('unreachable');
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await probeLanHub(hub, { fetch: failing })).toBe('unreachable');
  });
});

describe('hostLan', () => {
  const TOKEN = 'host-token-0123456789';
  let directory: string;
  let calls: string[];
  let agentState: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-host-'));
    calls = [];
    agentState = 'active';
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const settings = () => ({ env: {}, filePath: path.join(directory, 'lan-hub.json') });
  const unit = (name: string) => fs.readFileSync(path.join(directory, 'units', name), 'utf8');

  const dependencies = (overrides: Partial<HostLanDependencies> = {}): HostLanDependencies => ({
    services: new LanServiceManager({
      unitDir: path.join(directory, 'units'),
      run: async (program, args): Promise<CommandResult> => {
        const line = [program, ...args].join(' ');
        calls.push(line);
        if (line === 'systemctl --user is-active lody-lan-agent.service') {
          return { code: agentState === 'active' ? 0 : 3, stdout: `${agentState}\n`, stderr: '' };
        }
        if (line.startsWith('journalctl')) {
          return {
            code: 0,
            stdout: 'Cannot start: another agent service is running\n',
            stderr: '',
          };
        }
        if (line.startsWith('loginctl show-user')) {
          return { code: 0, stdout: 'Linger=yes\n', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    }),
    command: { runtime: '/usr/bin/node', entry: '/opt/lody/dist/index.js' },
    searchPath: '/usr/bin',
    settings: settings(),
    waitFor: async (condition, description) => {
      if (!(await condition())) throw new Error(`Timed out waiting for ${description}`);
    },
    probe: async () => 'reachable',
    readToken: () => TOKEN,
    ...overrides,
  });

  const options = {
    name: 'Home',
    host: '100.64.0.1',
    port: 8788,
    dataDir: '/home/me/.lody-lan-hub',
    withAgent: true,
  };

  it('hosts a LAN, joins it and starts the agent service', async () => {
    const result = await hostLan(options, dependencies());

    expect(result).toMatchObject({ created: true, agent: 'started', lingering: true });
    expect(result.hub).toEqual({
      id: deriveLanHubId(TOKEN),
      name: 'Home',
      url: 'http://100.64.0.1:8788',
      token: TOKEN,
    });
    expect(parseLanInvite(result.invite)).toEqual({
      url: 'http://100.64.0.1:8788',
      token: TOKEN,
      name: 'Home',
    });
    expect(readLanHubSettings(settings()).hubs).toEqual([result.hub]);
    expect(unit('lody-lan-hub.service')).toContain('"--host" "100.64.0.1" "--port" "8788"');
    expect(unit('lody-lan-agent.service')).toContain('"/opt/lody/dist/index.js" "start"');
    // The agent service starts after the settings name the LAN it joins.
    expect(calls.indexOf('systemctl --user restart lody-lan-hub.service')).toBeLessThan(
      calls.indexOf('systemctl --user restart lody-lan-agent.service')
    );
  });

  it('invites other machines to the address they can reach', async () => {
    const result = await hostLan(
      { ...options, host: '0.0.0.0', publicUrl: 'https://hub.example.com' },
      dependencies()
    );
    expect(result.hub.url).toBe('https://hub.example.com');
    expect(result.invite).toBe(`lody-lans://${TOKEN}@hub.example.com/Home`);
  });

  it('keeps the other LANs and the name of the machine', async () => {
    writeLanHubSettings(
      {
        hubs: [
          {
            id: deriveLanHubId('office'),
            name: 'Office',
            url: 'http://10.0.1.1:8788',
            token: 'office',
          },
        ],
        machineName: 'devnuc',
      },
      settings()
    );

    await hostLan(options, dependencies());

    const stored = readLanHubSettings(settings());
    expect(stored.machineName).toBe('devnuc');
    expect(stored.hubs.map((hub) => hub.name)).toEqual(['Office', 'Home']);
  });

  it('can be run again without joining the LAN twice', async () => {
    await hostLan(options, dependencies());
    const again = await hostLan({ ...options, name: null }, dependencies());
    expect(again.created).toBe(false);
    expect(readLanHubSettings(settings()).hubs).toHaveLength(1);
  });

  it('hosts without an agent service when asked to', async () => {
    const result = await hostLan({ ...options, withAgent: false }, dependencies());
    expect(result.agent).toBe('skipped');
    expect(fs.existsSync(path.join(directory, 'units', 'lody-lan-agent.service'))).toBe(false);
  });

  it('reports why the agent service did not start and still joins the LAN', async () => {
    agentState = 'failed';
    const result = await hostLan(options, dependencies());
    expect(result.agent).toBe('failed');
    expect(result.agentLog).toBe('Cannot start: another agent service is running');
    expect(readLanHubSettings(settings()).hubs).toHaveLength(1);
  });

  it('joins nothing when the host never becomes reachable', async () => {
    await expect(
      hostLan(options, dependencies({ probe: async () => 'unreachable' }))
    ).rejects.toThrow('Timed out waiting for lody-lan-hub.service to accept connections');
    expect(readLanHubSettings(settings()).hubs).toEqual([]);
  });

  it('starts no service when the LANs of this machine cannot be edited', async () => {
    await expect(
      hostLan(
        options,
        dependencies({
          settings: {
            env: { LODY_LAN_HUB_URL: 'http://10.0.0.9:8788', LODY_LAN_HUB_TOKEN: 'fixed' },
            filePath: settings().filePath,
          },
        })
      )
    ).rejects.toThrow(/set by the environment/);
    expect(calls).toEqual([]);
  });
  describe('taking over the host of a LAN', () => {
    let formerDir: string;
    let former: LanHubServer;
    let upstreams: number;
    let member: LanHub;
    const closing: Array<() => Promise<void>> = [];

    /** The Streams server of the former host, which has no authentication of its own. */
    const startStreams = async (): Promise<LanHubUpstream> => {
      upstreams += 1;
      const server = http.createServer((request, response) => {
        response.writeHead(request.method === 'PUT' ? 201 : 200).end('served');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      let stopped: (code: number | null) => void = () => {};
      const exited = new Promise<number | null>((resolve) => (stopped = resolve));
      return {
        port: (server.address() as AddressInfo).port,
        exited,
        stop: () => {
          server.closeAllConnections();
          server.close(() => stopped(0));
        },
      };
    };

    beforeEach(async () => {
      upstreams = 0;
      formerDir = path.join(directory, 'former');
      fs.mkdirSync(formerDir);
      fs.writeFileSync(path.join(formerDir, 'streams.sqlite'), 'the streams of the LAN');
      former = await startLanHubServer({
        host: '127.0.0.1',
        port: 0,
        dataDir: formerDir,
        startUpstream: startStreams,
      });
      closing.push(() => former.close());
      member = addLanHub([], { url: former.url, token: former.token, name: 'Home' }).hub;
      writeLanHubSettings({ hubs: [member], machineName: null }, settings());
    });

    afterEach(async () => {
      for (const close of closing.splice(0)) await close();
    });

    const target = () => ({
      hub: member,
      host: '100.64.0.9',
      port: 8788,
      dataDir: path.join(directory, 'hosted'),
    });
    const servedByFormer = async () =>
      (
        await fetch(`${former.url}/ds/lody/room`, {
          headers: { Authorization: `Bearer ${former.token}` },
        })
      ).status;

    it('hosts the data of the former host here and has its members pointed here', async () => {
      const result = await takeOverLan(target(), dependencies({ readToken: readLanHubToken }));

      expect(result.files.sort()).toEqual(['streams.sqlite', 'token']);
      expect(fs.readFileSync(path.join(target().dataDir, 'streams.sqlite'), 'utf8')).toBe(
        'the streams of the LAN'
      );
      expect(unit('lody-lan-hub.service')).toContain('"--host" "100.64.0.9" "--port" "8788"');
      expect(readLanHubSettings(settings()).hubs).toEqual([
        { ...member, url: 'http://100.64.0.9:8788' },
      ]);
      expect(await askWhereLanHubIs(member)).toBe('http://100.64.0.9:8788');
      expect(await servedByFormer()).toBe(410);
    });

    it('leaves the LAN with the former host when the new one never answers', async () => {
      await expect(
        takeOverLan(
          target(),
          dependencies({ readToken: readLanHubToken, probe: async () => 'unreachable' })
        )
      ).rejects.toThrow(/to accept connections/);

      expect(fs.existsSync(path.join(directory, 'units', 'lody-lan-hub.service'))).toBe(false);
      expect(readLanHubSettings(settings()).hubs).toEqual([member]);
      expect(await askWhereLanHubIs(member)).toBeNull();
      expect(await servedByFormer()).toBe(200);
      expect(upstreams).toBe(2);
    });

    it('asks nothing of the former host when this machine keeps another LAN there', async () => {
      await expect(
        takeOverLan(target(), dependencies({ readToken: () => 'another-credential' }))
      ).rejects.toThrow(/holds another LAN/);
      expect(await servedByFormer()).toBe(200);
      expect(upstreams).toBe(1);
    });
  });
});
