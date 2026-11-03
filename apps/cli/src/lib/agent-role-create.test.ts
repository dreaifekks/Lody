import { describe, expect, it, vi } from 'vitest';
import {
  getAgentRoleTargets,
  AGENT_ROLE_VERSION,
  snapshotAgentRole,
  normalizeAgentRole,
  workspaceFlockKeys,
  type AgentConfigId,
  type AgentRole,
  type AgentRoleId,
  type AgentRoleInstanceId,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import type { AuthContext } from './command-runtime';
import type { AgentRoleDiscoveryTarget } from './resource-discovery';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { CreateOptions } from '@/commands/session';
import {
  applyAgentRoleCreateTarget,
  composeAgentRolePrompt,
  resolveAgentRoleCreate,
  resolveAgentRoleCreateFromCatalog,
  selectAgentRoleTarget,
  selectUniqueAgentRoleByIdOrName,
} from './agent-role-create';
import { __lodyMcpServerInternals } from '../mcp/lody-mcp-server';

const { buildMcpCreateOptions, getSessionContext, resolveMcpSessionCreate } =
  __lodyMcpServerInternals;

const discoveryState = vi.hoisted(() => ({
  instances: [] as AgentRoleDiscoveryTarget[],
  projectMachineId: undefined as MachineId | undefined,
}));
vi.mock('./resource-discovery-runtime', () => ({
  createResourceDiscovery: async () => ({
    agentRoleTargets: async () => discoveryState.instances,
    localProjectMachineId: async () => discoveryState.projectMachineId,
    resolveMachine: async (selector: string) => selector,
  }),
}));
const auth: AuthContext = {
  token: 'test',
  userId: 'user-1',
  userName: 'User',
  userEmail: 'user@example.test',
  machineId: 'machine-b' as MachineId,
  machineName: 'B',
};

const createMcpContext = (): ReturnType<typeof getSessionContext> => ({
  machineId: 'machine-id',
  workspaceId: 'workspace-id',
  sessionId: 'current-session-id',
  localControlSocketPath: '/tmp/lody-control.sock',
  workdir: '/tmp/workspace',
});

const agentRole = (overrides: Partial<AgentRole> = {}) =>
  normalizeAgentRole({
    v: AGENT_ROLE_VERSION,
    id: 'reviewer' as AgentRoleId,
    ownerUserId: 'user-1',
    visibility: 'private',
    name: 'Reviewer',
    machineId: 'remote-machine' as MachineId,
    agentConfigId: 'claude-opus' as AgentConfigId,
    runConfig: {},
    revision: 7,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  })!;

const createRoleCatalogManager = (roles: AgentRole[]) => {
  const syncFlockDocOrThrow = vi.fn(async () => undefined);
  const openFlockDoc = vi.fn(async () => ({
    flock: {
      scan: ({ prefix }: { prefix?: readonly unknown[] } = {}) =>
        prefix?.[0] === 'agentRole'
          ? roles.map((role) => ({ key: workspaceFlockKeys.agentRole(role.id), value: role }))
          : [],
    },
  }));
  const manager = {
    syncFlockDocOrThrow,
    repo: { openFlockDoc },
  } as unknown as LoroDocumentManager;
  return { manager, syncFlockDocOrThrow };
};

describe('selectUniqueAgentRoleByIdOrName', () => {
  const roles = [agentRole(), agentRole({ id: 'implementer' as AgentRoleId, name: 'Implementer' })];

  it('resolves a fixed id before considering names', () => {
    expect(selectUniqueAgentRoleByIdOrName(roles, 'reviewer').id).toBe('reviewer');
    expect(
      selectUniqueAgentRoleByIdOrName(
        [agentRole({ id: 'Reviewer' as AgentRoleId, name: 'Other' }), ...roles],
        'Reviewer'
      ).id
    ).toBe('Reviewer');
  });

  it('resolves a unique name and reports ambiguity with candidates', () => {
    expect(selectUniqueAgentRoleByIdOrName(roles, 'Implementer').id).toBe('implementer');
    const duplicates = [
      agentRole({ id: 'reviewer-a' as AgentRoleId }),
      agentRole({ id: 'reviewer-b' as AgentRoleId }),
    ];
    expect(() => selectUniqueAgentRoleByIdOrName(duplicates, 'Reviewer')).toThrow(
      /Agent Role selector is ambiguous: Reviewer\. Use an id instead\. Candidates:/
    );
  });
});

describe('resolveAgentRoleCreate', () => {
  it('keeps the authored prompt, binds the Prompt prefix separately and freezes the Role run config', () => {
    const role = agentRole({
      runConfig: {
        modeId: 'default',
        modelId: 'opus',
        configOptionValues: { reasoning_effort: 'medium' },
      },
      promptPrefix: 'Act as a careful reviewer.',
    });

    const resolved = resolveAgentRoleCreate({ role, prompt: 'Review the current diff.' });

    expect(resolved.prompt).toBe('Review the current diff.');
    const options: CreateOptions = {};
    applyAgentRoleCreateTarget(options, resolved);
    expect(options.agentRolePromptPrefix).toBe('Act as a careful reviewer.');
    expect(resolved.dispatchConfig).toEqual({
      modeId: 'default',
      modelId: 'opus',
      configOptionValues: { reasoning_effort: 'medium' },
      inheritSessionDefaults: false,
    });
    expect(resolved.machineId).toBe('remote-machine');
    expect(resolved.agentConfigId).toBe('claude-opus');
    expect(composeAgentRolePrompt('  ', 'Review the current diff.')).toBe(
      'Review the current diff.'
    );
  });
});

describe('resolveAgentRoleCreateFromCatalog', () => {
  it('selects and freezes the local project instance just like MCP, and respects machine pins', async () => {
    const role = agentRole({
      instances: [
        {
          id: 'instance-a' as AgentRoleInstanceId,
          machineId: 'machine-a' as MachineId,
          agentConfigId: 'config-a' as AgentConfigId,
          runConfig: { modelId: 'a' },
        },
        {
          id: 'instance-b' as AgentRoleInstanceId,
          machineId: 'machine-b' as MachineId,
          agentConfigId: 'config-b' as AgentConfigId,
          runConfig: { modelId: 'b' },
        },
      ],
    });
    discoveryState.instances = getAgentRoleTargets(role).map((instance) => ({
      ...instance,
      alias: null,
      group: { key: 'claude', name: 'Claude' },
      availability: { state: 'available' },
    }));
    discoveryState.projectMachineId = 'machine-b' as MachineId;
    const { manager } = createRoleCatalogManager([role]);
    const cli = await resolveAgentRoleCreateFromCatalog({
      auth: { ...auth, machineId: 'machine-a' as MachineId },
      manager,
      workspaceId: 'workspace-id' as WorkspaceId,
      selector: role.id,
      prompt: 'Review',
      overrides: { localProject: 'project-b' },
    });
    const mcp = await __lodyMcpServerInternals.selectMcpAgentRoleTarget({
      role,
      requester: { machineId: 'machine-a' as MachineId },
      input: {
        operationId: 'role-project',
        prompt: 'Review',
        agentRoleId: role.id,
        workContext: { kind: 'local', projectId: 'project-b' },
      },
      discovery: async () => ({
        agentRoleTargets: async () => discoveryState.instances,
        localProjectMachineId: async () => discoveryState.projectMachineId,
      }),
    });
    expect(cli.instance).toEqual(mcp?.instance);
    expect(cli.machineId).toBe('machine-b');
    expect(cli.dispatchConfig.modelId).toBe('b');
    const options: CreateOptions = {};
    applyAgentRoleCreateTarget(options, cli);
    expect(options.agentRoleSnapshot).toEqual(
      snapshotAgentRole(role, getAgentRoleTargets(role)[1])
    );
    const pinned = await resolveAgentRoleCreateFromCatalog({
      auth,
      manager,
      workspaceId: 'workspace-id' as WorkspaceId,
      selector: role.id,
      prompt: 'Review',
      overrides: { machine: 'machine-a' },
    });
    expect(pinned.instance.id).toBe('instance-a');
    discoveryState.instances[0]!.availability = { state: 'unavailable', reason: 'machine_offline' };
    await expect(
      resolveAgentRoleCreateFromCatalog({
        auth,
        manager,
        workspaceId: 'workspace-id' as WorkspaceId,
        selector: role.id,
        prompt: 'Review',
        overrides: { machine: 'machine-a' },
      })
    ).rejects.toThrow('machine_unavailable');
    discoveryState.instances = [];
    discoveryState.projectMachineId = undefined;
  });
});

describe('applyAgentRoleCreateTarget', () => {
  it('replaces manual create flags and freezes Role provenance', () => {
    const role = agentRole({ promptPrefix: 'Act as a careful reviewer.' });
    const resolved = resolveAgentRoleCreate({ role, prompt: 'Review this.' });
    const options: CreateOptions = {
      machine: 'manual-machine',
      agent: 'manual-agent',
      agentConfig: 'manual-config',
      mode: 'manual-mode',
      model: 'manual-model',
      configOption: ['unknown=unadvertised'],
    };

    applyAgentRoleCreateTarget(options, resolved);

    expect(options.machine).toBe('remote-machine');
    expect(options.agentConfig).toBe('claude-opus');
    expect(options.agent).toBeUndefined();
    expect(options.mode).toBeUndefined();
    expect(options.model).toBeUndefined();
    expect(options.configOption).toEqual([]);
    expect(options.agentRoleId).toBe('reviewer');
    expect(options.agentRoleRevision).toBe(7);
    expect(options.agentRoleSnapshot).toEqual(
      snapshotAgentRole(role, getAgentRoleTargets(role)[0])
    );
  });

  it('keeps work-context flags untouched while replacing the target', () => {
    const resolved = resolveAgentRoleCreate({ role: agentRole(), prompt: 'Review this.' });
    const options: CreateOptions = {
      localProject: 'my-project',
      worktree: true,
      branch: 'feature/roles',
      machine: 'manual-machine',
      model: 'manual-model',
    };

    applyAgentRoleCreateTarget(options, resolved);

    expect(options.localProject).toBe('my-project');
    expect(options.worktree).toBe(true);
    expect(options.branch).toBe('feature/roles');
    expect(options.machine).toBe('remote-machine');
    expect(options.model).toBeUndefined();
  });
});

describe('a Role on several machines', () => {
  const both = agentRole({
    runConfig: { modelId: 'opus' },
    alias: 'Reviewer-Remote',
    additionalTargets: [
      {
        machineId: 'laptop' as MachineId,
        agentConfigId: 'codex' as AgentConfigId,
        runConfig: { modelId: 'gpt-5.6' },
        alias: 'Reviewer-Laptop',
      },
    ],
  });

  it('selects a target by alias or by id plus machine, and never picks one itself', () => {
    expect(selectAgentRoleTarget([both], 'Reviewer-Laptop')).toMatchObject({
      machineId: 'laptop',
      agentConfigId: 'codex',
    });
    expect(selectAgentRoleTarget([both], 'reviewer', { machineId: 'laptop' }).runConfig).toEqual({
      modelId: 'gpt-5.6',
    });
    expect(() => selectAgentRoleTarget([both], 'Reviewer')).toThrow(/machine_required/);
    expect(() => selectAgentRoleTarget([both], 'reviewer', { machineId: 'ci' })).toThrow(
      /machine_has_no_instance/
    );
  });

  it('lets --machine pick the target instead of reporting it as overridden', async () => {
    const { manager } = createRoleCatalogManager([
      both,
      agentRole({ id: 'solo' as AgentRoleId, name: 'Solo' }),
    ]);
    const picked = await resolveAgentRoleCreateFromCatalog({
      manager,
      auth: { machineId: 'caller', userId: 'user' } as never,
      workspaceId: 'workspace-id' as WorkspaceId,
      selector: 'reviewer',
      prompt: 'Review this.',
      overrides: { machine: 'laptop', model: 'manual' },
    });
    expect(picked).toMatchObject({ machineId: 'laptop', agentConfigId: 'codex' });
    expect(picked.dispatchConfig.modelId).toBe('gpt-5.6');
    expect(picked.ignoredOverrides).toEqual(['--model']);

    await expect(
      resolveAgentRoleCreateFromCatalog({
        manager,
        auth: { machineId: 'caller', userId: 'user' } as never,
        workspaceId: 'workspace-id' as WorkspaceId,
        selector: 'solo',
        prompt: 'Review.',
        overrides: { machine: 'laptop' },
      })
    ).rejects.toThrow('machine_has_no_instance');
  });

  it('rejects a readable name that also names another Role target alias', () => {
    const named = agentRole({ id: 'named' as AgentRoleId, name: 'Shared label' });
    const aliased = agentRole({
      id: 'aliased' as AgentRoleId,
      name: 'Other role',
      alias: 'Shared label',
    });
    expect(() => selectUniqueAgentRoleByIdOrName([named, aliased], 'Shared label')).toThrow(
      'ambiguous'
    );
    expect(selectAgentRoleTarget([named, aliased], 'named').id).toBe('named');
    expect(selectAgentRoleTarget([named, aliased], 'aliased:remote-machine').id).toBe('aliased');
  });

  it('resolves stable target ids and rejects bare aliases shared across machines', () => {
    const selected = selectAgentRoleTarget([both], 'reviewer:laptop');
    expect(selected).toMatchObject({ machineId: 'laptop', agentConfigId: 'codex' });
    const repeated = {
      ...both,
      alias: 'Same',
      additionalTargets: both.additionalTargets!.map((target) => ({ ...target, alias: 'Same' })),
    };
    expect(() => selectAgentRoleTarget([repeated], 'Same')).toThrow('ambiguous');
  });
});
