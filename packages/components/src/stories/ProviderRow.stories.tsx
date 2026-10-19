import type { Meta, StoryObj } from '@storybook/react';
import {
  ANTIGRAVITY_AGENT_TYPE,
  ANTIGRAVITY_ARGON_LIMIT_ID,
  ANTIGRAVITY_THIRD_PARTY_LIMIT_ID,
  CODEX_SPARK_LIMIT_ID,
  getRateLimitEntryKey,
  getServerNow,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type MachineViewMeta,
} from '@lody/shared';
import { MachineQuotaCompact } from '@/components/settings/machine-quota-compact';
import { ProviderRow } from '@/components/settings/provider-row';
import { cn } from '@/lib/utils';

const machineId = 'machine-1' as MachineId;
const resetIn = (seconds: number) => Math.floor(getServerNow() / 1000) + seconds;

const makeMachine = (overrides: Partial<MachineViewMeta> = {}): MachineViewMeta => ({
  id: machineId,
  name: 'Workstation',
  cliVersion: '0.44.0',
  os: 'macOS',
  sessions: [],
  raceLimits: {},
  ...overrides,
});

const makeConfig = (
  overrides: Partial<AgentConfigMeta> & Pick<AgentConfigMeta, 'cliType' | 'agentType' | 'name'>
): AgentConfigMeta => ({
  id: `cfg-${overrides.agentType}` as AgentConfigId,
  machineId,
  description: undefined,
  env: {},
  ...overrides,
});

type StoryProps = {
  config: AgentConfigMeta;
  machine: MachineViewMeta;
  showActions?: boolean;
  narrow?: boolean;
  usage?: { conversations: number; lastUsedAt: number | null };
};

function StoryWrapper({ config, machine, showActions, narrow, usage }: StoryProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border/60 bg-card/50',
        narrow ? 'w-[340px]' : 'w-[520px]'
      )}
    >
      <ProviderRow
        config={config}
        machine={machine}
        onEdit={() => {}}
        onRefresh={showActions ? async () => {} : undefined}
        onDelete={showActions ? async () => {} : undefined}
        usage={usage}
      />
    </div>
  );
}

const meta = {
  title: 'Settings/ProviderRow',
  component: StoryWrapper,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryWrapper>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ClaudeWithRateLimit: Story = {
  args: {
    config: makeConfig({ name: 'Claude Code', cliType: 'builtin', agentType: 'claude' }),
    machine: makeMachine({
      raceLimits: {
        [getRateLimitEntryKey('claude', 'claude', 'cfg-claude' as AgentConfigId)]: {
          limitId: 'claude',
          scope: { providerId: 'claude' },
          planName: 'Claude Pro',
          windows: [
            {
              usedPercent: 55,
              windowDurationSeconds: 18_000,
              resetsAtEpochSeconds: resetIn(1_800),
            },
            {
              usedPercent: 32,
              windowDurationSeconds: 604_800,
              resetsAtEpochSeconds: resetIn(86_400),
            },
            {
              label: 'Fable',
              usedPercent: 67,
              windowDurationSeconds: 604_800,
              resetsAtEpochSeconds: resetIn(86_400),
            },
          ],
        },
      },
    }),
  },
};

export const ClaudeWithRateLimitNarrow: Story = {
  args: { ...ClaudeWithRateLimit.args, narrow: true, showActions: true },
};

export const ClaudeEnvOverrideHidesRateLimit: Story = {
  args: {
    config: makeConfig({
      name: 'DeepSeek over Claude Code',
      cliType: 'builtin',
      agentType: 'claude',
      brandId: 'deepseek',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'sk-test',
      },
    }),
    machine: makeMachine({
      raceLimits: {
        [getRateLimitEntryKey('claude', 'claude', 'cfg-claude' as AgentConfigId)]: {
          limitId: 'claude',
          scope: { providerId: 'claude' },
          planName: 'Claude Pro',
          windows: [
            {
              usedPercent: 55,
              windowDurationSeconds: 18_000,
              resetsAtEpochSeconds: resetIn(1_800),
            },
            {
              usedPercent: 32,
              windowDurationSeconds: 604_800,
              resetsAtEpochSeconds: resetIn(86_400),
            },
          ],
        },
      },
    }),
  },
};

export const CodexSpark: Story = {
  args: {
    config: makeConfig({ name: 'Codex Spark', cliType: 'builtin', agentType: 'codex' }),
    machine: makeMachine({
      raceLimits: {
        [getRateLimitEntryKey('codex', CODEX_SPARK_LIMIT_ID, 'cfg-codex' as AgentConfigId)]: {
          limitId: CODEX_SPARK_LIMIT_ID,
          scope: { providerId: 'codex' },
          planName: 'Codex Spark',
          windows: [
            { usedPercent: 12, windowDurationSeconds: 18_000, resetsAtEpochSeconds: resetIn(300) },
            {
              usedPercent: 88,
              windowDurationSeconds: 604_800,
              resetsAtEpochSeconds: resetIn(172_800),
            },
          ],
        },
      },
    }),
  },
};

export const CodexWeeklyOnly: Story = {
  args: {
    config: makeConfig({ name: 'Codex', cliType: 'builtin', agentType: 'codex' }),
    machine: makeMachine({
      raceLimits: {
        [getRateLimitEntryKey('codex', 'codex', 'cfg-codex' as AgentConfigId)]: {
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
    }),
  },
};

export const CodexWeeklyOnlyNarrow: Story = {
  args: {
    ...CodexWeeklyOnly.args,
    narrow: true,
    showActions: true,
  },
};

export const ClaudeNoLimits: Story = {
  args: {
    config: makeConfig({ name: 'Claude Code', cliType: 'builtin', agentType: 'claude' }),
    machine: makeMachine(),
    showActions: true,
  },
};

export const RegistryProvider: Story = {
  args: {
    config: makeConfig({
      name: 'Auggie',
      cliType: 'registry',
      agentType: 'auggie',
      env: { AUGGIE_API_KEY: 'sk-test' },
    }),
    machine: makeMachine(),
  },
};

export const RegistryProviderWithActions: Story = {
  args: {
    config: makeConfig({
      name: 'Auggie',
      cliType: 'registry',
      agentType: 'auggie',
      env: { AUGGIE_API_KEY: 'sk-test' },
    }),
    machine: makeMachine(),
    showActions: true,
  },
};

/**
 * A custom command, used recently: the kind is the first fact of the meta line,
 * in the reader's language ("自定义 · 1 个对话 · 2 分钟前用过"), not a pill.
 */
export const CustomProviderWithUsage: Story = {
  args: {
    config: makeConfig({
      name: 'Deterministic E2E Agent',
      cliType: 'custom',
      agentType: 'custom',
    }),
    machine: makeMachine(),
    usage: { conversations: 1, lastUsedAt: getServerNow() - 2 * 60_000 },
  },
};

const antigravityConfig = makeConfig({
  name: 'Antigravity',
  cliType: 'registry',
  agentType: ANTIGRAVITY_AGENT_TYPE,
});
const antigravityMachine = makeMachine({
  raceLimits: Object.fromEntries(
    [
      {
        limitId: ANTIGRAVITY_ARGON_LIMIT_ID,
        limitName: 'Argon',
        windows: [
          {
            label: 'Argon',
            usedPercent: 43.5,
            windowDurationSeconds: 604_800,
            resetsAtEpochSeconds: resetIn(4 * 86_400),
          },
        ],
      },
      {
        limitId: 'gemini',
        limitName: 'Gemini',
        windows: [
          {
            label: 'Gemini',
            usedPercent: 50,
            windowDurationSeconds: 18_000,
            resetsAtEpochSeconds: resetIn(3_600),
          },
          {
            label: 'Gemini',
            usedPercent: 25,
            windowDurationSeconds: 604_800,
            resetsAtEpochSeconds: resetIn(86_400),
          },
        ],
      },
      {
        limitId: ANTIGRAVITY_THIRD_PARTY_LIMIT_ID,
        limitName: 'Claude / GPT',
        windows: [
          {
            label: 'Claude / GPT',
            usedPercent: 0,
            windowDurationSeconds: 18_000,
            resetsAtEpochSeconds: resetIn(3_600),
          },
          {
            label: 'Claude / GPT',
            usedPercent: 0,
            windowDurationSeconds: 604_800,
            resetsAtEpochSeconds: resetIn(86_400),
          },
        ],
      },
    ].map((limit) => [
      getRateLimitEntryKey(ANTIGRAVITY_AGENT_TYPE, limit.limitId, antigravityConfig.id),
      { ...limit, scope: { providerId: ANTIGRAVITY_AGENT_TYPE } },
    ])
  ),
});

export const AntigravityPro: Story = {
  args: { config: antigravityConfig, machine: antigravityMachine, showActions: true },
};

export const AntigravityProNarrow: Story = {
  args: { ...AntigravityPro.args, narrow: true },
};

export const AntigravityProCompact: Story = {
  args: AntigravityPro.args,
  render: ({ machine }) => (
    <div className="w-[340px]">
      <MachineQuotaCompact raceLimits={machine.raceLimits} />
    </div>
  ),
};
