// A self-hosted Streams hub: the single-node Durable Streams server from
// `@loro-dev/loro-cli` behind a bearer-token gate. Devices that share the
// hub's address and token sync and control each other without any hosted
// service.
//
// The upstream server has no authentication, so it only ever listens on
// loopback; the gate is the sole network entry point.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { LORO_STREAMS_BUCKET_ID } from '@lody/shared';
import { createApnsSender, readApnsConfig, type ApnsSender } from './apns';
import { createLanHubGitHub, type LanHubGitHub } from './hub-github';
import {
  LAN_HUB_HANDOVER_ABORT_PATH,
  LAN_HUB_HANDOVER_COMPLETE_PATH,
  LAN_HUB_HANDOVER_PATH,
  LAN_HUB_WHERE_PATH,
  readLanHubMoved,
  writeLanHubHandover,
  writeLanHubMoved,
  type LanHubMoved,
} from './hub-handover';
import { createLanHubPush, type LanHubPush } from './hub-push';

export const LAN_HUB_DEFAULT_PORT = 8788;
export const LAN_HUB_LORO_CLI_PACKAGE = '@loro-dev/loro-cli';
const UPSTREAM_START_TIMEOUT_MS = 15_000;
const LIVE_READ_KEEPALIVE_MS = 15_000;
const TOKEN_FILE_NAME = 'token';
const DATABASE_FILE_NAME = 'streams.sqlite';
/** A new host that took the data and never said it runs leaves the LAN here again. */
const HANDOVER_TIMEOUT_MS = 10 * 60_000;
const HANDOVER_BODY_MAX_BYTES = 4096;

// Connection-scoped headers must not cross the proxy in either direction.
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function getDefaultLanHubDataDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.lody-lan-hub');
}

export type LanHubUpstream = {
  port: number;
  /** Resolves with the exit code once the upstream is gone. */
  exited: Promise<number | null>;
  stop(): void;
};

export type LanHubServerOptions = {
  host: string;
  port: number;
  dataDir: string;
  tls?: { cert: Buffer; key: Buffer } | null;
  /** Replaces the Streams server; the gate is tested without spawning one. */
  startUpstream?: (options: { dataDir: string }) => Promise<LanHubUpstream>;
  keepaliveMs?: number;
  handoverTimeoutMs?: number;
  /** Replaces APNs; push is tested without Apple. */
  sendPush?: ApnsSender;
  log?: (line: string) => void;
};

export type LanHubServer = {
  /** Where this process listens; other devices may need another address. */
  url: string;
  port: number;
  token: string;
  /** Resolves when the hub stopped, with the reason when it did not stop on request. */
  stopped: Promise<{ error: Error | null }>;
  close(): Promise<void>;
};

export class LanHubUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LanHubUnavailableError';
  }
}

/** The credential of a hub, created the first time the hub starts. */
export function loadOrCreateLanHubToken(dataDir: string): string {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tokenPath = path.join(dataDir, TOKEN_FILE_NAME);
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

/** The credential of a hub that has started before; `null` when it never did. */
export function readLanHubToken(dataDir: string): string | null {
  try {
    return fs.readFileSync(path.join(dataDir, TOKEN_FILE_NAME), 'utf8').trim() || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function resolveLoroCli(): { binPath: string; manifestPath: string } {
  const require = createRequire(import.meta.url);
  let manifestPath: string;
  try {
    manifestPath = require.resolve(`${LAN_HUB_LORO_CLI_PACKAGE}/package.json`);
  } catch (error) {
    throw new LanHubUnavailableError(
      `Hosting a LAN needs ${LAN_HUB_LORO_CLI_PACKAGE}, which is not installed next to this CLI. ` +
        'The desktop application does not ship it; install the CLI on the machine that hosts the LAN.',
      { cause: error }
    );
  }
  const manifest = require(manifestPath) as { bin?: { loro?: string } };
  return {
    manifestPath,
    binPath: path.join(path.dirname(manifestPath), manifest.bin?.loro ?? 'bin/loro.mjs'),
  };
}

/**
 * A package manager that skips dependency build scripts leaves the Streams
 * server without its SQLite binding. The package's own install script fetches
 * the prebuilt binary.
 */
function ensureSqliteBinding(loroCliManifestPath: string): void {
  const sqliteDir = path.dirname(
    createRequire(loroCliManifestPath).resolve('better-sqlite3/package.json')
  );
  if (fs.existsSync(path.join(sqliteDir, 'build', 'Release', 'better_sqlite3.node'))) return;
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'install', '--silent'],
    { cwd: sqliteDir, stdio: ['ignore', 'ignore', 'inherit'] }
  );
  if (result.status !== 0) {
    throw new LanHubUnavailableError(
      `Failed to install the SQLite binding of the Streams server in ${sqliteDir}`
    );
  }
}

function waitForUpstreamPort(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(
      () => reject(new LanHubUnavailableError('Timed out waiting for the Streams server to start')),
      UPSTREAM_START_TIMEOUT_MS
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      try {
        const parsed = JSON.parse(stdout) as { ok?: boolean; data?: { port?: unknown } };
        if (parsed.ok === true && typeof parsed.data?.port === 'number') {
          clearTimeout(timer);
          resolve(parsed.data.port);
        }
      } catch {
        // Wait for the complete JSON envelope.
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      // Startup failures arrive as a JSON envelope on stdout.
      const detail = stdout.trim();
      reject(
        new LanHubUnavailableError(
          `Streams server exited before becoming ready (code=${String(code)})${
            detail ? `\n${detail}` : ''
          }`
        )
      );
    });
  });
}

async function startStreamsServer(options: { dataDir: string }): Promise<LanHubUpstream> {
  const loroCli = resolveLoroCli();
  ensureSqliteBinding(loroCli.manifestPath);
  const child = spawn(
    process.execPath,
    [
      loroCli.binPath,
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--protocol',
      'http1',
      '--db-path',
      path.join(options.dataDir, DATABASE_FILE_NAME),
      '--json',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  try {
    const port = await waitForUpstreamPort(child);
    return { port, exited, stop: () => void child.kill('SIGTERM') };
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
}

function requestUpstream(port: number, method: string, requestPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, method, path: requestPath },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      }
    );
    request.once('error', reject);
    request.end();
  });
}

function forwardedHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name.startsWith(':') || HOP_BY_HOP_HEADERS.has(name)) continue;
    // The credential is for this gate; the upstream has no use for it.
    if (name === 'authorization') continue;
    result[name] = value;
  }
  return result;
}

function answeredHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const result = forwardedHeaders(headers);
  for (const name of Object.keys(result)) {
    // The gate is what a browser talks to, so the gate alone states who may
    // read the answer. Two such statements make a browser refuse it.
    if (name.startsWith('access-control-') || name === 'vary') delete result[name];
  }
  return result;
}

function corsHeaders(request: http.IncomingMessage): http.OutgoingHttpHeaders {
  return {
    'Access-Control-Allow-Origin': request.headers.origin ?? '*',
    'Access-Control-Expose-Headers': '*',
    Vary: 'Origin',
  };
}

function sendJson(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  status: number,
  body: unknown
): void {
  response.writeHead(status, { ...corsHeaders(request), 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * Clients drop a live read that stays silent for 45 seconds and reconnect with
 * growing backoff, because a hosted gateway sends a keepalive every 15. The
 * development server sends none, so an idle room would spend much of its time
 * reconnecting. A comment line is ignored by the event parser and is only
 * written between events, never inside one.
 */
export function createLiveReadKeepalive(options: {
  write: (chunk: string) => void;
  intervalMs?: number;
}): { observe(chunk: Buffer): void; stop(): void } {
  const intervalMs = options.intervalMs ?? LIVE_READ_KEEPALIVE_MS;
  // The blank line that ends an event may arrive as its own chunk.
  let tail = '\n\n';
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const isBetweenEvents = () =>
    tail.endsWith('\n\n') || tail.endsWith('\r\n\r\n') || tail.endsWith('\r\r');
  const schedule = () => {
    if (timer) clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => {
      if (isBetweenEvents()) options.write(': keepalive\n\n');
      schedule();
    }, intervalMs);
    timer.unref?.();
  };
  schedule();
  return {
    observe: (chunk) => {
      tail = (tail + chunk.subarray(Math.max(0, chunk.length - 4)).toString('latin1')).slice(-4);
      schedule();
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function pipeLiveRead(
  upstreamResponse: http.IncomingMessage,
  response: http.ServerResponse,
  keepaliveMs: number | undefined
): void {
  const keepalive = createLiveReadKeepalive({
    intervalMs: keepaliveMs,
    write: (chunk) => {
      if (!response.writableEnded) response.write(chunk);
    },
  });
  upstreamResponse.on('data', (chunk: Buffer) => {
    keepalive.observe(chunk);
    if (!response.write(chunk)) {
      upstreamResponse.pause();
      response.once('drain', () => upstreamResponse.resume());
    }
  });
  upstreamResponse.once('end', () => {
    keepalive.stop();
    response.end();
  });
  upstreamResponse.once('error', (error) => {
    keepalive.stop();
    response.destroy(error);
  });
  response.once('close', () => keepalive.stop());
}

function isAuthorized(expected: Buffer, header: string | undefined): boolean {
  if (typeof header !== 'string') return false;
  const provided = Buffer.from(header);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function readSmallBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > HANDOVER_BODY_MAX_BYTES) request.destroy(new Error('body too large'));
    });
    request.once('end', () => resolve(body));
    request.once('error', reject);
  });
}

/**
 * Where a hub stands. It serves its LAN; or it is handing its data to a new
 * host and serves nothing, so nothing changes under the copy; or it moved,
 * and tells every member where.
 */
type HubState =
  | { kind: 'starting' }
  | { kind: 'serving'; upstream: LanHubUpstream }
  | { kind: 'handing-over'; timer: NodeJS.Timeout }
  | { kind: 'moved'; moved: LanHubMoved };

function createGate(options: {
  state: () => HubState;
  /** The routes of the hub itself: where it is, and its handover. */
  hub: (request: http.IncomingMessage, response: http.ServerResponse) => boolean;
  token: string;
  keepaliveMs?: number;
  push: LanHubPush;
  github: LanHubGitHub;
}): http.RequestListener {
  const expectedAuthorization = Buffer.from(`Bearer ${options.token}`);
  return (request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        ...corsHeaders(request),
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers':
          request.headers['access-control-request-headers'] ?? 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
      });
      response.end();
      return;
    }
    if (!isAuthorized(expectedAuthorization, request.headers.authorization)) {
      sendJson(request, response, 401, { error: 'unauthorized' });
      return;
    }
    if (options.hub(request, response)) return;
    const state = options.state();
    if (state.kind === 'moved') {
      sendJson(request, response, 410, { error: 'moved', ...state.moved });
      return;
    }
    if (state.kind !== 'serving') {
      response.setHeader('Retry-After', '30');
      sendJson(request, response, 503, { error: 'moving' });
      return;
    }
    if (request.url?.startsWith('/push/')) {
      void options.push.handle(request, response);
      return;
    }
    if (options.github.handles(request.url)) {
      options.github.handle(request, response);
      return;
    }

    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: state.upstream.port,
        method: request.method,
        path: request.url,
        headers: forwardedHeaders(request.headers),
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, {
          ...answeredHeaders(upstreamResponse.headers),
          ...corsHeaders(request),
        });
        const contentType = String(upstreamResponse.headers['content-type'] ?? '');
        if (contentType.toLowerCase().includes('text/event-stream')) {
          pipeLiveRead(upstreamResponse, response, options.keepaliveMs);
          return;
        }
        upstreamResponse.pipe(response);
      }
    );
    upstream.once('error', (error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      sendJson(request, response, 502, { error: 'hub upstream unavailable' });
    });
    // A live read stays open until the client leaves; release the upstream
    // subscription with it.
    response.once('close', () => upstream.destroy());
    request.pipe(upstream);
  };
}

export async function startLanHubServer(options: LanHubServerOptions): Promise<LanHubServer> {
  const dataDir = path.resolve(options.dataDir);
  const token = loadOrCreateLanHubToken(dataDir);
  const startUpstream = options.startUpstream ?? startStreamsServer;
  const loadApnsConfig = () => {
    try {
      return readApnsConfig(dataDir);
    } catch (error) {
      options.log?.(`[push] unreadable APNs configuration: ${String(error)}`);
      return null;
    }
  };
  const apns = createApnsSender({ loadConfig: loadApnsConfig });
  const push = createLanHubPush({
    dataDir,
    send: options.sendPush ?? apns,
    isConfigured: () => Boolean(options.sendPush) || loadApnsConfig() !== null,
    log: options.log,
  });

  let server: http.Server | https.Server | null = null;
  let closing = false;
  let resolveStopped: (result: { error: Error | null }) => void = () => {};
  const stopped = new Promise<{ error: Error | null }>((resolve) => (resolveStopped = resolve));
  let state: HubState = { kind: 'starting' };

  const close = async (error: Error | null = null): Promise<void> => {
    if (closing) {
      await stopped;
      return;
    }
    closing = true;
    const listening = server;
    if (listening) {
      await new Promise<void>((resolve) => {
        listening.close(() => resolve());
        // Live reads never end on their own.
        listening.closeAllConnections();
      });
    }
    apns.close();
    if (state.kind === 'serving') {
      state.upstream.stop();
      await state.upstream.exited;
    }
    if (state.kind === 'handing-over') clearTimeout(state.timer);
    resolveStopped({ error });
  };

  /** Starts the Streams server and serves the LAN with it. */
  const serve = async (): Promise<void> => {
    const upstream = await startUpstream({ dataDir });
    state = { kind: 'serving', upstream };
    void upstream.exited.then((code) => {
      // A handover stops the server on purpose, and a later one replaces it.
      if (closing || state.kind !== 'serving' || state.upstream !== upstream) return;
      void close(
        new LanHubUnavailableError(`Streams server exited unexpectedly (code=${String(code)})`)
      );
    });
    const bucketStatus = await requestUpstream(
      upstream.port,
      'PUT',
      `/ds/${encodeURIComponent(LORO_STREAMS_BUCKET_ID)}`
    );
    if (bucketStatus !== 201 && bucketStatus !== 409) {
      throw new LanHubUnavailableError(
        `Failed to prepare the ${LORO_STREAMS_BUCKET_ID} bucket (status=${bucketStatus})`
      );
    }
  };

  /** The data stays where it is; the LAN is served here again. */
  const resume = async (reason: string): Promise<void> => {
    if (closing || state.kind !== 'handing-over') return;
    clearTimeout(state.timer);
    options.log?.(`[handover] Serving the LAN here again: ${reason}`);
    try {
      await serve();
    } catch (error) {
      await close(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const hubRoutes = (request: http.IncomingMessage, response: http.ServerResponse): boolean => {
    const route = request.url?.split('?')[0];
    if (route === LAN_HUB_WHERE_PATH && request.method === 'GET') {
      if (state.kind === 'moved') sendJson(request, response, 410, state.moved);
      else sendJson(request, response, 200, { movedTo: null });
      return true;
    }
    if (request.method !== 'POST') return false;
    if (route === LAN_HUB_HANDOVER_PATH) {
      void handOver(request, response);
      return true;
    }
    if (route === LAN_HUB_HANDOVER_COMPLETE_PATH) {
      void completeHandover(request, response);
      return true;
    }
    if (route === LAN_HUB_HANDOVER_ABORT_PATH) {
      void (async () => {
        const wasHandingOver = state.kind === 'handing-over';
        await resume('the new host gave up');
        sendJson(request, response, 200, { resumed: wasHandingOver });
      })();
      return true;
    }
    return false;
  };

  const handOver = async (
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> => {
    if (state.kind !== 'serving') {
      sendJson(request, response, 409, { error: state.kind });
      return;
    }
    const { upstream } = state;
    const timer = setTimeout(
      () => void resume('the new host did not say it runs'),
      options.handoverTimeoutMs ?? HANDOVER_TIMEOUT_MS
    );
    timer.unref?.();
    state = { kind: 'handing-over', timer };
    options.log?.('[handover] A new host asked for this LAN; stopping the Streams server.');
    upstream.stop();
    await upstream.exited;
    response.writeHead(200, {
      ...corsHeaders(request),
      'Content-Type': 'application/octet-stream',
    });
    try {
      const files = await writeLanHubHandover(dataDir, response);
      response.end();
      options.log?.(`[handover] Sent ${files} file(s); waiting for the new host.`);
    } catch (error) {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
      await resume(`sending failed: ${String(error)}`);
    }
  };

  const completeHandover = async (
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> => {
    let movedTo: unknown;
    try {
      movedTo = (JSON.parse(await readSmallBody(request)) as { url?: unknown }).url;
    } catch {
      movedTo = null;
    }
    if (typeof movedTo !== 'string' || movedTo.trim() === '') {
      sendJson(request, response, 400, { error: 'url required' });
      return;
    }
    if (state.kind !== 'handing-over') {
      sendJson(request, response, 409, { error: state.kind });
      return;
    }
    clearTimeout(state.timer);
    let moved: LanHubMoved;
    try {
      moved = writeLanHubMoved(dataDir, token, movedTo);
    } catch (error) {
      sendJson(request, response, 500, { error: String(error) });
      return;
    }
    state = { kind: 'moved', moved };
    options.log?.(`[handover] The LAN moved to ${moved.movedTo}; members are pointed there.`);
    sendJson(request, response, 200, moved);
  };

  try {
    const moved = readLanHubMoved(dataDir);
    if (moved) {
      state = { kind: 'moved', moved };
      options.log?.(`[handover] This LAN moved to ${moved.movedTo}; members are pointed there.`);
    } else {
      await serve();
    }
    const gate = createGate({
      state: () => state,
      hub: hubRoutes,
      token,
      keepaliveMs: options.keepaliveMs,
      push,
      github: createLanHubGitHub({ dataDir, log: options.log }),
    });
    const created = options.tls
      ? https.createServer({ cert: options.tls.cert, key: options.tls.key }, gate)
      : http.createServer(gate);
    // Live reads are long-lived by design.
    created.requestTimeout = 0;
    // A member reuses an idle connection for its next request. Closing it
    // after Node's default five seconds races that request, and over a slow
    // link the close is still in flight often enough to fail joins; keep idle
    // connections well past any member's reuse.
    created.keepAliveTimeout = 65_000;
    created.headersTimeout = 66_000;
    await new Promise<void>((resolve, reject) => {
      created.once('error', reject);
      created.listen(options.port, options.host, () => {
        created.off('error', reject);
        resolve();
      });
    });
    server = created;
  } catch (error) {
    await close();
    throw error;
  }

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const host = options.host.includes(':') ? `[${options.host}]` : options.host;
  return {
    url: `${options.tls ? 'https' : 'http'}://${host}:${port}`,
    port,
    token,
    stopped,
    close: () => close(),
  };
}
