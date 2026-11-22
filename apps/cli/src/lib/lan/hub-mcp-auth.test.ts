import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import Database from 'better-sqlite3';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeMcpAuthenticationIO,
  type McpAuthenticationIO,
  type McpStoredAuthentication,
} from '@/mcp/authentication/io';
import {
  LAN_HUB_ALL_HANDOVER_FILES,
  LAN_HUB_EXTRA_CREDENTIAL_FILES,
  LAN_HUB_HANDOVER_ABORT_PATH,
  LAN_HUB_HANDOVER_FILES,
  LAN_HUB_HANDOVER_PATH,
  readLanHubHandover,
  writeLanHubHandover,
} from './hub-handover';
import { createLanHubMcpAuth } from './hub-mcp-auth';
import { startLanHubServer, type LanHubServer, type LanHubUpstream } from './hub-server';
import {
  LAN_HUB_SNAPSHOT_PATH,
  pullLanHubSnapshot,
  readKeptLanHubSnapshot,
  writeLanHubSnapshot,
} from './hub-snapshot';
import {
  decryptLanMcpAuthJson,
  deriveLanMcpAuthKey,
  encryptLanMcpAuthJson,
  hashLanMcpAuthTarget,
  LAN_HUB_MCP_AUTH_AUTHORIZE_CONFIG_PREFIX,
  LAN_HUB_MCP_AUTH_RECORDS_PREFIX,
  LAN_HUB_MCP_AUTH_STATUS_PATH,
  LAN_HUB_MCP_AUTH_TOKEN_PREFIX,
  LAN_MCP_AUTH_FILE_NAME,
  mcpAuthAuthorizeConfigRequestAad,
  mcpAuthAuthorizeConfigResponseAad,
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
  args: ['server.js', '--secret-arg=expanded_var_secret_999'],
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
    vi.restoreAllMocks();
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

  const requestAuthorizeConfig = async (
    serverId: string,
    payload: { target: string },
    token = hub.token
  ) => {
    const key = deriveLanMcpAuthKey(token, 'wire');
    const body = encryptLanMcpAuthJson(key, mcpAuthAuthorizeConfigRequestAad(serverId), payload);
    const response = await fetch(
      `${hub.url}${LAN_HUB_MCP_AUTH_AUTHORIZE_CONFIG_PREFIX}${encodeURIComponent(serverId)}`,
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
      decrypted: decryptLanMcpAuthJson(
        key,
        mcpAuthAuthorizeConfigResponseAad(serverId),
        raw
      ) as Record<string, unknown>,
    };
  };

  it('guards all MCP auth routes behind the hub bearer token, returns targetHash (no plaintext target), and supports OAuth + manual CRUD + authorize-config', async () => {
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
      targetHash: hashLanMcpAuthTarget(HTTP_TARGET),
      hasTokens: true,
      hasRefreshToken: true,
      hasCredentials: true,
      expiresAt: nowMs + 3_600_000,
      hasClient: true,
      revision: 1,
      updatedAt: nowMs,
    });
    expect('target' in savedOAuth.json).toBe(false);

    const savedStdio = await putRecord('srv-stdio', manualStdioRecord);
    expect(savedStdio.status).toBe(200);
    expect(JSON.stringify(savedStdio.json)).not.toContain('expanded_var_secret_999');
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
      'expanded_var_secret_999',
    ]) {
      expect(encContent).not.toContain(secret);
    }

    // Sanitized status endpoint returns targetHash and never leaks secrets or expanded target args
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
      'expanded_var_secret_999',
      'https://resource.example/mcp',
    ]) {
      expect(statusText).not.toContain(secret);
    }

    // Authorize-config endpoint returns encrypted OAuth client info only (never tokens/refresh_token)
    const authConfig = await requestAuthorizeConfig('srv-oauth', { target: HTTP_TARGET });
    expect(authConfig.status).toBe(200);
    expect(JSON.stringify(authConfig.raw)).not.toContain('super-secret-client-secret');
    expect(authConfig.decrypted).toEqual({
      clientId: 'oauth-client-id',
      clientSecret: 'super-secret-client-secret',
      client: {
        client_id: 'oauth-client-id',
        client_secret: 'super-secret-client-secret',
        issuer: 'https://issuer.example',
      },
    });
    expect(JSON.stringify(authConfig.decrypted)).not.toContain('initial-access-token');
    expect(JSON.stringify(authConfig.decrypted)).not.toContain('super-secret-refresh-token');
    expect((await requestAuthorizeConfig('missing', { target: HTTP_TARGET })).status).toBe(404);
    expect((await requestAuthorizeConfig('srv-oauth', { target: STDIO_TARGET })).status).toBe(409);
    expect((await requestAuthorizeConfig('srv-stdio', { target: STDIO_TARGET })).status).toBe(409);

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
      'expanded_var_secret_999',
    ]) {
      expect(allLogs).not.toContain(secret);
    }
  });

  it('serializes concurrent OAuth refreshes, deduplicates 401 retries (including short-lived tokens), and persists rotated refresh tokens before unlocking', async () => {
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
      // Short-lived 20s token (inside 30s skew window) must still deduplicate concurrent 401 retries
      return {
        ...record,
        tokens: {
          access_token: 'v2-short-lived-access',
          token_type: 'Bearer',
          refresh_token: 'v2-refresh-rotated',
          expires_in: 20,
          issuer: 'https://issuer.example',
        },
      };
    };

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

    // Exactly ONE refresh executed even though expires_in=20s < 30s skew window
    expect(refreshCalls).toBe(1);
    expect(seenRefreshTokens).toEqual(['v1-refresh']);
    for (const res of results) {
      expect(res.status).toBe(200);
      expect(res.decrypted).toEqual({
        mode: 'oauth',
        headers: { authorization: 'Bearer v2-short-lived-access' },
        expiresAt: nowMs + 20_000,
        revision: 2,
      });
      expect(JSON.stringify(res.decrypted)).not.toContain('v2-refresh-rotated');
    }

    // Once actually expired (now >= expiresAt), a stale failedRevision=1 DOES trigger a new refresh
    await hub.close();
    hub = await startHub();
    nowMs += 21_000;
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
      requestToken('srv-cas', { target: HTTP_TARGET, forceRefresh: true, failedRevision: 1 }),
      requestToken('srv-cas', { target: HTTP_TARGET, forceRefresh: true, failedRevision: 1 }),
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

  it('commits rotated refresh token in memory on ENOSPC persist failure without reusing old RT and flushes when disk recovers', async () => {
    await putRecord('srv-enospc', {
      target: HTTP_TARGET,
      settings: { mode: 'oauth' },
      client: { client_id: 'dcr-client', issuer: 'https://issuer.example' },
      tokens: {
        access_token: 'at-1',
        token_type: 'Bearer',
        refresh_token: 'rt-1-single-use',
        expires_in: 3600,
        issuer: 'https://issuer.example',
      },
    });

    const usedRefreshTokens: string[] = [];
    refreshHandler = async (record) => {
      const rt = record.tokens?.refresh_token ?? '';
      if (usedRefreshTokens.includes(rt)) throw new Error(`Reused invalidated refresh token ${rt}`);
      usedRefreshTokens.push(rt);
      return {
        ...record,
        tokens: {
          access_token: 'at-2-rotated',
          token_type: 'Bearer',
          refresh_token: 'rt-2-fresh',
          expires_in: 3600,
          issuer: 'https://issuer.example',
        },
      };
    };

    const realWriteFileSync = fs.writeFileSync.bind(fs);
    let failWrites = true;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
      const target = String(args[0]);
      if (failWrites && target.includes(LAN_MCP_AUTH_FILE_NAME)) {
        const err = new Error('no space left on device') as NodeJS.ErrnoException;
        err.code = 'ENOSPC';
        throw err;
      }
      return realWriteFileSync(...args);
    });

    // Refresh succeeds upstream -> commits rt-2-fresh in memory -> ENOSPC fails persist -> returns 500
    const failed1 = await requestToken('srv-enospc', {
      target: HTTP_TARGET,
      forceRefresh: true,
      failedRevision: 1,
    });
    expect(failed1.status).toBe(500);
    expect(failed1.raw).toEqual({ error: 'storage_unavailable' });
    expect(refreshCalls).toBe(1);
    expect(usedRefreshTokens).toEqual(['rt-1-single-use']);

    // While disk is still full, retrying MUST NOT re-call upstream with dead rt-1-single-use
    const failed2 = await requestToken('srv-enospc', {
      target: HTTP_TARGET,
      forceRefresh: true,
      failedRevision: 1,
    });
    expect(failed2.status).toBe(500);
    expect(failed2.raw).toEqual({ error: 'storage_unavailable' });
    expect(refreshCalls).toBe(1);

    // Disk recovers -> next request flushes pendingPersist and returns already-rotated at-2-rotated
    failWrites = false;
    const recovered = await requestToken('srv-enospc', {
      target: HTTP_TARGET,
      forceRefresh: true,
      failedRevision: 1,
    });
    expect(recovered.status).toBe(200);
    expect(recovered.decrypted).toEqual({
      mode: 'oauth',
      headers: { authorization: 'Bearer at-2-rotated' },
      expiresAt: nowMs + 3_600_000,
      revision: 2,
    });
    expect(refreshCalls).toBe(1);
    writeSpy.mockRestore();

    // Restart hub and verify rt-2-fresh was flushed to disk cleanly
    await hub.close();
    hub = await startHub();
    nowMs += 3_580_000;
    const nextRotate = await requestToken('srv-enospc', { target: HTTP_TARGET });
    expect(nextRotate.status).toBe(200);
    expect(usedRefreshTokens).toEqual(['rt-1-single-use', 'rt-2-fresh']);
  });

  it('drains mid-body PUT requests during handover so idle() cannot return before in-flight writes settle, and resumes on handover abort', async () => {
    const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-mcp-drain-'));
    try {
      const mcpAuth = createLanHubMcpAuth({
        dataDir: unitDir,
        token: hub.token,
        now: () => nowMs,
      });
      const bodyStream = new PassThrough();
      const putRequest = Object.assign(bodyStream, {
        method: 'PUT',
        url: `${LAN_HUB_MCP_AUTH_RECORDS_PREFIX}srv-race`,
      }) as unknown as IncomingMessage;
      const putResult = { status: 0, headers: {} as Record<string, string>, body: '' };
      const putResponse = {
        headersSent: false,
        destroyed: false,
        writeHead: (status: number, headers?: Record<string, string>) => {
          putResponse.headersSent = true;
          putResult.status = status;
          putResult.headers = headers ?? {};
          return putResponse;
        },
        end: (chunk?: string) => {
          putResult.body = chunk ?? '';
        },
      } as unknown as ServerResponse;

      // Start PUT while its body is still paused in flight
      const putDone = mcpAuth.handle(putRequest, putResponse);

      // Handover begins synchronously -> idle() must wait for mid-body PUT
      mcpAuth.beginHandover();
      let idleSettled = false;
      const idleDone = mcpAuth.idle().then(() => {
        idleSettled = true;
      });
      await Promise.resolve();
      expect(idleSettled).toBe(false);

      // Any new request arriving after beginHandover is immediately rejected with 503 moving
      const rejectedResult = { status: 0, body: '' };
      await mcpAuth.handle(
        { method: 'GET', url: LAN_HUB_MCP_AUTH_STATUS_PATH } as IncomingMessage,
        {
          headersSent: false,
          destroyed: false,
          writeHead: (status: number) => {
            rejectedResult.status = status;
          },
          end: (chunk?: string) => {
            rejectedResult.body = chunk ?? '';
          },
        } as unknown as ServerResponse
      );
      expect(rejectedResult.status).toBe(503);
      expect(JSON.parse(rejectedResult.body)).toEqual({ error: 'moving' });
      expect(idleSettled).toBe(false);

      // Now finish streaming the mid-body PUT -> sees draining inside lock, returns 503, does not persist
      const envelope = encryptLanMcpAuthJson(wireKey(), mcpAuthPutRecordRequestAad('srv-race'), {
        record: { target: HTTP_TARGET, settings: { mode: 'manual', bearerToken: 'race-secret' } },
      });
      bodyStream.end(JSON.stringify(envelope));
      await putDone;
      await idleDone;

      expect(idleSettled).toBe(true);
      expect(putResult.status).toBe(503);
      expect(JSON.parse(putResult.body)).toEqual({ error: 'moving' });
      expect(mcpAuth.hasRecords()).toBe(false);

      // Resuming after an aborted handover re-admits writes
      mcpAuth.resumeHandover();
      const resumedBody = new PassThrough();
      resumedBody.end(JSON.stringify(envelope));
      const resumedResult = { status: 0 };
      await mcpAuth.handle(
        Object.assign(resumedBody, {
          method: 'PUT',
          url: `${LAN_HUB_MCP_AUTH_RECORDS_PREFIX}srv-race`,
        }) as unknown as IncomingMessage,
        {
          headersSent: false,
          destroyed: false,
          writeHead: (status: number) => {
            resumedResult.status = status;
          },
          end: () => {},
        } as unknown as ServerResponse
      );
      expect(resumedResult.status).toBe(200);
      expect(mcpAuth.hasRecords()).toBe(true);
      mcpAuth.close();
    } finally {
      fs.rmSync(unitDir, { recursive: true, force: true });
    }

    // End-to-end handover abort on hub-server resumes MCP auth routes cleanly
    const handover = await fetch(`${hub.url}${LAN_HUB_HANDOVER_PATH}?credentials=1`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hub.token}` },
    });
    expect(handover.status).toBe(200);
    await handover.arrayBuffer();
    expect((await getStatus()).status).toBe(503);
    const aborted = await fetch(`${hub.url}${LAN_HUB_HANDOVER_ABORT_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hub.token}` },
    });
    expect(aborted.status).toBe(200);
    expect((await getStatus()).status).toBe(200);
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

    const stillValid = await requestToken('srv-err', { target: HTTP_TARGET });
    expect(stillValid.status).toBe(200);
    expect(stillValid.decrypted?.headers).toEqual({ authorization: 'Bearer valid-access' });

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
      { mode: 0o600 }
    );
    hub = await startHub();
    const status = await getStatus();
    expect(status.status).toBe(500);
    expect(status.json).toEqual({ error: 'storage_unavailable' });
    expect(wireKey().length).toBe(32);
  });

  it('negotiates env.json and mcp-auth.enc via ?credentials=1 across rolling-upgrade handover and standby snapshots', async () => {
    // Baseline constant remains unchanged for older peers; extra files live behind ?credentials=1
    expect(LAN_HUB_HANDOVER_FILES).not.toContain('mcp-auth.enc');
    expect(LAN_HUB_HANDOVER_FILES).not.toContain('env.json');
    expect(LAN_HUB_EXTRA_CREDENTIAL_FILES).toEqual(['env.json', 'mcp-auth.enc']);
    expect(LAN_HUB_ALL_HANDOVER_FILES).toContain('mcp-auth.enc');
    expect(LAN_HUB_ALL_HANDOVER_FILES).toContain('env.json');

    fs.writeFileSync(path.join(dataDir, 'env.json'), '{"FOO":"bar"}\n', { mode: 0o600 });
    const db = new Database(path.join(dataDir, 'streams.sqlite'));
    const destOldNoMcp = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-handover-old-nomcp-'));
    const destNewWithCreds = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-handover-new-creds-'));
    const standbyNewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-standby-new-'));
    const standbyOldHubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-standby-oldhub-'));
    try {
      db.pragma('journal_mode = WAL');
      db.exec('create table entries (id integer primary key, body text)');
      db.prepare('insert into entries (body) values (?)').run('hello');

      // 1) Old host handover WITHOUT ?credentials=1 succeeds when hub has NO mcp-auth.enc (sends baseline only)
      const handoverNoMcp = await fetch(`${hub.url}${LAN_HUB_HANDOVER_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${hub.token}` },
      });
      expect(handoverNoMcp.status).toBe(200);
      const oldReceived = await readLanHubHandover(
        Readable.fromWeb(handoverNoMcp.body as WebReadableStream<Uint8Array>),
        destOldNoMcp
      );
      expect(oldReceived).not.toContain('env.json');
      expect(oldReceived).not.toContain('mcp-auth.enc');
      await fetch(`${hub.url}${LAN_HUB_HANDOVER_ABORT_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${hub.token}` },
      });

      // Now add MCP auth record so mcp-auth.enc exists on hub
      await putRecord('srv-handover', {
        target: HTTP_TARGET,
        settings: { mode: 'manual', bearerToken: 'handover-secret' },
      });

      // 2) Old host handover WITHOUT ?credentials=1 is rejected with 409 BEFORE stopping upstream
      const rejectedOld = await fetch(`${hub.url}${LAN_HUB_HANDOVER_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${hub.token}` },
      });
      expect(rejectedOld.status).toBe(409);
      expect(await rejectedOld.json()).toMatchObject({ error: 'upgrade_required' });
      // Hub stayed in serving state (never stopped upstream!)
      expect((await getStatus()).status).toBe(200);

      // 3) Old standby snapshot WITHOUT ?credentials=1 receives baseline side files only (no crash)
      const oldStandbyRes = await fetch(`${hub.url}${LAN_HUB_SNAPSHOT_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${hub.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ have: [] }),
      });
      expect(oldStandbyRes.status).toBe(200);
      const oldStandbyText = Buffer.from(await oldStandbyRes.arrayBuffer()).toString('latin1');
      expect(oldStandbyText).not.toContain('"name":"mcp-auth.enc"');
      expect(oldStandbyText).not.toContain('"name":"env.json"');

      // 4) New standby (pullLanHubSnapshot -> ?credentials=1) against New Hub receives env.json & mcp-auth.enc
      await pullLanHubSnapshot({
        hub: { url: hub.url, token: hub.token },
        directory: standbyNewDir,
      });
      const keptNew = readKeptLanHubSnapshot(standbyNewDir);
      expect(keptNew).not.toBeNull();
      expect(fs.existsSync(path.join(keptNew!.path, 'mcp-auth.enc'))).toBe(true);
      expect(fs.existsSync(path.join(keptNew!.path, 'env.json'))).toBe(true);
      expect(fs.readFileSync(path.join(keptNew!.path, 'env.json'), 'utf8')).toBe('{"FOO":"bar"}\n');

      // 5) New standby (sends ?credentials=1) against Old Hub (ignores query, sends baseline only) succeeds
      const oldHubFetch: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/lan/shares/copy') return new Response(null, { status: 404 });
        expect(url.searchParams.get('credentials')).toBe('1');
        const { have } = JSON.parse(String(init?.body)) as { have: string[] };
        const pipe = new PassThrough();
        // Simulate old hub ignoring ?credentials=1
        void writeLanHubSnapshot({ dataDir, have, stream: pipe, credentials: false });
        return new Response(Readable.toWeb(pipe) as ReadableStream<Uint8Array>, { status: 200 });
      };
      await pullLanHubSnapshot({
        hub: { url: hub.url, token: hub.token },
        directory: standbyOldHubDir,
        fetch: oldHubFetch,
      });
      const keptOldHub = readKeptLanHubSnapshot(standbyOldHubDir);
      expect(keptOldHub).not.toBeNull();
      expect(fs.existsSync(path.join(keptOldHub!.path, 'mcp-auth.enc'))).toBe(false);

      // 6) New host handover WITH ?shares=1&credentials=1 transfers both env.json & mcp-auth.enc
      const handoverNew = await fetch(`${hub.url}${LAN_HUB_HANDOVER_PATH}?shares=1&credentials=1`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${hub.token}` },
      });
      expect(handoverNew.status).toBe(200);
      const newReceived = await readLanHubHandover(
        Readable.fromWeb(handoverNew.body as WebReadableStream<Uint8Array>),
        destNewWithCreds
      );
      expect(newReceived).toContain('mcp-auth.enc');
      expect(newReceived).toContain('env.json');
      expect(fs.statSync(path.join(destNewWithCreds, 'mcp-auth.enc')).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(path.join(destNewWithCreds, 'env.json'), 'utf8')).toBe(
        '{"FOO":"bar"}\n'
      );

      // Direct helper check: writeLanHubHandover({ credentials: false }) omits extra files
      const streamBase = new PassThrough();
      const baseDest = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-handover-base-'));
      try {
        await Promise.all([
          writeLanHubHandover(dataDir, streamBase).then(() => streamBase.end()),
          readLanHubHandover(streamBase, baseDest),
        ]);
        expect(fs.existsSync(path.join(baseDest, 'mcp-auth.enc'))).toBe(false);
      } finally {
        fs.rmSync(baseDest, { recursive: true, force: true });
      }
    } finally {
      db.close();
      fs.rmSync(destOldNoMcp, { recursive: true, force: true });
      fs.rmSync(destNewWithCreds, { recursive: true, force: true });
      fs.rmSync(standbyNewDir, { recursive: true, force: true });
      fs.rmSync(standbyOldHubDir, { recursive: true, force: true });
    }
  });
});
