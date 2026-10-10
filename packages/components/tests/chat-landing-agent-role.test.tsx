// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_ROLE_VERSION,
  resolveAgentRoleInstanceAvailability,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRoleId,
  type AgentRoleInstance,
  type AgentRoleInstanceId,
  type CatalogAgentRole,
  type MachineId,
} from '@lody/shared';

/**
 * The new-chat page itself: its own state, effects and derivations decide
 * whether a picked Role becomes the composer's. Only where it reads the world
 * (workspace, machines, agent configs, Roles) and what it draws are replaced.
 */
// The page's import graph reaches Monaco, which asks this of the document at load.
vi.hoisted(() => {
  document.queryCommandSupported = () => false;
});

const world = vi.hoisted(() => ({
  roles: [] as unknown[],
  configs: [] as unknown[],
  machines: new Map<string, unknown>(),
  online: new Set<string>(),
  menu: null as null | {
    agentSelection: { agentId: string; machineId: string } | null;
    agentRoles: {
      items: { instance: { id: string }; title: string; availability: { kind: string } }[];
      selectedInstanceId: string | null;
      onSelect: (id: string | null) => void;
    };
  },
}));

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => () => undefined,
}));
vi.mock('@posthog/react', () => ({ usePostHog: () => null }));
vi.mock('@lody/platform/react', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAppCapability: () => false,
  useCloudQuery: () => undefined,
  useCloudMutation: () => async () => undefined,
}));
vi.mock('../src/hooks/use-authenticated-convex', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAuthenticatedConvex: () => ({
    isAuthenticated: true,
    isLoading: false,
    authSessionId: 'auth',
    confirmedUnauthenticated: false,
    isRecovering: false,
    claimAutomaticCommand: () => false,
    requestAuthRecovery: () => undefined,
  }),
}));
vi.mock('../src/hooks/use-open-settings', () => ({
  useOpenSettings: () => ({ openSettings: () => undefined }),
}));
vi.mock('../src/hooks/useOrganization', () => ({
  useOrganization: () => ({
    activeOrganization: { id: 'ws', slug: 'ws', name: 'ws', members: [] },
    organizations: [],
    switchOrganization: async () => undefined,
  }),
}));
vi.mock('../src/hooks/use-resolved-workspace-scope', () => ({
  useResolvedWorkspaceScope: () => ({ workspaceId: 'ws', enabled: true }),
}));
vi.mock('../src/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => ({
    machines: world.machines,
    accessByMachineId: new Map(),
    machineFlockRemoteSyncedMachineIds: new Set(world.machines.keys()),
    convexAuthorizedMachineIds: new Set(world.machines.keys()),
    isLoading: false,
  }),
}));
vi.mock('../src/hooks/use-machine-online-status', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useOnlineMachineIds: () => world.online,
}));
vi.mock('../src/atoms/agents', async (importOriginal) => {
  const { atom } = await import('jotai');
  return { ...(await importOriginal<object>()), getAllAgentConfigAtom: atom(() => world.configs) };
});
vi.mock('../src/hooks/use-workspace-agent-roles', () => ({
  useWorkspaceAgentRoles: () => ({ roles: world.roles, synced: true }),
  useAgentRoleAvailability: () => ({
    resolveInstance: (instance: AgentRoleInstance) =>
      resolveAgentRoleInstanceAvailability(instance, {
        authorizedMachineIds: new Set(world.machines.keys()) as Set<MachineId>,
        onlineMachineIds: new Set(world.machines.keys()) as Set<MachineId>,
        agentConfigMachineIds: new Map(
          (world.configs as AgentConfigMeta[]).map((config) => [config.id, config.machineId!])
        ),
        loadedAgentConfigMachineIds: new Set(world.machines.keys()) as Set<MachineId>,
      }),
  }),
  useComposerAgentRoleNames: () => ({
    machine: (id: string) => (world.machines.get(id) as { name: string } | undefined)?.name,
    unknownAgent: 'Unknown agent',
  }),
}));
vi.mock('../src/components/settings/agent-role-editor-dialog', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  AgentRoleEditorDialog: () => null,
}));
vi.mock('../src/components/sessions/desktop-run-config-menu', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  DesktopRunConfigMenu: (props: NonNullable<typeof world.menu>) => {
    world.menu = props;
    return null;
  },
}));
vi.mock('../src/components/chat/chat-landing-view', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ChatLandingView: ({ footerSelector }: { footerSelector?: ReactNode }) => footerSelector ?? null,
}));

import { ChatLanding } from '../src/components/chat/chat-landing';
import { initI18n } from '../src/i18n';
import { writeChatLandingDefaults } from '../src/lib/chat-landing-defaults';
import { reportedClaudeCapabilities, singleMachineRole } from './agent-role-fixture';
import { TestCloudPlatformProvider } from './test-platform';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const here = 'machine-here' as MachineId;
const there = 'machine-there' as MachineId;
const config = (id: string, machineId: MachineId, agentType: 'claude' | 'codex') =>
  ({
    id,
    machineId,
    name: agentType === 'claude' ? 'Claude Code' : 'Codex',
    cliType: 'builtin',
    agentType,
    env: {},
  }) as unknown as AgentConfigMeta;
const instance = (
  id: string,
  machineId: MachineId,
  agentConfigId: string,
  runConfig: AgentRoleInstance['runConfig'],
  alias?: string
): AgentRoleInstance => ({
  id: id as AgentRoleInstanceId,
  machineId,
  agentConfigId: agentConfigId as AgentConfigId,
  runConfig,
  ...(alias ? { alias } : {}),
});
const role = (id: string, instances: AgentRoleInstance[]): CatalogAgentRole =>
  singleMachineRole({
    v: AGENT_ROLE_VERSION,
    id: id as AgentRoleId,
    name: id,
    ownerUserId: 'user-1',
    visibility: 'workspace',
    machineId: instances[0]!.machineId,
    agentConfigId: instances[0]!.agentConfigId,
    runConfig: instances[0]!.runConfig,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    instances,
  });

/* Run configs as the workspace's own Roles store them. */
const fable = { modeId: 'auto', modelId: 'claude-fable-5-1' };
const codexPins = {
  modeId: 'agent-auto-review',
  modelId: 'gpt-6-astra',
  configOptionValues: { 'fast-mode': false, plan_mode: false, reasoning_effort: 'high' },
};
const roles = [
  // One instance.
  role('perf', [
    instance('perf-here', here, 'claude-here', {
      modeId: 'auto',
      modelId: 'opus',
      configOptionValues: { effort: 'high', fast: false },
    }),
  ]),
  // One group on two machines.
  role('vision', [
    instance('vision-here', here, 'codex-here', codexPins),
    instance('vision-there', there, 'codex-there', codexPins),
  ]),
  // Two groups here, one of them also elsewhere. The Claude instance here is
  // the stored shape that used not to take: Fable, with Fast pinned off.
  role('uiStyle', [
    instance(
      'ui-claude-here',
      here,
      'claude-here',
      { ...fable, configOptionValues: { effort: 'high', fast: false } },
      'Claude'
    ),
    instance(
      'ui-claude-there',
      there,
      'claude-there',
      { ...fable, configOptionValues: { effort: 'high' } },
      'Claude'
    ),
    instance('ui-codex-here', here, 'codex-here', codexPins, 'Codex'),
  ]),
  // Only elsewhere: picking it moves the chat.
  role('remote', [
    instance('remote-there', there, 'claude-there', {
      ...fable,
      configOptionValues: { effort: 'max', fast: false },
    }),
  ]),
];

describe('picking a Role on the new-chat page', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(async () => {
    await initI18n('en');
    world.roles = roles;
    world.configs = [
      config('claude-here', here, 'claude'),
      config('codex-here', here, 'codex'),
      config('claude-there', there, 'claude'),
      config('codex-there', there, 'codex'),
    ];
    world.machines = new Map(
      (
        [
          [here, 'devnuc', 'claude-here'],
          [there, 'n100', 'claude-there'],
        ] as const
      ).map(([id, name, claudeConfigId]) => [
        id,
        {
          id,
          name,
          localProjects: {},
          acpCapabilities: { [claudeConfigId]: reportedClaudeCapabilities },
        },
      ])
    );
    world.online = new Set(world.machines.keys());
    world.menu = null;
    localStorage.clear();
    // The composer opens where the user last was: this machine's Claude.
    writeChatLandingDefaults('ws', {
      contextType: 'chat',
      agentId: 'claude-here',
      machineId: here,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        createElement(
          TestCloudPlatformProvider,
          null,
          createElement(ChatLanding, { workspaceSlug: 'ws' })
        )
      )
    );
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  const pick = async (instanceId: string) => {
    await act(async () => world.menu!.agentRoles.onSelect(instanceId));
    return {
      selected: world.menu!.agentRoles.selectedInstanceId,
      agent: world.menu!.agentSelection,
    };
  };

  it('offers every group once, this machine first', () => {
    expect(world.menu?.agentSelection).toEqual({ agentId: 'claude-here', machineId: here });
    expect(world.menu?.agentRoles.items.map((item) => [item.title, item.instance.id])).toEqual([
      ['perf', 'perf-here'],
      ['uiStyle · Claude', 'ui-claude-here'],
      ['uiStyle · Codex', 'ui-codex-here'],
      ['vision', 'vision-here'],
      ['remote · n100', 'remote-there'],
    ]);
  });

  it.each([
    ['a Role with one instance', 'perf-here', 'claude-here', here],
    ['one group that also runs elsewhere', 'vision-here', 'codex-here', here],
    ['a second group of a Role, on another agent', 'ui-codex-here', 'codex-here', here],
    // The stored shape that did not take: Fable has no Fast toggle to carry `fast: false`.
    ['a Fable instance that pins Fast off', 'ui-claude-here', 'claude-here', here],
    [
      'an instance on another machine, moving the chat there',
      'remote-there',
      'claude-there',
      there,
    ],
  ])('becomes %s', async (_what, instanceId, agentId, machineId) => {
    expect(await pick(instanceId)).toEqual({
      selected: instanceId,
      agent: { agentId, machineId },
    });
  });

  it('follows one pick after another, and leaves a Role by name only', async () => {
    for (const instanceId of ['ui-claude-here', 'vision-here', 'remote-there', 'ui-codex-here']) {
      expect((await pick(instanceId)).selected).toBe(instanceId);
    }
    const left = await pick(null as never);
    expect(left.selected).toBeNull();
    // Clearing the name keeps the agent the Role had put there.
    expect(left.agent).toEqual({ agentId: 'codex-here', machineId: here });
  });
});
