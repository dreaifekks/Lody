import { useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { AgentConfigId, AgentRoleInstanceId, MachineId } from '@lody/shared';
import {
  AgentRoleForm,
  type AgentRoleFormProps,
  type AgentRoleInstanceRowModel,
} from '@/components/settings/agent-role-form';
import type { AcpSelectorOptions } from '@/components/shared/acp-selector-options';
import { EMPTY_AGENT_ROLE_FORM_VALUE, type AgentRoleFormValue } from '@lody/shared';

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

const machines = [
  { machineId: studio, label: 'Studio', online: true },
  { machineId: buildBox, label: 'Build box', online: false },
];

const claude = 'instance-claude' as AgentRoleInstanceId;
const gemini = 'instance-gemini' as AgentRoleInstanceId;
const codex = 'instance-codex' as AgentRoleInstanceId;
const strict = 'instance-strict' as AgentRoleInstanceId;

const families: Record<string, { key: string; name: string }> = {
  'config-claude': { key: 'builtin:claude', name: 'Claude Code' },
  'config-gemini': { key: 'builtin:gemini', name: 'Gemini' },
  'config-codex': { key: 'builtin:codex', name: 'Codex' },
};
const agentFamilyOf = (agentConfigId: AgentConfigId) => families[agentConfigId];

const studioConfigs = [
  { agentConfigId: 'config-claude' as AgentConfigId, label: 'Claude' },
  { agentConfigId: 'config-gemini' as AgentConfigId, label: 'Gemini' },
];

const configured: AgentRoleFormValue = {
  ...EMPTY_AGENT_ROLE_FORM_VALUE,
  name: 'uiStyle',
  description: 'Review a UI change against the design system before it ships.',
  emoji: '🎨',
  instances: [
    {
      id: claude,
      alias: '',
      machineId: studio,
      agentConfigId: 'config-claude' as AgentConfigId,
      modeId: 'default',
      modelId: 'gpt-5.6-sol',
      configOptionValues: { thought_level: 'high', 'fast-mode': false },
      memory: { providerId: 'nowledge-mem', memoryId: 'ui-style' },
    },
    {
      id: gemini,
      alias: '',
      machineId: studio,
      agentConfigId: 'config-gemini' as AgentConfigId,
      modeId: 'default',
      modelId: 'gpt-5.6-luna',
      configOptionValues: { thought_level: 'medium', 'fast-mode': false },
    },
    {
      id: codex,
      alias: '',
      machineId: buildBox,
      agentConfigId: 'config-codex' as AgentConfigId,
      modeId: 'default',
      modelId: 'gpt-5.6-sol',
      configOptionValues: { thought_level: 'high', 'fast-mode': false },
    },
    {
      // A second Claude Code on the studio, configured differently: its alias
      // makes it a group of its own.
      id: strict,
      alias: 'Strict',
      machineId: studio,
      agentConfigId: 'config-claude' as AgentConfigId,
      modeId: 'plan',
      modelId: 'gpt-5.6-sol',
      configOptionValues: { thought_level: 'high', 'fast-mode': false },
    },
  ],
  promptPrefix: 'Check spacing and colour against the tokens before anything else.',
};

const instanceRows = new Map<AgentRoleInstanceId, AgentRoleInstanceRowModel>([
  [
    claude,
    { agentConfigs: studioConfigs, selectorOptions, issues: [], summary: 'Claude · GPT-5.6 Sol' },
  ],
  [
    gemini,
    { agentConfigs: studioConfigs, selectorOptions, issues: [], summary: 'Gemini · GPT-5.6 Luna' },
  ],
  [
    strict,
    { agentConfigs: studioConfigs, selectorOptions, issues: [], summary: 'Claude · GPT-5.6 Sol' },
  ],
  [
    codex,
    {
      agentConfigs: [{ agentConfigId: 'config-codex' as AgentConfigId, label: 'Codex' }],
      selectorOptions,
      issues: [],
      summary: 'Codex · GPT-5.6 Sol',
    },
  ],
]);

/** Stands in for the memory picker, which reads a machine's imported identities. */
const memoryStandIn = (): ReactNode => (
  <div className="rounded-md border px-3 py-2 text-sm">ui-style · Nowledge Mem</div>
);

/** The dialog owns the value and the open instance in the product; the story owns them here. */
function StatefulAgentRoleForm(props: AgentRoleFormProps) {
  const [value, setValue] = useState(props.value);
  const [expanded, setExpanded] = useState(props.expandedInstanceId);
  return (
    <AgentRoleForm
      {...props}
      value={value}
      onChange={setValue}
      expandedInstanceId={expanded}
      onExpandedInstanceChange={setExpanded}
    />
  );
}

const meta = {
  title: 'Settings/AgentRoleForm',
  component: StatefulAgentRoleForm,
  args: {
    value: configured,
    onChange: () => undefined,
    machines,
    agentFamilyOf,
    instanceRows,
    expandedInstanceId: null,
    onExpandedInstanceChange: () => undefined,
    onAddInstance: () => undefined,
    renderMemory: memoryStandIn,
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

/** Four instances: three on the studio (one aliased), one on the build box; every row closed. */
export const Instances: Story = {};

/** One instance open: its machine, agent, alias, options and memory. */
export const InstanceOpen: Story = {
  args: { expandedInstanceId: claude },
};

export const NewRole: Story = {
  args: {
    value: {
      ...EMPTY_AGENT_ROLE_FORM_VALUE,
      instances: [
        {
          id: 'instance-new' as AgentRoleInstanceId,
          alias: '',
          machineId: null,
          agentConfigId: null,
          modeId: null,
          modelId: null,
          configOptionValues: {},
        },
      ],
    },
    expandedInstanceId: 'instance-new' as AgentRoleInstanceId,
    errors: ['name_required', 'machine_required', 'agent_config_required'],
  },
};

/** A second unaliased Claude Code on the studio would be the same group. */
export const DuplicateGroup: Story = {
  args: {
    value: {
      ...configured,
      instances: configured.instances.map((instance) =>
        instance.id === strict ? { ...instance, alias: '' } : instance
      ),
    },
    expandedInstanceId: strict,
    errors: ['group_taken'],
  },
};

/** A saved model that the agent stopped publishing — reported, never swapped. */
export const IncompatibleRunConfig: Story = {
  args: {
    expandedInstanceId: claude,
    instanceRows: new Map(instanceRows).set(claude, {
      ...instanceRows.get(claude)!,
      issues: [
        { kind: 'model_unsupported', value: 'gpt-5.5-retired' },
        { kind: 'option_unsupported', configId: 'legacy_effort' },
      ],
    }),
  },
};

export const SharedWithWorkspace: Story = {
  args: { value: { ...configured, shareWithWorkspace: true }, isEditing: true },
};

export const DuplicateName: Story = {
  args: { errors: ['name_taken'], isEditing: true },
};
