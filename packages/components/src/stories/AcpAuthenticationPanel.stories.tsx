import type { Meta, StoryObj } from '@storybook/react';
import { userEvent, within } from 'storybook/test';
import type { ReactNode } from 'react';
import { Provider } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';
import {
  getMachineRoomId,
  type AgentConfigId,
  type MachineId,
  type MachineMeta,
  type WorkspaceId,
} from '@lody/shared';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { machineMetaCacheAtom } from '@/atoms/doc-meta';
import { runtimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { AcpAuthenticationPanel } from '@/components/settings/acp-authentication-panel';

const workspaceId = 'settings-story-workspace' as WorkspaceId;
const machineId = 'settings-story-machine' as MachineId;
const configId = 'settings-story-lody-agent' as AgentConfigId;
const antigravityConfigId = 'settings-story-antigravity' as AgentConfigId;

const authMethods = [
  {
    id: 'sorbet:anthropic:oauth',
    type: 'agent' as const,
    name: 'Anthropic',
    description: 'Sign in with a Claude subscription',
  },
  {
    id: 'sorbet:openai:oauth',
    type: 'agent' as const,
    name: 'ChatGPT',
    description: 'Use a ChatGPT plan',
  },
  {
    id: 'sorbet:openrouter:api-key',
    type: 'agent' as const,
    name: 'OpenRouter',
    description: 'Paste an API key',
  },
];

const antigravityAuthMethods = [
  {
    id: 'oauth-personal',
    type: 'agent' as const,
    name: 'Log in with Google',
    description: 'Log in with your Google account',
  },
  {
    id: 'oauth-business',
    type: 'agent' as const,
    name: 'Log in with Gemini Enterprise',
    description: 'Log in with your Gemini Enterprise account',
  },
  {
    id: 'gemini-api-key',
    type: 'agent' as const,
    name: 'Gemini API key',
    description: 'Use an API key with Gemini Developer API',
  },
  {
    id: 'agent-platform',
    type: 'agent' as const,
    name: 'Gemini Enterprise Agent Platform',
    description:
      'Use Gemini Enterprise Agent Platform (formerly Vertex AI) with Application Default Credentials',
  },
];

const capabilityEntry = {
  cacheVersion: 12,
  cliType: 'builtin',
  agentType: 'sorbet',
  sourceVersion: 'builtin-sorbet:@sorbetai/acp@0.1.0-alpha.5',
  modes: [],
  models: [],
  authMethods,
};

const antigravityCapabilityEntry = {
  cacheVersion: 12,
  cliType: 'builtin',
  agentType: 'antigravity',
  sourceVersion: 'builtin:antigravity:1.5.14',
  modes: [],
  models: [],
  authMethods: antigravityAuthMethods,
};

function machineMeta(withAdvertisedMethods: boolean): MachineMeta {
  return {
    id: machineId,
    name: 'Workstation',
    ownerUserId: 'settings-story-user',
    os: 'macOS',
    cliVersion: '0.60.0',
    sessions: [],
    protocolCapabilities: {
      providerSetup: 1,
      sorbetCredentials: 1,
      sorbetProviders: 1,
      acpProtocolAuthentication: 2,
      acpAuthenticationInteractions: 2,
      acpAuthenticationMethodSelection: 1,
    },
    acpCapabilities: withAdvertisedMethods
      ? { [configId]: capabilityEntry, [antigravityConfigId]: antigravityCapabilityEntry }
      : {},
  } as unknown as MachineMeta;
}

/** Never answers, so the panel stays in its waiting state for the screenshot. */
const waitingRuntime = {
  workspaceId,
  workspaceSlug: 'lody',
  contentMode: 'ordinary',
  accountId: 'settings-story-user',
  sendControl: () => {},
  subscribeMachineAcpAuthenticationProgress: () => () => {},
  waitForMachineAcpAuthenticateResponse: () => new Promise(() => {}),
} as unknown as WorkspaceRuntime;

function Hydrate({
  children,
  withMethods = true,
  withRuntime = false,
}: {
  children: ReactNode;
  withMethods?: boolean;
  withRuntime?: boolean;
}) {
  useHydrateAtoms(
    [
      [machineMetaCacheAtom, { [getMachineRoomId(machineId)]: machineMeta(withMethods) }],
      ...(withRuntime
        ? [
            [currentWorkspaceIdAtom, workspaceId],
            [runtimeAtom, waitingRuntime],
          ]
        : []),
    ] as never
  );
  return <>{children}</>;
}

function Fixture(props: {
  children: ReactNode;
  withMethods?: boolean;
  withRuntime?: boolean;
}) {
  return (
    <Provider>
      <Hydrate {...props} />
    </Provider>
  );
}

const meta = {
  title: 'Settings/ACP authentication panel',
  component: AcpAuthenticationPanel,
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-[calc(100vw-2rem)] bg-background p-6">
        <Story />
      </div>
    ),
  ],
  parameters: { layout: 'centered' },
  args: {
    machineId,
    configId,
    cliType: 'builtin',
    agentType: 'sorbet',
    providerName: 'Lody Agent',
    compact: true,
  },
} satisfies Meta<typeof AcpAuthenticationPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Methods the probe recorded are rows; each row is its own sign-in action. */
export const AdvertisedMethods: Story = {
  args: { layout: 'rows' },
  render: (args) => (
    <Fixture>
      <AcpAuthenticationPanel {...args} />
    </Fixture>
  ),
};

/** The older single sign-in, for a Provider with no recorded methods yet. */
export const SingleSignIn: Story = {
  args: { layout: 'default' },
  render: (args) => (
    <Fixture withMethods={false}>
      <AcpAuthenticationPanel {...args} />
    </Fixture>
  ),
};

/**
 * Row layout while a sign-in runs on the target machine: the chosen row becomes the
 * wait, names the step, shows the time spent, and keeps Cancel beside it.
 */
export const WaitingOnSignIn: Story = {
  args: { layout: 'rows' },
  render: (args) => (
    <Fixture withRuntime>
      <AcpAuthenticationPanel {...args} />
    </Fixture>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const buttons = await canvas.findAllByRole('button', { name: 'Sign in' });
    await userEvent.click(buttons[0]!);
  },
};

/** Editing an already-signed-in Antigravity provider collapses advertised methods behind Sign in again. */
export const AntigravityReauthenticationCollapsed: Story = {
  args: {
    configId: antigravityConfigId,
    cliType: 'builtin',
    agentType: 'antigravity',
    providerName: 'Google Antigravity',
    layout: 'default',
    reauthentication: true,
  },
  render: (args) => (
    <Fixture>
      <AcpAuthenticationPanel {...args} />
    </Fixture>
  ),
};

/** Clicking Sign in again expands Antigravity's advertised methods with a Cancel action. */
export const AntigravityReauthenticationExpanded: Story = {
  args: {
    configId: antigravityConfigId,
    cliType: 'builtin',
    agentType: 'antigravity',
    providerName: 'Google Antigravity',
    layout: 'default',
    reauthentication: true,
  },
  render: (args) => (
    <Fixture>
      <AcpAuthenticationPanel {...args} />
    </Fixture>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = await canvas.findByRole('button', { name: 'Sign in again' });
    await userEvent.click(button);
  },
};

/** When authentication is actually required, Antigravity's advertised methods appear up front. */
export const AntigravityUnauthenticatedMethods: Story = {
  args: {
    configId: antigravityConfigId,
    cliType: 'builtin',
    agentType: 'antigravity',
    providerName: 'Google Antigravity',
    layout: 'default',
    reauthentication: false,
  },
  render: (args) => (
    <Fixture>
      <AcpAuthenticationPanel {...args} />
    </Fixture>
  ),
};
