// Member-side MCP authentication adapter for LAN workspaces.
//
// Implements the same 6-method surface as `McpAuthenticationLegacy` without
// touching the OS keyring: credentials live centrally on the LAN Hub behind
// AES-256-GCM wire envelopes (`hub-mcp-auth.ts`), short-lived access headers
// are cached in process memory only, OAuth interactive authorization runs on
// the browser-equipped member via `io.ts`, and HTTP MCP traffic flows through
// a per-session local loopback relay with MCP protocol 404/405 passthrough.
import { randomBytes } from 'node:crypto';
import {
  assertPublicMcpServer,
  McpLocalAuthenticationSchema,
  publicMcpServer,
  resolveSessionMcpServers,
  type LocalMachineRpcRequestValidated,
  type McpAuthenticationResult,
  type McpLocalAuthentication,
  type McpToolListResult,
  type ResolvedMcpServer,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import type { LanHub } from '@lody/shared/node/lan-hub';
import {
  makeMcpAuthenticationIO,
  mcpOAuthChallenge,
  type McpAuthenticationIO,
  type McpCallbackEndpoint,
  type McpRelayEndpoint,
  type McpRelayRequest,
  type McpStoredAuthentication,
} from '@/mcp/authentication/io';
import { McpAuthenticationError } from '@/mcp/authentication/service';
import { listMcpTools } from '@/mcp/list-mcp-tools';
import {
  decryptLanMcpAuthJson,
  deriveLanMcpAuthKey,
  encryptLanMcpAuthJson,
  hashLanMcpAuthTarget,
  LAN_HUB_MCP_AUTH_AUTHORIZE_CONFIG_PREFIX,
  LAN_HUB_MCP_AUTH_RECORDS_PREFIX,
  LAN_HUB_MCP_AUTH_STATUS_PATH,
  LAN_HUB_MCP_AUTH_TOKEN_PREFIX,
  LanMcpAuthAuthorizeConfigResponseSchema,
  LanMcpAuthDeleteRecordResponseSchema,
  LanMcpAuthErrorResponseSchema,
  LanMcpAuthPutRecordResponseSchema,
  LanMcpAuthStatusResponseSchema,
  LanMcpAuthTokenResponseSchema,
  mcpAuthAuthorizeConfigRequestAad,
  mcpAuthAuthorizeConfigResponseAad,
  mcpAuthPutRecordRequestAad,
  mcpAuthTokenRequestAad,
  mcpAuthTokenResponseAad,
  type LanMcpAuthAuthorizeConfigResponse,
  type LanMcpAuthPutRecordResponse,
  type LanMcpAuthStatusItem,
  type LanMcpAuthStatusResponse,
  type LanMcpAuthTokenRequest,
  type LanMcpAuthTokenResponse,
} from './lan-mcp-auth-crypto';

const REFRESH_SKEW_MS = 30_000;
const MANUAL_CACHE_TTL_MS = 30_000;
const HUB_REQUEST_TIMEOUT_MS = 20_000;
const HUB_TOKEN_TIMEOUT_MS = 35_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10 * 60_000;
const CLOSE_TIMEOUT_MS = 5_000;
const RELAY_QUEUE_CAPACITY = 32;
const RELAY_WORKER_CONCURRENCY = 4;
const MAX_PASSTHROUGH_HEADER_LENGTH = 8192;
const SAFE_PROTOCOL_ERROR_HEADERS = ['allow', 'mcp-session-id', 'mcp-protocol-version'] as const;

type Reason = NonNullable<McpAuthenticationResult['reason']>;

/** Public facade contract shared by `McpAuthenticationLegacy` and `LanMcpAuthentication`. */
export interface McpAuthenticationPort {
  status(server: WorkspaceMcpServerMeta): Promise<McpAuthenticationResult>;
  request(
    request: Extract<LocalMachineRpcRequestValidated, { method: 'mcp/authentication' }>
  ): Promise<McpAuthenticationResult>;
  listTools(
    authoredServer: WorkspaceMcpServerMeta,
    requesterUserId?: string
  ): Promise<McpToolListResult>;
  prepare(
    server: WorkspaceMcpServerMeta,
    resolved: ResolvedMcpServer,
    owner: string,
    requesterUserId: string
  ): Promise<ResolvedMcpServer>;
  release(owner: string): Promise<void>;
  close(): Promise<void>;
}

export interface LanMcpAuthenticationOptions {
  userId: string;
  /** Dynamically resolves the active LAN hub so handover/failover updates take effect immediately. */
  resolveHub: () => Pick<LanHub, 'url' | 'token'> | null;
  /** Shared LAN MCP environment table, merged behind daemon env for target normalization. */
  lanEnv?: () => Readonly<Record<string, string>>;
  /** Daemon environment (defaults to `process.env`; injectable for tests). */
  env?: () => Readonly<Record<string, string | undefined>>;
  /** MCP OAuth / callback / relay / forward IO (defaults to `makeMcpAuthenticationIO()`). */
  io?: McpAuthenticationIO;
  /** Fetch used for member -> hub requests (defaults to global `fetch`). */
  hubFetch?: typeof fetch;
  /** Clock in epoch ms (defaults to `Date.now`). */
  now?: () => number;
  /** Interactive OAuth attempt timeout in ms (defaults to 10 minutes). */
  attemptTimeoutMs?: number;
}

type CachedToken = {
  hubUrl: string;
  target: string;
  mode: 'oauth' | 'manual';
  headers: Record<string, string>;
  env: Record<string, string>;
  expiresAt?: number;
  cachedUntil?: number;
  revision: number;
};

type LocalStateEntry = {
  target: string;
  basedOnRevision?: number;
  value: McpAuthenticationResult;
};

type Attempt = {
  id: string;
  target: string;
  controller: AbortController;
  status: McpAuthenticationResult;
  done: Promise<void>;
};

type RelayLease = {
  owner: string;
  serverId: string;
  server: ResolvedMcpServer;
  close(): Promise<void>;
};

const targetOf = (server: WorkspaceMcpServerMeta): string =>
  JSON.stringify(publicMcpServer(server).connection);

const authResult = (
  status: McpAuthenticationResult['status'],
  hasCredentials = false,
  reason?: Reason
): McpAuthenticationResult => ({
  type: 'mcp/authentication',
  status,
  hasCredentials,
  ...(reason ? { reason } : {}),
});

function writeRedactedUnavailable(job: McpRelayRequest): void {
  if (job.response.destroyed || job.response.writableEnded) return;
  if (!job.response.headersSent) {
    job.response.writeHead(503, {
      'content-type': 'text/plain',
      'cache-control': 'no-store',
    });
  }
  job.response.end('MCP connection unavailable. Check this service in Lody Settings.');
}

/**
 * Preserves MCP Streamable HTTP protocol status codes (404 expired session,
 * 405 SSE GET unsupported) and safe protocol headers while stripping upstream
 * error bodies and non-protocol headers.
 */
function writeProtocolStatusError(job: McpRelayRequest, upstream: Response): void {
  if (job.response.destroyed || job.response.writableEnded) return;
  const headers: Record<string, string> = {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
  };
  for (const name of SAFE_PROTOCOL_ERROR_HEADERS) {
    const value = upstream.headers.get(name);
    if (value && value.length <= MAX_PASSTHROUGH_HEADER_LENGTH) {
      headers[name] = value;
    }
  }
  if (!job.response.headersSent) {
    job.response.writeHead(upstream.status, headers);
  }
  job.response.end(upstream.status === 404 ? 'MCP session not found.' : 'Method not allowed.');
}

async function closeWithTimeout(
  action: (() => Promise<void>) | undefined,
  timeoutMs = CLOSE_TIMEOUT_MS
): Promise<void> {
  if (!action) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      action(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    // Teardown errors are contained so sibling resources still close.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Ensures an async IO step settles immediately on abort so cleanup joins without hanging. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(new Error('cancelled'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

class BoundedRelayQueue {
  private readonly pending: McpRelayRequest[] = [];
  private readonly waiters: Array<(job: McpRelayRequest | null) => void> = [];
  private closed = false;

  constructor(private readonly maxSize: number) {}

  offer(job: McpRelayRequest): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(job);
      return true;
    }
    if (this.pending.length >= this.maxSize) return false;
    this.pending.push(job);
    return true;
  }

  take(): Promise<McpRelayRequest | null> {
    const next = this.pending.shift();
    if (next) return Promise.resolve(next);
    if (this.closed) return Promise.resolve(null);
    return new Promise<McpRelayRequest | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  close(onDrop: (job: McpRelayRequest) => void): void {
    if (this.closed) return;
    this.closed = true;
    while (this.pending.length > 0) {
      onDrop(this.pending.shift()!);
    }
    while (this.waiters.length > 0) {
      this.waiters.shift()!(null);
    }
  }
}

function mapHubErrorCode(code: string | undefined): Reason {
  switch (code) {
    case 'not_found':
    case 'oauth_required':
    case 'manual_required':
      return 'oauth_required';
    case 'expired':
      return 'expired';
    case 'unsupported':
      return 'unsupported';
    case 'storage_unavailable':
      return 'storage_unavailable';
    default:
      return 'connection_failed';
  }
}

export class LanMcpAuthentication implements McpAuthenticationPort {
  private readonly userId: string;
  private readonly resolveHub: () => Pick<LanHub, 'url' | 'token'> | null;
  private readonly lanEnv?: () => Readonly<Record<string, string>>;
  private readonly env?: () => Readonly<Record<string, string | undefined>>;
  private readonly io: McpAuthenticationIO;
  private readonly hubFetch: typeof fetch;
  private readonly now: () => number;
  private readonly attemptTimeoutMs: number;

  private readonly shutdown = new AbortController();
  private readonly serverLocks = new Map<string, Promise<void>>();
  private readonly attemptLocks = new Map<string, Promise<void>>();
  private leaseLock: Promise<void> = Promise.resolve();
  private readonly tokenCache = new Map<string, CachedToken>();
  private readonly localStates = new Map<string, LocalStateEntry>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly leases = new Map<string, RelayLease>();
  private readonly closedOwners = new Set<string>();
  private closing: Promise<void> | null = null;
  private closed = false;

  constructor(options: LanMcpAuthenticationOptions) {
    this.userId = options.userId;
    this.resolveHub = options.resolveHub;
    this.lanEnv = options.lanEnv;
    this.env = options.env;
    this.io = options.io ?? makeMcpAuthenticationIO();
    this.hubFetch = options.hubFetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('MCP authentication is shutting down.');
  }

  private mergedEnv(): Readonly<Record<string, string | undefined>> {
    return { ...this.lanEnv?.(), ...(this.env?.() ?? process.env) };
  }

  private connectionTarget(
    server: WorkspaceMcpServerMeta,
    resolved?: ResolvedMcpServer
  ): WorkspaceMcpServerMeta {
    assertPublicMcpServer(server);
    const target =
      resolved ??
      resolveSessionMcpServers({
        catalog: { [server.id]: server },
        selectedIds: [server.id],
        agentCapabilities: { http: true },
        env: this.mergedEnv(),
      }).servers[0];
    if (!target || !server.connection) {
      throw new Error('MCP connection configuration is incomplete.');
    }
    const normalized: WorkspaceMcpServerMeta = {
      ...server,
      connection:
        'type' in target && server.connection.transport === 'http'
          ? { ...server.connection, url: target.url }
          : !('type' in target) && server.connection.transport === 'stdio'
            ? { ...server.connection, command: target.command, args: target.args }
            : undefined,
    };
    if (!normalized.connection) throw new Error('MCP connection transport mismatch.');
    assertPublicMcpServer(normalized);
    return normalized;
  }

  private async withKeyedLock<T>(
    map: Map<string, Promise<void>>,
    key: string,
    work: () => Promise<T>
  ): Promise<T> {
    const previous = map.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    map.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (map.get(key) === tail) {
        map.delete(key);
      }
    }
  }

  private withServerLock<T>(serverId: string, work: () => Promise<T>): Promise<T> {
    return this.withKeyedLock(this.serverLocks, serverId, work);
  }

  private withAttemptLock<T>(serverId: string, work: () => Promise<T>): Promise<T> {
    return this.withKeyedLock(this.attemptLocks, serverId, work);
  }

  private async withLeaseLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.leaseLock;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.leaseLock = previous.then(() => gate);
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private requireHub(): { url: string; token: string; wireKey: Buffer } {
    const hub = this.resolveHub();
    if (!hub || !hub.url || !hub.token) {
      throw new McpAuthenticationError({ reason: 'connection_failed' });
    }
    return {
      url: hub.url.replace(/\/+$/, ''),
      token: hub.token,
      wireKey: deriveLanMcpAuthKey(hub.token, 'wire'),
    };
  }

  private async hubRequest(
    pathname: string,
    init: {
      method: 'GET' | 'PUT' | 'POST' | 'DELETE';
      hub?: { url: string; token: string; wireKey: Buffer };
      body?: unknown;
      timeoutMs?: number;
      signal?: AbortSignal;
    }
  ): Promise<{ response: Response; wireKey: Buffer }> {
    const hub = init.hub ?? this.requireHub();
    const signals = [
      this.shutdown.signal,
      AbortSignal.timeout(init.timeoutMs ?? HUB_REQUEST_TIMEOUT_MS),
      ...(init.signal ? [init.signal] : []),
    ];
    let response: Response;
    try {
      response = await this.hubFetch(`${hub.url}${pathname}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${hub.token}`,
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.any(signals),
      });
    } catch {
      throw new McpAuthenticationError({ reason: 'connection_failed' });
    }
    if (!response.ok) {
      const parsedError = LanMcpAuthErrorResponseSchema.safeParse(
        await response.json().catch(() => null)
      );
      throw new McpAuthenticationError({
        reason: mapHubErrorCode(parsedError.success ? parsedError.data.error : undefined),
      });
    }
    return { response, wireKey: hub.wireKey };
  }

  private async hubGetStatus(signal?: AbortSignal): Promise<LanMcpAuthStatusResponse> {
    const { response } = await this.hubRequest(LAN_HUB_MCP_AUTH_STATUS_PATH, {
      method: 'GET',
      signal,
    });
    try {
      return LanMcpAuthStatusResponseSchema.parse(await response.json());
    } catch {
      throw new McpAuthenticationError({ reason: 'connection_failed' });
    }
  }

  private async hubPutRecord(
    serverId: string,
    record: McpStoredAuthentication,
    signal?: AbortSignal
  ): Promise<LanMcpAuthPutRecordResponse> {
    const hub = this.requireHub();
    const envelope = encryptLanMcpAuthJson(hub.wireKey, mcpAuthPutRecordRequestAad(serverId), {
      record,
    });
    const { response } = await this.hubRequest(
      `${LAN_HUB_MCP_AUTH_RECORDS_PREFIX}${encodeURIComponent(serverId)}`,
      { method: 'PUT', hub, body: envelope, signal }
    );
    try {
      return LanMcpAuthPutRecordResponseSchema.parse(await response.json());
    } catch {
      throw new McpAuthenticationError({ reason: 'connection_failed' });
    }
  }

  private async hubDeleteRecord(serverId: string, signal?: AbortSignal): Promise<void> {
    const { response } = await this.hubRequest(
      `${LAN_HUB_MCP_AUTH_RECORDS_PREFIX}${encodeURIComponent(serverId)}`,
      { method: 'DELETE', signal }
    );
    try {
      LanMcpAuthDeleteRecordResponseSchema.parse(await response.json());
    } catch {
      throw new McpAuthenticationError({ reason: 'connection_failed' });
    }
  }

  private async hubFetchToken(
    serverId: string,
    payload: LanMcpAuthTokenRequest,
    hub: { url: string; token: string; wireKey: Buffer },
    signal?: AbortSignal
  ): Promise<LanMcpAuthTokenResponse> {
    const envelope = encryptLanMcpAuthJson(hub.wireKey, mcpAuthTokenRequestAad(serverId), payload);
    const { response, wireKey } = await this.hubRequest(
      `${LAN_HUB_MCP_AUTH_TOKEN_PREFIX}${encodeURIComponent(serverId)}`,
      { method: 'POST', hub, body: envelope, timeoutMs: HUB_TOKEN_TIMEOUT_MS, signal }
    );
    try {
      const decrypted = decryptLanMcpAuthJson(
        wireKey,
        mcpAuthTokenResponseAad(serverId),
        await response.json()
      );
      return LanMcpAuthTokenResponseSchema.parse(decrypted);
    } catch {
      throw new McpAuthenticationError({ reason: 'connection_failed' });
    }
  }

  private async hubFetchAuthorizeConfig(
    serverId: string,
    target: string,
    signal?: AbortSignal
  ): Promise<LanMcpAuthAuthorizeConfigResponse> {
    const hub = this.requireHub();
    const envelope = encryptLanMcpAuthJson(
      hub.wireKey,
      mcpAuthAuthorizeConfigRequestAad(serverId),
      { target }
    );
    const { response, wireKey } = await this.hubRequest(
      `${LAN_HUB_MCP_AUTH_AUTHORIZE_CONFIG_PREFIX}${encodeURIComponent(serverId)}`,
      { method: 'POST', hub, body: envelope, signal }
    );
    try {
      const decrypted = decryptLanMcpAuthJson(
        wireKey,
        mcpAuthAuthorizeConfigResponseAad(serverId),
        await response.json()
      );
      return LanMcpAuthAuthorizeConfigResponseSchema.parse(decrypted);
    } catch {
      throw new McpAuthenticationError({ reason: 'connection_failed' });
    }
  }

  private rememberLocal(
    server: WorkspaceMcpServerMeta,
    value: McpAuthenticationResult,
    basedOnRevision?: number
  ): McpAuthenticationResult {
    this.localStates.set(server.id, { target: targetOf(server), basedOnRevision, value });
    return value;
  }

  private statusFromHubMeta(
    server: WorkspaceMcpServerMeta,
    meta: LanMcpAuthStatusItem | undefined
  ): McpAuthenticationResult {
    const target = targetOf(server);
    const targetHash = hashLanMcpAuthTarget(target);
    const local = this.localStates.get(server.id);
    if (!meta || meta.targetHash !== targetHash) {
      if (local && local.target === target && local.value.status !== 'authorized') {
        return local.value;
      }
      return authResult('required');
    }
    if (
      local &&
      local.target === target &&
      local.basedOnRevision === meta.revision &&
      (local.value.status === 'error' || local.value.reason === 'oauth_required')
    ) {
      return local.value;
    }
    if (meta.refreshError) {
      return {
        ...authResult('required', false, meta.refreshError),
        mode: meta.mode,
      };
    }
    return {
      ...authResult(meta.hasCredentials ? 'authorized' : 'required', meta.hasCredentials),
      mode: meta.mode,
    };
  }

  private async statusInternal(server: WorkspaceMcpServerMeta): Promise<McpAuthenticationResult> {
    const target = targetOf(server);
    const attempt = this.attempts.get(server.id);
    if (attempt && attempt.target === target && attempt.status.status === 'waiting') {
      return { ...attempt.status, authorizationUrl: undefined };
    }
    if (server.connection?.authentication !== 'local') {
      const local = this.localStates.get(server.id);
      if (local && local.target === target) return local.value;
      return authResult('unknown');
    }
    const hubStatus = await this.hubGetStatus();
    return this.statusFromHubMeta(server, hubStatus.records[server.id]);
  }

  async status(authoredServer: WorkspaceMcpServerMeta): Promise<McpAuthenticationResult> {
    this.assertOpen();
    const server = this.connectionTarget(authoredServer);
    try {
      return await this.statusInternal(server);
    } catch (error) {
      return authResult(
        'error',
        false,
        error instanceof McpAuthenticationError ? error.reason : 'connection_failed'
      );
    }
  }

  private async stopAttempt(serverId: string, attemptId?: string): Promise<void> {
    const attempt = this.attempts.get(serverId);
    if (!attempt || (attemptId && attempt.id !== attemptId)) return;
    attempt.controller.abort(new Error('cancelled'));
    await attempt.done;
    if (this.attempts.get(serverId) === attempt) {
      this.attempts.delete(serverId);
    }
  }

  private async revokeLeases(predicate: (lease: RelayLease) => boolean): Promise<void> {
    const toClose: RelayLease[] = [];
    await this.withLeaseLock(async () => {
      for (const [key, lease] of this.leases) {
        if (predicate(lease)) {
          this.leases.delete(key);
          toClose.push(lease);
        }
      }
    });
    await Promise.all(toClose.map((lease) => lease.close()));
  }

  private async configureInternal(
    server: WorkspaceMcpServerMeta,
    authentication: McpLocalAuthentication
  ): Promise<McpAuthenticationResult> {
    if (server.connection?.authentication !== 'local') {
      throw new McpAuthenticationError({ reason: 'unsupported' });
    }
    const settings = McpLocalAuthenticationSchema.parse(authentication);
    await this.withAttemptLock(server.id, () => this.stopAttempt(server.id));
    await this.revokeLeases((lease) => lease.serverId === server.id);
    return await this.withServerLock(server.id, async () => {
      const target = targetOf(server);
      const saved = await this.hubPutRecord(server.id, { target, settings });
      this.tokenCache.delete(server.id);
      this.localStates.delete(server.id);
      return {
        ...authResult(saved.hasCredentials ? 'authorized' : 'required', saved.hasCredentials),
        mode: saved.mode,
      };
    });
  }

  private async authorizeInternal(
    server: WorkspaceMcpServerMeta
  ): Promise<McpAuthenticationResult> {
    if (server.connection?.transport !== 'http' || server.connection.authentication !== 'local') {
      throw new McpAuthenticationError({ reason: 'unsupported' });
    }

    const target = targetOf(server);
    const url = server.connection.url;
    let resolveReady!: (value: McpAuthenticationResult) => void;
    let rejectReady!: (error: McpAuthenticationError) => void;
    const readyPromise = new Promise<McpAuthenticationResult>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    let readySettled = false;
    const settleReadyResolve = (value: McpAuthenticationResult) => {
      if (readySettled) return;
      readySettled = true;
      resolveReady(value);
    };
    const settleReadyReject = (error: McpAuthenticationError) => {
      if (readySettled) return;
      readySettled = true;
      rejectReady(error);
    };

    const attempt = await this.withAttemptLock(server.id, async () => {
      await this.stopAttempt(server.id);
      // Verify hub reachability and read existing metadata before launching browser OAuth.
      const hubStatus = await this.hubGetStatus();
      const targetHash = hashLanMcpAuthTarget(target);
      const existingMeta =
        hubStatus.records[server.id]?.targetHash === targetHash
          ? hubStatus.records[server.id]
          : undefined;
      let authorizeConfig: LanMcpAuthAuthorizeConfigResponse | undefined;
      if (existingMeta?.mode === 'oauth' && existingMeta.hasClient) {
        try {
          authorizeConfig = await this.hubFetchAuthorizeConfig(server.id, target);
        } catch (error) {
          if (!(error instanceof McpAuthenticationError) || error.reason !== 'oauth_required') {
            throw error;
          }
        }
      }
      const staged: McpStoredAuthentication = {
        target,
        settings: {
          mode: 'oauth',
          ...(authorizeConfig?.clientId ? { clientId: authorizeConfig.clientId } : {}),
          ...(authorizeConfig?.clientSecret ? { clientSecret: authorizeConfig.clientSecret } : {}),
        },
      };

      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('timeout'));
      }, this.attemptTimeoutMs);
      timeout.unref?.();

      const created: Attempt = {
        id: randomBytes(24).toString('hex'),
        target,
        controller,
        status: authResult('waiting'),
        done: Promise.resolve(),
      };
      this.attempts.set(server.id, created);

      const signal = AbortSignal.any([this.shutdown.signal, controller.signal]);
      const worker = async (): Promise<void> => {
        let endpoint: McpCallbackEndpoint | undefined;
        let state: string | undefined = randomBytes(32).toString('base64url');
        let verifier: string | undefined;
        let code: string | undefined;
        try {
          try {
            endpoint = await this.io.callback(state);
          } catch {
            throw new McpAuthenticationError({ reason: 'connection_failed' });
          }
          let discovery: Awaited<ReturnType<McpAuthenticationIO['discover']>>;
          try {
            discovery = await raceAbort(this.io.discover(url, undefined, signal), signal);
          } catch {
            throw new McpAuthenticationError({ reason: 'connection_failed' });
          }
          if (
            !discovery.resourceMetadata ||
            !discovery.authorizationServerMetadata?.authorization_endpoint ||
            !discovery.authorizationServerMetadata.token_endpoint
          ) {
            throw new McpAuthenticationError({ reason: 'unsupported' });
          }
          if (
            !discovery.authorizationServerMetadata.registration_endpoint &&
            !staged.settings.clientId
          ) {
            throw new McpAuthenticationError({ reason: 'client_required' });
          }
          const discoveredIssuer =
            discovery.authorizationServerMetadata.issuer ??
            discovery.authorizationServerUrl?.toString();
          const reusableClient =
            authorizeConfig?.client &&
            discoveredIssuer !== undefined &&
            authorizeConfig.client.issuer === discoveredIssuer
              ? authorizeConfig.client
              : undefined;
          const authorizeRecord: McpStoredAuthentication = reusableClient
            ? { ...staged, client: reusableClient }
            : staged;
          let started: Awaited<ReturnType<McpAuthenticationIO['authorize']>>;
          try {
            started = await raceAbort(
              this.io.authorize(authorizeRecord, {
                url,
                state,
                redirectUrl: endpoint.redirectUrl,
                discovery,
                signal,
              }),
              signal
            );
          } catch {
            throw new McpAuthenticationError({ reason: 'connection_failed' });
          }
          if (!started.url || !started.verifier) {
            throw new McpAuthenticationError({ reason: 'unsupported' });
          }
          verifier = started.verifier;
          const waiting: McpAuthenticationResult = {
            ...authResult('waiting'),
            mode: 'oauth',
            attemptId: created.id,
            authorizationUrl: started.url,
          };
          created.status = waiting;
          settleReadyResolve(waiting);

          let callbackResult: { code: string; iss?: string };
          try {
            callbackResult = await raceAbort(endpoint.wait(signal), signal);
          } catch {
            throw new McpAuthenticationError({
              reason: controller.signal.aborted && !timedOut ? 'cancelled' : 'connection_failed',
            });
          }
          if (signal.aborted || this.closed || this.attempts.get(server.id) !== created) {
            return;
          }
          code = callbackResult.code;

          let completed: Awaited<ReturnType<McpAuthenticationIO['authorize']>>;
          try {
            completed = await raceAbort(
              this.io.authorize(started.record, {
                url,
                state,
                redirectUrl: endpoint.redirectUrl,
                verifier,
                discovery: started.discovery,
                code,
                iss: callbackResult.iss,
                signal,
              }),
              signal
            );
          } catch {
            throw new McpAuthenticationError({ reason: 'connection_failed' });
          }
          if (!completed.record.tokens) {
            throw new McpAuthenticationError({ reason: 'oauth_required' });
          }
          if (signal.aborted || this.closed || this.attempts.get(server.id) !== created) {
            return;
          }

          let saved = false;
          await this.withServerLock(server.id, async () => {
            if (signal.aborted || this.closed || this.attempts.get(server.id) !== created) {
              return;
            }
            await this.hubPutRecord(server.id, completed.record, signal);
            this.tokenCache.delete(server.id);
            this.localStates.delete(server.id);
            created.status = { ...authResult('authorized', true), mode: 'oauth' };
            saved = true;
          });
          if (saved) {
            await this.revokeLeases((lease) => lease.serverId === server.id);
          }
        } catch (error) {
          if (controller.signal.aborted && !timedOut) {
            settleReadyReject(new McpAuthenticationError({ reason: 'cancelled' }));
            return;
          }
          const failure =
            error instanceof McpAuthenticationError
              ? error
              : new McpAuthenticationError({ reason: 'connection_failed' });
          const failedResult: McpAuthenticationResult = {
            ...authResult('error', existingMeta?.hasCredentials ?? false, failure.reason),
            ...(existingMeta ? { mode: existingMeta.mode } : {}),
          };
          created.status = failedResult;
          this.rememberLocal(server, failedResult, existingMeta?.revision);
          settleReadyReject(failure);
        } finally {
          clearTimeout(timeout);
          state = undefined;
          verifier = undefined;
          code = undefined;
          await closeWithTimeout(endpoint ? () => endpoint!.close() : undefined);
          if (this.attempts.get(server.id) === created) {
            this.attempts.delete(server.id);
          }
        }
      };

      created.done = worker();
      return created;
    });

    try {
      return await readyPromise;
    } catch (error) {
      await attempt.done;
      throw error;
    }
  }

  private async cancelInternal(
    server: WorkspaceMcpServerMeta,
    attemptId?: string
  ): Promise<McpAuthenticationResult> {
    const stopped = await this.withAttemptLock(server.id, async () => {
      const attempt = this.attempts.get(server.id);
      if (!attempt || (attemptId && attempt.id !== attemptId)) return false;
      await this.stopAttempt(server.id, attemptId);
      return true;
    });
    if (!stopped) return await this.statusInternal(server);
    this.localStates.delete(server.id);
    const previous = await this.statusInternal(server);
    if (previous.hasCredentials) return previous;
    return this.rememberLocal(server, { ...previous, reason: 'cancelled' });
  }

  private async signoutInternal(server: WorkspaceMcpServerMeta): Promise<McpAuthenticationResult> {
    await this.withAttemptLock(server.id, () => this.stopAttempt(server.id));
    await this.revokeLeases((lease) => lease.serverId === server.id);
    return await this.withServerLock(server.id, async () => {
      this.tokenCache.delete(server.id);
      this.localStates.delete(server.id);
      await this.hubDeleteRecord(server.id);
      return authResult('required');
    });
  }

  async request(
    request: Extract<LocalMachineRpcRequestValidated, { method: 'mcp/authentication' }>
  ): Promise<McpAuthenticationResult> {
    this.assertOpen();
    const { server: authoredServer, action, authentication, attemptId } = request.params;
    if (request.params.requesterUserId !== this.userId) {
      throw new Error('MCP authentication account mismatch.');
    }
    const server = this.connectionTarget(authoredServer);
    try {
      switch (action) {
        case 'configure':
          if (!authentication || server.connection?.authentication !== 'local') {
            throw new McpAuthenticationError({ reason: 'unsupported' });
          }
          return await this.configureInternal(server, authentication);
        case 'authorize':
          return await this.authorizeInternal(server);
        case 'cancel':
          return await this.cancelInternal(server, attemptId);
        case 'signout':
          return await this.signoutInternal(server);
        case 'status':
          return await this.statusInternal(server);
      }
      throw new McpAuthenticationError({ reason: 'unsupported' });
    } catch (error) {
      return authResult(
        'error',
        false,
        error instanceof McpAuthenticationError ? error.reason : 'connection_failed'
      );
    }
  }

  private async observe(
    server: WorkspaceMcpServerMeta,
    response: Response,
    signal?: AbortSignal,
    basedOnRevision?: number
  ): Promise<void> {
    try {
      const metadata = mcpOAuthChallenge(response);
      const connection = server.connection;
      if (!metadata || connection?.transport !== 'http') return;
      const effectiveSignal = signal
        ? AbortSignal.any([this.shutdown.signal, signal])
        : this.shutdown.signal;
      const info = await this.io.discover(connection.url, metadata, effectiveSignal);
      const supported = Boolean(
        info.resourceMetadata &&
        info.authorizationServerMetadata?.authorization_endpoint &&
        info.authorizationServerMetadata.token_endpoint
      );
      if (supported) {
        this.rememberLocal(
          server,
          authResult('required', false, 'oauth_required'),
          basedOnRevision
        );
      }
    } catch {
      // Discovery failure does not turn an ordinary 401 into an OAuth prompt.
    }
  }

  private connected(server: WorkspaceMcpServerMeta): void {
    if (server.connection?.authentication === 'local') {
      const local = this.localStates.get(server.id);
      if (local && local.target === targetOf(server)) {
        this.localStates.delete(server.id);
      }
      return;
    }
    const references =
      server.connection?.transport === 'http' &&
      Boolean(
        server.connection.bearerToken || Object.keys(server.connection.headers ?? {}).length > 0
      );
    this.rememberLocal(
      server,
      references ? { ...authResult('authorized'), mode: 'manual' } : authResult('not_required')
    );
  }

  private async acquireToken(
    server: WorkspaceMcpServerMeta,
    options: {
      forceFromHub?: boolean;
      forceRefresh?: boolean;
      failedRevision?: number;
      signal?: AbortSignal;
    } = {}
  ): Promise<CachedToken> {
    const target = targetOf(server);
    return await this.withServerLock(server.id, async () => {
      const currentHub = this.requireHub();
      const cached = this.tokenCache.get(server.id);
      const currentNow = this.now();
      const cacheMatches =
        cached !== undefined && cached.hubUrl === currentHub.url && cached.target === target;
      const cacheFresh =
        cacheMatches &&
        (cached.mode === 'manual'
          ? cached.cachedUntil !== undefined && cached.cachedUntil > currentNow
          : cached.expiresAt === undefined || cached.expiresAt > currentNow + REFRESH_SKEW_MS);

      if (!options.forceFromHub) {
        if (options.forceRefresh) {
          // Member-local CAS dedupe when a sibling relay worker already refreshed past failedRevision.
          if (
            cacheFresh &&
            options.failedRevision !== undefined &&
            options.failedRevision < cached.revision
          ) {
            return cached;
          }
        } else if (cacheFresh) {
          return cached;
        }
      }

      const payload: LanMcpAuthTokenRequest = {
        target,
        ...(server.connection?.transport === 'http'
          ? { connectionUrl: server.connection.url }
          : {}),
        ...(options.forceRefresh ? { forceRefresh: true } : {}),
        ...(options.failedRevision !== undefined ? { failedRevision: options.failedRevision } : {}),
      };
      let fetched: LanMcpAuthTokenResponse;
      try {
        fetched = await this.hubFetchToken(server.id, payload, currentHub, options.signal);
      } catch (error) {
        if (
          error instanceof McpAuthenticationError &&
          (error.reason === 'oauth_required' || error.reason === 'expired')
        ) {
          this.tokenCache.delete(server.id);
        }
        throw error;
      }
      const next: CachedToken = {
        hubUrl: currentHub.url,
        target,
        mode: fetched.mode,
        headers: fetched.mode === 'oauth' ? fetched.headers : (fetched.headers ?? {}),
        env: fetched.mode === 'manual' ? (fetched.env ?? {}) : {},
        ...(fetched.mode === 'oauth' && fetched.expiresAt !== undefined
          ? { expiresAt: fetched.expiresAt }
          : {}),
        ...(fetched.mode === 'manual' ? { cachedUntil: this.now() + MANUAL_CACHE_TTL_MS } : {}),
        revision: fetched.revision,
      };
      this.tokenCache.set(server.id, next);
      return next;
    });
  }

  async listTools(
    authoredServer: WorkspaceMcpServerMeta,
    requesterUserId?: string
  ): Promise<McpToolListResult> {
    this.assertOpen();
    assertPublicMcpServer(authoredServer);
    if (!requesterUserId) return listMcpTools(authoredServer, { env: {} });
    if (requesterUserId !== this.userId) {
      throw new Error('MCP authentication account mismatch.');
    }
    const server = this.connectionTarget(authoredServer);
    let headers: Record<string, string> = {};
    let localEnv: Record<string, string> = {};
    let tokenRevision: number | undefined;
    if (server.connection?.authentication === 'local') {
      if (server.transport === 'http') {
        try {
          const token = await this.acquireToken(server, { forceFromHub: true });
          headers = token.headers;
          tokenRevision = token.revision;
        } catch (error) {
          if (
            !(error instanceof McpAuthenticationError) ||
            (error.reason !== 'oauth_required' && error.reason !== 'expired')
          ) {
            throw error;
          }
        }
      } else if (server.transport === 'stdio') {
        localEnv = (await this.acquireToken(server, { forceFromHub: true })).env;
      }
    }
    const tools = await listMcpTools(server, {
      env: this.mergedEnv(),
      headers,
      localEnv,
      fetch: async (input, init) => {
        const response = await this.io.fetch(input, {
          ...init,
          redirect: 'error',
          credentials: 'omit',
        });
        if (response.status === 401) {
          await this.observe(
            server,
            response,
            init?.signal ?? (input instanceof Request ? input.signal : undefined),
            tokenRevision
          );
        }
        return response;
      },
    });
    this.connected(server);
    return tools;
  }

  async prepare(
    authoredServer: WorkspaceMcpServerMeta,
    resolved: ResolvedMcpServer,
    owner: string,
    requesterUserId: string
  ): Promise<ResolvedMcpServer> {
    this.assertOpen();
    if (this.closedOwners.has(owner)) {
      throw new McpAuthenticationError({ reason: 'cancelled' });
    }
    const server = this.connectionTarget(authoredServer, resolved);
    const own = requesterUserId === this.userId;
    if (
      'type' in resolved &&
      (server.connection?.transport !== 'http' || server.connection.url !== resolved.url)
    ) {
      throw new McpAuthenticationError({ reason: 'unsupported' });
    }
    if (
      !('type' in resolved) &&
      (server.connection?.transport !== 'stdio' ||
        server.connection.command !== resolved.command ||
        JSON.stringify(server.connection.args ?? []) !== JSON.stringify(resolved.args))
    ) {
      throw new McpAuthenticationError({ reason: 'unsupported' });
    }
    if (!own && server.connection?.authentication === 'local') {
      throw new McpAuthenticationError({ reason: 'oauth_required' });
    }

    if (!('type' in resolved)) {
      if (!own || server.connection?.authentication !== 'local') {
        return resolved;
      }
      const token = await this.acquireToken(server, { forceFromHub: true });
      if (this.closed || this.closedOwners.has(owner)) {
        throw new McpAuthenticationError({ reason: 'cancelled' });
      }
      return {
        ...resolved,
        env: Object.entries({
          ...Object.fromEntries(resolved.env.map(({ name, value }) => [name, value])),
          ...token.env,
        }).map(([name, value]) => ({ name, value })),
      };
    }

    if (own && server.connection?.authentication === 'local') {
      await this.acquireToken(server, { forceFromHub: true });
    }

    const target = targetOf(server);
    const leaseKey = JSON.stringify([owner, server.id, target]);

    return await this.withLeaseLock(async () => {
      if (this.closed || this.closedOwners.has(owner)) {
        throw new McpAuthenticationError({ reason: 'cancelled' });
      }
      const existing = this.leases.get(leaseKey);
      if (existing) return existing.server;

      const leaseController = new AbortController();
      const leaseSignal = AbortSignal.any([this.shutdown.signal, leaseController.signal]);
      const queue = new BoundedRelayQueue(RELAY_QUEUE_CAPACITY);
      let endpoint: McpRelayEndpoint;
      try {
        endpoint = await this.io.relay((job) => queue.offer(job));
      } catch {
        queue.close(writeRedactedUnavailable);
        throw new McpAuthenticationError({ reason: 'connection_failed' });
      }

      const baseHeaders = Object.fromEntries(
        resolved.headers.map(({ name, value }) => [name.toLowerCase(), value])
      );

      const handleJob = async (job: McpRelayRequest): Promise<void> => {
        try {
          let token: CachedToken | undefined;
          if (own && server.connection?.authentication === 'local') {
            token = await this.acquireToken(server, { signal: leaseSignal });
          }
          let response = await this.io.forward(
            job,
            resolved.url,
            { ...baseHeaders, ...(token?.headers ?? {}) },
            leaseSignal
          );
          let observedRevision = token?.revision;
          if (response?.status === 401 && own && server.connection?.authentication === 'local') {
            const fresh = await this.acquireToken(server, {
              forceRefresh: true,
              failedRevision: token?.revision,
              signal: leaseSignal,
            });
            observedRevision = fresh.revision;
            response = await this.io.forward(
              job,
              resolved.url,
              { ...baseHeaders, ...fresh.headers },
              leaseSignal
            );
          }
          if (response) {
            if (response.status === 401) {
              if (own) await this.observe(server, response, leaseSignal, observedRevision);
              writeRedactedUnavailable(job);
            } else if (response.status === 404 || response.status === 405) {
              writeProtocolStatusError(job, response);
            } else {
              writeRedactedUnavailable(job);
            }
          }
        } catch {
          writeRedactedUnavailable(job);
        } finally {
          if (!job.response.writableEnded) {
            job.response.destroy();
          }
        }
      };

      const workers = Array.from({ length: RELAY_WORKER_CONCURRENCY }, async () => {
        for (;;) {
          const job = await queue.take();
          if (!job) break;
          await handleJob(job);
        }
      });

      let closingLease: Promise<void> | undefined;
      const closeLease = () => {
        if (closingLease) return closingLease;
        closingLease = (async () => {
          leaseController.abort();
          queue.close(writeRedactedUnavailable);
          await closeWithTimeout(() => endpoint.close());
          await closeWithTimeout(async () => {
            await Promise.allSettled(workers);
          });
        })();
        return closingLease;
      };

      const connection: ResolvedMcpServer = {
        type: 'http',
        name: resolved.name,
        url: endpoint.url,
        headers: [{ name: 'Authorization', value: `Bearer ${endpoint.capability}` }],
      };
      this.leases.set(leaseKey, {
        owner,
        serverId: server.id,
        server: connection,
        close: closeLease,
      });
      return connection;
    });
  }

  async release(owner: string): Promise<void> {
    const toClose: RelayLease[] = [];
    await this.withLeaseLock(async () => {
      this.closedOwners.add(owner);
      for (const [key, lease] of this.leases) {
        if (lease.owner === owner) {
          this.leases.delete(key);
          toClose.push(lease);
        }
      }
    });
    await Promise.all(toClose.map((lease) => lease.close()));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.shutdown.abort();
    this.closing = (async () => {
      const runningAttempts = [...this.attempts.values()];
      for (const attempt of runningAttempts) {
        attempt.controller.abort(new Error('shutdown'));
      }
      await Promise.allSettled(runningAttempts.map((attempt) => attempt.done));
      this.attempts.clear();

      await this.revokeLeases(() => true);
      this.tokenCache.clear();
      this.localStates.clear();
    })();
    return this.closing;
  }
}
