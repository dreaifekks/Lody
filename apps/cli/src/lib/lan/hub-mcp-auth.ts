// Central LAN Hub custody for MCP authentication (OAuth 2.1 + manual).
//
// Credentials are stored encrypted at rest in `<dataDir>/mcp-auth.enc` using an
// AES-256-GCM key HKDF-derived from the hub token. Over the wire, credential
// payloads travel in AES-256-GCM envelopes using a distinct HKDF-derived key
// behind the hub's Bearer gate. OAuth refresh runs exclusively on the hub under
// a per-serverId mutex so `refresh_token` never leaves the hub and concurrent
// 401/near-expiry storms collapse to a single rotation.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/client';
import { z } from 'zod';
import {
  makeMcpAuthenticationIO,
  McpStoredAuthenticationSchema,
  type McpAuthenticationIO,
  type McpStoredAuthentication,
} from '@/mcp/authentication/io';
import {
  decryptLanMcpAuthJson,
  deriveLanMcpAuthKey,
  encryptLanMcpAuthJson,
  hashLanMcpAuthTarget,
  LAN_HUB_MCP_AUTH_AUTHORIZE_CONFIG_PREFIX,
  LAN_HUB_MCP_AUTH_PREFIX,
  LAN_HUB_MCP_AUTH_RECORDS_PREFIX,
  LAN_HUB_MCP_AUTH_STATUS_PATH,
  LAN_HUB_MCP_AUTH_TOKEN_PREFIX,
  LAN_MCP_AUTH_FILE_NAME,
  LanMcpAuthAuthorizeConfigRequestSchema,
  LanMcpAuthAuthorizeConfigResponseSchema,
  LanMcpAuthPutRecordPayloadSchema,
  LanMcpAuthTokenRequestSchema,
  LanMcpAuthTokenResponseSchema,
  mcpAuthAtRestAad,
  mcpAuthAuthorizeConfigRequestAad,
  mcpAuthAuthorizeConfigResponseAad,
  mcpAuthPutRecordRequestAad,
  mcpAuthTokenRequestAad,
  mcpAuthTokenResponseAad,
  type LanMcpAuthAuthorizeConfigResponse,
  type LanMcpAuthDeleteRecordResponse,
  type LanMcpAuthPutRecordResponse,
  type LanMcpAuthRefreshError,
  type LanMcpAuthStatusItem,
  type LanMcpAuthStatusResponse,
  type LanMcpAuthTokenResponse,
} from './lan-mcp-auth-crypto';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_SERVER_ID_LENGTH = 256;
const REFRESH_SKEW_MS = 30_000;
const REFRESH_TIMEOUT_MS = 30_000;
const BODY_READ_TIMEOUT_MS = 30_000;

const StoredEntrySchema = z
  .object({
    revision: z.number().int().positive(),
    record: McpStoredAuthenticationSchema,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
type StoredEntry = z.infer<typeof StoredEntrySchema>;

const StoredFileSchema = z
  .object({
    version: z.literal(1),
    nextRevision: z.number().int().positive().optional(),
    records: z.record(z.string(), StoredEntrySchema),
  })
  .strict();

export type LanHubMcpAuth = {
  handles(url: string | undefined): boolean;
  handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void>;
  /** Rejects new MCP auth requests while the hub is handing over or moved. */
  beginHandover(): void;
  /** Re-admits MCP auth requests when an aborted handover resumes serving here. */
  resumeHandover(): void;
  /** Whether this hub holds MCP authentication state (in memory or `mcp-auth.enc`). */
  hasRecords(): boolean;
  /** Waits for all in-flight requests/mutations and flushes any pending persist before handover. */
  idle(): Promise<void>;
  /** Aborts in-flight upstream refreshes when the hub closes. */
  close(): void;
};

export type LanHubMcpAuthOptions = {
  dataDir: string;
  token: string;
  io?: McpAuthenticationIO;
  now?: () => number;
  bodyTimeoutMs?: number;
  log?: (line: string) => void;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
  }
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(
  request: http.IncomingMessage,
  timeoutMs: number,
  signal: AbortSignal
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    request.destroy();
  }, timeoutMs);
  timer.unref?.();
  const onAbort = () => {
    request.destroy();
  };
  if (signal.aborted) {
    clearTimeout(timer);
    throw new HttpError(503, 'moving');
  }
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of request) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += part.length;
      if (bytes > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large');
      chunks.push(part);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (timedOut) throw new HttpError(408, 'request_timeout');
    if (signal.aborted) throw new HttpError(503, 'moving');
    throw new HttpError(400, 'invalid_json');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
  if (timedOut) throw new HttpError(408, 'request_timeout');
  if (signal.aborted) throw new HttpError(503, 'moving');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

function parseServerIdSegment(pathname: string, prefix: string): string {
  const raw = pathname.slice(prefix.length);
  if (!raw || raw.includes('/')) throw new HttpError(400, 'invalid_server_id');
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'invalid_server_id');
  }
  if (!decoded || decoded.length > MAX_SERVER_ID_LENGTH) {
    throw new HttpError(400, 'invalid_server_id');
  }
  return decoded;
}

function hasRecordCredentials(record: McpStoredAuthentication): boolean {
  if (record.settings.mode === 'oauth') return Boolean(record.tokens);
  return Boolean(
    record.settings.bearerToken ||
    Object.keys(record.settings.headers ?? {}).length > 0 ||
    Object.keys(record.settings.env ?? {}).length > 0
  );
}

function toStatusItem(
  entry: StoredEntry,
  refreshError?: LanMcpAuthRefreshError
): LanMcpAuthStatusItem {
  return {
    mode: entry.record.settings.mode,
    targetHash: hashLanMcpAuthTarget(entry.record.target),
    hasTokens: Boolean(entry.record.tokens),
    hasRefreshToken: Boolean(entry.record.tokens?.refresh_token),
    hasCredentials: hasRecordCredentials(entry.record),
    ...(entry.record.expiresAt !== undefined ? { expiresAt: entry.record.expiresAt } : {}),
    hasClient: Boolean(entry.record.client?.client_id || entry.record.settings.clientId),
    revision: entry.revision,
    updatedAt: entry.updatedAt,
    ...(refreshError ? { refreshError } : {}),
  };
}

function buildOAuthHeaders(record: McpStoredAuthentication): Record<string, string> {
  const headers = Object.fromEntries(
    Object.entries(record.settings.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  headers.authorization = `Bearer ${record.tokens!.access_token}`;
  return headers;
}

function buildManualCredentials(record: McpStoredAuthentication): {
  headers?: Record<string, string>;
  env?: Record<string, string>;
} {
  const headers = Object.fromEntries(
    Object.entries(record.settings.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  if (record.settings.bearerToken) {
    headers.authorization = `Bearer ${record.settings.bearerToken}`;
  }
  const env = record.settings.env ? { ...record.settings.env } : undefined;
  return {
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
  };
}

function extractHttpTargetUrl(target: string): string | null {
  try {
    const parsed = JSON.parse(target) as { transport?: unknown; url?: unknown };
    if (parsed.transport === 'http' && typeof parsed.url === 'string' && parsed.url.length > 0) {
      return parsed.url;
    }
    return null;
  } catch {
    return null;
  }
}

function classifyRefreshError(error: unknown): 'expired' | 'oauth_required' | 'connection_failed' {
  if (error instanceof OAuthError) {
    switch (error.code) {
      case OAuthErrorCode.InvalidGrant:
      case OAuthErrorCode.InvalidToken:
        return 'expired';
      case OAuthErrorCode.InvalidClient:
      case OAuthErrorCode.UnauthorizedClient:
      case OAuthErrorCode.AccessDenied:
      case OAuthErrorCode.InvalidScope:
      case OAuthErrorCode.InsufficientScope:
      case OAuthErrorCode.InvalidTarget:
      case OAuthErrorCode.UnsupportedGrantType:
        return 'oauth_required';
      default:
        return 'connection_failed';
    }
  }
  if (error instanceof Error) {
    if (error.message === 'MCP authorization is required.') return 'expired';
    if (
      error.name === 'AuthorizationServerMismatchError' ||
      error.message.includes('MCP authorization server changed')
    ) {
      return 'oauth_required';
    }
  }
  return 'connection_failed';
}

export function createLanHubMcpAuth(options: LanHubMcpAuthOptions): LanHubMcpAuth {
  const atRestKey = deriveLanMcpAuthKey(options.token, 'at-rest');
  const wireKey = deriveLanMcpAuthKey(options.token, 'wire');
  const atRestAad = mcpAuthAtRestAad();
  const io = options.io ?? makeMcpAuthenticationIO();
  const now = options.now ?? Date.now;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? BODY_READ_TIMEOUT_MS;
  const filePath = path.join(options.dataDir, LAN_MCP_AUTH_FILE_NAME);
  const shutdown = new AbortController();

  const records = new Map<string, StoredEntry>();
  const refreshErrors = new Map<string, LanMcpAuthRefreshError>();
  const serverLocks = new Map<string, Promise<void>>();
  const activeOps = new Set<Promise<unknown>>();
  const idleWaiters = new Set<() => void>();
  const dirtyServers = new Set<string>();
  let nextRevision = 1;
  let storageCorrupted = false;
  let draining = false;
  let inFlightRequests = 0;

  const notifyIfIdle = (): void => {
    if (inFlightRequests === 0 && activeOps.size === 0) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    }
  };

  const loadFromDisk = (): void => {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      storageCorrupted = true;
      options.log?.(
        `[mcp-auth] unreadable ${LAN_MCP_AUTH_FILE_NAME}: ${error instanceof Error ? error.name : 'error'}`
      );
      return;
    }
    try {
      const decrypted = decryptLanMcpAuthJson(atRestKey, atRestAad, JSON.parse(raw));
      const parsed = StoredFileSchema.parse(decrypted);
      let maxRevision = 0;
      for (const [serverId, entry] of Object.entries(parsed.records)) {
        records.set(serverId, entry);
        if (entry.revision > maxRevision) maxRevision = entry.revision;
      }
      nextRevision = Math.max(parsed.nextRevision ?? 1, maxRevision + 1);
    } catch (error) {
      storageCorrupted = true;
      options.log?.(
        `[mcp-auth] failed to decrypt ${LAN_MCP_AUTH_FILE_NAME}: ${error instanceof Error ? error.name : 'error'}`
      );
    }
  };
  loadFromDisk();

  const ensureStorageHealthy = (): void => {
    if (storageCorrupted) throw new HttpError(500, 'storage_unavailable');
  };

  const ensureNotDraining = (): void => {
    if (draining) throw new HttpError(503, 'moving');
  };

  /** Atomically writes the full encrypted store with `0600` permissions. */
  const persistSnapshot = (
    nextRecords: ReadonlyMap<string, StoredEntry>,
    candidateNextRevision: number
  ): void => {
    const payload = {
      version: 1 as const,
      nextRevision: candidateNextRevision,
      records: Object.fromEntries(nextRecords.entries()),
    };
    const envelope = encryptLanMcpAuthJson(atRestKey, atRestAad, payload);
    fs.mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, filePath);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  };

  const flushPendingPersist = (context: string, serverId?: string): void => {
    if (dirtyServers.size === 0) return;
    if (serverId !== undefined && !dirtyServers.has(serverId)) return;
    try {
      persistSnapshot(records, nextRevision);
      dirtyServers.clear();
    } catch (error) {
      options.log?.(
        `[mcp-auth] retry persist failed (${context}): ${error instanceof Error ? error.name : 'error'}`
      );
      throw new HttpError(500, 'storage_unavailable');
    }
  };

  const withServerLock = async <T>(serverId: string, work: () => Promise<T>): Promise<T> => {
    const previous = serverLocks.get(serverId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    serverLocks.set(serverId, tail);
    await previous;
    const op = (async () => {
      try {
        return await work();
      } finally {
        release();
        if (serverLocks.get(serverId) === tail) {
          serverLocks.delete(serverId);
        }
      }
    })();
    const settled = op.then(
      () => undefined,
      () => undefined
    );
    activeOps.add(settled);
    void settled.finally(() => {
      activeOps.delete(settled);
      notifyIfIdle();
    });
    return await op;
  };

  const handleStatus = (response: http.ServerResponse): void => {
    ensureStorageHealthy();
    const result: LanMcpAuthStatusResponse = {
      records: Object.fromEntries(
        [...records.entries()].map(([serverId, entry]) => [
          serverId,
          toStatusItem(entry, refreshErrors.get(serverId)),
        ])
      ),
    };
    sendJson(response, 200, result);
  };

  const handlePutRecord = async (
    serverId: string,
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> => {
    ensureStorageHealthy();
    const rawBody = await readJsonBody(request, bodyTimeoutMs, shutdown.signal);
    let record: McpStoredAuthentication;
    try {
      const decrypted = decryptLanMcpAuthJson(
        wireKey,
        mcpAuthPutRecordRequestAad(serverId),
        rawBody
      );
      record = LanMcpAuthPutRecordPayloadSchema.parse(decrypted).record;
    } catch {
      throw new HttpError(400, 'invalid_envelope');
    }
    const status = await withServerLock(serverId, async () => {
      ensureNotDraining();
      ensureStorageHealthy();
      const timestamp = now();
      const normalizedRecord: McpStoredAuthentication = {
        ...record,
        expiresAt: record.tokens
          ? record.tokens.expires_in !== undefined
            ? timestamp + record.tokens.expires_in * 1000
            : record.expiresAt
          : undefined,
      };
      const revision = nextRevision;
      const entry: StoredEntry = {
        revision,
        record: McpStoredAuthenticationSchema.parse(normalizedRecord),
        updatedAt: timestamp,
      };
      const staged = new Map(records);
      staged.set(serverId, entry);
      try {
        persistSnapshot(staged, revision + 1);
      } catch (error) {
        options.log?.(
          `[mcp-auth] persist failed on PUT for ${serverId}: ${error instanceof Error ? error.name : 'error'}`
        );
        throw new HttpError(500, 'storage_unavailable');
      }
      records.set(serverId, entry);
      nextRevision = revision + 1;
      dirtyServers.clear();
      refreshErrors.delete(serverId);
      options.log?.(
        `[mcp-auth] saved ${entry.record.settings.mode} credentials for ${serverId} (rev ${revision})`
      );
      return { serverId, ...toStatusItem(entry) } satisfies LanMcpAuthPutRecordResponse;
    });
    sendJson(response, 200, status);
  };

  const handleDeleteRecord = async (
    serverId: string,
    response: http.ServerResponse
  ): Promise<void> => {
    ensureStorageHealthy();
    const removed = await withServerLock(serverId, async () => {
      ensureNotDraining();
      ensureStorageHealthy();
      const existed = records.has(serverId);
      if (existed) {
        const staged = new Map(records);
        staged.delete(serverId);
        try {
          persistSnapshot(staged, nextRevision);
        } catch (error) {
          options.log?.(
            `[mcp-auth] persist failed on DELETE for ${serverId}: ${error instanceof Error ? error.name : 'error'}`
          );
          throw new HttpError(500, 'storage_unavailable');
        }
        records.delete(serverId);
        dirtyServers.clear();
        options.log?.(`[mcp-auth] removed credentials for ${serverId}`);
      } else if (dirtyServers.has(serverId)) {
        flushPendingPersist(`DELETE ${serverId}`, serverId);
      }
      refreshErrors.delete(serverId);
      return existed;
    });
    sendJson(response, 200, { removed } satisfies LanMcpAuthDeleteRecordResponse);
  };

  const handleAuthorizeConfig = async (
    serverId: string,
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> => {
    ensureStorageHealthy();
    const rawBody = await readJsonBody(request, bodyTimeoutMs, shutdown.signal);
    let configRequest: z.infer<typeof LanMcpAuthAuthorizeConfigRequestSchema>;
    try {
      const decrypted = decryptLanMcpAuthJson(
        wireKey,
        mcpAuthAuthorizeConfigRequestAad(serverId),
        rawBody
      );
      configRequest = LanMcpAuthAuthorizeConfigRequestSchema.parse(decrypted);
    } catch {
      throw new HttpError(400, 'invalid_envelope');
    }

    const configResponse = await withServerLock(
      serverId,
      async (): Promise<LanMcpAuthAuthorizeConfigResponse> => {
        ensureNotDraining();
        ensureStorageHealthy();
        const entry = records.get(serverId);
        if (!entry) throw new HttpError(404, 'not_found');
        if (
          entry.record.target !== configRequest.target ||
          entry.record.settings.mode !== 'oauth'
        ) {
          throw new HttpError(409, 'oauth_required');
        }
        return LanMcpAuthAuthorizeConfigResponseSchema.parse({
          ...(entry.record.settings.clientId ? { clientId: entry.record.settings.clientId } : {}),
          ...(entry.record.settings.clientSecret
            ? { clientSecret: entry.record.settings.clientSecret }
            : {}),
          ...(entry.record.client ? { client: entry.record.client } : {}),
        });
      }
    );

    const envelope = encryptLanMcpAuthJson(
      wireKey,
      mcpAuthAuthorizeConfigResponseAad(serverId),
      configResponse
    );
    sendJson(response, 200, envelope);
  };

  const handleToken = async (
    serverId: string,
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> => {
    ensureStorageHealthy();
    const rawBody = await readJsonBody(request, bodyTimeoutMs, shutdown.signal);
    let tokenRequest: z.infer<typeof LanMcpAuthTokenRequestSchema>;
    try {
      const decrypted = decryptLanMcpAuthJson(wireKey, mcpAuthTokenRequestAad(serverId), rawBody);
      tokenRequest = LanMcpAuthTokenRequestSchema.parse(decrypted);
    } catch {
      throw new HttpError(400, 'invalid_envelope');
    }

    const tokenResponse = await withServerLock(
      serverId,
      async (): Promise<LanMcpAuthTokenResponse> => {
        ensureNotDraining();
        ensureStorageHealthy();
        let entry = records.get(serverId);
        if (!entry) throw new HttpError(404, 'not_found');
        if (entry.record.target !== tokenRequest.target) {
          throw new HttpError(
            409,
            entry.record.settings.mode === 'manual' ? 'manual_required' : 'oauth_required'
          );
        }

        if (entry.record.settings.mode === 'manual') {
          if (!hasRecordCredentials(entry.record)) {
            throw new HttpError(409, 'manual_required');
          }
          flushPendingPersist(`token ${serverId}`, serverId);
          const manual = buildManualCredentials(entry.record);
          return LanMcpAuthTokenResponseSchema.parse({
            mode: 'manual',
            ...manual,
            revision: entry.revision,
          });
        }

        if (!entry.record.tokens) {
          throw new HttpError(409, 'oauth_required');
        }

        const currentNow = now();
        const expiredNow =
          entry.record.expiresAt !== undefined && entry.record.expiresAt <= currentNow;
        const nearExpiry =
          entry.record.expiresAt !== undefined &&
          entry.record.expiresAt <= currentNow + REFRESH_SKEW_MS;
        const alreadyRefreshed =
          tokenRequest.forceRefresh === true &&
          tokenRequest.failedRevision !== undefined &&
          tokenRequest.failedRevision < entry.revision;
        // Short-lived tokens already rotated past failedRevision are reused until actually expired.
        const needsRefresh = alreadyRefreshed
          ? expiredNow
          : nearExpiry || tokenRequest.forceRefresh === true;

        if (needsRefresh) {
          if (!entry.record.tokens.refresh_token) {
            refreshErrors.set(serverId, 'expired');
            throw new HttpError(401, 'expired');
          }
          const targetUrl = extractHttpTargetUrl(entry.record.target);
          if (!targetUrl) {
            throw new HttpError(400, 'unsupported');
          }
          if (
            tokenRequest.connectionUrl !== undefined &&
            tokenRequest.connectionUrl !== targetUrl
          ) {
            throw new HttpError(409, 'oauth_required');
          }
          const refreshSignal = AbortSignal.any([
            shutdown.signal,
            AbortSignal.timeout(REFRESH_TIMEOUT_MS),
          ]);
          let refreshed: Awaited<ReturnType<McpAuthenticationIO['authorize']>>;
          try {
            refreshed = await io.authorize(entry.record, {
              url: targetUrl,
              signal: refreshSignal,
            });
          } catch (error) {
            const reason = classifyRefreshError(error);
            if (reason === 'expired' || reason === 'oauth_required') {
              refreshErrors.set(serverId, reason);
              throw new HttpError(401, reason);
            }
            // Transient failure: preserve the existing stored record untouched.
            throw new HttpError(502, 'connection_failed');
          }
          if (!refreshed.record.tokens || refreshed.url) {
            refreshErrors.set(serverId, 'expired');
            throw new HttpError(401, 'expired');
          }
          const refreshedAt = now();
          const nextRecord: McpStoredAuthentication = McpStoredAuthenticationSchema.parse({
            ...refreshed.record,
            target: entry.record.target,
            client: refreshed.record.client ?? entry.record.client,
            tokens: {
              ...refreshed.record.tokens,
              ...(!refreshed.record.tokens.refresh_token && entry.record.tokens.refresh_token
                ? { refresh_token: entry.record.tokens.refresh_token }
                : {}),
              ...(!refreshed.record.tokens.issuer && entry.record.tokens.issuer
                ? { issuer: entry.record.tokens.issuer }
                : {}),
            },
            expiresAt:
              refreshed.record.tokens.expires_in !== undefined
                ? refreshedAt + refreshed.record.tokens.expires_in * 1000
                : undefined,
          });
          const revision = nextRevision;
          const nextEntry: StoredEntry = {
            revision,
            record: nextRecord,
            updatedAt: refreshedAt,
          };
          // Commit rotated tokens in memory first so an ENOSPC persist failure never
          // causes subsequent calls to reuse an already-invalidated single-use refresh token.
          records.set(serverId, nextEntry);
          nextRevision = revision + 1;
          refreshErrors.delete(serverId);
          entry = nextEntry;
          try {
            persistSnapshot(records, nextRevision);
            dirtyServers.clear();
          } catch (error) {
            dirtyServers.add(serverId);
            options.log?.(
              `[mcp-auth] failed to persist rotated OAuth token for ${serverId}: ${error instanceof Error ? error.name : 'error'}`
            );
            throw new HttpError(500, 'storage_unavailable');
          }
          options.log?.(`[mcp-auth] refreshed OAuth token for ${serverId} (rev ${revision})`);
        } else {
          flushPendingPersist(`token ${serverId}`, serverId);
        }

        return LanMcpAuthTokenResponseSchema.parse({
          mode: 'oauth',
          headers: buildOAuthHeaders(entry.record),
          ...(entry.record.expiresAt !== undefined ? { expiresAt: entry.record.expiresAt } : {}),
          revision: entry.revision,
        });
      }
    );

    const envelope = encryptLanMcpAuthJson(
      wireKey,
      mcpAuthTokenResponseAad(serverId),
      tokenResponse
    );
    sendJson(response, 200, envelope);
  };

  return {
    handles: (url) => {
      const pathname = url?.split('?')[0] ?? '';
      return pathname === '/lan/mcp-auth' || pathname.startsWith(LAN_HUB_MCP_AUTH_PREFIX);
    },
    handle: async (request, response) => {
      // Synchronous admission check before any await so handover draining cannot miss mid-body writes.
      if (draining) {
        sendJson(response, 503, { error: 'moving' }, { 'Retry-After': '30' });
        return;
      }
      inFlightRequests += 1;
      const pathname = request.url?.split('?')[0] ?? '';
      const method = request.method ?? '';
      try {
        if (pathname === LAN_HUB_MCP_AUTH_STATUS_PATH) {
          if (method !== 'GET') throw new HttpError(405, 'method_not_allowed');
          handleStatus(response);
          return;
        }
        if (pathname.startsWith(LAN_HUB_MCP_AUTH_RECORDS_PREFIX)) {
          const serverId = parseServerIdSegment(pathname, LAN_HUB_MCP_AUTH_RECORDS_PREFIX);
          if (method === 'PUT') {
            await handlePutRecord(serverId, request, response);
            return;
          }
          if (method === 'DELETE') {
            await handleDeleteRecord(serverId, response);
            return;
          }
          throw new HttpError(405, 'method_not_allowed');
        }
        if (pathname.startsWith(LAN_HUB_MCP_AUTH_TOKEN_PREFIX)) {
          const serverId = parseServerIdSegment(pathname, LAN_HUB_MCP_AUTH_TOKEN_PREFIX);
          if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
          await handleToken(serverId, request, response);
          return;
        }
        if (pathname.startsWith(LAN_HUB_MCP_AUTH_AUTHORIZE_CONFIG_PREFIX)) {
          const serverId = parseServerIdSegment(pathname, LAN_HUB_MCP_AUTH_AUTHORIZE_CONFIG_PREFIX);
          if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
          await handleAuthorizeConfig(serverId, request, response);
          return;
        }
        throw new HttpError(404, 'not_found');
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(
            response,
            error.status,
            { error: error.code },
            error.status === 503 && error.code === 'moving' ? { 'Retry-After': '30' } : undefined
          );
          return;
        }
        options.log?.(
          `[mcp-auth] ${method} ${pathname} failed: ${error instanceof Error ? error.name : 'error'}`
        );
        sendJson(response, 500, { error: 'mcp_auth_failed' });
      } finally {
        inFlightRequests -= 1;
        notifyIfIdle();
      }
    },
    beginHandover: () => {
      draining = true;
    },
    resumeHandover: () => {
      draining = false;
    },
    hasRecords: () => records.size > 0 || storageCorrupted || fs.existsSync(filePath),
    idle: async () => {
      while (inFlightRequests > 0 || activeOps.size > 0) {
        if (activeOps.size > 0) {
          await Promise.allSettled([...activeOps]);
        }
        if (inFlightRequests > 0 || activeOps.size > 0) {
          await new Promise<void>((resolve) => {
            idleWaiters.add(resolve);
          });
        }
      }
      if (dirtyServers.size > 0 && !storageCorrupted) {
        persistSnapshot(records, nextRevision);
        dirtyServers.clear();
      }
    },
    close: () => {
      draining = true;
      shutdown.abort();
      if (dirtyServers.size > 0 && !storageCorrupted) {
        try {
          persistSnapshot(records, nextRevision);
          dirtyServers.clear();
        } catch (error) {
          options.log?.(
            `[mcp-auth] close persist failed: ${error instanceof Error ? error.name : 'error'}`
          );
        }
      }
    },
  };
}
