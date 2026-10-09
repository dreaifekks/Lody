import type { Meta, StoryObj } from '@storybook/react';
import * as stylex from '@stylexjs/stylex';
import {
  AGENT_ROLE_VERSION,
  withAgentRolePlacements,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';
import { AgentRoleRow } from '@/components/settings/agent-roles-setting';
import { settingsSurface } from '@/components/settings/surface';

const base: AgentRole = withAgentRolePlacements(
  {
    v: AGENT_ROLE_VERSION,
    id: 'reviewer' as AgentRoleId,
    ownerUserId: 'user-1',
    visibility: 'private',
    name: 'Code Reviewer',
    emoji: '🔍',
    revision: 3,
    createdAt: 1,
    updatedAt: 2,
  },
  [
    {
      machineId: 'machine-1' as MachineId,
      agentConfigId: 'config-1' as AgentConfigId,
      enabled: true,
      runConfig: { modelId: 'gpt-5.6-sol', configOptionValues: { thought_level: 'high' } },
    },
  ]
);

const codex: Pick<AgentConfigMeta, 'cliType' | 'agentType' | 'brandId' | 'env'> = {
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
};
const claude: Pick<AgentConfigMeta, 'cliType' | 'agentType' | 'brandId' | 'env'> = {
  cliType: 'builtin',
  agentType: 'claude',
  env: {},
};

const meta = {
  title: 'Settings/AgentRoleRow',
  component: AgentRoleRow,
  args: {
    role: base,
    availability: { kind: 'available' },
    machines: [{ label: 'Studio', online: true, agentConfig: codex }],
    canManage: true,
    onEdit: () => undefined,
    onRemove: () => undefined,
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[640px] p-4">
        {/* The row is a line of the list's card; the list draws the card. */}
        <div {...stylex.props(settingsSurface.card)}>
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof AgentRoleRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Private: Story = {};

/** One Role on two machines, each with its own agent; the offline one is dimmed. */
export const TwoMachines: Story = {
  args: {
    machines: [
      { label: 'Studio', online: true, agentConfig: codex },
      { label: 'MacBook', online: false, agentConfig: claude },
    ],
  },
};

/** No emoji picked: the row shows the shared default glyph. */
export const DefaultEmoji: Story = {
  args: { role: { ...base, emoji: undefined } },
};

export const SharedWithWorkspace: Story = {
  args: { role: { ...base, visibility: 'workspace' } },
};

export const WithPromptPrefix: Story = {
  args: { role: { ...base, promptPrefix: 'Check correctness before style.' } },
};

/**
 * Its only machine is asleep. The row adds no sentence for it: the dimmed
 * machine name already carries that status.
 */
export const MachineOffline: Story = {
  args: {
    availability: { kind: 'unavailable', reason: 'machine_offline' },
    machines: [{ label: 'Studio', online: false, agentConfig: codex }],
  },
};

/** The provider was deleted. Nothing is substituted for it. */
export const AgentConfigMissing: Story = {
  args: {
    availability: { kind: 'unavailable', reason: 'agent_config_missing' },
    machines: [{ label: 'Studio', online: true }],
  },
};

/** That machine's configs have not been read yet, so nothing is claimed. */
export const CheckingAvailability: Story = {
  args: { availability: { kind: 'unknown' } },
};

/** Another member's shared role: readable and editable, not deletable. */
export const SharedByAnotherMember: Story = {
  args: {
    role: { ...base, ownerUserId: 'user-2', visibility: 'workspace' },
    canManage: false,
  },
};
