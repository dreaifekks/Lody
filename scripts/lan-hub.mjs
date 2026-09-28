#!/usr/bin/env node
// Self-hosted Streams hub for the local platform: the single-node Durable
// Streams server from `@loro-dev/loro-cli` behind a bearer-token gate.
// Devices that share this hub's address and token sync and control each
// other without any hosted service.
//
//   node scripts/lan-hub.mjs --host 100.64.0.1 --port 8788
//
// The upstream server has no authentication, so it only ever listens on
// loopback; this process is the sole network entry point.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const STREAMS_BUCKET_ID = 'lody';
const UPSTREAM_START_TIMEOUT_MS = 15_000;
const LIVE_READ_KEEPALIVE_MS = 15_000;
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

const { values: args } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '8788' },
    'data-dir': { type: 'string', default: path.join(os.homedir(), '.lody-lan-hub') },
    'public-url': { type: 'string' },
    'tls-cert': { type: 'string' },
    'tls-key': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

if (args.help) {
  console.log(`Usage: node scripts/lan-hub.mjs [options]

  --host <address>      Interface to listen on (default 127.0.0.1).
                        Use a LAN or Tailscale address to serve other devices.
  --port <port>         Port to listen on (default 8788).
  --data-dir <path>     Stream database and token location (default ~/.lody-lan-hub).
  --public-url <url>    Address other devices use, printed in the client config.
  --tls-cert <path>     Serve HTTPS with this certificate (requires --tls-key).
  --tls-key <path>      Private key for --tls-cert.`);
  process.exit(0);
}

const port = Number(args.port);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error(`Invalid --port: ${args.port}`);
  process.exit(1);
}
if (Boolean(args['tls-cert']) !== Boolean(args['tls-key'])) {
  console.error('--tls-cert and --tls-key must be passed together');
  process.exit(1);
}
const tls = args['tls-cert']
  ? { cert: fs.readFileSync(args['tls-cert']), key: fs.readFileSync(args['tls-key']) }
  : null;

const dataDir = path.resolve(args['data-dir']);
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

function loadOrCreateToken() {
  const tokenPath = path.join(dataDir, 'token');
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing) return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

const token = loadOrCreateToken();
const expectedAuthorization = Buffer.from(`Bearer ${token}`);

function isAuthorized(header) {
  if (typeof header !== 'string') return false;
  const provided = Buffer.from(header);
  return (
    provided.length === expectedAuthorization.length &&
    crypto.timingSafeEqual(provided, expectedAuthorization)
  );
}

function resolveLoroCli() {
  // The server ships with the dev dependency the RPC integration test uses.
  const requireFromRpc = createRequire(
    new URL('../packages/loro-streams-rpc/package.json', import.meta.url)
  );
  const manifestPath = requireFromRpc.resolve('@loro-dev/loro-cli/package.json');
  const manifest = requireFromRpc(manifestPath);
  return {
    manifestPath,
    binPath: path.join(path.dirname(manifestPath), manifest.bin?.loro ?? 'bin/loro.mjs'),
  };
}

// pnpm skips dependency build scripts, so the server's own SQLite binding is
// absent on a fresh install. Same repair as the RPC integration test.
function ensureSqliteBinding(loroCliManifestPath) {
  const sqliteDir = path.dirname(
    createRequire(loroCliManifestPath).resolve('better-sqlite3/package.json')
  );
  if (fs.existsSync(path.join(sqliteDir, 'build', 'Release', 'better_sqlite3.node'))) return;
  console.log('Installing the SQLite binding for the Streams server...');
  const result = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['--dir', sqliteDir, 'run', 'install'],
    { stdio: 'inherit' }
  );
  if (result.status !== 0) {
    throw new Error('Failed to install the SQLite binding for the Streams server');
  }
}

function startUpstream() {
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
      path.join(dataDir, 'streams.sqlite'),
      '--json',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const ready = new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for the Streams server to start')),
      UPSTREAM_START_TIMEOUT_MS
    );
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      try {
        const parsed = JSON.parse(stdout);
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
        new Error(
          `Streams server exited before becoming ready (code=${code})${detail ? `\n${detail}` : ''}`
        )
      );
    });
  });
  return { child, ready };
}

function requestUpstream(upstreamPort, method, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: upstreamPort, method, path: requestPath },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      }
    );
    request.once('error', reject);
    request.end();
  });
}

function forwardedHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name.startsWith(':') || HOP_BY_HOP_HEADERS.has(name)) continue;
    // The credential is for this gate; the upstream has no use for it.
    if (name === 'authorization') continue;
    result[name] = value;
  }
  return result;
}

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': request.headers.origin ?? '*',
    'Access-Control-Expose-Headers': '*',
    Vary: 'Origin',
  };
}

function sendJson(request, response, status, body) {
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
function pipeLiveRead(upstreamResponse, response) {
  // The blank line that ends an event may arrive as its own chunk.
  let tail = '\n\n';
  let timer = null;
  const isBetweenEvents = () =>
    tail.endsWith('\n\n') || tail.endsWith('\r\n\r\n') || tail.endsWith('\r\r');
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (isBetweenEvents() && !response.writableEnded) response.write(': keepalive\n\n');
      schedule();
    }, LIVE_READ_KEEPALIVE_MS);
  };
  upstreamResponse.on('data', (chunk) => {
    tail = (tail + chunk.subarray(Math.max(0, chunk.length - 4)).toString('latin1')).slice(-4);
    if (!response.write(chunk)) {
      upstreamResponse.pause();
      response.once('drain', () => upstreamResponse.resume());
    }
    schedule();
  });
  upstreamResponse.once('end', () => {
    clearTimeout(timer);
    response.end();
  });
  upstreamResponse.once('error', (error) => {
    clearTimeout(timer);
    response.destroy(error);
  });
  response.once('close', () => clearTimeout(timer));
  schedule();
}

function createHandler(upstreamPort) {
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
    if (!isAuthorized(request.headers.authorization)) {
      sendJson(request, response, 401, { error: 'unauthorized' });
      return;
    }

    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: upstreamPort,
        method: request.method,
        path: request.url,
        headers: forwardedHeaders(request.headers),
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, {
          ...forwardedHeaders(upstreamResponse.headers),
          ...corsHeaders(request),
        });
        const contentType = String(upstreamResponse.headers['content-type'] ?? '');
        if (contentType.toLowerCase().includes('text/event-stream')) {
          pipeLiveRead(upstreamResponse, response);
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

let upstream = null;
let server = null;
let stopping = false;
let started = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  server?.close();
  server?.closeAllConnections?.();
  upstream?.child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

try {
  upstream = startUpstream();
  upstream.child.once('exit', (code) => {
    // Before readiness the rejected `ready` promise carries the reason.
    if (stopping || !started) return;
    console.error(`Streams server exited unexpectedly (code=${code})`);
    stop(1);
  });
  const upstreamPort = await upstream.ready;
  started = true;
  const bucketStatus = await requestUpstream(
    upstreamPort,
    'PUT',
    `/ds/${encodeURIComponent(STREAMS_BUCKET_ID)}`
  );
  if (bucketStatus !== 201 && bucketStatus !== 409) {
    throw new Error(`Failed to prepare the ${STREAMS_BUCKET_ID} bucket (status=${bucketStatus})`);
  }

  const handler = createHandler(upstreamPort);
  server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  // Live reads are long-lived by design.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, args.host, resolve);
  });

  const scheme = tls ? 'https' : 'http';
  const publicUrl = (args['public-url'] ?? `${scheme}://${args.host}:${port}`).replace(/\/+$/g, '');
  console.log(`Lody LAN hub listening on ${scheme}://${args.host}:${port}`);
  console.log(`Data directory: ${dataDir}`);
  console.log('');
  console.log('Save this as ~/.lody-oss/lan-hub.json on every device that joins the hub:');
  console.log(JSON.stringify({ url: publicUrl, token }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  stop(1);
}
