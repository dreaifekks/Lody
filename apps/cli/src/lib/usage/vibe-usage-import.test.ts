import { describe, expect, it } from 'vitest';
import type { LanMachine } from '@lody/shared';
import { fetchVibeBuckets, matchVibeHost, vibeBucketsToRows } from './vibe-usage-import';

const DAY = 86_400_000;

function bucket(overrides: Record<string, unknown>) {
  return {
    source: 'codex',
    model: 'gpt-5.5',
    project: 'lody',
    hostname: 'homenucserver',
    bucketStart: '2026-10-01T00:00:00.000Z',
    inputTokens: 10,
    outputTokens: 2,
    cachedInputTokens: 100,
    reasoningOutputTokens: 3,
    cacheCreation5mTokens: 4,
    cacheCreation1hTokens: 5,
    totalTokens: 15,
    estimatedCost: 0.5,
    ...overrides,
  };
}

function machine(name: string, alias: string | null = null, machineId = name): LanMachine {
  return {
    machineId,
    name,
    alias,
    os: 'linux',
    self: false,
    online: true,
    lans: [{ workspaceId: 'lw_home', name: 'Home' }],
    version: null,
    build: null,
    update: null,
    controllable: true,
    agents: [],
  };
}

describe('Vibe Usage import', () => {
  it('reads the service through its own key and keeps the buckets it understands', async () => {
    const asked: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = (async (url: URL, init?: RequestInit) => {
      asked.push({
        url: url.toString(),
        auth: new Headers(init?.headers).get('authorization'),
      });
      return new Response(JSON.stringify({ buckets: [bucket({}), { model: 'broken' }] }));
    }) as typeof fetch;

    const buckets = await fetchVibeBuckets(
      { apiKey: 'vibe-key', apiUrl: 'https://vibe.example' },
      400,
      fetchImpl
    );

    expect(asked).toEqual([
      { url: 'https://vibe.example/api/usage?days=400', auth: 'Bearer vibe-key' },
    ]);
    expect(buckets).toHaveLength(1);
  });

  it('adds the buckets of one host, day and model into one row with Lody counters', () => {
    const rows = vibeBucketsToRows([
      bucket({}),
      bucket({ source: 'claude-code', project: 'other', bucketStart: '2026-10-01T12:30:00.000Z' }),
      bucket({ hostname: 'Ubuntu-dreaife-N100' }),
      bucket({ bucketStart: 'not a date' }),
    ]);

    expect(rows.get('homenucserver')).toEqual([
      {
        startMs: Date.UTC(2026, 9, 1),
        spanMs: DAY,
        modelId: 'gpt-5.5',
        inputTokens: 20,
        outputTokens: 4,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 18,
        reasoningOutputTokens: 6,
        costUSD: 1,
      },
    ]);
    expect(rows.get('Ubuntu-dreaife-N100')).toHaveLength(1);
  });

  it('finds the machine of a host by name or short name, in any case, or as mapped', () => {
    const machines = [
      machine('homenucserver', 'devNuc'),
      machine('dreaifemacbook-air', 'mba'),
      machine('Ubuntu-dreaife-N100', 'homeN100'),
    ];
    const none = new Map<string, string>();

    expect(matchVibeHost('dreaifeMacBook-Air', machines, none)?.name).toBe('dreaifemacbook-air');
    expect(matchVibeHost('homenucserver.lan', machines, none)?.name).toBe('homenucserver');
    expect(matchVibeHost('devnuc', machines, none)?.name).toBe('homenucserver');
    expect(matchVibeHost('old-laptop', machines, none)).toBeNull();
    expect(matchVibeHost('old-laptop', machines, new Map([['old-laptop', 'mba']]))?.name).toBe(
      'dreaifemacbook-air'
    );
    expect(
      matchVibeHost('twin', [machine('twin'), machine('twin', null, 'twin-2')], none)
    ).toBeNull();
  });
});
