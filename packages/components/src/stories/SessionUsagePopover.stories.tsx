import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  ANTIGRAVITY_AGENT_TYPE,
  ANTIGRAVITY_ARGON_LIMIT_ID,
  getRateLimitEntryKey,
  getServerNow,
  type AgentConfigId,
} from '@lody/shared';

import { SessionUsagePopover } from '@/components/sessions/session-usage-popover';

const resetIn = (seconds: number) => Math.floor(getServerNow() / 1000) + seconds;

const codexLimits = {
  [getRateLimitEntryKey('codex', 'codex')]: {
    planName: 'ChatGPT Plus',
    limitId: 'codex',
    scope: { providerId: 'codex' },
    windows: [
      {
        usedPercent: 18,
        windowDurationSeconds: 5 * 60 * 60,
        resetsAtEpochSeconds: resetIn(2 * 60 * 60),
      },
      {
        usedPercent: 42,
        windowDurationSeconds: 7 * 24 * 60 * 60,
        resetsAtEpochSeconds: resetIn(4 * 24 * 60 * 60),
      },
    ],
  },
};

const meta = {
  title: 'Sessions/SessionUsagePopover',
  component: SessionUsagePopover,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  args: {
    agentType: 'codex',
    modelId: 'gpt-5.4',
    modelLabel: 'GPT-5.4',
  },
} satisfies Meta<typeof SessionUsagePopover>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ContextAndQuota: Story = {
  args: {
    contextWindowUsage: { size: 256_000, used: 81_920 },
    rateLimits: codexLimits,
  },
};

export const ContextOnly: Story = {
  args: {
    contextWindowUsage: { size: 200_000, used: 168_000 },
  },
};

export const Compacting: Story = {
  args: {
    contextWindowUsage: { size: 200_000, used: 168_000 },
    rateLimits: codexLimits,
    isContextCompacting: true,
  },
};

export const QuotaOnly: Story = {
  args: {
    rateLimits: codexLimits,
    showRateLimitWithoutContext: true,
  },
};

export const WeeklyOnly: Story = {
  args: {
    contextWindowUsage: { size: 258_000, used: 119_000 },
    rateLimits: {
      [getRateLimitEntryKey('codex', 'codex')]: {
        planName: 'ChatGPT Plus',
        limitId: 'codex',
        scope: { providerId: 'codex' },
        windows: [
          {
            usedPercent: 29,
            windowDurationSeconds: 7 * 24 * 60 * 60,
            resetsAtEpochSeconds: resetIn(5 * 24 * 60 * 60),
          },
        ],
      },
    },
  },
};

export const FiveHourOnly: Story = {
  args: {
    modelId: 'gpt-5.5',
    modelLabel: '5.5',
    contextWindowUsage: { size: 258_000, used: 152_000 },
    rateLimits: {
      [getRateLimitEntryKey('codex', 'codex')]: {
        planName: 'ChatGPT Plus',
        limitId: 'codex',
        scope: { providerId: 'codex' },
        windows: [
          {
            usedPercent: 29,
            windowDurationSeconds: 5 * 60 * 60,
            resetsAtEpochSeconds: resetIn(2 * 60 * 60),
          },
        ],
      },
    },
  },
};

export const Unavailable: Story = {
  args: {
    contextWindowUsage: undefined,
    rateLimits: {},
  },
};

export const ClaudeFableWeekly: Story = {
  args: {
    agentType: 'claude',
    modelId: 'claude-fable-5',
    modelLabel: 'Fable',
    showRateLimitWithoutContext: true,
    rateLimits: {
      [getRateLimitEntryKey('claude', 'claude')]: {
        limitId: 'claude',
        scope: { providerId: 'claude' },
        planName: 'Max',
        windows: [
          { usedPercent: 12, windowDurationSeconds: 18_000, resetsAtEpochSeconds: resetIn(3600) },
          {
            usedPercent: 30,
            windowDurationSeconds: 604_800,
            resetsAtEpochSeconds: resetIn(172800),
          },
          {
            label: 'Fable',
            usedPercent: 67,
            windowDurationSeconds: 604_800,
            resetsAtEpochSeconds: resetIn(172800),
          },
        ],
      },
    },
  },
};

const antigravityConfigId = 'antigravity' as AgentConfigId;
const antigravityLimits = {
  [getRateLimitEntryKey(ANTIGRAVITY_AGENT_TYPE, 'gemini', antigravityConfigId)]: {
    limitId: 'gemini',
    limitName: 'Gemini',
    scope: { providerId: ANTIGRAVITY_AGENT_TYPE },
    windows: [
      {
        label: 'Gemini',
        usedPercent: 0,
        windowDurationSeconds: 18_000,
        resetsAtEpochSeconds: resetIn(5 * 60 * 60),
      },
      {
        label: 'Gemini',
        usedPercent: 0.1,
        windowDurationSeconds: 604_800,
        resetsAtEpochSeconds: resetIn(42 * 60 * 60),
      },
    ],
  },
  [getRateLimitEntryKey(ANTIGRAVITY_AGENT_TYPE, ANTIGRAVITY_ARGON_LIMIT_ID, antigravityConfigId)]: {
    limitId: ANTIGRAVITY_ARGON_LIMIT_ID,
    limitName: 'Argon',
    scope: { providerId: ANTIGRAVITY_AGENT_TYPE },
    windows: [
      {
        label: 'Argon',
        usedPercent: 60.1,
        windowDurationSeconds: 604_800,
        resetsAtEpochSeconds: resetIn(42 * 60 * 60),
      },
    ],
  },
};

export const AntigravityArgonModel: Story = {
  args: {
    agentType: ANTIGRAVITY_AGENT_TYPE,
    agentConfigId: antigravityConfigId,
    modelId: 'gemini-4-argon',
    modelLabel: 'Gemini 4 Argon',
    showRateLimitWithoutContext: true,
    rateLimits: antigravityLimits,
  },
};

export const AntigravityFlashModel: Story = {
  args: {
    ...AntigravityArgonModel.args,
    modelId: 'gemini-3.8-flash',
    modelLabel: 'Gemini 3.8 Flash',
  },
};
