import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { AgentConfigId, MachineId } from '@lody/shared';
import {
  AgentRoleForm,
  type AgentRoleFormProps,
  type AgentRoleFormTab,
  type AgentRoleMachineRow,
} from '@/components/settings/agent-role-form';
import type { AcpSelectorOptions } from '@/components/shared/acp-selector-options';
import { EMPTY_AGENT_ROLE_FORM_VALUE, type AgentRoleFormValue } from '@lody/shared';

const agentConfigs = [
  { agentConfigId: 'config-1' as AgentConfigId, label: 'Codex' },
  { agentConfigId: 'config-2' as AgentConfigId, label: 'Claude' },
];

const selectorOptions: AcpSelectorOptions = {
  capabilityAuthority: 'authoritative',
  defaultModeId: 'default',
  defaultModelId: 'gpt-5.6-sol',
  modelReasoningEfforts: undefined,
  modeOptions: [
    { value: 'default', label: 'Default' },
    { value: 'plan', label: 'Plan' },
  ],
  modelOptions: [
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  ],
  configOptionSelectors: [
    {
      type: 'select',
      configId: 'thought_level',
      label: 'Reasoning',
      description: 'How long the agent thinks before answering.',
      category: 'thought_level',
      currentValue: 'medium',
      options: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
      ],
    },
    {
      type: 'boolean',
      configId: 'fast-mode',
      label: 'Fast mode',
      options: [],
      currentValue: false,
    },
  ],
};

const studio = 'machine-1' as MachineId;
const buildBox = 'machine-2' as MachineId;
const laptop = 'machine-3' as MachineId;

/** Rows in list order: the Role's machines first, then the rest. */
const machines: AgentRoleMachineRow[] = [
  {
    machineId: studio,
    label: 'Studio',
    online: true,
    agentConfigs,
    selectorOptions,
    issues: [],
  },
  {
    machineId: buildBox,
    label: 'Build box',
    online: false,
    agentConfigs,
    selectorOptions,
    issues: [],
  },
  {
    machineId: laptop,
    label: 'Laptop',
    online: true,
    agentConfigs,
    selectorOptions: null,
    issues: [],
  },
];

const configured: AgentRoleFormValue = {
  ...EMPTY_AGENT_ROLE_FORM_VALUE,
  name: 'Code Reviewer',
  description: 'Call this agent to review code changes for correctness before merging.',
  emoji: '🔍',
  placements: [
    {
      machineId: studio,
      enabled: true,
      agentConfigId: 'config-1' as AgentConfigId,
      modeId: 'default',
      modelId: 'gpt-5.6-sol',
      configOptionValues: { thought_level: 'high', 'fast-mode': false },
    },
    {
      machineId: buildBox,
      enabled: false,
      agentConfigId: 'config-2' as AgentConfigId,
      modeId: 'default',
      modelId: 'gpt-5.6-luna',
      configOptionValues: { thought_level: 'medium', 'fast-mode': false },
    },
  ],
  promptPrefix: 'Check correctness before style.',
};

const withPlacement = (
  index: number,
  patch: Partial<AgentRoleFormValue['placements'][number]>
): AgentRoleFormValue => ({
  ...configured,
  placements: configured.placements.map((placement, at) =>
    at === index ? { ...placement, ...patch } : placement
  ),
});

/** The dialog owns the value and tab in the product; the story owns them here. */
function StatefulAgentRoleForm(props: AgentRoleFormProps) {
  const [value, setValue] = useState(props.value);
  const [tab, setTab] = useState<AgentRoleFormTab>(props.tab ?? 'machines');
  return (
    <AgentRoleForm {...props} value={value} onChange={setValue} tab={tab} onTabChange={setTab} />
  );
}

const meta = {
  title: 'Settings/AgentRoleForm',
  component: StatefulAgentRoleForm,
  args: {
    value: configured,
    onChange: () => undefined,
    machines,
    errors: [],
    onSubmit: () => undefined,
    onCancel: () => undefined,
    className: 'min-h-0 flex-1',
  },
  decorators: [
    // Mirrors the settings dialog that hosts the form: a fixed-height panel the
    // form's own scroll body and sticky footer size themselves against. The
    // panel pads its content; the form has no padding of its own.
    (Story) => (
      <div className="mx-auto flex h-[900px] w-[620px] flex-col gap-4 overflow-hidden rounded-lg border bg-background p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StatefulAgentRoleForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NewRole: Story = {
  args: {
    value: EMPTY_AGENT_ROLE_FORM_VALUE,
    errors: ['name_required', 'machine_required'],
  },
};

/** One machine on, one kept but switched off, one never used. */
export const Configured: Story = {};

/** Two machines on, each with its own agent and model. */
export const TwoMachines: Story = {
  args: { value: withPlacement(1, { enabled: true }) },
};

/**
 * No emoji picked: the trigger shows the default glyph, so a Role never looks
 * half-authored. Clicking it opens the picker.
 */
export const DefaultEmoji: Story = {
  args: { value: { ...configured, emoji: '' } },
};

export const SharedWithWorkspace: Story = {
  args: { value: { ...configured, shareWithWorkspace: true }, isEditing: true },
};

/** A machine with no providers yet: nothing is offered in their place. */
export const MachineWithoutAgentConfigs: Story = {
  args: {
    machines: machines.map((machine) =>
      machine.machineId === studio ? { ...machine, agentConfigs: [] } : machine
    ),
  },
};

/** Capabilities were never reported, so no run-config control is offered. */
export const CapabilitiesUnavailable: Story = {
  args: {
    machines: machines.map((machine) =>
      machine.machineId === studio
        ? {
            ...machine,
            selectorOptions: { ...selectorOptions, capabilityAuthority: 'unavailable' },
            issues: [{ kind: 'capabilities_unknown' }],
          }
        : machine
    ),
  },
};

/** A saved model that the agent stopped publishing — reported, never swapped. */
export const IncompatibleRunConfig: Story = {
  args: {
    value: withPlacement(0, { modelId: 'gpt-5.5-retired' }),
    machines: machines.map((machine) =>
      machine.machineId === studio
        ? {
            ...machine,
            issues: [
              { kind: 'model_unsupported', value: 'gpt-5.5-retired' },
              { kind: 'option_unsupported', configId: 'legacy_effort' },
            ],
          }
        : machine
    ),
  },
};

/** The Memory tab: the panel itself is supplied by the dialog. */
export const MemoryTab: Story = {
  args: {
    tab: 'memory',
    memoryPanel: <p>Memory panel for Studio</p>,
  },
};

export const DuplicateName: Story = {
  args: { errors: ['name_taken'], isEditing: true },
};

export const SavedLocallyNotSynced: Story = {
  args: {
    isEditing: true,
    error:
      'Saved on this device but not yet synced to the workspace (offline). Other members cannot see it yet.',
  },
};
