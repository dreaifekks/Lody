import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_AGENT_TYPE,
  ANTIGRAVITY_ARGON_LIMIT_ID,
  ANTIGRAVITY_THIRD_PARTY_LIMIT_ID,
  CODEX_SPARK_LIMIT_ID,
  getRateLimitEntryKey,
  type AgentConfigId,
} from '@lody/shared';

import {
  canShowSubscriptionRateLimits,
  formatRateLimitWindowShortLabel,
  getAgentRateLimitWindows,
  getContextWindowUsageData,
  resolveAgentRateLimitForModel,
  resolveAgentRateLimitsForModel,
  type MachineRateLimits,
} from '../src/lib/session-usage';

const usage = (overrides: Partial<MachineRateLimits[string]> = {}): MachineRateLimits[string] => ({
  limitId: 'codex',
  scope: { providerId: 'codex' },
  planName: null,
  windows: [
    {
      usedPercent: 25,
      windowDurationSeconds: 5 * 60 * 60,
      resetsAtEpochSeconds: null,
    },
    {
      usedPercent: 40,
      windowDurationSeconds: 7 * 24 * 60 * 60,
      resetsAtEpochSeconds: null,
    },
  ],
  ...overrides,
});

describe('session usage', () => {
  it('derives remaining context tokens and clamps over-capacity usage', () => {
    expect(getContextWindowUsageData({ size: 128_000, used: 32_000 })).toMatchObject({
      remainingTokens: 96_000,
      usedPercentage: 25,
      remainingPercentage: 75,
    });
    expect(getContextWindowUsageData({ size: 100, used: 120 })).toMatchObject({
      remainingTokens: 0,
      usedPercentage: 100,
      remainingPercentage: 0,
    });
    expect(getContextWindowUsageData({ size: 0, used: 0 })).toBeNull();
  });

  it('uses provider-reported window durations instead of positional 5h/7d labels', () => {
    const windows = getAgentRateLimitWindows(
      usage({
        windows: [
          {
            usedPercent: 29,
            windowDurationSeconds: 7 * 24 * 60 * 60,
            resetsAtEpochSeconds: 1784505071,
          },
        ],
      })
    );

    expect(windows).toEqual([
      {
        usedPercent: 29,
        remainingPercent: 71,
        windowDurationSeconds: 604_800,
        resetsAtEpochSeconds: 1784505071,
      },
    ]);
    expect(formatRateLimitWindowShortLabel(windows[0]!.windowDurationSeconds)).toBe('7d');
  });

  it('preserves scoped windows even when their values match the shared quota', () => {
    const weekly = { usedPercent: 0, windowDurationSeconds: 604_800, resetsAtEpochSeconds: null };
    expect(
      getAgentRateLimitWindows(usage({ windows: [weekly, { ...weekly, label: ' Fable ' }] }))
    ).toEqual([
      { ...weekly, remainingPercent: 100 },
      { ...weekly, remainingPercent: 100, label: 'Fable' },
    ]);
  });

  it('keeps sub-one-percent Grok usage on the percentage scale', () => {
    expect(
      getAgentRateLimitWindows(
        usage({
          scope: { providerId: 'grok' },
          windows: [
            {
              usedPercent: 0.5,
              windowDurationSeconds: 604_800,
              resetsAtEpochSeconds: 1784505071,
            },
          ],
        })
      )
    ).toEqual([
      {
        usedPercent: 0.5,
        remainingPercent: 99.5,
        windowDurationSeconds: 604_800,
        resetsAtEpochSeconds: 1784505071,
      },
    ]);
  });

  it('selects the quota tier that matches the current Codex model', () => {
    const rateLimits: MachineRateLimits = {
      [getRateLimitEntryKey('codex', 'codex')]: usage({ limitId: 'codex' }),
      [getRateLimitEntryKey('codex', CODEX_SPARK_LIMIT_ID)]: usage({
        limitId: CODEX_SPARK_LIMIT_ID,
        limitName: 'GPT-5.3-Codex-Spark',
        sevenDay: 88,
      }),
    };

    expect(
      resolveAgentRateLimitForModel({
        rateLimits,
        agentType: 'codex',
        modelId: 'gpt-5.3-codex-spark',
      })?.limitId
    ).toBe(CODEX_SPARK_LIMIT_ID);
    expect(
      resolveAgentRateLimitForModel({
        rateLimits,
        agentType: 'codex',
        modelId: 'gpt-5.4',
      })?.limitId
    ).toBe('codex');
  });

  it('selects Antigravity Argon or Gemini quota by model and available groups', () => {
    const configId = 'antigravity-mac' as AgentConfigId;
    const scope = { providerId: ANTIGRAVITY_AGENT_TYPE };
    const argonKey = getRateLimitEntryKey(
      ANTIGRAVITY_AGENT_TYPE,
      ANTIGRAVITY_ARGON_LIMIT_ID,
      configId
    );
    const rateLimits: MachineRateLimits = {
      [argonKey]: usage({
        limitId: ANTIGRAVITY_ARGON_LIMIT_ID,
        limitName: 'Argon',
        scope,
        windows: [
          {
            label: 'Argon',
            usedPercent: 43.5,
            windowDurationSeconds: 604_800,
            resetsAtEpochSeconds: null,
          },
        ],
      }),
      [getRateLimitEntryKey(ANTIGRAVITY_AGENT_TYPE, 'gemini', configId)]: usage({
        limitId: 'gemini',
        limitName: 'Gemini',
        scope,
      }),
      [getRateLimitEntryKey(ANTIGRAVITY_AGENT_TYPE, ANTIGRAVITY_THIRD_PARTY_LIMIT_ID, configId)]:
        usage({ limitId: ANTIGRAVITY_THIRD_PARTY_LIMIT_ID, limitName: 'Claude / GPT', scope }),
    };
    const limitFor = (modelId: string) =>
      resolveAgentRateLimitForModel({
        rateLimits,
        agentType: ANTIGRAVITY_AGENT_TYPE,
        agentConfigId: configId,
        modelId,
      })?.limitId;

    expect(limitFor('gemini-4-argon-high')).toBe(ANTIGRAVITY_ARGON_LIMIT_ID);
    expect(limitFor('gemini-3.8-flash-high')).toBe('gemini');
    expect(limitFor('gemini-pro-agent')).toBe('gemini');
    // Google never counts ACP use against the Claude/GPT group, so it is not shown.
    expect(limitFor('claude-opus-5-5-high')).toBeUndefined();
    expect(limitFor('gpt-oss-120b-medium')).toBeUndefined();
    const groupsFor = (modelId: string) =>
      resolveAgentRateLimitsForModel({
        rateLimits,
        agentType: ANTIGRAVITY_AGENT_TYPE,
        agentConfigId: configId,
        modelId,
      }).map((entry) => entry.limitId);
    // The composer shows both Gemini family groups, the session model's first.
    expect(groupsFor('gemini-4-argon')).toEqual([ANTIGRAVITY_ARGON_LIMIT_ID, 'gemini']);
    expect(groupsFor('gemini-3.8-flash-high')).toEqual(['gemini', ANTIGRAVITY_ARGON_LIMIT_ID]);
    expect(groupsFor('claude-opus-5-5-high')).toEqual([]);
    delete rateLimits[argonKey];
    expect(limitFor('gemini-4-argon-high')).toBe('gemini');
    expect(limitFor('gemini-3.8-flash-high')).toBe('gemini');
    expect(groupsFor('gemini-4-argon-high')).toEqual(['gemini']);
  });

  it('keeps quota snapshots isolated between Codex provider configs', () => {
    const workConfigId = 'codex-work' as AgentConfigId;
    const personalConfigId = 'codex-personal' as AgentConfigId;
    const rateLimits: MachineRateLimits = {
      [getRateLimitEntryKey('codex', 'codex')]: usage({
        windows: [{ usedPercent: 55, windowDurationSeconds: 604_800, resetsAtEpochSeconds: null }],
      }),
      [getRateLimitEntryKey('codex', 'codex', workConfigId)]: usage({
        windows: [{ usedPercent: 10, windowDurationSeconds: 604_800, resetsAtEpochSeconds: null }],
      }),
      [getRateLimitEntryKey('codex', 'codex', personalConfigId)]: usage({
        windows: [{ usedPercent: 80, windowDurationSeconds: 604_800, resetsAtEpochSeconds: null }],
      }),
    };

    expect(
      resolveAgentRateLimitForModel({
        rateLimits,
        agentType: 'codex',
        agentConfigId: workConfigId,
        modelId: null,
      })?.limits.windows[0]?.usedPercent
    ).toBe(10);
    expect(
      resolveAgentRateLimitForModel({
        rateLimits,
        agentType: 'codex',
        agentConfigId: personalConfigId,
        modelId: null,
      })?.limits.windows[0]?.usedPercent
    ).toBe(80);
    expect(
      resolveAgentRateLimitForModel({
        rateLimits,
        agentType: 'codex',
        modelId: null,
      })?.limits.windows[0]?.usedPercent
    ).toBe(55);
  });

  it('does not show a model-specific tier beside a different selected model', () => {
    const rateLimits: MachineRateLimits = {
      [getRateLimitEntryKey('codex', CODEX_SPARK_LIMIT_ID)]: usage({
        limitId: CODEX_SPARK_LIMIT_ID,
        limitName: 'GPT-5.3-Codex-Spark',
      }),
    };

    expect(
      resolveAgentRateLimitForModel({
        rateLimits,
        agentType: 'codex',
        modelId: 'gpt-5.4',
      })
    ).toBeNull();
  });

  it.each(['claude', 'codex', 'grok'])(
    'keeps %s quota with unrelated tool settings and hides account overrides',
    (agentType) => {
      const input = { cliType: 'builtin' as const, agentType, capability: { version: 1 as const } };
      expect(
        canShowSubscriptionRateLimits({
          ...input,
          config: { env: { NMEM_AGENT_ID: 'lody', HTTPS_PROXY: 'http://localhost:7890' } },
        })
      ).toBe(true);
      expect(
        canShowSubscriptionRateLimits({
          ...input,
          config: { env: { NODE_OPTIONS: '--require override.js' } },
        })
      ).toBe(false);
      expect(canShowSubscriptionRateLimits({ ...input, config: { brandId: 'deepseek' } })).toBe(
        false
      );
    }
  );
  it.each([
    ['claude', 'ANTHROPIC_API_KEY'],
    ['codex', 'OPENAI_API_KEY'],
    ['grok', 'XAI_API_KEY'],
  ])('treats empty %s account override %s as an account change', (agentType, key) => {
    expect(
      canShowSubscriptionRateLimits({
        cliType: 'builtin',
        agentType,
        capability: { version: 1 },
        config: { env: { [key]: '' } },
      })
    ).toBe(false);
  });

  it('keeps Antigravity eligibility independent of env and brand', () => {
    expect(
      canShowSubscriptionRateLimits({
        capability: { version: 1 },
        cliType: 'registry',
        agentType: ANTIGRAVITY_AGENT_TYPE,
        config: { brandId: 'deepseek', env: { OPENAI_API_KEY: 'override' } },
      })
    ).toBe(true);
  });

  it('hides subscription limits for unsupported providers', () => {
    expect(
      canShowSubscriptionRateLimits({
        cliType: 'custom',
        agentType: 'custom-agent',
      })
    ).toBe(false);
    expect(canShowSubscriptionRateLimits({ cliType: 'registry', agentType: 'claude' })).toBe(false);
    expect(canShowSubscriptionRateLimits({ cliType: 'builtin', agentType: 'pi' })).toBe(false);
  });
});

it('requires quota declarations for builtin and third-party providers', () => {
  for (const target of [
    { cliType: 'builtin', agentType: 'codex' },
    { cliType: 'custom', agentType: 'example-agent' },
  ] as const) {
    expect(canShowSubscriptionRateLimits(target)).toBe(false);
    expect(canShowSubscriptionRateLimits({ ...target, capability: { version: 1 } })).toBe(true);
  }
});
