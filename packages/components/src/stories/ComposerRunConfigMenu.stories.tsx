import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import { useMemo, useState } from 'react';
import { fn, userEvent, within } from 'storybook/test';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import {
  AGENT_ROLE_VERSION,
  withAgentRoleInstances,
  getAgentConfigRoomId,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type AgentRoleInstance,
  type AgentRoleInstanceId,
  type CatalogAgentRole,
  type MachineId,
} from '@lody/shared';

import { agentConfigMetaCacheAtom } from '@/atoms/doc-meta';
import { ChatLandingView } from '@/components/chat/chat-landing-view';
import {
  DesktopMachineMenu,
  DesktopPermissionModeButton,
  DesktopRunConfigMenu,
} from '@/components/sessions/desktop-run-config-menu';
import { resolvePermissionModeFace } from '@/lib/permission-mode-face';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';
import {
  doesAgentRolePinPermissionMode,
  findComposerAgentRoleItem,
  formatAgentRoleInstanceTitle,
  isComposerAgentRoleApplied,
  type ComposerAgentRoleItem,
} from '@/lib/composer-agent-roles';

/**
 * The desktop composer's run-config dropdown. A Role row sits above the
 * individual settings and opens the roles available in this scope; the footer
 * names a Role only while every value it pins is still what will run.
 */
const machineId = 'machine-storybook' as MachineId;
const codexId = 'agent-codex' as AgentConfigId;
const claudeId = 'agent-claude' as AgentConfigId;

const codex: AgentConfigMeta = {
  id: codexId,
  machineId,
  name: 'Codex Primary',
  description: 'Codex on zx-macbook',
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
};

const claude: AgentConfigMeta = {
  id: claudeId,
  machineId,
  name: 'Claude (Opus)',
  description: 'Claude Code',
  cliType: 'builtin',
  agentType: 'claude',
  env: {},
};

const agents: AgentConfigMeta[] = [codex, claude];

const recentRuns = [
  {
    id: 'recent-codex',
    agent: codex,
    modelLabel: '5.4',
    reasoningLabel: 'High',
    planOn: false,
    fastOn: false,
  },
  {
    id: 'recent-codex-mini',
    agent: codex,
    modelLabel: '5.4-mini',
    reasoningLabel: 'High',
    planOn: false,
    fastOn: false,
  },
  {
    id: 'recent-claude',
    agent: claude,
    modelLabel: 'Default',
    reasoningLabel: 'High',
    planOn: false,
    fastOn: false,
  },
];

const modelOptions: AcpSessionSelectOption[] = [
  { value: 'gpt-5.5', label: '5.5', description: 'Latest frontier Codex model' },
  { value: 'gpt-5.4', label: '5.4', description: 'Frontier Codex model' },
  { value: 'gpt-5.4-mini', label: '5.4-mini', description: 'Smaller, faster Codex model' },
];

/* What a provider with a large catalog publishes — the case the Model submenu's
   fuzzy search exists for. */
const manyModelOptions: AcpSessionSelectOption[] = [
  { value: 'gpt-5.5', label: '5.5', description: 'Latest frontier Codex model' },
  { value: 'gpt-5.5-codex', label: '5.5-codex', description: 'Tuned for coding' },
  { value: 'gpt-5.4', label: '5.4', description: 'Frontier Codex model' },
  { value: 'gpt-5.4-mini', label: '5.4-mini', description: 'Smaller, faster Codex model' },
  { value: 'gpt-5.3', label: '5.3', description: 'Previous frontier model' },
  { value: 'gpt-5.3-mini', label: '5.3-mini', description: 'Previous small model' },
  { value: 'o5-preview', label: 'o5-preview', description: 'Reasoning preview' },
  { value: 'o5-mini', label: 'o5-mini', description: 'Small reasoning model' },
  { value: 'o4', label: 'o4', description: 'Older reasoning model' },
  { value: 'gpt-4.1', label: '4.1', description: 'Legacy general model' },
];

const modeOptions: AcpSessionSelectOption[] = [
  {
    value: 'read-only',
    label: 'Read-only',
    description: 'Requires approval to edit files and run commands.',
  },
  { value: 'agent', label: 'Agent', description: 'Read and edit files, and run commands.' },
  {
    value: 'agent-full-access',
    label: 'Full access',
    description: 'Can edit files outside this workspace and run commands with network access.',
  },
];

const selectors: AcpConfigOptionSelector[] = [
  {
    type: 'select',
    configId: 'reasoning_effort',
    category: 'thought_level',
    label: 'Reasoning effort',
    currentValue: 'medium',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ],
  },
  {
    type: 'select',
    configId: 'collaboration_mode',
    category: 'collaboration_mode',
    label: 'Collaboration mode',
    currentValue: 'default',
    options: [
      { value: 'default', label: 'Default' },
      { value: 'plan', label: 'Plan' },
    ],
  },
  {
    type: 'select',
    configId: 'fast-mode',
    category: 'fast-mode',
    label: 'Fast mode',
    currentValue: 'off',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' },
    ],
  },
];

const makeRole = (
  overrides: Partial<AgentRole> & Pick<AgentRole, 'id' | 'name'>
): CatalogAgentRole => {
  const role: Omit<AgentRole, 'instances'> = {
    v: AGENT_ROLE_VERSION,
    ownerUserId: 'user-storybook',
    visibility: 'private',
    machineId,
    agentConfigId: codexId,
    runConfig: {},
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
  return withAgentRoleInstances(
    role,
    overrides.instances ?? [
      {
        id: `${role.id}:${role.machineId}` as AgentRoleInstanceId,
        label: role.agentConfigId === claudeId ? 'Claude' : 'Codex',
        machineId: role.machineId,
        agentConfigId: role.agentConfigId,
        runConfig: role.runConfig,
      },
    ]
  );
};

/** The composer's entries for a Role: one per instance, titled as the composer titles them. */
const itemsOf = (
  role: CatalogAgentRole,
  availability: ComposerAgentRoleItem['availability'],
  agentConfigFor: (instance: AgentRoleInstance) => ComposerAgentRoleItem['agentConfig']
): ComposerAgentRoleItem[] =>
  role.instances.map((instance) => ({
    role,
    instance,
    title: formatAgentRoleInstanceTitle(role, instance),
    availability,
    agentConfig: agentConfigFor(instance),
  }));

const reviewer = makeRole({
  id: 'role-reviewer' as AgentRoleId,
  name: 'Code Reviewer',
  emoji: '🔍',
  promptPrefix:
    'Review the diff for correctness before style. Name the concrete failure scenario for every issue you raise.',
  runConfig: {
    modelId: 'gpt-5.5',
    modeId: 'read-only',
    configOptionValues: { reasoning_effort: 'high' },
  },
});
/** Two instances on this machine: listed as two entries, each with its label. */
const uiStyle = makeRole({
  id: 'role-ui-style' as AgentRoleId,
  name: 'uiStyle',
  emoji: '🎨',
  instances: [
    {
      id: 'ui-style-claude' as AgentRoleInstanceId,
      label: 'Claude',
      machineId,
      agentConfigId: claudeId,
      runConfig: { modelId: 'gpt-5.4', configOptionValues: { reasoning_effort: 'medium' } },
    },
    {
      id: 'ui-style-codex' as AgentRoleInstanceId,
      label: 'Codex',
      machineId,
      agentConfigId: codexId,
      runConfig: { modelId: 'gpt-5.5', configOptionValues: { reasoning_effort: 'high' } },
    },
  ],
});
const agentConfigOf = (instance: AgentRoleInstance) =>
  instance.agentConfigId === claudeId
    ? claude
    : instance.agentConfigId === codexId
      ? codex
      : undefined;

const roleItems: ComposerAgentRoleItem[] = [
  ...itemsOf(reviewer, { kind: 'available' }, agentConfigOf),
  ...itemsOf(
    makeRole({
      id: 'role-docs' as AgentRoleId,
      name: 'Docs Writer',
      emoji: '📝',
      visibility: 'workspace',
      agentConfigId: claudeId,
      promptPrefix: 'Write for someone who has never seen this codebase.',
      runConfig: { modelId: 'gpt-5.4', configOptionValues: { reasoning_effort: 'medium' } },
    }),
    { kind: 'available' },
    agentConfigOf
  ),
  ...itemsOf(uiStyle, { kind: 'available' }, agentConfigOf),
  ...itemsOf(
    makeRole({
      id: 'role-triage' as AgentRoleId,
      name: 'Bug Triage',
      emoji: '🐛',
      runConfig: {
        modelId: 'gpt-5.4-mini',
        configOptionValues: { reasoning_effort: 'low', collaboration_mode: 'plan' },
      },
    }),
    { kind: 'available' },
    agentConfigOf
  ),
  // Listed, disabled, and stating its reason: an instance never re-points at
  // whichever agent config happens to be available.
  ...itemsOf(
    makeRole({
      id: 'role-gone' as AgentRoleId,
      name: 'Retired Reviewer',
      emoji: '🗑️',
      agentConfigId: 'agent-removed' as AgentConfigId,
      runConfig: { modelId: 'gpt-5.1-codex' },
    }),
    { kind: 'unavailable', reason: 'agent_config_missing' },
    () => undefined
  ),
];

const manyRoleItems: ComposerAgentRoleItem[] = [
  ...roleItems,
  ...Array.from({ length: 12 }, (_, index) =>
    itemsOf(
      makeRole({
        id: `role-extra-${index}` as AgentRoleId,
        name: `Workspace role ${index + 1}`,
        emoji: '🧩',
        promptPrefix:
          'Inspect the request and repository context, explain any important constraints, ' +
          'then make a focused change and verify the observable result. '.repeat(3),
        runConfig: { modelId: 'gpt-5.4' },
      }),
      { kind: 'available' },
      agentConfigOf
    )
  ).flat(),
];

/* The menu calls `useOnlineMachines`, so it needs a platform in context. A
   local provider keeps the story offline; the agent pool is passed explicitly
   through `availableAgentConfigs` so it does not depend on machine presence. */
const storyPlatform = createLocalPlatformProvider({
  session: createStaticStore({
    status: 'authenticated',
    user: { id: 'user-storybook-roles', name: 'Zixuan' },
  }),
  workspaces: createStaticStore({
    status: 'ready',
    workspaces: [
      { id: 'workspace-storybook', name: 'Storybook Workspace', slug: null, role: 'owner' },
    ],
    activeWorkspaceId: 'workspace-storybook',
  }),
});

/**
 * Mirrors the landing composer: picking a Role sets the agent and every value
 * it pins, and the Role stays named only while that is still what will run.
 */
function StoryShell({
  items,
  initialInstanceId = null,
  models = modelOptions,
  landing = false,
  existingSession = false,
}: {
  items: ReadonlyArray<ComposerAgentRoleItem>;
  initialInstanceId?: AgentRoleInstanceId | null;
  /** Overridden by the long-list story: what an agent provider may publish. */
  models?: AcpSessionSelectOption[];
  landing?: boolean;
  existingSession?: boolean;
}) {
  const store = useMemo(() => {
    const s = createStore();
    s.set(
      agentConfigMetaCacheAtom,
      Object.fromEntries(agents.map((agent) => [getAgentConfigRoomId(agent.id), agent]))
    );
    return s;
  }, []);

  const initialRole = findComposerAgentRoleItem(items, initialInstanceId)?.instance;
  const [agentSelection, setAgentSelection] = useState(() =>
    initialRole
      ? { agentId: initialRole.agentConfigId, machineId: initialRole.machineId }
      : { agentId: codexId, machineId }
  );
  const [model, setModel] = useState<string | null>(
    initialRole?.runConfig.modelId ?? models[0]?.value ?? null
  );
  const [mode, setMode] = useState<string | null>(
    initialRole?.runConfig.modeId ?? modeOptions[1]?.value ?? null
  );
  const [values, setValues] = useState<Record<string, AcpConfigOptionValue>>(() => ({
    ...Object.fromEntries(selectors.map((selector) => [selector.configId, selector.currentValue])),
    ...(initialRole?.runConfig.configOptionValues ?? {}),
  }));

  /* Mirrors production: leaving a Role clears the NAME, not the configuration,
     so a cleared Role stays cleared until something actually changes. */
  const [clearedInstanceId, setClearedInstanceId] = useState<AgentRoleInstanceId | null>(null);
  const [pickedInstanceId, setPickedInstanceId] = useState(initialInstanceId);
  // The picked instance while it still applies, else the first one that does.
  const applied = (item: ComposerAgentRoleItem) =>
    isComposerAgentRoleApplied(item.instance, {
      agentSelection,
      modeId: mode,
      modelId: model,
      configOptionValues: values,
    });
  const picked = findComposerAgentRoleItem(items, pickedInstanceId);
  const matched = (picked && applied(picked) ? picked : items.find(applied))?.instance ?? null;
  const selected = matched && matched.id !== clearedInstanceId ? matched : null;
  const permissionPinnedByRole =
    selected != null &&
    doesAgentRolePinPermissionMode(
      selected.runConfig,
      resolvePermissionModeFace({
        modeOptions,
        selectedModeId: mode,
        configOptionSelectors: selectors,
        configOptionValues: values,
      }).source
    );

  const footer = (
    <>
      <DesktopRunConfigMenu
        agentSelection={agentSelection}
        availableAgentConfigs={agents}
        agentLocked={existingSession}
        showAgentNameInTrigger={!landing}
        onAgentConfigChange={setAgentSelection}
        modelOptions={models}
        selectedModelId={model}
        onModelChange={setModel}
        configOptionSelectors={selectors}
        configOptionValues={values}
        onConfigOptionChange={(configId, value) =>
          setValues((prev) => ({ ...prev, [configId]: value }))
        }
        modeOptions={modeOptions}
        selectedModeId={mode}
        recentRunConfigs={landing ? recentRuns : undefined}
        onRecentRunConfigSelect={landing ? fn() : undefined}
        agentRoles={{
          items,
          selectedInstanceId: selected?.id ?? null,
          onSelect: (instanceId) => {
            if (instanceId === null) {
              setClearedInstanceId(matched?.id ?? null);
              return;
            }
            setClearedInstanceId(null);
            const instance = findComposerAgentRoleItem(items, instanceId)?.instance;
            if (!instance) return;
            setPickedInstanceId(instance.id);
            setAgentSelection({
              agentId: instance.agentConfigId,
              machineId: instance.machineId,
            });
            setModel(instance.runConfig.modelId ?? null);
            setMode(instance.runConfig.modeId ?? null);
            setValues((prev) => ({ ...prev, ...(instance.runConfig.configOptionValues ?? {}) }));
          },
          onCreate: fn(),
          onEdit: existingSession ? undefined : fn(),
        }}
      />
      {/* Mirrors the composer footer: behind a Role that pins permission,
          this button is gone and the Role's face states the value. */}
      {permissionPinnedByRole ? null : (
        <DesktopPermissionModeButton
          modeOptions={modeOptions}
          selectedModeId={mode}
          onModeChange={setMode}
          configOptionSelectors={selectors}
          configOptionValues={values}
          onConfigOptionChange={(configId, value) =>
            setValues((prev) => ({ ...prev, [configId]: value }))
          }
        />
      )}
    </>
  );

  return (
    <PlatformContext.Provider value={storyPlatform}>
      <Provider store={store}>
        {landing ? (
          <div className="h-dvh">
            <ChatLandingView
              tone="light"
              title="今天想做点什么？"
              promptValue=""
              onPromptChange={fn()}
              promptPlaceholder="按 / 使用命令，@ 添加提及。"
              onAttachmentAddClick={fn()}
              topSelector={
                <DesktopMachineMenu
                  value={machineId}
                  visibleLocalMachineId={machineId}
                  options={[{ value: machineId, label: 'Mac Studio' }]}
                  onChange={fn()}
                />
              }
              footerSelector={footer}
            />
          </div>
        ) : (
          <div className="flex min-h-dvh items-end bg-background p-8">
            <div className="mb-6 flex w-full max-w-3xl items-center gap-2 rounded-xl bg-input/90 px-4 py-3">
              {footer}
            </div>
          </div>
        )}
      </Provider>
    </PlatformContext.Provider>
  );
}

const meta = {
  title: 'Sessions/ComposerRunConfigMenu',
  component: StoryShell,
  args: { items: roleItems },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

const openMenu = async (canvasElement: HTMLElement) => {
  const trigger = canvasElement.querySelector<HTMLButtonElement>('[data-run-config-trigger]');
  if (!trigger) throw new Error('Run configuration trigger is missing');
  await userEvent.click(trigger);
};

const openRoleSubmenu = async (canvasElement: HTMLElement) => {
  await openMenu(canvasElement);
  await userEvent.hover(
    await within(document.body).findByRole('menuitem', { name: /^(?:Role|角色)/ })
  );
};

/** The footer button while the composer is configured knob by knob. */
export const Closed: Story = {};

/** The Role row leads the menu, because a Role answers every row under it. */
export const Menu: Story = {
  play: async ({ canvasElement }) => {
    await openMenu(canvasElement);
  },
};

/** The Role submenu: recognise the Role on the left, read what it runs on the right. */
export const RoleSubmenu: Story = {
  play: async ({ canvasElement }) => {
    await openRoleSubmenu(canvasElement);
  },
};

/** The production landing view docks the composer at the bottom of the page. */
export const LandingRoleSubmenu: Story = {
  args: { landing: true },
  play: async ({ canvasElement }) => {
    await openRoleSubmenu(canvasElement);
  },
};

/** The list and the preview scroll separately when the machine has many Roles. */
export const LandingManyRoles: Story = {
  args: { landing: true, items: manyRoleItems },
  play: async ({ canvasElement }) => {
    await openRoleSubmenu(canvasElement);
  },
};

/** The empty Role row is a create action, not a submenu. */
export const LandingNoRoles: Story = {
  args: { landing: true, items: [] },
  play: async ({ canvasElement }) => {
    await openMenu(canvasElement);
  },
};

/** A selected Role changes the docked composer's face and may hide permission. */
export const LandingRoleSelected: Story = {
  args: { landing: true, initialInstanceId: reviewer.instances[0]!.id },
  play: async ({ canvasElement }) => {
    await openRoleSubmenu(canvasElement);
  },
};

/** Existing sessions keep their Agent and only offer Roles for that binding. */
export const ExistingSessionRoles: Story = {
  args: {
    existingSession: true,
    items: roleItems.filter((item) => item.instance.agentConfigId === codexId),
  },
  play: async ({ canvasElement }) => {
    await openRoleSubmenu(canvasElement);
  },
};

/**
 * A Role the composer currently IS: the footer names it and states its values
 * beside the button, and the permission button is gone because the Role pins it.
 */
export const RoleSelected: Story = {
  args: { initialInstanceId: reviewer.instances[0]!.id },
  play: async ({ canvasElement }) => {
    await openRoleSubmenu(canvasElement);
  },
};

/**
 * A Role that pins full access keeps the amber shield in the face. The rest of
 * the face is quiet because the Role decided it, but this is the one value that
 * no longer has a button of its own carrying the warning.
 */
export const RoleWithWarningPermission: Story = {
  args: {
    items: [
      {
        ...roleItems[0]!,
        title: 'Autofix',
        role: { ...roleItems[0]!.role, name: 'Autofix', emoji: '\u{1F6E0}\u{FE0F}' },
        instance: {
          ...roleItems[0]!.instance,
          runConfig: { ...roleItems[0]!.instance.runConfig, modeId: 'agent-full-access' },
        },
      },
      ...roleItems.slice(1),
    ],
    initialInstanceId: reviewer.instances[0]!.id,
  },
};

/**
 * A provider with a long model list: the Model submenu gains a fuzzy search row
 * that stays put while the options scroll under it. Type `54m` to see it narrow
 * to `5.4-mini` — a scroll is not a way to find one model among dozens.
 */
export const ModelSearch: Story = {
  args: { models: manyModelOptions },
  play: async ({ canvasElement }) => {
    await openMenu(canvasElement);
    await userEvent.hover(await within(document.body).findByText('Model'));
  },
};

/**
 * No Roles on this machine yet: the row's value IS the way to make one, seeded
 * with whatever the rows under it are set to right now.
 */
export const NoRolesYet: Story = {
  args: { items: [] },
  play: async ({ canvasElement }) => {
    await openMenu(canvasElement);
  },
};
