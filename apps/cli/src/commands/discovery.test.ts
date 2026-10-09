import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  withAgentRoleInstances,
  type AgentRole,
  type MachineId,
  type MachineMeta,
} from '@lody/shared';
import { ResourceDiscovery, type DiscoverySource } from '@/lib/resource-discovery';
import { discoveryListCommand, discoveryGetCommand } from './discovery';

const state = vi.hoisted(() => ({
  output: undefined as unknown,
  discovery: undefined as ResourceDiscovery | undefined,
  platform: 'cloud',
}));
vi.mock('@/lib/resource-discovery-runtime', () => ({
  createResourceDiscovery: async () => state.discovery,
}));
vi.mock('@/lib/cli-platform', () => ({ getCliPlatformKind: () => state.platform }));
// The daemon's terminal tools, answering from the same catalog and checking
// arguments against the tool schemas, as the daemon does.
vi.mock('@/lib/terminal-session-tools', () => ({
  resolveTerminalToolTarget: async () => ({ machineId: 'machine', workspaceId: 'workspace' }),
  callTerminalSessionTool: async (_target: unknown, name: string, args: object) => {
    const { ResourceListSchemas } = await import('@/lib/discovery-query');
    const match = /^lody_(.+)_(list|get)$/.exec(name);
    const discovery = state.discovery;
    if (!discovery || !match) throw new Error(`Unexpected tool ${name}`);
    const resource = match[1] as keyof typeof ResourceListSchemas;
    const input = JSON.parse(JSON.stringify(args)) as { id?: string };
    if (match[2] === 'list')
      return discovery.list(resource, ResourceListSchemas[resource].parse(input));
    if (resource !== 'agent_config' && resource !== 'agent_role') throw new Error(`No ${name}`);
    return discovery.get(resource, String(input.id));
  },
}));
vi.mock('@/lib/command-runtime', () => ({
  getAuthContextOrThrow: () => {
    if (state.platform === 'local') throw new Error('Local discovery read a cloud login');
    return { userId: 'user' };
  },
  resolveWorkspaceOrThrow: async () => ({ id: 'workspace' }),
  withWorkspaceManager: async (
    _auth: unknown,
    _workspace: unknown,
    _name: string,
    read: (manager: object) => Promise<void>
  ) => read({}),
  runOneShotCommand: async (_name: string, _options: unknown, read: () => Promise<void>) => read(),
  printJson: (output: unknown) => {
    state.output = output;
  },
}));
afterEach(() => {
  state.output = undefined;
  state.discovery = undefined;
  state.platform = 'cloud';
});

function fixture(): ResourceDiscovery {
  const source: DiscoverySource = {
    workspaceId: 'workspace',
    userId: 'user',
    machines: async () => [{ id: 'machine', name: 'Workstation' } as MachineMeta],
    canAccess: async () => true,
    onlineMachineIds: async () => new Set(['machine'] as MachineId[]),
    configs: async () => [],
    capabilities: async () => ({}),
    projects: async () => [],
    repositories: async () => [],
    mcpServers: async () => [],
    roles: async () =>
      Array.from({ length: 25 }, (_, n) =>
        withAgentRoleInstances(
          {
            v: 1,
            id: `role-${n}`,
            name: `Role ${n}`,
            visibility: 'workspace',
            ownerUserId: 'user',
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
          } as AgentRole,
          [
            {
              id: `role-${n}:machine` as AgentRole['instances'][number]['id'],
              label: 'Default',
              machineId: 'machine' as MachineId,
              agentConfigId: 'missing' as AgentRole['agentConfigId'],
              runConfig: {},
            },
          ]
        )
      ),
  };
  return new ResourceDiscovery(source);
}

describe('CLI discovery boundary', () => {
  it('uses the shared Role query, machine name resolution and all-pages traversal', async () => {
    state.discovery = fixture();
    await discoveryListCommand('agent_role').parseAsync(
      ['--json', '--machine', 'Workstation', '--all-pages', '--limit', '10'],
      { from: 'user' }
    );
    expect(state.output).toMatchObject({ ok: true, hasMore: false, workspaceId: 'workspace' });
    const output = state.output as { items: Array<{ id: string; availability: unknown }> };
    expect(output.items).toHaveLength(25);
    expect(new Set(output.items.map((row) => row.id)).size).toBe(25);
    expect(output.items[0]?.availability).toEqual({
      state: 'unavailable',
      reason: 'agent_config_missing',
    });
  });

  it('returns the same detail as MCP', async () => {
    const discovery = fixture();
    state.discovery = discovery;
    await discoveryGetCommand('agent_role').parseAsync(['role-1', '--json'], { from: 'user' });
    expect(state.output).toEqual(await discovery.get('agent_role', 'role-1'));
  });

  it.each(['NaN', '0', '-1', '1.5', '101'])(
    'rejects invalid page size %s without producing a result',
    async (limit) => {
      state.discovery = fixture();
      await expect(
        discoveryListCommand('agent_role').parseAsync(['--json', '--limit', limit], {
          from: 'user',
        })
      ).rejects.toThrow();
      expect(state.output).toBeUndefined();
    }
  );

  it('normalizes query text and allows a different page size on continuation', async () => {
    state.discovery = fixture();
    await discoveryListCommand('agent_role').parseAsync(
      ['--json', '--query', '  ROLE 1  ', '--limit', '1'],
      { from: 'user' }
    );
    const first = state.output as { items: Array<{ id: string }>; nextCursor: string };
    expect(first.items.map((row) => row.id)).toEqual(['role-1']);
    await discoveryListCommand('agent_role').parseAsync(
      ['--json', '--query', 'ROLE 1', '--cursor', first.nextCursor, '--limit', '2'],
      { from: 'user' }
    );
    expect(state.output).toMatchObject({ items: [{ id: 'role-10' }, { id: 'role-11' }] });
  });

  it('reads the local catalog through the daemon, never a cloud login', async () => {
    state.platform = 'local';
    state.discovery = fixture();
    await discoveryListCommand('agent_role').parseAsync(
      ['--json', '--machine', 'Workstation', '--all-pages', '--limit', '10'],
      { from: 'user' }
    );
    const output = state.output as { items: Array<{ id: string }>; roles: unknown[] };
    expect(output.items).toHaveLength(25);
    expect(output.roles).toEqual(output.items);
    await expect(
      discoveryListCommand('agent_role').parseAsync(['--json', '--machine', 'Elsewhere'], {
        from: 'user',
      })
    ).rejects.toThrow('Machine not found: Elsewhere');

    const discovery = fixture();
    state.discovery = discovery;
    await discoveryGetCommand('agent_role').parseAsync(['role-1', '--json'], { from: 'user' });
    expect(state.output).toEqual(await discovery.get('agent_role', 'role-1'));
  });
});
