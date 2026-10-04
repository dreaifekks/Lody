// A minimal APNs provider for a self-hosted hub: token-based (.p8) auth over
// HTTP/2, alert and Live Activity pushes. The hub sends to the few devices of
// one LAN, so one session per APNs host is plenty.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http2 from 'node:http2';
import path from 'node:path';

export type ApnsEnvironment = 'development' | 'production';

export type ApnsConfig = {
  keyId: string;
  teamId: string;
  /** Contents of the AuthKey_<keyId>.p8 file. */
  privateKey: string;
};

export type ApnsPush = {
  deviceToken: string;
  environment: ApnsEnvironment;
  topic: string;
  pushType: 'alert' | 'liveactivity';
  priority: 5 | 10;
  payload: unknown;
  collapseId?: string;
  /** Seconds since epoch; 0 delivers once or never. */
  expiration?: number;
};

export type ApnsResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      reason: string;
      /** The token is dead for this topic and environment; forget it. */
      unregistered: boolean;
    };

export type ApnsSender = (push: ApnsPush) => Promise<ApnsResult>;

export const APNS_CONFIG_FILE_NAME = 'apns.json';
export const APNS_KEY_FILE_NAME = 'apns-key.p8';
const HOSTS: Record<ApnsEnvironment, string> = {
  development: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
};
// APNs refuses a provider token older than an hour and one refreshed more
// often than every 20 minutes.
const PROVIDER_TOKEN_TTL_MS = 40 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const KEY_ID_PATTERN = /^[A-Z0-9]{10}$/;
const DEVICE_TOKEN_PATTERN = /^[a-f0-9]{32,200}$/;

export function isApnsDeviceToken(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_TOKEN_PATTERN.test(value);
}

/** Validates the parts of a key before anything is written to disk. */
export function validateApnsConfig(config: ApnsConfig): ApnsConfig {
  if (!KEY_ID_PATTERN.test(config.keyId)) throw new Error('APNs key id must be 10 characters');
  if (!KEY_ID_PATTERN.test(config.teamId)) throw new Error('Apple team id must be 10 characters');
  try {
    const key = crypto.createPrivateKey(config.privateKey);
    if (key.asymmetricKeyType !== 'ec') throw new Error('not an EC key');
  } catch (error) {
    throw new Error(`Not an APNs .p8 key: ${error instanceof Error ? error.message : error}`, {
      cause: error,
    });
  }
  return config;
}

export function writeApnsConfig(dataDir: string, config: ApnsConfig): void {
  validateApnsConfig(config);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, APNS_KEY_FILE_NAME), config.privateKey, { mode: 0o600 });
  fs.writeFileSync(
    path.join(dataDir, APNS_CONFIG_FILE_NAME),
    `${JSON.stringify({ keyId: config.keyId, teamId: config.teamId }, null, 2)}\n`,
    { mode: 0o600 }
  );
}

/** `false` when there was nothing to remove. */
export function removeApnsConfig(dataDir: string): boolean {
  let removed = false;
  for (const name of [APNS_CONFIG_FILE_NAME, APNS_KEY_FILE_NAME]) {
    try {
      fs.unlinkSync(path.join(dataDir, name));
      removed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return removed;
}

/** `null` until `lody lan push setup` has run on the hub. */
export function readApnsConfig(dataDir: string): ApnsConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dataDir, APNS_CONFIG_FILE_NAME), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as { keyId?: unknown; teamId?: unknown };
  if (typeof parsed.keyId !== 'string' || typeof parsed.teamId !== 'string') return null;
  const privateKey = fs.readFileSync(path.join(dataDir, APNS_KEY_FILE_NAME), 'utf8');
  return { keyId: parsed.keyId, teamId: parsed.teamId, privateKey };
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

export function createApnsProviderToken(config: ApnsConfig, nowMs: number): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(nowMs / 1000) }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: config.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${claims}.${base64url(signature)}`;
}

/**
 * Sends through the configuration it reads at each push, so `lody lan push
 * setup` takes effect on a running hub.
 */
export function createApnsSender(options: {
  loadConfig: () => ApnsConfig | null;
  now?: () => number;
}): ApnsSender & { close(): void } {
  const now = options.now ?? Date.now;
  const sessions = new Map<ApnsEnvironment, http2.ClientHttp2Session>();
  let providerToken: { value: string; keyId: string; teamId: string; issuedAt: number } | null =
    null;

  const tokenFor = (config: ApnsConfig): string => {
    const current = now();
    if (
      !providerToken ||
      providerToken.keyId !== config.keyId ||
      providerToken.teamId !== config.teamId ||
      current - providerToken.issuedAt > PROVIDER_TOKEN_TTL_MS
    ) {
      providerToken = {
        value: createApnsProviderToken(config, current),
        keyId: config.keyId,
        teamId: config.teamId,
        issuedAt: current,
      };
    }
    return providerToken.value;
  };

  const sessionFor = (environment: ApnsEnvironment): http2.ClientHttp2Session => {
    const existing = sessions.get(environment);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = http2.connect(HOSTS[environment]);
    const forget = () => {
      if (sessions.get(environment) === session) sessions.delete(environment);
    };
    session.on('error', forget);
    session.on('goaway', forget);
    session.on('close', forget);
    // An idle hub must not be kept alive by its push connection.
    session.unref();
    sessions.set(environment, session);
    return session;
  };
  // A push in flight keeps the process alive until APNs answers.
  const inFlight = new WeakMap<http2.ClientHttp2Session, number>();
  const hold = (session: http2.ClientHttp2Session) => {
    inFlight.set(session, (inFlight.get(session) ?? 0) + 1);
    session.ref();
    return () => {
      const left = (inFlight.get(session) ?? 1) - 1;
      inFlight.set(session, left);
      if (left === 0 && !session.destroyed) session.unref();
    };
  };

  const send: ApnsSender = async (push) => {
    const config = options.loadConfig();
    if (!config) return { ok: false, status: 0, reason: 'NotConfigured', unregistered: false };
    const headers: http2.OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': `/3/device/${push.deviceToken}`,
      authorization: `bearer ${tokenFor(config)}`,
      'apns-topic': push.topic,
      'apns-push-type': push.pushType,
      'apns-priority': String(push.priority),
      'apns-expiration': String(push.expiration ?? 0),
      'content-type': 'application/json',
    };
    if (push.collapseId) headers['apns-collapse-id'] = push.collapseId.slice(0, 64);
    const body = JSON.stringify(push.payload);
    return await new Promise<ApnsResult>((resolve) => {
      let request: http2.ClientHttp2Stream;
      let release: () => void;
      try {
        const session = sessionFor(push.environment);
        request = session.request(headers);
        release = hold(session);
      } catch (error) {
        resolve({ ok: false, status: 0, reason: String(error), unregistered: false });
        return;
      }
      request.setTimeout(REQUEST_TIMEOUT_MS, () => request.close(http2.constants.NGHTTP2_CANCEL));
      let status = 0;
      let text = '';
      request.on('response', (responseHeaders) => {
        status = Number(responseHeaders[':status'] ?? 0);
      });
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => (text += chunk));
      request.on('error', (error) =>
        resolve({ ok: false, status, reason: error.message, unregistered: false })
      );
      request.on('close', () => {
        release();
        if (status === 200) {
          resolve({ ok: true });
          return;
        }
        let reason = text || 'NoResponse';
        try {
          reason = (JSON.parse(text) as { reason?: string }).reason ?? reason;
        } catch {
          // Not JSON; keep the raw text.
        }
        if (reason === 'ExpiredProviderToken') providerToken = null;
        resolve({
          ok: false,
          status,
          reason,
          unregistered:
            status === 410 ||
            reason === 'BadDeviceToken' ||
            reason === 'Unregistered' ||
            reason === 'DeviceTokenNotForTopic',
        });
      });
      request.end(body);
    });
  };

  return Object.assign(send, {
    close: () => {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    },
  });
}
