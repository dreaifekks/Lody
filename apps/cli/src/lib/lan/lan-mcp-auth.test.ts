import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerId, WorkspaceMcpServerMeta } from '@lody/shared';
import type { LanHub } from '@lody/shared/node/lan-hub';
import {
  makeMcpAuthenticationIO,
  type McpAuthenticationIO,
  type McpCallback,
  type McpRelayRequest,
} from '@/mcp/authentication/io';
import { readLanHubHandover, writeLanHubHandover } from './hub-handover';
import { startLanHubServer, type LanHubServer, type LanHubUpstream } from './hub-server';
import { LanMcpAuthentication } from './lan-mcp-auth';

const SERVER_ID = 'mcp-notion' as McpServerId;
const HTTP_ENTRY: WorkspaceMcpServerMeta = {
  id: SERVER_ID,
  name: 'Notion',
  transport: 'http',
  connection: {
    transport: 'http',
    url: 'https://resource.example/mcp',
    authentication: 'local',
  },
  createdAt: 1,
  updatedAt: 1,
};
const STDIO_ENTRY: WorkspaceMcpServerMeta = {
  id: 'mcp-stdio' as McpServerId,
  name: 'LocalTool',
  transport: 'stdio',
  connection: {
    transport: 'stdio',
    command: 'node',
    args: ['tool.js'],
    authentication: 'local',
  },
  createdAt: 1,
  updatedAt: 1,
};

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

function createFakeOAuthWorld() {
  const seenRemoteHeaders: Headers[] = [];
  const seenRemoteBodies: string[] = [];
  const refreshedTokens: string[] = [];
  let tokenVersion = 0;
  let nextRemoteResponses: Array<() => Response> = [];
  let failRefreshWithInvalidGrant = false;
  let requirePreconfiguredClient = false;
  let currentIssuer = 'https://issuer.example';

  const oauthFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(init?.redirect).toBe('error');
    expect(init?.credentials).toBe('omit');
    if (url.pathname.includes('oauth-protected-resource')) {
      return Response.json({
        resource: 'https://resource.example/mcp',
        authorization_servers: [currentIssuer],
        scopes_supported: ['tools'],
      });
    }
    if (url.pathname.includes('oauth-authorization-server')) {
      return Response.json({
        issuer: currentIssuer,
        authorization_endpoint: `${currentIssuer}/authorize`,
        token_endpoint: `${currentIssuer}/token`,
        ...(requirePreconfiguredClient
          ? {}
          : { registration_endpoint: `${currentIssuer}/register` }),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      });
    }
    if (url.pathname === '/register') {
      return Response.json({
        ...JSON.parse(String(init?.body)),
        client_id:
          currentIssuer === 'https://issuer.example' ? 'dcr-client-id' : 'dcr-client-id-new',
      });
    }
    if (url.pathname === '/token') {
      const params = new URLSearchParams(String(init?.body));
      if (params.get('grant_type') === 'refresh_token') {
        if (failRefreshWithInvalidGrant) {
          return Response.json(
            { error: 'invalid_grant', error_description: 'revoked' },
            { status: 400 }
          );
        }
        const rt = params.get('refresh_token') ?? '';
        if (refreshedTokens.includes(rt)) throw new Error('Single-use refresh token reused');
        refreshedTokens.push(rt);
        tokenVersion += 1;
        return Response.json({
          access_token: `rotated-access-v${tokenVersion}`,
          token_type: 'Bearer',
          refresh_token: `rotated-refresh-v${tokenVersion}`,
          expires_in: 3600,
        });
      }
      expect(params.get('code')).toBe('synthetic-auth-code');
      expect(params.get('code_verifier')?.length).toBeGreaterThanOrEqual(43);
      return Response.json({
        access_token: 'initial-access-v0',
        token_type: 'Bearer',
        refresh_token: 'initial-refresh-v0',
        expires_in: 3600,
      });
    }
    seenRemoteHeaders.push(new Headers(init?.headers));
    if (init?.body instanceof ArrayBuffer) {
      seenRemoteBodies.push(Buffer.from(init.body).toString('utf8'));
    } else if (typeof init?.body === 'string') {
      seenRemoteBodies.push(init.body);
    } else {
      seenRemoteBodies.push('');
    }
    const next = nextRemoteResponses.shift();
    if (next) return next();
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (method === 'GET') {
      return new Response(null, { status: 405 });
    }
    const rawBody =
      seenRemoteBodies.at(-1) || (input instanceof Request ? await input.clone().text() : '');
    try {
      const parsed = JSON.parse(rawBody) as {
        id?: unknown;
        method?: string;
        params?: { protocolVersion?: string };
      };
      if (parsed.method === 'server/discover') {
        return Response.json({
          jsonrpc: '2.0',
          id: parsed.id,
          error: { code: -32601, message: 'Method not found' },
        });
      }
      if (parsed.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: parsed.id,
          result: {
            protocolVersion: parsed.params?.protocolVersion ?? '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'srv', version: '1.0.0' },
          },
        });
      }
      if (parsed.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      if (parsed.method === 'tools/list') {
        return Response.json({ jsonrpc: '2.0', id: parsed.id, result: { tools: [] } });
      }
    } catch {
      // fall through to generic JSON-RPC response
    }
    return Response.json({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  };

  const makeMemberIo = () => {
    let callback = Promise.withResolvers<McpCallback>();
    let callbackWaiting = Promise.withResolvers<void>();
    let offer: ((job: McpRelayRequest) => boolean) | undefined;
    let closedCallbacks = 0;
    let closedRelays = 0;
    const base = makeMcpAuthenticationIO(oauthFetch);
    const io: McpAuthenticationIO = {
      ...base,
      callback: async () => {
        callback = Promise.withResolvers<McpCallback>();
        callbackWaiting = Promise.withResolvers<void>();
        return {
          redirectUrl: 'http://127.0.0.1:43210/callback',
          wait: (signal: AbortSignal) => {
            callbackWaiting.resolve();
            return new Promise<McpCallback>((resolve, reject) => {
              const abort = () => reject(new Error('cancelled'));
              signal.addEventListener('abort', abort, { once: true });
              callback.promise
                .then(resolve, reject)
                .finally(() => signal.removeEventListener('abort', abort));
              if (signal.aborted) abort();
            });
          },
          close: async () => {
            closedCallbacks += 1;
          },
        };
      },
      relay: async (accept) => {
        offer = accept;
        return {
          url: 'http://127.0.0.1:43211/mcp',
          capability: 'local-relay-cap',
          close: async () => {
            closedRelays += 1;
          },
        };
      },
    };
    return {
      io,
      resolveCallback: (value: McpCallback) => callback.resolve(value),
      waitForCallbackReady: () => callbackWaiting.promise,
      closedCallbacks: () => closedCallbacks,
      closedRelays: () => closedRelays,
      sendRelay: async (
        options: {
          method?: string;
          body?: string;
          headers?: Record<string, string>;
        } = {}
      ) => {
        if (!offer) throw new Error('Relay not started');
        const request = Object.assign(
          Readable.from(options.body !== undefined ? [options.body] : []),
          {
            method: options.method ?? 'POST',
            headers: {
              authorization: 'Bearer local-relay-cap',
              'content-type': 'application/json',
              ...options.headers,
            },
          }
        ) as unknown as IncomingMessage;
        let statusCode = 200;
        let responseHeaders: Record<string, string> = {};
        const stream = new PassThrough();
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        const finished = Promise.withResolvers<void>();
        stream.once('finish', () => finished.resolve());
        stream.once('close', () => finished.resolve());
        const response = Object.assign(stream, {
          headersSent: false,
          writeHead: (code: number, headers?: Record<string, string>) => {
            response.headersSent = true;
            statusCode = code;
            responseHeaders = Object.fromEntries(
              Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])
            );
            return response;
          },
        }) as unknown as ServerResponse;
        const accepted = offer({ request, response });
        expect(accepted).toBe(true);
        await finished.promise;
        return {
          status: statusCode,
          headers: responseHeaders,
          body: Buffer.concat(chunks).toString('utf8'),
        };
      },
    };
  };

  return {
    oauthFetch,
    hubIo: makeMcpAuthenticationIO(oauthFetch),
    seenRemoteHeaders,
    seenRemoteBodies,
    refreshedTokens,
    queueRemoteResponse: (factory: () => Response) => {
      nextRemoteResponses.push(factory);
    },
    setFailRefreshWithInvalidGrant: (value: boolean) => {
      failRefreshWithInvalidGrant = value;
    },
    setRequirePreconfiguredClient: (value: boolean) => {
      requirePreconfiguredClient = value;
    },
    setIssuer: (issuer: string) => {
      currentIssuer = issuer;
    },
    makeMemberIo,
  };
}

describe('LanMcpAuthentication member integration', () => {
  let hubDir: string;
  let hub: LanHubServer;
  let nowMs: number;
  let world: ReturnType<typeof createFakeOAuthWorld>;

  beforeEach(async () => {
    hubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-mcp-member-hub-'));
    nowMs = 1_700_000_000_000;
    world = createFakeOAuthWorld();
    hub = await startLanHubServer({
      host: '127.0.0.1',
      port: 0,
      sharePort: null,
      dataDir: hubDir,
      startUpstream: startFakeUpstream,
      mcpAuthIo: world.hubIo,
      now: () => nowMs,
    });
  });

  afterEach(async () => {
    await hub.close();
    fs.rmSync(hubDir, { recursive: true, force: true });
  });

  const activeHub = (): Pick<LanHub, 'url' | 'token'> => ({ url: hub.url, token: hub.token });

  it('authorizes on desktop member A, serves headless member B with zero keyring, refreshes on 401, and passes through MCP 404/405 while redacting 500/401', async () => {
    const desktopIo = world.makeMemberIo();
    const headlessIo = world.makeMemberIo();
    const desktop = new LanMcpAuthentication({
      userId: 'lan-user',
      resolveHub: activeHub,
      io: desktopIo.io,
      now: () => nowMs,
    });
    const headless = new LanMcpAuthentication({
      userId: 'lan-user',
      resolveHub: activeHub,
      io: headlessIo.io,
      now: () => nowMs,
    });
    try {
      // Desktop starts OAuth interactive flow
      const waiting = await desktop.request({
        machineId: 'mac-desktop',
        workspaceId: 'ws-lan',
        method: 'mcp/authentication',
        params: { requesterUserId: 'lan-user', action: 'authorize', server: HTTP_ENTRY },
      });
      expect(waiting.status).toBe('waiting');
      expect(waiting.mode).toBe('oauth');
      expect(waiting.authorizationUrl).toContain('https://issuer.example/authorize');
      await desktopIo.waitForCallbackReady();

      // Status reports waiting without re-exposing authorizationUrl
      expect(await desktop.status(HTTP_ENTRY)).toMatchObject({
        status: 'waiting',
        mode: 'oauth',
        attemptId: waiting.attemptId,
      });

      desktopIo.resolveCallback({ code: 'synthetic-auth-code' });
      // Wait for desktop callback worker to save record to Hub
      await vi.waitFor(async () => {
        const st = await headless.status(HTTP_ENTRY);
        expect(st).toEqual({
          type: 'mcp/authentication',
          status: 'authorized',
          hasCredentials: true,
          mode: 'oauth',
        });
      });
      expect(desktopIo.closedCallbacks()).toBe(1);

      // Headless Linux member prepares session relay without touching keyring
      const resolved = {
        type: 'http' as const,
        name: HTTP_ENTRY.name,
        url: 'https://resource.example/mcp',
        headers: [],
      };
      const connection = await headless.prepare(HTTP_ENTRY, resolved, 'session-1', 'lan-user');
      expect(JSON.stringify(connection)).not.toContain('initial-access-v0');
      expect(JSON.stringify(connection)).not.toContain('initial-refresh-v0');

      // Normal 200 MCP request gets Bearer access token injected
      const ok = await headlessIo.sendRelay({
        method: 'POST',
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        headers: { cookie: 'must-be-stripped' },
      });
      expect(ok.status).toBe(200);
      expect(world.seenRemoteHeaders[0]?.get('authorization')).toBe('Bearer initial-access-v0');
      expect(world.seenRemoteHeaders[0]?.get('cookie')).toBeNull();

      // Upstream 401 -> headless asks Hub with failedRevision -> Hub refreshes once -> replay succeeds
      world.queueRemoteResponse(() => new Response('unauthorized secret detail', { status: 401 }));
      world.queueRemoteResponse(() => Response.json({ jsonrpc: '2.0', id: 2, result: 'replayed' }));
      const replayed = await headlessIo.sendRelay({
        method: 'POST',
        body: '{"jsonrpc":"2.0","id":2,"method":"tools/call"}',
      });
      expect(replayed.status).toBe(200);
      expect(replayed.body).toContain('replayed');
      expect(world.refreshedTokens).toEqual(['initial-refresh-v0']);
      expect(world.seenRemoteHeaders[2]?.get('authorization')).toBe('Bearer rotated-access-v1');
      expect(world.seenRemoteBodies[2]).toBe('{"jsonrpc":"2.0","id":2,"method":"tools/call"}');

      // Fix #2: 404 (expired Mcp-Session-Id) passes through 404 + safe headers, redacts body & unsafe headers
      world.queueRemoteResponse(
        () =>
          new Response('upstream-secret-internal-404-body', {
            status: 404,
            headers: {
              'mcp-session-id': 'sess-expired',
              'mcp-protocol-version': '2025-03-26',
              'x-internal-secret': 'leak-me-not',
            },
          })
      );
      const res404 = await headlessIo.sendRelay({ method: 'POST', body: '{}' });
      expect(res404.status).toBe(404);
      expect(res404.headers['mcp-session-id']).toBe('sess-expired');
      expect(res404.headers['mcp-protocol-version']).toBe('2025-03-26');
      expect(res404.headers['x-internal-secret']).toBeUndefined();
      expect(res404.body).not.toContain('upstream-secret-internal-404-body');

      // Fix #2: 405 (GET /mcp SSE unsupported) passes through 405 + allow header, redacts body
      world.queueRemoteResponse(
        () =>
          new Response('upstream-secret-internal-405-body', {
            status: 405,
            headers: {
              allow: 'POST, DELETE',
              'mcp-protocol-version': '2025-03-26',
              'set-cookie': 'secret-cookie=1',
            },
          })
      );
      const res405 = await headlessIo.sendRelay({ method: 'GET' });
      expect(res405.status).toBe(405);
      expect(res405.headers.allow).toBe('POST, DELETE');
      expect(res405.headers['set-cookie']).toBeUndefined();
      expect(res405.body).not.toContain('upstream-secret-internal-405-body');

      // Upstream 500 is redacted to 503
      world.queueRemoteResponse(() => new Response('stack trace with secret', { status: 500 }));
      const res500 = await headlessIo.sendRelay({ method: 'POST', body: '{}' });
      expect(res500.status).toBe(503);
      expect(res500.body).not.toContain('stack trace');

      // Upstream 401 when Hub refresh fails (invalid_grant) returns redacted 503 (never leaks 401)
      world.setFailRefreshWithInvalidGrant(true);
      world.queueRemoteResponse(() => new Response('invalid token secret', { status: 401 }));
      const res401Fail = await headlessIo.sendRelay({ method: 'POST', body: '{}' });
      expect(res401Fail.status).toBe(503);
      expect(res401Fail.body).not.toContain('invalid token secret');

      // Signout deletes from Hub and revokes local leases
      const signedOut = await headless.request({
        machineId: 'linux-headless',
        workspaceId: 'ws-lan',
        method: 'mcp/authentication',
        params: { requesterUserId: 'lan-user', action: 'signout', server: HTTP_ENTRY },
      });
      expect(signedOut).toEqual({
        type: 'mcp/authentication',
        status: 'required',
        hasCredentials: false,
      });
      expect(headlessIo.closedRelays()).toBe(1);
      expect(await desktop.status(HTTP_ENTRY)).toEqual({
        type: 'mcp/authentication',
        status: 'required',
        hasCredentials: false,
      });

      // Release prevents future prepare for the closed owner
      await headless.release('session-1');
      await expect(headless.prepare(HTTP_ENTRY, resolved, 'session-1', 'lan-user')).rejects.toThrow(
        'cancelled'
      );
    } finally {
      await desktop.close();
      await headless.close();
    }
  });

  it('supports manual stdio env, OAuth cancellation/late-exchange discard, lanEnv target normalization, and dynamic hub failover', async () => {
    const lanEnvValues: Record<string, string> = { MCP_HOST: 'resource.example' };
    let currentHub: Pick<LanHub, 'url' | 'token'> | null = activeHub();
    const memberIo = world.makeMemberIo();
    const member = new LanMcpAuthentication({
      userId: 'lan-user',
      resolveHub: () => currentHub,
      lanEnv: () => lanEnvValues,
      env: () => ({}),
      io: memberIo.io,
      now: () => nowMs,
    });
    const envEntry: WorkspaceMcpServerMeta = {
      ...HTTP_ENTRY,
      id: 'mcp-env-http' as McpServerId,
      connection: {
        transport: 'http',
        url: 'https://${MCP_HOST}/mcp',
        authentication: 'local',
      },
    };
    let hub2: LanHubServer | undefined;
    let hub2Dir: string | undefined;
    try {
      // Account mismatch is rejected
      await expect(
        member.request({
          machineId: 'm1',
          workspaceId: 'ws-lan',
          method: 'mcp/authentication',
          params: { requesterUserId: 'other-user', action: 'status', server: HTTP_ENTRY },
        })
      ).rejects.toThrow('account mismatch');
      await expect(member.listTools(HTTP_ENTRY, 'other-user')).rejects.toThrow('account mismatch');

      // Manual stdio env configure & prepare merge
      const stdioConfigured = await member.request({
        machineId: 'm1',
        workspaceId: 'ws-lan',
        method: 'mcp/authentication',
        params: {
          requesterUserId: 'lan-user',
          action: 'configure',
          server: STDIO_ENTRY,
          authentication: { mode: 'manual', env: { SECRET_KEY: 'stdio-hub-secret' } },
        },
      });
      expect(stdioConfigured).toEqual({
        type: 'mcp/authentication',
        status: 'authorized',
        hasCredentials: true,
        mode: 'manual',
      });
      const preparedStdio = await member.prepare(
        STDIO_ENTRY,
        {
          name: STDIO_ENTRY.name,
          command: 'node',
          args: ['tool.js'],
          env: [{ name: 'BASE', value: '1' }],
        },
        'stdio-owner',
        'lan-user'
      );
      expect(preparedStdio).toEqual({
        name: STDIO_ENTRY.name,
        command: 'node',
        args: ['tool.js'],
        env: [
          { name: 'BASE', value: '1' },
          { name: 'SECRET_KEY', value: 'stdio-hub-secret' },
        ],
      });

      // lanEnv resolves https://${MCP_HOST}/mcp target and invalidates when lanEnv changes
      await member.request({
        machineId: 'm1',
        workspaceId: 'ws-lan',
        method: 'mcp/authentication',
        params: {
          requesterUserId: 'lan-user',
          action: 'configure',
          server: envEntry,
          authentication: { mode: 'manual', bearerToken: 'env-bound-token' },
        },
      });
      expect(await member.status(envEntry)).toMatchObject({
        status: 'authorized',
        hasCredentials: true,
        mode: 'manual',
      });
      lanEnvValues.MCP_HOST = 'other.example';
      expect(await member.status(envEntry)).toMatchObject({
        status: 'required',
        hasCredentials: false,
      });
      await expect(
        member.prepare(
          envEntry,
          { type: 'http', name: envEntry.name, url: 'https://other.example/mcp', headers: [] },
          'owner-2',
          'lan-user'
        )
      ).rejects.toThrow('oauth_required');
      lanEnvValues.MCP_HOST = 'resource.example';

      // Cancel preserves existing manual sign-in and closes callback listener
      const replaceAttempt = await member.request({
        machineId: 'm1',
        workspaceId: 'ws-lan',
        method: 'mcp/authentication',
        params: { requesterUserId: 'lan-user', action: 'authorize', server: envEntry },
      });
      expect(replaceAttempt.status).toBe('waiting');
      await memberIo.waitForCallbackReady();
      const cancelled = await member.request({
        machineId: 'm1',
        workspaceId: 'ws-lan',
        method: 'mcp/authentication',
        params: {
          requesterUserId: 'lan-user',
          action: 'cancel',
          server: envEntry,
          attemptId: replaceAttempt.attemptId,
        },
      });
      expect(cancelled).toEqual({
        type: 'mcp/authentication',
        status: 'authorized',
        hasCredentials: true,
        mode: 'manual',
      });
      expect(memberIo.closedCallbacks()).toBe(1);

      // listTools 401 Bearer challenge triggers observe() -> oauth_required
      const unconfigured: WorkspaceMcpServerMeta = {
        ...HTTP_ENTRY,
        id: 'mcp-probe' as McpServerId,
        connection: { transport: 'http', url: 'https://resource.example/mcp' },
      };
      world.queueRemoteResponse(
        () =>
          new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="https://resource.example/.well-known/oauth-protected-resource/mcp"',
            },
          })
      );
      await expect(member.listTools(unconfigured, 'lan-user')).rejects.toThrow();
      expect(await member.status(unconfigured)).toEqual({
        type: 'mcp/authentication',
        status: 'required',
        hasCredentials: false,
        reason: 'oauth_required',
      });

      // Dynamic Hub Failover: hand over hubDir -> hub2Dir, close hub 1, switch resolveHub -> hub2
      hub2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-mcp-failover-hub2-'));
      const handoverStream = new PassThrough();
      await Promise.all([
        writeLanHubHandover(hubDir, handoverStream, { credentials: true }).then(() =>
          handoverStream.end()
        ),
        readLanHubHandover(handoverStream, hub2Dir),
      ]);
      await hub.close();

      // While hub is away (null), status returns clear connection_failed error without touching keyring
      currentHub = null;
      expect(await member.status(envEntry)).toEqual({
        type: 'mcp/authentication',
        status: 'error',
        hasCredentials: false,
        reason: 'connection_failed',
      });

      // Hub 2 comes up from handed-over dataDir and member automatically follows via resolveHub()
      hub2 = await startLanHubServer({
        host: '127.0.0.1',
        port: 0,
        sharePort: null,
        dataDir: hub2Dir,
        startUpstream: startFakeUpstream,
        mcpAuthIo: world.hubIo,
        now: () => nowMs,
      });
      currentHub = { url: hub2.url, token: hub2.token };
      expect(await member.status(envEntry)).toEqual({
        type: 'mcp/authentication',
        status: 'authorized',
        hasCredentials: true,
        mode: 'manual',
      });
      const failoverConn = await member.prepare(
        envEntry,
        { type: 'http', name: envEntry.name, url: 'https://resource.example/mcp', headers: [] },
        'failover-owner',
        'lan-user'
      );
      expect(failoverConn.type).toBe('http');
      const resAfterFailover = await memberIo.sendRelay({ method: 'POST', body: '{}' });
      expect(resAfterFailover.status).toBe(200);
      expect(world.seenRemoteHeaders.at(-1)?.get('authorization')).toBe('Bearer env-bound-token');
    } finally {
      await member.close();
      await hub2?.close();
      if (hub2Dir) fs.rmSync(hub2Dir, { recursive: true, force: true });
    }
  });

  it('supports preconfigured OAuth clientId/clientSecret and discards late token exchange results after cancel', async () => {
    world.setRequirePreconfiguredClient(true);
    const memberIo = world.makeMemberIo();
    const member = new LanMcpAuthentication({
      userId: 'lan-user',
      resolveHub: activeHub,
      io: memberIo.io,
      now: () => nowMs,
    });
    try {
      // Without DCR or clientId -> client_required
      const missingClient = await member.request({
        machineId: 'm1',
        workspaceId: 'ws-lan',
        method: 'mcp/authentication',
        params: { requesterUserId: 'lan-user', action: 'authorize', server: HTTP_ENTRY },
      });
      expect(missingClient).toEqual({
        type: 'mcp/authentication',
        status: 'error',
        hasCredentials: false,
        reason: 'client_required',
      });

      // Configure OAuth clientId + clientSecret -> authorize succeeds
      const configured = await member.request({
        machineId: 'm1',
        workspaceId: 'ws-lan',
        method: 'mcp/authentication',
        params: {
          requesterUserId: 'lan-user',
          action: 'configure',
          server: HTTP_ENTRY,
          authentication: {
            mode: 'oauth',
            clientId: 'preconf-client',
            clientSecret: 'preconf-secret-never-sent-back',
          },
        },
      });
      expect(configured).toEqual({
        type: 'mcp/authentication',
        status: 'required',
        hasCredentials: false,
        mode: 'oauth',
      });

      // Intercept code exchange to verify cancellation discards late tokens
      const exchanging = Promise.withResolvers<void>();
      const late = Promise.withResolvers<Awaited<ReturnType<McpAuthenticationIO['authorize']>>>();
      const realAuthorize = memberIo.io.authorize;
      memberIo.io.authorize = async (record, options) => {
        if (!options.code) return realAuthorize(record, options);
        exchanging.resolve();
        return late.promise;
      };

      const waiting = await member.request({
        machineId: 'm1',
        workspaceId: 'ws-lan',
        method: 'mcp/authentication',
        params: { requesterUserId: 'lan-user', action: 'authorize', server: HTTP_ENTRY },
      });
      expect(waiting.status).toBe('waiting');
      expect(waiting.authorizationUrl).toContain('client_id=preconf-client');
      await memberIo.waitForCallbackReady();
      memberIo.resolveCallback({ code: 'synthetic-auth-code' });
      await exchanging.promise;

      const cancelled = await member.request({
        machineId: 'm1',
        workspaceId: 'ws-lan',
        method: 'mcp/authentication',
        params: {
          requesterUserId: 'lan-user',
          action: 'cancel',
          server: HTTP_ENTRY,
          attemptId: waiting.attemptId,
        },
      });
      expect(cancelled).toMatchObject({
        status: 'required',
        hasCredentials: false,
        reason: 'cancelled',
      });

      late.resolve({
        record: {
          target: JSON.stringify(HTTP_ENTRY.connection),
          settings: { mode: 'oauth', clientId: 'preconf-client', clientSecret: 'preconf-secret' },
          tokens: { access_token: 'late-discarded-token', token_type: 'Bearer' },
        },
      });
      await late.promise;

      // Late token was NOT written to Hub
      expect(await member.status(HTTP_ENTRY)).toMatchObject({
        status: 'required',
        hasCredentials: false,
      });
      expect(memberIo.closedCallbacks()).toBe(2);

      // Re-authorizing from a brand-new desktop instance (simulating daemon restart / another desktop)
      // fetches the preconfigured clientId/clientSecret from Hub via /authorize-config
      const desktop2Io = world.makeMemberIo();
      const desktop2 = new LanMcpAuthentication({
        userId: 'lan-user',
        resolveHub: activeHub,
        io: desktop2Io.io,
        now: () => nowMs,
      });
      try {
        const waiting2 = await desktop2.request({
          machineId: 'm2',
          workspaceId: 'ws-lan',
          method: 'mcp/authentication',
          params: { requesterUserId: 'lan-user', action: 'authorize', server: HTTP_ENTRY },
        });
        expect(waiting2.status).toBe('waiting');
        expect(waiting2.authorizationUrl).toContain('client_id=preconf-client');
        await desktop2Io.waitForCallbackReady();
        desktop2Io.resolveCallback({ code: 'synthetic-auth-code' });
        await vi.waitFor(async () => {
          expect(await desktop2.status(HTTP_ENTRY)).toEqual({
            type: 'mcp/authentication',
            status: 'authorized',
            hasCredentials: true,
            mode: 'oauth',
          });
        });

        // If the MCP server later migrates to a new OAuth issuer with DCR enabled,
        // re-authorizing drops the stale DCR client instead of failing issuer check
        world.setRequirePreconfiguredClient(false);
        await desktop2.request({
          machineId: 'm2',
          workspaceId: 'ws-lan',
          method: 'mcp/authentication',
          params: { requesterUserId: 'lan-user', action: 'signout', server: HTTP_ENTRY },
        });
        const waitingDcr1 = await desktop2.request({
          machineId: 'm2',
          workspaceId: 'ws-lan',
          method: 'mcp/authentication',
          params: { requesterUserId: 'lan-user', action: 'authorize', server: HTTP_ENTRY },
        });
        expect(waitingDcr1.authorizationUrl).toContain('client_id=dcr-client-id');
        await desktop2Io.waitForCallbackReady();
        desktop2Io.resolveCallback({ code: 'synthetic-auth-code' });
        await vi.waitFor(async () => {
          expect(await desktop2.status(HTTP_ENTRY)).toMatchObject({ status: 'authorized' });
        });

        world.setIssuer('https://new-issuer.example');
        const waitingDcr2 = await desktop2.request({
          machineId: 'm2',
          workspaceId: 'ws-lan',
          method: 'mcp/authentication',
          params: { requesterUserId: 'lan-user', action: 'authorize', server: HTTP_ENTRY },
        });
        expect(waitingDcr2.status).toBe('waiting');
        expect(waitingDcr2.authorizationUrl).toContain('https://new-issuer.example/authorize');
        expect(waitingDcr2.authorizationUrl).toContain('client_id=dcr-client-id-new');
        await desktop2Io.waitForCallbackReady();
        desktop2Io.resolveCallback({ code: 'synthetic-auth-code' });
        await vi.waitFor(async () => {
          expect(await desktop2.status(HTTP_ENTRY)).toMatchObject({
            status: 'authorized',
            hasCredentials: true,
            mode: 'oauth',
          });
        });
      } finally {
        await desktop2.close();
      }
    } finally {
      await member.close();
    }
  });

  it('expires manual relay cache within 30s on cross-machine signout, invalidates immediately on hub switch, and surfaces oauth_required when manual credentials hit a 401 OAuth challenge', async () => {
    let activeHubTarget: Pick<LanHub, 'url' | 'token'> = activeHub();
    const memberAIo = world.makeMemberIo();
    const memberBIo = world.makeMemberIo();
    const memberA = new LanMcpAuthentication({
      userId: 'lan-user',
      resolveHub: activeHub,
      io: memberAIo.io,
      now: () => nowMs,
    });
    const memberB = new LanMcpAuthentication({
      userId: 'lan-user',
      resolveHub: () => activeHubTarget,
      io: memberBIo.io,
      now: () => nowMs,
    });
    let hub2: LanHubServer | undefined;
    let hub2Dir: string | undefined;
    const resolved = {
      type: 'http' as const,
      name: HTTP_ENTRY.name,
      url: 'https://resource.example/mcp',
      headers: [],
    };
    try {
      // Member A configures manual token v1 -> Member B starts relay and forwards with token-v1
      await memberA.request({
        machineId: 'mA',
        workspaceId: 'ws-lan',
        method: 'mcp/authentication',
        params: {
          requesterUserId: 'lan-user',
          action: 'configure',
          server: HTTP_ENTRY,
          authentication: { mode: 'manual', bearerToken: 'manual-token-v1' },
        },
      });
      await memberB.prepare(HTTP_ENTRY, resolved, 'relay-owner', 'lan-user');
      const r1 = await memberBIo.sendRelay({ method: 'POST', body: '{}' });
      expect(r1.status).toBe(200);
      expect(world.seenRemoteHeaders.at(-1)?.get('authorization')).toBe('Bearer manual-token-v1');

      // Suggestion #2: manual token hitting 401 OAuth Bearer challenge in listTools overrides status to oauth_required
      expect(await memberB.status(HTTP_ENTRY)).toEqual({
        type: 'mcp/authentication',
        status: 'authorized',
        hasCredentials: true,
        mode: 'manual',
      });
      world.queueRemoteResponse(
        () =>
          new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="https://resource.example/.well-known/oauth-protected-resource/mcp"',
            },
          })
      );
      await expect(memberB.listTools(HTTP_ENTRY, 'lan-user')).rejects.toThrow();
      expect(await memberB.status(HTTP_ENTRY)).toEqual({
        type: 'mcp/authentication',
        status: 'required',
        hasCredentials: false,
        reason: 'oauth_required',
      });

      // If the same credential revision succeeds on a subsequent listTools call, clear the stale challenge
      await memberB.listTools(HTTP_ENTRY, 'lan-user');
      expect(await memberB.status(HTTP_ENTRY)).toEqual({
        type: 'mcp/authentication',
        status: 'authorized',
        hasCredentials: true,
        mode: 'manual',
      });

      // Trigger 401 OAuth challenge again, then verify advancing Hub revision also clears it
      world.queueRemoteResponse(
        () =>
          new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="https://resource.example/.well-known/oauth-protected-resource/mcp"',
            },
          })
      );
      await expect(memberB.listTools(HTTP_ENTRY, 'lan-user')).rejects.toThrow();
      expect(await memberB.status(HTTP_ENTRY)).toEqual({
        type: 'mcp/authentication',
        status: 'required',
        hasCredentials: false,
        reason: 'oauth_required',
      });

      // Updating credentials on Hub advances revision -> clears stale revision-bound oauth_required
      await memberA.request({
        machineId: 'mA',
        workspaceId: 'ws-lan',
        method: 'mcp/authentication',
        params: {
          requesterUserId: 'lan-user',
          action: 'configure',
          server: HTTP_ENTRY,
          authentication: { mode: 'manual', bearerToken: 'manual-token-v2' },
        },
      });
      expect(await memberB.status(HTTP_ENTRY)).toEqual({
        type: 'mcp/authentication',
        status: 'authorized',
        hasCredentials: true,
        mode: 'manual',
      });

      // Advance 30s TTL -> Member B's running relay picks up manual-token-v2
      nowMs += 30_000;
      const r2 = await memberBIo.sendRelay({ method: 'POST', body: '{}' });
      expect(r2.status).toBe(200);
      expect(world.seenRemoteHeaders.at(-1)?.get('authorization')).toBe('Bearer manual-token-v2');

      // Switch to Hub 2 holding manual-token-hub2 -> Member B IMMEDIATELY invalidates cache (no 30s wait)
      hub2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-mcp-switch-hub2-'));
      hub2 = await startLanHubServer({
        host: '127.0.0.1',
        port: 0,
        sharePort: null,
        dataDir: hub2Dir,
        startUpstream: startFakeUpstream,
        mcpAuthIo: world.hubIo,
        now: () => nowMs,
      });
      const hub2Target = { url: hub2.url, token: hub2.token };
      const memberHub2 = new LanMcpAuthentication({
        userId: 'lan-user',
        resolveHub: () => hub2Target,
        io: world.makeMemberIo().io,
        now: () => nowMs,
      });
      try {
        await memberHub2.request({
          machineId: 'mA',
          workspaceId: 'ws-lan',
          method: 'mcp/authentication',
          params: {
            requesterUserId: 'lan-user',
            action: 'configure',
            server: HTTP_ENTRY,
            authentication: { mode: 'manual', bearerToken: 'manual-token-hub2' },
          },
        });
      } finally {
        await memberHub2.close();
      }
      activeHubTarget = hub2Target;
      const rHub2 = await memberBIo.sendRelay({ method: 'POST', body: '{}' });
      expect(rHub2.status).toBe(200);
      expect(world.seenRemoteHeaders.at(-1)?.get('authorization')).toBe('Bearer manual-token-hub2');

      // Cross-machine signout on Hub 1 + switch back -> after 30s TTL, running relay fails closed (503)
      activeHubTarget = activeHub();
      const rBack = await memberBIo.sendRelay({ method: 'POST', body: '{}' });
      expect(rBack.status).toBe(200);
      await memberA.request({
        machineId: 'mA',
        workspaceId: 'ws-lan',
        method: 'mcp/authentication',
        params: { requesterUserId: 'lan-user', action: 'signout', server: HTTP_ENTRY },
      });
      nowMs += 30_000;
      const rAfterSignout = await memberBIo.sendRelay({ method: 'POST', body: '{}' });
      expect(rAfterSignout.status).toBe(503);
    } finally {
      await memberA.close();
      await memberB.close();
      await hub2?.close();
      if (hub2Dir) fs.rmSync(hub2Dir, { recursive: true, force: true });
    }
  });
});
