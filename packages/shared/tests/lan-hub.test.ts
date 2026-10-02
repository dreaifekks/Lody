import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LAN_HUB_DEFAULT_NAME,
  LanHubInputError,
  formatLanInvite,
  getLanHubRendererOrigin,
  normalizeLanHubUrl,
  normalizeMachineName,
  parseLanInvite,
  resolveLanHubSlug,
} from '../src/lan-hub';
import {
  addLanHub,
  classifyLanHubChange,
  deriveLanHubId,
  deriveLanHubUserId,
  findLanHub,
  measureLanHubLatency,
  readLanHubSettings,
  removeLanHub,
  resolveMachineName,
  summarizeLanHubs,
  updateLanHub,
  watchLanHubSettings,
  writeLanHubSettings,
  type LanHub,
} from '../src/node/lan-hub';

const HOME_TOKEN = 'home-token-0123456789';
const OFFICE_TOKEN = 'office-token-0123456789';
const EXAMPLE_USER_ID = 'local:eb246c243a7924a5b45831f136c5d740';

let directory: string;
let filePath: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-hub-'));
  filePath = path.join(directory, 'lan-hub.json');
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(directory, { recursive: true, force: true });
});

function join(hubs: readonly LanHub[], name: string, url: string, token: string): LanHub[] {
  return addLanHub(hubs, { name, url, token }).hubs;
}

function read() {
  return readLanHubSettings({ env: {}, filePath });
}

describe('LAN identity', () => {
  it('names a workspace by the credential alone', () => {
    const id = deriveLanHubId(HOME_TOKEN);
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(deriveLanHubId(HOME_TOKEN)).toBe(id);
    expect(deriveLanHubId(OFFICE_TOKEN)).not.toBe(id);
    expect(getLanHubRendererOrigin(id)).toBe(`lody-hub://${id}`);
  });

  it('keeps the workspace of a LAN that was joined before LANs could be listed', () => {
    // Pinned to the value the first format produced: a changed derivation
    // would strand every session already stored in that LAN.
    expect(deriveLanHubId('example')).toBe('d0a7eafae3e58819efdd620bcf9ca111');
    fs.writeFileSync(filePath, JSON.stringify({ url: 'http://10.0.0.1:8788/', token: HOME_TOKEN }));
    expect(read()).toEqual({
      hubs: [
        {
          id: deriveLanHubId(HOME_TOKEN),
          name: LAN_HUB_DEFAULT_NAME,
          url: 'http://10.0.0.1:8788',
          token: HOME_TOKEN,
        },
      ],
      machineName: null,
      source: 'file',
    });
    expect(summarizeLanHubs(read().hubs)[0]).toMatchObject({
      slug: 'lan',
      workspaceId: `lw_${deriveLanHubId(HOME_TOKEN)}`,
    });
  });

  it('refuses to address something that is not a LAN', () => {
    expect(() => getLanHubRendererOrigin('hub')).toThrow(LanHubInputError);
    expect(() => getLanHubRendererOrigin(`${deriveLanHubId(HOME_TOKEN)}/../x`)).toThrow(
      LanHubInputError
    );
  });

  it('gives the members of a LAN one user, and another LAN another', () => {
    // Pinned like the workspace: builds that joined a LAN before LANs could
    // be listed derive this user, and have to keep meeting newer ones.
    expect(deriveLanHubUserId('example')).toBe(EXAMPLE_USER_ID);
    expect(deriveLanHubUserId(HOME_TOKEN)).toBe(deriveLanHubUserId(HOME_TOKEN));
    expect(deriveLanHubUserId(HOME_TOKEN)).not.toBe(deriveLanHubUserId(OFFICE_TOKEN));
    expect(summarizeLanHubs(join([], 'Home', 'http://10.0.0.1:8788', HOME_TOKEN))[0]?.userId).toBe(
      deriveLanHubUserId(HOME_TOKEN)
    );
  });
});

describe('LAN settings file', () => {
  it('is absent on a local-only installation', () => {
    expect(read()).toEqual({ hubs: [], machineName: null, source: 'none' });
  });

  it('round-trips several LANs and the machine name', () => {
    let hubs = join([], 'Home', '100.64.0.1:8788', HOME_TOKEN);
    hubs = join(hubs, 'Office', 'https://hub.example.com', OFFICE_TOKEN);
    writeLanHubSettings({ hubs, machineName: 'devnuc' }, { env: {}, filePath });

    expect(read()).toEqual({ hubs, machineName: 'devnuc', source: 'file' });
    expect(hubs.map((hub) => hub.url)).toEqual([
      'http://100.64.0.1:8788',
      'https://hub.example.com',
    ]);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(directory)).toEqual(['lan-hub.json']);
    // The id is derived on every read, so a hand-edited file cannot disagree.
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).hubs[0]).toEqual({
      name: 'Home',
      url: 'http://100.64.0.1:8788',
      token: HOME_TOKEN,
    });
  });

  it('refuses a malformed file instead of falling back to local-only', () => {
    fs.writeFileSync(filePath, '{');
    expect(() => read()).toThrow(/not valid JSON/);
    fs.writeFileSync(filePath, JSON.stringify({ version: 3, hubs: [] }));
    expect(() => read()).toThrow(/unsupported version 3/);
    fs.writeFileSync(filePath, JSON.stringify({ version: 2, hubs: [{ url: 'http://a' }] }));
    expect(() => read()).toThrow(/requires both url and token/);
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 2,
        hubs: [
          { name: 'A', url: 'http://a', token: HOME_TOKEN },
          { name: 'B', url: 'http://b', token: HOME_TOKEN },
        ],
      })
    );
    expect(() => read()).toThrow(/lists the same LAN twice/);
  });

  it('never repeats the credential in an error', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 2, hubs: [{ url: 'ftp://a', token: HOME_TOKEN }] })
    );
    let message = '';
    try {
      read();
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/must use http or https/);
    expect(message).not.toContain(HOME_TOKEN);
  });

  it('lets the environment describe one LAN and then refuses edits', () => {
    const env = { LODY_LAN_HUB_URL: 'http://10.0.0.9:8788', LODY_LAN_HUB_TOKEN: HOME_TOKEN };
    fs.writeFileSync(
      filePath,
      JSON.stringify({ url: 'http://10.0.0.1:8788', token: OFFICE_TOKEN })
    );
    expect(readLanHubSettings({ env, filePath })).toMatchObject({
      hubs: [{ url: 'http://10.0.0.9:8788', token: HOME_TOKEN }],
      source: 'environment',
    });
    expect(() => writeLanHubSettings({ hubs: [], machineName: null }, { env, filePath })).toThrow(
      /LODY_LAN_HUB_URL/
    );
    expect(() =>
      readLanHubSettings({ env: { LODY_LAN_HUB_URL: 'http://10.0.0.9:8788' }, filePath })
    ).toThrow(/requires both url and token/);
  });
});

describe('editing LANs', () => {
  it('joins a second LAN without touching the first', () => {
    const first = addLanHub([], { url: 'http://10.0.0.1:8788', token: HOME_TOKEN });
    expect(first.created).toBe(true);
    expect(first.hub.name).toBe(LAN_HUB_DEFAULT_NAME);
    const second = addLanHub(first.hubs, { url: 'http://10.0.1.1:8788', token: OFFICE_TOKEN });
    expect(second.hub.name).toBe(`${LAN_HUB_DEFAULT_NAME} 2`);
    expect(second.hubs).toEqual([first.hub, second.hub]);
  });

  it('updates the address when the same LAN is joined again', () => {
    const hubs = join([], 'Home', 'http://192.168.1.5:8788', HOME_TOKEN);
    const again = addLanHub(hubs, { url: 'http://100.64.0.1:8788', token: HOME_TOKEN });
    expect(again.created).toBe(false);
    expect(again.hubs).toEqual([{ ...hubs[0], url: 'http://100.64.0.1:8788' }]);
  });

  it('renames and moves a LAN while it keeps its workspace', () => {
    const hubs = join([], 'Home', 'http://192.168.1.5:8788', HOME_TOKEN);
    const { hub } = updateLanHub(hubs, 'home', { name: 'Flat', url: '100.64.0.1:9000' });
    expect(hub).toEqual({
      id: hubs[0]!.id,
      name: 'Flat',
      url: 'http://100.64.0.1:9000',
      token: HOME_TOKEN,
    });
  });

  it('refuses two LANs with one name', () => {
    let hubs = join([], 'Home', 'http://10.0.0.1:8788', HOME_TOKEN);
    expect(() => join(hubs, 'home', 'http://10.0.1.1:8788', OFFICE_TOKEN)).toThrow(
      /already called home/
    );
    hubs = join(hubs, 'Office', 'http://10.0.1.1:8788', OFFICE_TOKEN);
    expect(() => updateLanHub(hubs, 'Office', { name: 'HOME' })).toThrow(LanHubInputError);
    // A LAN may keep its own name.
    expect(updateLanHub(hubs, 'Office', { name: 'office' }).hub.name).toBe('office');
  });

  it('finds a LAN by name, slug, id and workspace', () => {
    let hubs = join([], 'Home', 'http://10.0.0.1:8788', HOME_TOKEN);
    hubs = join(hubs, 'Office', 'http://10.0.1.1:8788', OFFICE_TOKEN);
    const office = hubs[1]!;
    for (const selector of [
      'Office',
      'office',
      office.id,
      office.id.slice(0, 8),
      `lw_${office.id}`,
    ]) {
      expect(findLanHub(hubs, selector), selector).toBe(office);
    }
    expect(findLanHub(hubs, 'lan-home')).toBe(hubs[0]);
    expect(findLanHub(hubs, '')).toBeNull();
    expect(findLanHub(hubs, office.id.slice(0, 3))).toBeNull();
    expect(() => removeLanHub(hubs, 'Garage')).toThrow(/No LAN matches "Garage"/);
    expect(removeLanHub(hubs, 'Home').hubs).toEqual([office]);
  });

  it('refuses an address or credential that cannot work', () => {
    for (const url of ['', 'ftp://host', 'http://host/path', 'http://user:pass@host', 'http://']) {
      expect(() => normalizeLanHubUrl(url), url).toThrow(LanHubInputError);
    }
    expect(normalizeLanHubUrl(' https://Hub.Example.com:443/ ')).toBe('https://hub.example.com');
    expect(() => addLanHub([], { url: 'http://host', token: 'with space' })).toThrow(
      /unsupported characters/
    );
    expect(() => addLanHub([], { url: 'http://host', token: '   ' })).toThrow(/token is required/);
    expect(() => addLanHub([], { url: 'http://host', token: 'ok', name: 'x'.repeat(41) })).toThrow(
      /at most 40 characters/
    );
  });
});

describe('LAN slugs', () => {
  const id = deriveLanHubId(HOME_TOKEN);

  it('follows the name', () => {
    expect(resolveLanHubSlug({ id, name: 'Office 2F' })).toBe('office-2f');
    expect(resolveLanHubSlug({ id, name: LAN_HUB_DEFAULT_NAME })).toBe('lan');
  });

  it('avoids names the application routes itself', () => {
    expect(resolveLanHubSlug({ id, name: 'Home' })).toBe('lan-home');
    expect(resolveLanHubSlug({ id, name: 'Settings' })).toBe('lan-settings');
  });

  it('falls back to the id for a name without Latin letters', () => {
    expect(resolveLanHubSlug({ id, name: '家里' })).toBe(`lan-${id.slice(0, 8)}`);
  });

  it('stays unique among the LANs of one device', () => {
    let hubs = join([], 'Lab A', 'http://10.0.0.1:8788', HOME_TOKEN);
    hubs = join(hubs, 'Lab-A', 'http://10.0.1.1:8788', OFFICE_TOKEN);
    const slugs = summarizeLanHubs(hubs).map((hub) => hub.slug);
    expect(slugs).toEqual(['lab-a', 'lan-lab-a']);
    expect(slugs.every((slug) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))).toBe(true);
  });
});

describe('LAN invites', () => {
  it('carries everything a device needs in one shell-safe word', () => {
    const invite = formatLanInvite({
      url: 'http://100.64.0.1:8788',
      token: HOME_TOKEN,
      name: 'Home',
    });
    expect(invite).toBe(`lody-lan://${HOME_TOKEN}@100.64.0.1:8788/Home`);
    expect(invite).toMatch(/^[A-Za-z0-9._~:/@%-]+$/);
    expect(parseLanInvite(invite)).toEqual({
      url: 'http://100.64.0.1:8788',
      token: HOME_TOKEN,
      name: 'Home',
    });
  });

  it('keeps TLS, an IPv6 address and a name in any script', () => {
    const invite = formatLanInvite({
      url: 'https://[fd7a:115c:a1e0::1]:8788',
      token: 'a+b/c=',
      name: '家里 的 网',
    });
    expect(invite.startsWith('lody-lans://a%2Bb%2Fc%3D@[fd7a:115c:a1e0::1]:8788/')).toBe(true);
    expect(parseLanInvite(invite)).toEqual({
      url: 'https://[fd7a:115c:a1e0::1]:8788',
      token: 'a+b/c=',
      name: '家里 的 网',
    });
  });

  it('may leave the name to the device that joins', () => {
    expect(parseLanInvite(`lody-lan://${HOME_TOKEN}@hub.lan`)).toEqual({
      url: 'http://hub.lan',
      token: HOME_TOKEN,
      name: null,
    });
  });

  it('refuses a link that is not an invite', () => {
    for (const link of [
      'http://100.64.0.1:8788',
      'lody-lan://100.64.0.1:8788',
      `lody-lan://${HOME_TOKEN}:secret@100.64.0.1:8788`,
      `lody-lan://${HOME_TOKEN}@100.64.0.1:8788/Home?x=1`,
      'lody-lan://',
    ]) {
      expect(() => parseLanInvite(link), link).toThrow(LanHubInputError);
    }
  });
});

describe('machine name', () => {
  it('drops the domain of the network the machine happens to be on', () => {
    expect(normalizeMachineName('macbook-air.tail1234.ts.net')).toBe('macbook-air');
    expect(normalizeMachineName('macbook-air.local')).toBe('macbook-air');
    expect(normalizeMachineName('devnuc')).toBe('devnuc');
    expect(normalizeMachineName('devnuc.')).toBe('devnuc');
  });

  it('keeps an address whole', () => {
    expect(normalizeMachineName('192.168.1.5')).toBe('192.168.1.5');
    expect(normalizeMachineName('fd7a:115c:a1e0::1')).toBe('fd7a:115c:a1e0::1');
  });

  it('prefers an explicit name over the host name', () => {
    expect(resolveMachineName({ hostname: 'mac.tail1234.ts.net' })).toEqual({
      name: 'mac',
      explicit: false,
    });
    expect(
      resolveMachineName({ hostname: 'mac.local', settings: { machineName: 'Studio Mac' } })
    ).toEqual({ name: 'Studio Mac', explicit: true });
    expect(
      resolveMachineName({
        hostname: 'mac.local',
        settings: { machineName: 'Studio Mac' },
        override: 'build.box',
      })
    ).toEqual({ name: 'build.box', explicit: true });
  });
});

describe('following a settings change', () => {
  const home = addLanHub([], { name: 'Home', url: 'http://10.0.0.1:8788', token: HOME_TOKEN }).hub;
  const office = addLanHub([], {
    name: 'Office',
    url: 'http://10.0.1.1:8788',
    token: OFFICE_TOKEN,
  }).hub;
  const settings = (hubs: LanHub[], machineName: string | null = null) => ({ hubs, machineName });

  it('follows added, removed and renamed LANs without a restart', () => {
    expect(classifyLanHubChange(settings([home]), settings([home, office]))).toEqual({
      kind: 'workspaces',
    });
    // The process is the user of its first LAN and cannot become another.
    expect(classifyLanHubChange(settings([home, office]), settings([office]))).toEqual({
      kind: 'restart',
      reason: 'the first LAN of this machine changed',
    });
    expect(classifyLanHubChange(settings([home, office]), settings([home]))).toEqual({
      kind: 'workspaces',
    });
    expect(classifyLanHubChange(settings([home]), settings([{ ...home, name: 'Flat' }]))).toEqual({
      kind: 'workspaces',
    });
    expect(classifyLanHubChange(settings([home]), settings([{ ...home }]))).toEqual({
      kind: 'none',
    });
  });

  it('restarts when the process changes between local-only and LAN operation', () => {
    expect(classifyLanHubChange(settings([]), settings([home]))).toEqual({
      kind: 'restart',
      reason: 'the first LAN was added',
    });
    expect(classifyLanHubChange(settings([home]), settings([]))).toEqual({
      kind: 'restart',
      reason: 'the last LAN was removed',
    });
    expect(classifyLanHubChange(settings([]), settings([]))).toEqual({ kind: 'none' });
  });

  it('restarts when a LAN moves or the machine is renamed', () => {
    expect(
      classifyLanHubChange(
        settings([home, office]),
        settings([home, { ...office, url: 'http://10.0.1.2:8788' }])
      )
    ).toEqual({ kind: 'restart', reason: 'Office moved to another address' });
    expect(classifyLanHubChange(settings([home]), settings([home], 'devnuc'))).toEqual({
      kind: 'restart',
      reason: 'this machine was renamed',
    });
  });
});

describe('watching the settings file', () => {
  const DEBOUNCE_MS = 100;

  function watch() {
    vi.useFakeTimers();
    const changes: unknown[] = [];
    const errors: unknown[] = [];
    let emit: (filename: string | Buffer | null) => void = () => {};
    let closed = false;
    const watcher = watchLanHubSettings({
      filePath,
      env: {},
      debounceMs: DEBOUNCE_MS,
      onChange: (settings) => changes.push(settings),
      onError: (error) => errors.push(error),
      watchDirectory: (_directory, onEvent) => {
        emit = onEvent;
        return { close: () => (closed = true) };
      },
    });
    return {
      changes,
      errors,
      emit: (name: string | null) => emit(name),
      watcher,
      settle: () => vi.advanceTimersByTime(DEBOUNCE_MS),
      isClosed: () => closed,
    };
  }

  it('reads once for a burst of events and ignores other files', () => {
    const hubs = join([], 'Home', 'http://10.0.0.1:8788', HOME_TOKEN);
    const watched = watch();
    writeLanHubSettings({ hubs, machineName: null }, { env: {}, filePath });
    watched.emit('workspace-catalog.json');
    watched.settle();
    expect(watched.changes).toEqual([]);

    watched.emit('lan-hub.json');
    watched.emit('lan-hub.json');
    watched.emit(null);
    watched.settle();
    expect(watched.changes).toEqual([{ hubs, machineName: null, source: 'file' }]);
  });

  it('reads the state after the burst, not the state that started it', () => {
    const watched = watch();
    watched.emit('lan-hub.json');
    const hubs = join([], 'Home', 'http://10.0.0.1:8788', HOME_TOKEN);
    writeLanHubSettings({ hubs, machineName: null }, { env: {}, filePath });
    watched.settle();
    expect(watched.changes).toEqual([{ hubs, machineName: null, source: 'file' }]);
  });

  it('reports a removed file as no LAN and a broken file as an error', () => {
    const watched = watch();
    watched.emit('lan-hub.json');
    watched.settle();
    expect(watched.changes).toEqual([{ hubs: [], machineName: null, source: 'none' }]);

    fs.writeFileSync(filePath, '{');
    watched.emit('lan-hub.json');
    watched.settle();
    expect(watched.changes).toHaveLength(1);
    expect(String(watched.errors[0])).toMatch(/not valid JSON/);
  });

  it('stops reporting once closed', () => {
    const watched = watch();
    watched.emit('lan-hub.json');
    watched.watcher.close();
    watched.settle();
    expect(watched.changes).toEqual([]);
    expect(watched.isClosed()).toBe(true);
  });
});

describe('the round trip to a hub', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          })
      )
    );
  });

  /** A hub on this machine that knows one credential and never saw the workspace. */
  const listen = async () => {
    const seen: Array<{ method?: string; url?: string; authorization?: string }> = [];
    let connections = 0;
    const server = http.createServer((request, response) => {
      seen.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
      });
      // As the hub does: a length even on HEAD, which lets the connection be kept.
      response.statusCode = request.headers.authorization === 'Bearer good' ? 404 : 401;
      response.setHeader('content-length', 0);
      response.end();
    });
    server.on('connection', () => {
      connections += 1;
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('the server has no port');
    return { url: `http://127.0.0.1:${address.port}`, seen, connections: () => connections };
  };

  it('is measured on one kept connection, and is nothing when the hub refuses or is away', async () => {
    const hub = await listen();
    const id = 'a'.repeat(32);

    const first = await measureLanHubLatency({ url: hub.url, token: 'good', id });
    const second = await measureLanHubLatency({ url: hub.url, token: 'good', id });
    expect(first).toEqual(expect.any(Number));
    expect(second).toEqual(expect.any(Number));
    expect(hub.seen).toEqual([
      { method: 'HEAD', url: `/ds/lody/lw_${id}%3Ameta`, authorization: 'Bearer good' },
      { method: 'HEAD', url: `/ds/lody/lw_${id}%3Ameta`, authorization: 'Bearer good' },
    ]);
    expect(hub.connections()).toBe(1);

    await expect(measureLanHubLatency({ url: hub.url, token: 'bad', id })).resolves.toBeNull();

    const away = await listen();
    const awayUrl = away.url;
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    await expect(measureLanHubLatency({ url: awayUrl, token: 'good', id })).resolves.toBeNull();
  });
});
