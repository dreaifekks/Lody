import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RateLimit } from 'acp-extension-core';
import type { AgentConfigId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import {
  AntigravityQuotaPoller,
  antigravityRateLimitsFromSummary,
  createAntigravityQuotaClient,
} from './antigravity-quota';

// Synthetic, shaped like Cloud Code's `retrieveUserQuotaSummary` answer.
const SUMMARY = {
  groups: [
    {
      displayName: 'Gemini Models',
      buckets: [
        {
          bucketId: 'gemini-weekly',
          window: 'weekly',
          resetTime: '2026-10-09T05:20:44Z',
          remainingFraction: 0.75,
        },
        {
          bucketId: 'gemini-5h',
          window: '5h',
          resetTime: '2026-10-04T05:18:55Z',
          remainingFraction: 0.5,
        },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      buckets: [
        { bucketId: '3p-weekly', window: 'weekly', resetTime: '2026-10-10T14:42:16Z' },
        { bucketId: '3p-5h', window: '5h', remainingFraction: 1 },
      ],
    },
  ],
};

const silentLogger = { debug: () => undefined } as unknown as Logger;

describe('antigravityRateLimitsFromSummary', () => {
  it('makes one limit per model group with the shortest window first', () => {
    expect(antigravityRateLimitsFromSummary(SUMMARY)).toEqual([
      {
        limitId: 'gemini',
        scope: { providerId: 'antigravity-acp' },
        limitName: 'Gemini',
        windows: [
          {
            label: 'Gemini',
            usedPercent: 50,
            windowDurationSeconds: 5 * 60 * 60,
            resetsAtEpochSeconds: Date.parse('2026-10-04T05:18:55Z') / 1000,
          },
          {
            label: 'Gemini',
            usedPercent: 25,
            windowDurationSeconds: 7 * 24 * 60 * 60,
            resetsAtEpochSeconds: Date.parse('2026-10-09T05:20:44Z') / 1000,
          },
        ],
      },
      {
        limitId: 'third-party',
        scope: { providerId: 'antigravity-acp' },
        limitName: 'Claude / GPT',
        windows: [
          {
            label: 'Claude / GPT',
            usedPercent: 0,
            windowDurationSeconds: 5 * 60 * 60,
            resetsAtEpochSeconds: null,
          },
          // No remainingFraction: proto JSON left out a zero, the window is used up.
          {
            label: 'Claude / GPT',
            usedPercent: 100,
            windowDurationSeconds: 7 * 24 * 60 * 60,
            resetsAtEpochSeconds: Date.parse('2026-10-10T14:42:16Z') / 1000,
          },
        ],
      },
    ]);
  });

  it('yields nothing for an answer of another shape', () => {
    expect(antigravityRateLimitsFromSummary({ groups: 'none' })).toEqual([]);
    expect(antigravityRateLimitsFromSummary(null)).toEqual([]);
  });
});

describe('createAntigravityQuotaClient', () => {
  let dir: string;
  let tokenPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-antigravity-quota-'));
    tokenPath = path.join(dir, 'acp_token.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const writeToken = async (refreshToken: string) => {
    await fs.writeFile(
      tokenPath,
      JSON.stringify({
        client_id: 'client-id',
        client_secret: 'client-secret',
        refresh_token: refreshToken,
        token_uri: 'https://oauth2.example.test/token',
        project_id: 'project-1',
      })
    );
  };

  // A fake Google: the token endpoint hands out one access token per refresh
  // token, and the quota endpoint records the bearer and body it was sent.
  const fakeGoogle = () => {
    const quotaRequests: { bearer: string | null; body: unknown }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://oauth2.example.test/token') {
        const form = new URLSearchParams(String(init?.body));
        return Response.json({
          access_token: `access-for-${form.get('refresh_token')}`,
          expires_in: 3600,
        });
      }
      if (url.endsWith('/v1internal:retrieveUserQuotaSummary')) {
        const headers = new Headers(init?.headers);
        // Like Cloud Code: a caller that is not Antigravity holds no licence.
        if (headers.get('User-Agent') !== 'antigravity') {
          return Response.json(
            { error: { code: 403, message: 'You do not have a valid license of this product.' } },
            { status: 403 }
          );
        }
        quotaRequests.push({
          bearer: headers.get('Authorization'),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json(SUMMARY);
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    return { fetchImpl, quotaRequests };
  };

  it('reads the quota with the access token of the current sign-in', async () => {
    const google = fakeGoogle();
    const client = createAntigravityQuotaClient({ tokenPath, fetch: google.fetchImpl });

    await writeToken('refresh-a');
    const limits = await client.fetchRateLimits();
    expect(limits?.map((limit) => limit.limitId)).toEqual(['gemini', 'third-party']);

    // Signing in again with another account replaces the cached access token.
    await writeToken('refresh-b');
    await client.fetchRateLimits();

    expect(google.quotaRequests).toEqual([
      { bearer: 'Bearer access-for-refresh-a', body: { project: 'project-1' } },
      { bearer: 'Bearer access-for-refresh-b', body: { project: 'project-1' } },
    ]);
  });

  it('answers null when this machine has no sign-in', async () => {
    const client = createAntigravityQuotaClient({ tokenPath, fetch: fakeGoogle().fetchImpl });
    await expect(client.fetchRateLimits()).resolves.toBeNull();
  });

  it('keeps the contents of an unreadable sign-in file out of its error', async () => {
    await fs.writeFile(tokenPath, '{"refresh_token": "secret-value"');
    const client = createAntigravityQuotaClient({ tokenPath, fetch: fakeGoogle().fetchImpl });

    const error = await client.fetchRateLimits().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('secret-value');
  });
});

describe('AntigravityQuotaPoller', () => {
  const limit = (limitId: string): RateLimit => ({
    limitId,
    scope: { providerId: 'antigravity-acp' },
    windows: [],
  });

  it('writes every limit to every Antigravity provider of the machine', async () => {
    const written: [AgentConfigId, string][] = [];
    const poller = new AntigravityQuotaPoller({
      listAgentConfigIds: async () => ['a' as AgentConfigId, 'b' as AgentConfigId],
      write: async (configId, rateLimit) => {
        written.push([configId, rateLimit.limitId]);
      },
      fetchRateLimits: async () => [limit('gemini'), limit('third-party')],
      logger: silentLogger,
    });

    await poller.poll();

    expect(written).toEqual([
      ['a', 'gemini'],
      ['a', 'third-party'],
      ['b', 'gemini'],
      ['b', 'third-party'],
    ]);
  });

  it('asks Google nothing while the machine has no Antigravity provider', async () => {
    let asked = false;
    const poller = new AntigravityQuotaPoller({
      listAgentConfigIds: async () => [],
      write: async () => undefined,
      fetchRateLimits: async () => {
        asked = true;
        return [];
      },
      logger: silentLogger,
    });

    await poller.poll();

    expect(asked).toBe(false);
  });

  it('survives a failed round and writes on the next one', async () => {
    const written: string[] = [];
    let fail = true;
    const poller = new AntigravityQuotaPoller({
      listAgentConfigIds: async () => ['a' as AgentConfigId],
      write: async (_configId, rateLimit) => {
        written.push(rateLimit.limitId);
      },
      fetchRateLimits: async () => {
        if (fail) throw new Error('offline');
        return [limit('gemini')];
      },
      logger: silentLogger,
    });

    await poller.poll();
    fail = false;
    await poller.poll();

    expect(written).toEqual(['gemini']);
  });
});
