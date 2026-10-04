// Subscription quota of Google Antigravity, read by the daemon itself: the
// official ACP server reports none, and no Lody adapter sits in front of it.
// The server's own sign-in (`~/.gemini/antigravity-acp/acp_token.json`) is
// refreshed for an access token, Cloud Code's quota summary is asked for, and
// each model group becomes one rate limit on the machine's provider rows, so
// every LAN member sees this machine's quota. The credential never leaves this
// module: not into logs, not into the Flock.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { RateLimit, RateLimitWindow } from 'acp-extension-core';
import { ANTIGRAVITY_AGENT_TYPE, type AgentConfigId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

export const ANTIGRAVITY_QUOTA_INTERVAL_MS = 5 * 60_000;
const CLOUD_CODE_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
// Cloud Code tells products apart by User-Agent; without it the account reads as unlicensed (403).
const CLOUD_CODE_USER_AGENT = 'antigravity';
const REQUEST_TIMEOUT_MS = 20_000;
/** An access token is replaced this long before Google says it expires. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

const TokenFileSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  refresh_token: z.string().min(1),
  token_uri: z.string().url().optional(),
  project_id: z.string().min(1).optional(),
});
type TokenFile = z.infer<typeof TokenFileSchema>;

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
});

const GoogleErrorSchema = z.object({ error: z.object({ message: z.string() }) });

const QuotaSummarySchema = z.object({
  groups: z
    .array(
      z.object({
        displayName: z.string().optional(),
        buckets: z
          .array(
            z.object({
              bucketId: z.string().optional(),
              window: z.string().optional(),
              resetTime: z.string().optional(),
              remainingFraction: z.number().optional(),
            })
          )
          .optional(),
      })
    )
    .optional(),
});

export function defaultAntigravityTokenPath(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity-acp', 'acp_token.json');
}

const WINDOW_SECONDS: Record<string, number> = {
  '5h': 5 * 60 * 60,
  daily: 24 * 60 * 60,
  weekly: 7 * 24 * 60 * 60,
};

function windowSeconds(window: string | undefined): number | null {
  if (!window) return null;
  const known = WINDOW_SECONDS[window];
  if (known) return known;
  const match = /^(\d+)([mhd])$/.exec(window);
  if (!match) return null;
  const unit = match[2] === 'm' ? 60 : match[2] === 'h' ? 60 * 60 : 24 * 60 * 60;
  return Number(match[1]) * unit;
}

/** The bucket id without its window suffix: `gemini-5h` → `gemini`, `3p-weekly` → `3p`. */
function groupIdOf(bucketId: string | undefined): string | null {
  const id = bucketId?.trim();
  if (!id) return null;
  const dash = id.lastIndexOf('-');
  return dash > 0 ? id.slice(0, dash) : id;
}

// The session usage popover picks a limit by matching its name against the
// selected model, so the Gemini group is named so that `gemini-*` models find it.
const GROUP_NAMES: Record<string, string> = { gemini: 'Gemini', '3p': 'Claude / GPT' };
// Provider rows show the first limit; `gemini` sorts before `third-party`.
const GROUP_LIMIT_IDS: Record<string, string> = { '3p': 'third-party' };

/**
 * Maps a `retrieveUserQuotaSummary` response to one rate limit per model group,
 * windows shortest first. Proto JSON omits a zero `remainingFraction`, so a
 * bucket without one is exhausted.
 */
export function antigravityRateLimitsFromSummary(summary: unknown): RateLimit[] {
  const parsed = QuotaSummarySchema.safeParse(summary);
  if (!parsed.success) return [];
  const limits: RateLimit[] = [];
  for (const group of parsed.data.groups ?? []) {
    const buckets = group.buckets ?? [];
    const groupId = buckets.map((bucket) => groupIdOf(bucket.bucketId)).find(Boolean);
    if (!groupId) continue;
    const name = GROUP_NAMES[groupId] ?? group.displayName?.trim() ?? groupId;
    const windows: RateLimitWindow[] = buckets
      .map((bucket) => {
        const remaining = Math.min(1, Math.max(0, bucket.remainingFraction ?? 0));
        const resetsAtMs = bucket.resetTime ? Date.parse(bucket.resetTime) : Number.NaN;
        return {
          label: name,
          usedPercent: Math.round((1 - remaining) * 1000) / 10,
          windowDurationSeconds: windowSeconds(bucket.window),
          resetsAtEpochSeconds: Number.isFinite(resetsAtMs) ? Math.floor(resetsAtMs / 1000) : null,
        };
      })
      .sort(
        (left, right) =>
          (left.windowDurationSeconds ?? Number.MAX_SAFE_INTEGER) -
          (right.windowDurationSeconds ?? Number.MAX_SAFE_INTEGER)
      );
    if (windows.length === 0) continue;
    limits.push({
      limitId: GROUP_LIMIT_IDS[groupId] ?? groupId,
      scope: { providerId: ANTIGRAVITY_AGENT_TYPE },
      limitName: name,
      windows,
    });
  }
  return limits;
}

export type AntigravityQuotaClientOptions = {
  tokenPath?: string;
  fetch?: typeof fetch;
  now?: () => number;
};

/** Reads the quota summary with the ACP server's own sign-in; null when this machine is not signed in. */
export function createAntigravityQuotaClient(options: AntigravityQuotaClientOptions = {}) {
  const tokenPath = options.tokenPath ?? defaultAntigravityTokenPath();
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let access: { token: string; refreshToken: string; until: number } | null = null;

  const readTokenFile = async (): Promise<TokenFile | null> => {
    let raw: string;
    try {
      raw = await fs.readFile(tokenPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    // JSON.parse quotes the input in its error, which would put the secret in the log.
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error('The Antigravity sign-in file is not JSON');
    }
    const parsed = TokenFileSchema.safeParse(json);
    if (!parsed.success) throw new Error('The Antigravity sign-in file has an unknown shape');
    return parsed.data;
  };

  const post = async (url: string, init: RequestInit): Promise<unknown> => {
    const response = await fetchImpl(url, {
      ...init,
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Google's error message names the reason (licence, quota project) and holds no credential.
      const detail = await response
        .json()
        .then((body: unknown) => GoogleErrorSchema.safeParse(body).data?.error.message)
        .catch(() => undefined);
      throw new Error(
        `${new URL(url).host} answered HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`
      );
    }
    return await response.json();
  };

  const accessToken = async (file: TokenFile): Promise<string> => {
    // The ACP server may sign in again with another account; a cached token
    // stays only while the refresh token it came from is unchanged.
    if (access && access.refreshToken === file.refresh_token && access.until > now()) {
      return access.token;
    }
    const body = new URLSearchParams({
      client_id: file.client_id,
      client_secret: file.client_secret,
      refresh_token: file.refresh_token,
      grant_type: 'refresh_token',
    });
    const parsed = TokenResponseSchema.parse(
      await post(file.token_uri ?? DEFAULT_TOKEN_URI, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
    );
    const lifetimeMs = (parsed.expires_in ?? 3600) * 1000;
    access = {
      token: parsed.access_token,
      refreshToken: file.refresh_token,
      until: now() + Math.max(0, lifetimeMs - TOKEN_EXPIRY_MARGIN_MS),
    };
    return access.token;
  };

  return {
    async fetchRateLimits(): Promise<RateLimit[] | null> {
      const file = await readTokenFile();
      if (!file) return null;
      const token = await accessToken(file);
      const summary = await post(CLOUD_CODE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': CLOUD_CODE_USER_AGENT,
        },
        body: JSON.stringify(file.project_id ? { project: file.project_id } : {}),
      });
      return antigravityRateLimitsFromSummary(summary);
    },
  };
}

export type AntigravityQuotaPollerOptions = {
  /** Antigravity providers of this machine. */
  listAgentConfigIds: () => Promise<AgentConfigId[]>;
  write: (agentConfigId: AgentConfigId, limits: RateLimit) => Promise<void>;
  fetchRateLimits: () => Promise<RateLimit[] | null>;
  logger: Logger;
  intervalMs?: number;
};

/** Polls while this machine has an Antigravity provider; quiet when it has none. */
export class AntigravityQuotaPoller {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastFailure: string | null = null;

  constructor(private readonly options: AntigravityQuotaPollerOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.options.intervalMs ?? ANTIGRAVITY_QUOTA_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One round; overlapping calls share it. */
  poll(): Promise<void> {
    this.running ??= this.pollOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pollOnce(): Promise<void> {
    try {
      const configIds = await this.options.listAgentConfigIds();
      if (configIds.length === 0) return;
      const limits = await this.options.fetchRateLimits();
      if (!limits) {
        this.reportFailure('no Antigravity sign-in on this machine');
        return;
      }
      for (const configId of configIds) {
        for (const limit of limits) {
          await this.options.write(configId, limit);
        }
      }
      this.lastFailure = null;
    } catch (error) {
      this.reportFailure(formatErrorMessage(error));
    }
  }

  // Logged once per distinct reason, so a machine that is signed out or offline
  // does not fill the file log every five minutes.
  private reportFailure(reason: string): void {
    if (reason === this.lastFailure) return;
    this.lastFailure = reason;
    this.options.logger.debug(`[antigravity-quota] Quota not read: ${reason}`);
  }
}
