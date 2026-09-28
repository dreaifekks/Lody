// Node-only contract for the self-hosted Streams hub used by the local
// platform. The CLI and the Electron shell read the same file so every local
// process agrees on one hub, identity and workspace.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getLodyDataDir } from './installation-profile';
import { LOCAL_USER_ID_PREFIX, LOCAL_WORKSPACE_ID_PREFIX } from '../platform-kind';

export const LAN_HUB_CONFIG_FILE_NAME = 'lan-hub.json';
export const LAN_HUB_URL_ENV = 'LODY_LAN_HUB_URL';
export const LAN_HUB_TOKEN_ENV = 'LODY_LAN_HUB_TOKEN';
export const LAN_HUB_WORKSPACE_NAME = 'Lody LAN';
export const LAN_HUB_WORKSPACE_SLUG = 'lan';

export type LanHubConfig = {
  /** Origin of the hub, e.g. `http://100.64.0.1:8788`. No trailing slash. */
  url: string;
  /** Bearer credential shared by every device that joins this hub. */
  token: string;
};

export type LanHubIdentity = {
  userId: string;
  workspaceId: string;
};

export function getLanHubConfigPath(): string {
  return path.join(getLodyDataDir('local'), LAN_HUB_CONFIG_FILE_NAME);
}

function parseLanHubConfig(
  source: string,
  value: { url?: unknown; token?: unknown }
): LanHubConfig {
  const url = typeof value.url === 'string' ? value.url.trim().replace(/\/+$/g, '') : '';
  const token = typeof value.token === 'string' ? value.token.trim() : '';
  if (!url || !token) {
    throw new Error(`LAN hub config from ${source} requires both url and token`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`LAN hub url from ${source} is not a valid URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`LAN hub url from ${source} must use http or https`);
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`LAN hub url from ${source} must be an origin without path or query`);
  }
  return { url: parsed.origin, token };
}

/**
 * Returns the configured hub, or `null` when the installation is plain
 * local-only. A present but malformed config throws: silently falling back to
 * local-only would strand writes the user expects to reach other devices.
 */
export function readLanHubConfig(
  options: { env?: NodeJS.ProcessEnv; filePath?: string } = {}
): LanHubConfig | null {
  const env = options.env ?? process.env;
  const envUrl = env[LAN_HUB_URL_ENV]?.trim();
  const envToken = env[LAN_HUB_TOKEN_ENV]?.trim();
  if (envUrl || envToken) {
    return parseLanHubConfig('environment', { url: envUrl, token: envToken });
  }

  const filePath = options.filePath ?? getLanHubConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error(`LAN hub config ${filePath} is not valid JSON`, { cause: error });
  }
  if (!decoded || typeof decoded !== 'object') {
    throw new Error(`LAN hub config ${filePath} must be an object`);
  }
  return parseLanHubConfig(filePath, decoded as { url?: unknown; token?: unknown });
}

function deriveId(label: string, token: string): string {
  return crypto
    .createHash('sha256')
    .update(`lody-lan-hub:${label}:${token}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Every device holding the same hub token resolves the same user and
 * workspace, so their machines and sessions belong to one owner without any
 * account service. The ids keep the local prefixes and stay disjoint from
 * hosted ids.
 */
export function deriveLanHubIdentity(token: string): LanHubIdentity {
  return {
    userId: `${LOCAL_USER_ID_PREFIX}${deriveId('user', token)}`,
    workspaceId: `${LOCAL_WORKSPACE_ID_PREFIX}${deriveId('workspace', token)}`,
  };
}
