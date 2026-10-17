import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LanHub } from '@lody/shared/node/lan-hub';
import {
  getLanCredentialsDirectory,
  LAN_ENV_FILE_NAME,
  LAN_HUB_CREDENTIALS_ENV_PATH,
  LAN_HUB_CREDENTIALS_PATH,
  readLanCredentialsEnv,
} from '@lody/shared/node/lan-credentials';
import { LanHubCredentialsSchema } from './hub-credentials';
import { readLanHubEnv } from './hub-env';
import { startLanHubServer, type LanHubServer, type LanHubUpstream } from './hub-server';
import { createLanCredentialSync, fillMissingLanHubCredentials } from './lan-credential-sync';
import { listLanEnvNames, readLanEnvValue, setLanEnv, unsetLanEnv } from './lan-env';

const SECRET = 'tmc_secret_value_that_must_stay_off_the_wire';
const quiet = { debug: () => {}, info: () => {}, warn: () => {} } as never;

async function startUpstream(): Promise<LanHubUpstream> {
  const server = http.createServer((request, response) =>
    response.writeHead(request.method === 'PUT' ? 201 : 200).end()
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let stopped: (code: number | null) => void = () => {};
  return {
    port: (server.address() as AddressInfo).port,
    exited: new Promise((resolve) => (stopped = resolve)),
    stop: () => {
      server.closeAllConnections();
      server.close(() => stopped(0));
    },
  };
}

describe('the environment table of a LAN host', () => {
  let dataDir: string;
  let memberDir: string;
  let hub: LanHubServer;
  let logged: string[];

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-env-hub-'));
    memberDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-env-member-'));
    logged = [];
    hub = await startLanHubServer({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      startUpstream,
      log: (line) => logged.push(line),
    });
  });

  afterEach(async () => {
    await hub.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(memberDir, { recursive: true, force: true });
  });

  const member = (): LanHub => ({
    id: 'e'.repeat(32),
    name: 'Home',
    url: hub.url,
    token: hub.token,
  });

  const call = async (method: string, pathname: string, body?: unknown, token = hub.token) => {
    const response = await fetch(`${hub.url}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  it('keeps variables set behind the gate, lists their names alone and logs no value', async () => {
    const set = { name: 'TELE_MESS_MCP_TOKEN', value: SECRET };
    expect((await call('PUT', LAN_HUB_CREDENTIALS_ENV_PATH, set, 'wrong')).status).toBe(401);
    expect(
      (await call('PUT', LAN_HUB_CREDENTIALS_ENV_PATH, { name: 'not a name', value: 'x' })).status
    ).toBe(400);
    expect(
      (await call('PUT', LAN_HUB_CREDENTIALS_ENV_PATH, { name: 'EMPTY', value: '' })).status
    ).toBe(400);
    expect((await call('PUT', LAN_HUB_CREDENTIALS_ENV_PATH, set)).status).toBe(200);
    expect(
      (await call('PUT', LAN_HUB_CREDENTIALS_ENV_PATH, { name: 'HEBI8M_TOKEN', value: 'h8m' }))
        .status
    ).toBe(200);

    expect(readLanHubEnv(dataDir)).toEqual({ HEBI8M_TOKEN: 'h8m', TELE_MESS_MCP_TOKEN: SECRET });
    expect(fs.statSync(path.join(dataDir, LAN_ENV_FILE_NAME)).mode & 0o777).toBe(0o600);

    const names = await call('GET', LAN_HUB_CREDENTIALS_ENV_PATH);
    expect(names.body).toEqual({ names: ['HEBI8M_TOKEN', 'TELE_MESS_MCP_TOKEN'] });
    expect(JSON.stringify(names.body)).not.toContain(SECRET);
    // The whole document carries the values to members, as it carries the GitHub token.
    expect((await call('GET', LAN_HUB_CREDENTIALS_PATH)).body.env).toEqual({
      HEBI8M_TOKEN: 'h8m',
      TELE_MESS_MCP_TOKEN: SECRET,
    });

    expect(
      (await call('DELETE', LAN_HUB_CREDENTIALS_ENV_PATH, { name: 'HEBI8M_TOKEN' })).body
    ).toEqual({ removed: true });
    expect(
      (await call('DELETE', LAN_HUB_CREDENTIALS_ENV_PATH, { name: 'HEBI8M_TOKEN' })).body
    ).toEqual({ removed: false });
    expect(readLanHubEnv(dataDir)).toEqual({ TELE_MESS_MCP_TOKEN: SECRET });

    expect(logged.some((line) => line.includes('TELE_MESS_MCP_TOKEN set'))).toBe(true);
    expect(logged.join('\n')).not.toContain(SECRET);
  });

  it('is copied to every member, where the daemon reads it, and leaves when emptied', async () => {
    const lan = member();
    await call('PUT', LAN_HUB_CREDENTIALS_ENV_PATH, { name: 'TELE_MESS_MCP_TOKEN', value: SECRET });
    const sync = createLanCredentialSync({ hubs: () => [lan], logger: quiet, dataDir: memberDir });
    await sync.syncNow();

    const copy = getLanCredentialsDirectory(lan.id, memberDir);
    expect(fs.statSync(path.join(copy, LAN_ENV_FILE_NAME)).mode & 0o777).toBe(0o600);
    expect(readLanCredentialsEnv(lan.id, memberDir)).toEqual({ TELE_MESS_MCP_TOKEN: SECRET });

    // A hub promoted from a standby copy without the table takes this machine's copy.
    const promoted = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-env-promoted-'));
    try {
      expect(fillMissingLanHubCredentials(promoted, copy)).toContain(LAN_ENV_FILE_NAME);
      expect(readLanHubEnv(promoted)).toEqual({ TELE_MESS_MCP_TOKEN: SECRET });
    } finally {
      fs.rmSync(promoted, { recursive: true, force: true });
    }

    await call('DELETE', LAN_HUB_CREDENTIALS_ENV_PATH, { name: 'TELE_MESS_MCP_TOKEN' });
    await sync.syncNow();
    expect(fs.existsSync(path.join(copy, LAN_ENV_FILE_NAME))).toBe(false);
    expect(readLanCredentialsEnv(lan.id, memberDir)).toEqual({});

    // A copy nobody can read is an empty table, never a failed session start.
    fs.writeFileSync(path.join(copy, LAN_ENV_FILE_NAME), '{not json');
    expect(readLanCredentialsEnv(lan.id, memberDir)).toEqual({});
  });

  it('takes a hub of an earlier build, whose document has no table, as an empty one', () => {
    const parsed = LanHubCredentialsSchema.safeParse({
      revision: 'r1',
      github: null,
      apns: null,
      devices: [],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.env).toEqual({});
  });

  it('is set from a stream by `lody lan env set`, which lists names only', async () => {
    const lan = member();
    const value = await readLanEnvValue(Readable.from([Buffer.from(`${SECRET}\n`)]));
    expect(value).toBe(SECRET);
    await setLanEnv({ hub: lan }, 'TELE_MESS_MCP_TOKEN', value);
    await expect(setLanEnv({ hub: lan }, 'bad name', 'x')).rejects.toThrow(/not an environment/);
    await expect(setLanEnv({ hub: lan }, 'NO_VALUE', '')).rejects.toThrow(/No value/);

    // Written on the host's own machine instead of sent to the hub.
    const direct = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-env-direct-'));
    try {
      await setLanEnv({ dataDir: direct }, 'HEBI8M_TOKEN', 'h8m');
      expect(await listLanEnvNames({ dataDir: direct })).toEqual(['HEBI8M_TOKEN']);
      expect(await unsetLanEnv({ dataDir: direct }, 'HEBI8M_TOKEN')).toBe(true);
      expect(await listLanEnvNames({ dataDir: direct })).toEqual([]);
    } finally {
      fs.rmSync(direct, { recursive: true, force: true });
    }

    const seen: string[] = [];
    const listed = await listLanEnvNames({ hub: lan }, async (input, init) => {
      const response = await fetch(input, init);
      seen.push(await response.clone().text());
      return response;
    });
    expect(listed).toEqual(['TELE_MESS_MCP_TOKEN']);
    expect(seen.join('\n')).not.toContain(SECRET);
    expect(await unsetLanEnv({ hub: lan }, 'TELE_MESS_MCP_TOKEN')).toBe(true);
    expect(await unsetLanEnv({ hub: lan }, 'TELE_MESS_MCP_TOKEN')).toBe(false);
  });
});
