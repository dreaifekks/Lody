import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeMcpAuthenticationIO,
  type McpAuthenticationIO,
  type McpStoredAuthentication,
} from '@/mcp/authentication/io';
import { LAN_HUB_HANDOVER_FILES, readLanHubHandover, writeLanHubHandover } from './hub-handover';
import { startLanHubServer, type LanHubServer, type LanHubUpstream } from './hub-server';
import { pullLanHubSnapshot, readKeptLanHubSnapshot, writeLanHubSnapshot } from './hub-snapshot';
import {
  decryptLanMcpAuthJson,
  deriveLanMcpAuthKey,
  encryptLanMcpAuthJson,
  LAN_HUB_MCP_AUTH_RECORDS_PREFIX,
  LAN_HUB_MCP_AUTH_STATUS_PATH,
  LAN_HUB_MCP_AUTH_TOKEN_PREFIX,
  LAN_MCP_AUTH_FILE_NAME,
  mcpAuthPutRecordRequestAad,
  mcpAuthTokenRequestAad,
  mcpAuthTokenResponseAad,
} from './lan-mcp-auth-crypto';

const HTTP_TARGET = JSON.stringify({
  transport: 'http',
  url: 'https://resource.example/mcp',
  authentication: 'local',
});
const STDIO_TARGET = JSON.stringify({
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
  authentication: 'local',
});

async function startFakeUpstream(): Promise<LanHubUpstream> {
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

describe('LAN hub centralized MCP authentication', () => {
  let dataDir: string;
  let hub: LanHubServer;
  let nowMs: number;
  let logged: string[];
  let refreshHandler: (
    record: McpStoredAuthentication,
    url: string,
    signal: AbortSignal
  ) => Promise<McpStoredAuthentication>;
  let refreshCalls: number;
  let mockIo: McpAuthenticationIO;

  const startHub = async () =>
    await startLanHubServer({
      host: '127.0.0.1',
      port: 0,
      sharePort: null,
      dataDir,
      startUpstream: startFakeUpstream,
      mcpAuthIo: mockIo,
      now: () => nowMs,
      log: (line) => logged.push(line),
    });

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-hub-mcp-auth-'));
    nowMs = 1_700_000_000_000;
    logged = [];
    refreshCalls = 0;
    refreshHandler = async (record) => ({
      ...record,
      tokens: {
        access_token: `rotated-access-${refreshCalls}`,
        token_type: 'Bearer',
        refresh_token: `rotated-refresh-${refreshCalls}`,
        expires_in: 3600,
        issuer: record.tokens?.issuer,
      },
    });
    mockIo = {
      ...makeMcpAuthenticationIO(),
      authorize: async (record, options) => {
        refreshCalls += 1;
        const next = await refreshHandler(structuredClone(record), options.url, options.signal);
        return { record: next };
      },
    };
    hub = await startHub();
  });

  afterEach(async () => {
    await hub.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const wireKey = () => deriveLanMcpAuthKey(hub.token, 'wire');

  const putRecord = async (
    serverId: string,
    record: McpStoredAuthentication,
    token = hub.token
  ) => {
    const body = encryptLanMcpAuthJson(
      deriveLanMcpAuthKey(token, 'wire'),
      mcpAuthPutRecordRequestAad(serverId),
      { record }
    );
    const response = await fetch(
      `${hub.url}${LAN_HUB_MCP_AUTH_RECORDS_PREFIX}${encodeURIComponent(serverId)}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };

  const getStatus = async (token = hub.token) => {
    const response = await fetch(`${hub.url}${LAN_HUB_MCP_AUTH_STATUS_PATH}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };

  const deleteRecord = async (serverId: string, token = hub.token) => {
    const response = await fetch(
      `${hub.url}${LAN_HUB_MCP_AUTH_RECORDS_PREFIX}${encodeURIComponent(serverId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };

  const requestToken = async (
    serverId: string,
    payload: {
      target: string;
      connectionUrl?: string;
      forceRefresh?: boolean;
      failedRevision?: number;
    },
    token = hub.token
  ) => {
    const key = deriveLanMcpAuthKey(token, 'wire');
    const body = encryptLanMcpAuthJson(key, mcpAuthTokenRequestAad(serverId), payload);
    const response = await fetch(
      `${hub.url}${LAN_HUB_MCP_AUTH_TOKEN_PREFIX}${encodeURIComponent(serverId)}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    const raw = (await response.json()) as Record<string, unknown>;
    if (response.status !== 200) return { status: response.status, raw, decrypted: null };
    return {
      status: response.status,
      raw,
      decrypted: decryptLanMcpAuthJson(key, mcpAuthTokenResponseAad(serverId), raw) as Record<
        string,
        unknown
      >,
    };
  };

  it('guards all MCP auth routes behind the hub bearer token and supports OAuth + manual CRUD', async () => {
    expect((await getStatus('wrong-token')).status).toBe(401);
    expect((await deleteRecord('srv-1', 'wrong-token')).status).toBe(401);

    const oauthRecord: McpStoredAuthentication = {
      target: HTTP_TARGET,
      settings: {
        mode: 'oauth',
        clientId: 'oauth-client-id',
        clientSecret: 'super-secret-client-secret',
      },
      client: {
        client_id: 'oauth-client-id',
        client_secret: 'super-secret-client-secret',
        issuer: 'https://issuer.example',
      },
      tokens: {
        access_token: 'initial-access-token',
        token_type: 'Bearer',
        refresh_token: 'super-secret-refresh-token',
        expires_in: 3600,
        issuer: 'https://issuer.example',
      },
    };
    const manualStdioRecord: McpStoredAuthentication = {
      target: STDIO_TARGET,
      settings: {
        mode: 'manual',
        env: { MCP_API_KEY: 'super-secret-stdio-key' },
      },
    };
    const manualHttpRecord: McpStoredAuthentication = {
      target: HTTP_TARGET,
      settings: {
        mode: 'manual',
        bearerToken: 'super-secret-manual-bearer',
        headers: { 'X-Custom-Key': 'custom-secret-header' },
      },
    };

    const savedOAuth = await putRecord('srv-oauth', oauthRecord);
    expect(savedOAuth.status).toBe(200);
    expect(savedOAuth.json).toEqual({
      serverId: 'srv-oauth',
      mode: 'oauth',
      target: HTTP_TARGET,
      hasTokens: true,
      hasRefreshToken: true,
      hasCredentials: true,
      expiresAt: nowMs + 3_600_000,
      hasClient: true,
      revision: 1,
      updatedAt: nowMs,
    });
    expect((await putRecord('srv-stdio', manualStdioRecord)).status).toBe(200);
    expect((await putRecord('srv-manual-http', manualHttpRecord)).status).toBe(200);

    // At-rest encryption & 0600 file permissions
    const encPath = path.join(dataDir, LAN_MCP_AUTH_FILE_NAME);
    expect(fs.statSync(encPath).mode & 0o777).toBe(0o600);
    const encContent = fs.readFileSync(encPath, 'utf8');
    for (const secret of [
      'initial-access-token',
      'super-secret-refresh-token',
      'super-secret-client-secret',
      'super-secret-stdio-key',
      'super-secret-manual-bearer',
      'custom-secret-header',
    ]) {
      expect(encContent).not.toContain(secret);
    }

    // Sanitized status endpoint never returns any secrets
    const status = await getStatus();
    expect(status.status).toBe(200);
    const statusText = JSON.stringify(status.json);
    for (const secret of [
      'initial-access-token',
      'super-secret-refresh-token',
      'super-secret-client-secret',
      'super-secret-stdio-key',
      'super-secret-manual-bearer',
      'custom-secret-header',
    ]) {
      expect(statusText).not.toContain(secret);
    }

    // Token responses: OAuth strips refresh_token & client_secret; manual returns headers/env
    const oauthToken = await requestToken('srv-oauth', {
      target: HTTP_TARGET,
      connectionUrl: 'https://resource.example/mcp',
    });
    expect(oauthToken.status).toBe(200);
    expect(JSON.stringify(oauthToken.raw)).not.toContain('initial-access-token');
    expect(oauthToken.decrypted).toEqual({
      mode: 'oauth',
      headers: { authorization: 'Bearer initial-access-token' },
      expiresAt: nowMs + 3_600_000,
      revision: 1,
    });
    expect(JSON.stringify(oauthToken.decrypted)).not.toContain('super-secret-refresh-token');
    expect(JSON.stringify(oauthToken.decrypted)).not.toContain('super-secret-client-secret');

    const stdioToken = await requestToken('srv-stdio', { target: STDIO_TARGET });
    expect(stdioToken.status).toBe(200);
    expect(stdioToken.decrypted).toEqual({
      mode: 'manual',
      env: { MCP_API_KEY: 'super-secret-stdio-key' },
      revision: 2,
    });

    const manualHttpToken = await requestToken('srv-manual-http', { target: HTTP_TARGET });
    expect(manualHttpToken.status).toBe(200);
    expect(manualHttpToken.decrypted).toEqual({
      mode: 'manual',
      headers: {
        'x-custom-key': 'custom-secret-header',
        authorization: 'Bearer super-secret-manual-bearer',
      },
      revision: 3,
    });

    // Missing and target-mismatch checks
    expect((await requestToken('missing', { target: HTTP_TARGET })).status).toBe(404);
    const mismatchOAuth = await requestToken('srv-oauth', { target: STDIO_TARGET });
    expect(mismatchOAuth.status).toBe(409);
    expect(mismatchOAuth.raw).toEqual({ error: 'oauth_required' });
    const mismatchManual = await requestToken('srv-stdio', { target: HTTP_TARGET });
    expect(mismatchManual.status).toBe(409);
    expect(mismatchManual.raw).toEqual({ error: 'manual_required' });

    // Hub restart reloads encrypted state from disk cleanly
    await hub.close();
    hub = await startHub();
    const afterRestart = await requestToken('srv-oauth', { target: HTTP_TARGET });
    expect(afterRestart.status).toBe(200);
    expect(afterRestart.decrypted?.revision).toBe(1);

    // Delete removes record and persists atomically
    expect(await deleteRecord('srv-oauth')).toEqual({ status: 200, json: { removed: true } });
    expect(await deleteRecord('srv-oauth')).toEqual({ status: 200, json: { removed: false } });
    expect((await requestToken('srv-oauth', { target: HTTP_TARGET })).status).toBe(404);

    // Logs contain no secrets
    const allLogs = logged.join('\n');
    for (const secret of [
      'initial-access-token',
      'super-secret-refresh-token',
      'super-secret-client-secret',
      'super-secret-stdio-key',
      'super-secret-manual-bearer',
    ]) {
      expect(allLogs).not.toContain(secret);
    }
  });

  it('serializes concurrent OAuth refreshes, deduplicates 401 retries via failedRevision CAS, and persists rotated refresh tokens before unlocking', async () => {
    await putRecord('srv-cas', {
      target: HTTP_TARGET,
      settings: { mode: 'oauth' },
      client: { client_id: 'dcr-client', issuer: 'https://issuer.example' },
      tokens: {
        access_token: 'v1-access',
        token_type: 'Bearer',
        refresh_token: 'v1-refresh',
        expires_in: 3600,
        issuer: 'https://issuer.example',
      },
    });

    const gate = Promise.withResolvers<void>();
    const seenRefreshTokens: string[] = [];
    refreshHandler = async (record) => {
      seenRefreshTokens.push(record.tokens?.refresh_token ?? '');
      await gate.promise;
      return {
        ...record,
        tokens: {
          access_token: 'v2-access',
          token_type: 'Bearer',
          refresh_token: 'v2-refresh-rotated',
          expires_in: 3600,
          issuer: 'https://issuer.example',
        },
      };
    };

    // Three members simultaneously report 401 for revision 1
    const pending = [
      requestToken('srv-cas', {
        target: HTTP_TARGET,
        connectionUrl: 'https://resource.example/mcp',
        forceRefresh: true,
        failedRevision: 1,
      }),
      requestToken('srv-cas', {
        target: HTTP_TARGET,
        connectionUrl: 'https://resource.example/mcp',
        forceRefresh: true,
        failedRevision: 1,
      }),
      requestToken('srv-cas', {
        target: HTTP_TARGET,
        connectionUrl: 'https://resource.example/mcp',
        forceRefresh: true,
        failedRevision: 1,
      }),
    ];

    gate.resolve();
    const results = await Promise.all(pending);

    // Exactly ONE refresh executed; all three received the rotated revision 2
    expect(refreshCalls).toBe(1);
    expect(seenRefreshTokens).toEqual(['v1-refresh']);
    for (const res of results) {
      expect(res.status).toBe(200);
      expect(res.decrypted).toEqual({
        mode: 'oauth',
        headers: { authorization: 'Bearer v2-access' },
        expiresAt: nowMs + 3_600_000,
        revision: 2,
      });
      expect(JSON.stringify(res.decrypted)).not.toContain('v2-refresh-rotated');
    }

    // Verify rotated refresh token was atomically persisted before unlocking
    await hub.close();
    hub = await startHub();
    nowMs += 3_580_000; // within 30s skew -> triggers near-expiry refresh
    refreshHandler = async (record) => {
      seenRefreshTokens.push(record.tokens?.refresh_token ?? '');
      // Omit refresh_token to verify fallback preservation of v2-refresh-rotated
      return {
        ...record,
        tokens: {
          access_token: 'v3-access',
          token_type: 'Bearer',
          expires_in: 3600,
          issuer: 'https://issuer.example',
        },
      };
    };
    const [r1, r2] = await Promise.all([
      requestToken('srv-cas', { target: HTTP_TARGET }),
      requestToken('srv-cas', { target: HTTP_TARGET }),
    ]);
    expect(refreshCalls).toBe(2);
    expect(seenRefreshTokens).toEqual(['v1-refresh', 'v2-refresh-rotated']);
    expect(r1.decrypted?.revision).toBe(3);
    expect(r2.decrypted?.revision).toBe(3);

    // Trigger another refresh and verify v2-refresh-rotated was preserved
    nowMs += 3_580_000;
    refreshHandler = async (record) => {
      seenRefreshTokens.push(record.tokens?.refresh_token ?? '');
      return {
        ...record,
        tokens: {
          access_token: 'v4-access',
          token_type: 'Bearer',
          expires_in: 3600,
          issuer: 'https://issuer.example',
        },
      };
    };
    const r3 = await requestToken('srv-cas', { target: HTTP_TARGET });
    expect(r3.status).toBe(200);
    expect(seenRefreshTokens).toEqual(['v1-refresh', 'v2-refresh-rotated', 'v2-refresh-rotated']);
  });

  it('preserves stored records on transient network failures and reports expired on invalid_grant', async () => {
    await putRecord('srv-err', {
      target: HTTP_TARGET,
      settings: { mode: 'oauth' },
      client: { client_id: 'dcr-client', issuer: 'https://issuer.example' },
      tokens: {
        access_token: 'valid-access',
        token_type: 'Bearer',
        refresh_token: 'valid-refresh',
        expires_in: 3600,
        issuer: 'https://issuer.example',
      },
    });

    // Transient network outage during forced refresh -> 502 connection_failed, record stays intact
    refreshHandler = async () => {
      throw new TypeError('fetch failed');
    };
    const transient = await requestToken('srv-err', {
      target: HTTP_TARGET,
      forceRefresh: true,
      failedRevision: 1,
    });
    expect(transient.status).toBe(502);
    expect(transient.raw).toEqual({ error: 'connection_failed' });
    const statusAfterTransient = await getStatus();
    expect((statusAfterTransient.json.records as Record<string, unknown>)['srv-err']).toMatchObject(
      {
        hasTokens: true,
        hasRefreshToken: true,
        revision: 1,
      }
    );
    expect(
      (statusAfterTransient.json.records as Record<string, Record<string, unknown>>)['srv-err']
        ?.refreshError
    ).toBeUndefined();

    // Token is still valid without refresh
    const stillValid = await requestToken('srv-err', { target: HTTP_TARGET });
    expect(stillValid.status).toBe(200);
    expect(stillValid.decrypted?.headers).toEqual({ authorization: 'Bearer valid-access' });

    // Terminal OAuth invalid_grant -> 401 expired and refreshError surfaced in /status
    refreshHandler = async () => {
      throw new OAuthError(OAuthErrorCode.InvalidGrant, 'refresh token revoked');
    };
    const expired = await requestToken('srv-err', {
      target: HTTP_TARGET,
      forceRefresh: true,
      failedRevision: 1,
    });
    expect(expired.status).toBe(401);
    expect(expired.raw).toEqual({ error: 'expired' });
    const statusAfterExpired = await getStatus();
    expect((statusAfterExpired.json.records as Record<string, unknown>)['srv-err']).toMatchObject({
      mode: 'oauth',
      refreshError: 'expired',
    });
  });

  it('fails closed with storage_unavailable when mcp-auth.enc is corrupted', async () => {
    await hub.close();
    fs.writeFileSync(
      path.join(dataDir, LAN_MCP_AUTH_FILE_NAME),
      '{"v":1,"iv":"bad","tag":"bad","ciphertext":"bad"}\n',
      {
        mode: 0o600,
      }
    );
    hub = await startHub();
    const status = await getStatus();
    expect(status.status).toBe(500);
    expect(status.json).toEqual({ error: 'storage_unavailable' });
    // Rejects wrong-AAD envelope too when healthy
    expect(wireKey().length).toBe(32);
  });

  it('includes mcp-auth.enc and env.json in handover and standby snapshots while remaining compatible when absent', async () => {
    expect(LAN_HUB_HANDOVER_FILES).toContain('mcp-auth.enc');
    expect(LAN_HUB_HANDOVER_FILES).toContain('env.json');

    // Handover WITH both files present
    await putRecord('srv-handover', {
      target: HTTP_TARGET,
      settings: { mode: 'manual', bearerToken: 'handover-secret' },
    });
    fs.writeFileSync(path.join(dataDir, 'env.json'), '{"FOO":"bar"}\n', { mode: 0o600 });
    const handoverStream = new PassThrough();
    const destWithFiles = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-handover-dest-'));
    const destWithoutFiles = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-handover-empty-'));
    const emptySource = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-handover-src-'));
    const standbyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-standby-mcp-'));
    const db = new Database(path.join(dataDir, 'streams.sqlite'));
    try {
      db.pragma('journal_mode = WAL');
      db.exec('create table entries (id integer primary key, body text)');
      db.prepare('insert into entries (body) values (?)').run('hello');

      const [sentCount, received] = await Promise.all([
        writeLanHubHandover(dataDir, handoverStream).then((count) => {
          handoverStream.end();
          return count;
        }),
        readLanHubHandover(handoverStream, destWithFiles),
      ]);
      expect(sentCount).toBe(received.length);
      expect(received).toContain('mcp-auth.enc');
      expect(received).toContain('env.json');
      expect(fs.statSync(path.join(destWithFiles, 'mcp-auth.enc')).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(path.join(destWithFiles, 'env.json'), 'utf8')).toBe('{"FOO":"bar"}\n');

      // Handover WITHOUT mcp-auth.enc and env.json (older hub compatibility)
      fs.writeFileSync(path.join(emptySource, 'token'), 'old-hub-token\n', { mode: 0o600 });
      const oldStream = new PassThrough();
      const [, receivedOld] = await Promise.all([
        writeLanHubHandover(emptySource, oldStream).then((count) => {
          oldStream.end();
          return count;
        }),
        readLanHubHandover(oldStream, destWithoutFiles),
      ]);
      expect(receivedOld).toEqual(['token']);

      // Standby snapshot copies both mcp-auth.enc and env.json
      const snapFetch: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/lan/shares/copy') {
          return new Response(null, { status: 404 });
        }
        const { have } = JSON.parse(String(init?.body)) as { have: string[] };
        const pipe = new PassThrough();
        void writeLanHubSnapshot({ dataDir, have, stream: pipe });
        return new Response(Readable.toWeb(pipe) as ReadableStream<Uint8Array>, { status: 200 });
      };
      await pullLanHubSnapshot({
        hub: { url: hub.url, token: hub.token },
        directory: standbyDir,
        fetch: snapFetch,
      });
      const kept = readKeptLanHubSnapshot(standbyDir);
      expect(kept).not.toBeNull();
      expect(fs.existsSync(path.join(kept!.path, 'mcp-auth.enc'))).toBe(true);
      expect(fs.existsSync(path.join(kept!.path, 'env.json'))).toBe(true);
      expect(fs.readFileSync(path.join(kept!.path, 'env.json'), 'utf8')).toBe('{"FOO":"bar"}\n');
    } finally {
      db.close();
      fs.rmSync(destWithFiles, { recursive: true, force: true });
      fs.rmSync(destWithoutFiles, { recursive: true, force: true });
      fs.rmSync(emptySource, { recursive: true, force: true });
      fs.rmSync(standbyDir, { recursive: true, force: true });
    }
  });
});
