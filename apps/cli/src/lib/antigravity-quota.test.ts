import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RateLimit } from 'acp-extension-core';
import {
  ANTIGRAVITY_AGENT_TYPE,
  ANTIGRAVITY_ARGON_LIMIT_ID,
  getMachineFlockDocId,
  getMachineFlockRateLimits,
  getRateLimitEntryKey,
  readMachineFlockRowsFromFlock,
  type AgentConfigId,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import { LoroRepo } from 'loro-repo';
import { MachineDocument } from './loro/doc';
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
    {
      displayName: 'Gemini 4 Argon',
      description:
        'For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.',
      buckets: [
        {
          bucketId: 'gemini-argon-wtu-weekly',
          displayName: 'Gemini 4 Argon Weekly Limit',
          window: 'weekly',
          resetTime: '2026-10-24T02:47:02Z',
          remainingFraction: 0.5653113126754761,
        },
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
      {
        limitId: ANTIGRAVITY_ARGON_LIMIT_ID,
        scope: { providerId: 'antigravity-acp' },
        limitName: 'Argon',
        windows: [
          {
            label: 'Argon',
            usedPercent: 43.5,
            windowDurationSeconds: 7 * 24 * 60 * 60,
            resetsAtEpochSeconds: Date.parse('2026-10-24T02:47:02Z') / 1000,
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
    expect(limits?.map((limit) => limit.limitId)).toEqual([
      'gemini',
      'third-party',
      ANTIGRAVITY_ARGON_LIMIT_ID,
    ]);

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
  const workspaceId = 'quota-workspace' as WorkspaceId;
  const machineId = 'quota-machine' as MachineId;
  const configId = 'a' as AgentConfigId;
  const otherConfigId = 'b' as AgentConfigId;
  let repo: LoroRepo;
  let document: MachineDocument;

  beforeEach(async () => {
    repo = await LoroRepo.create({});
    document = new MachineDocument(repo, workspaceId, machineId, () => {});
    await document.init();
  });

  afterEach(async () => {
    await document.destroy();
    await repo.destroy();
  });

  const readLimits = async () => {
    const { flock } = await repo.openFlockDoc(getMachineFlockDocId(workspaceId, machineId));
    return getMachineFlockRateLimits(readMachineFlockRowsFromFlock(flock));
  };
  const replaceRateLimits = (id: AgentConfigId, limits: RateLimit[]) =>
    document.replaceRateLimits(id, ANTIGRAVITY_AGENT_TYPE, limits);
  const proLimits = antigravityRateLimitsFromSummary(SUMMARY);
  const ultraLimits = proLimits.slice(0, 2).map((limit) => ({
    ...limit,
    windows: limit.windows.map((window) => ({ ...window, usedPercent: 10 })),
  }));
  const entries = (id: AgentConfigId, limits: RateLimit[], cliType = ANTIGRAVITY_AGENT_TYPE) =>
    Object.fromEntries(
      limits.map((limit) => [getRateLimitEntryKey(cliType, limit.limitId, id), limit])
    );

  it('replaces Pro with Ultra quota and preserves other providers and CLI types', async () => {
    await replaceRateLimits(configId, proLimits);
    await replaceRateLimits(otherConfigId, proLimits);
    await document.updateRateLimits(configId, 'codex', proLimits[2]!);
    await document.updateRateLimits(undefined, 'claude', proLimits[2]!);
    expect(await readLimits()).toEqual({
      ...entries(configId, proLimits),
      ...entries(otherConfigId, proLimits),
      ...entries(configId, [proLimits[2]!], 'codex'),
      [getRateLimitEntryKey('claude', 'argon')]: proLimits[2],
    });

    const poller = new AntigravityQuotaPoller({
      listAgentConfigIds: async () => [configId],
      replaceRateLimits,
      fetchRateLimits: async () => ultraLimits,
      logger: silentLogger,
    });
    await poller.poll();

    expect(await readLimits()).toEqual({
      ...entries(configId, ultraLimits),
      ...entries(otherConfigId, proLimits),
      ...entries(configId, [proLimits[2]!], 'codex'),
      [getRateLimitEntryKey('claude', 'argon')]: proLimits[2],
    });
  });

  it('writes the complete snapshot to every Antigravity provider', async () => {
    const poller = new AntigravityQuotaPoller({
      listAgentConfigIds: async () => [configId, otherConfigId],
      replaceRateLimits,
      fetchRateLimits: async () => proLimits,
      logger: silentLogger,
    });
    await poller.poll();
    expect(await readLimits()).toEqual({
      ...entries(configId, proLimits),
      ...entries(otherConfigId, proLimits),
    });
  });

  it.each(['signed out', 'failed'] as const)(
    'preserves stored quota when fetch is %s and replaces it after recovery',
    async (failure) => {
      await replaceRateLimits(configId, proLimits);
      let recovered = false;
      const poller = new AntigravityQuotaPoller({
        listAgentConfigIds: async () => [configId],
        replaceRateLimits,
        fetchRateLimits: async () => {
          if (recovered) return ultraLimits;
          if (failure === 'failed') throw new Error('offline');
          return null;
        },
        logger: silentLogger,
      });
      await poller.poll();
      expect(await readLimits()).toEqual(entries(configId, proLimits));

      recovered = true;
      await poller.poll();
      expect(await readLimits()).toEqual(entries(configId, ultraLimits));
    }
  );

  it('removes all groups after a successful empty snapshot', async () => {
    await replaceRateLimits(configId, proLimits);
    const poller = new AntigravityQuotaPoller({
      listAgentConfigIds: async () => [configId],
      replaceRateLimits,
      fetchRateLimits: async () => [],
      logger: silentLogger,
    });
    await poller.poll();
    expect(await readLimits()).toEqual({});
  });

  it('asks Google nothing while the machine has no Antigravity provider', async () => {
    let asked = false;
    const poller = new AntigravityQuotaPoller({
      listAgentConfigIds: async () => [],
      replaceRateLimits,
      fetchRateLimits: async () => {
        asked = true;
        return [];
      },
      logger: silentLogger,
    });
    await poller.poll();
    expect(asked).toBe(false);
    expect(await readLimits()).toEqual({});
  });
});
