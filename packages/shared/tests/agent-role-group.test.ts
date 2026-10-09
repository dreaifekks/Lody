import { describe, expect, it } from 'vitest';

import type { AgentRoleInstance } from '../src/agent-role';
import {
  findAgentRoleGroupClash,
  getAgentRoleAgentFamily,
  getAgentRoleInstanceGroup,
  groupAgentRoleInstances,
  type AgentRoleAgentConfig,
} from '../src/agent-role-group';
import type { AgentConfigId, AgentRoleInstanceId, MachineId } from '../src/ids';

const configs: Record<string, AgentRoleAgentConfig> = {
  'claude-devnuc': { name: 'Claude (Opus)', cliType: 'builtin', agentType: 'claude', env: {} },
  'claude-n100': { name: 'Claude', cliType: 'builtin', agentType: 'claude', env: {} },
  'deepseek-n100': {
    name: 'DeepSeek',
    cliType: 'builtin',
    agentType: 'claude',
    brandId: 'deepseek',
    env: {},
  },
  'gemini-devnuc': { name: 'Gemini', cliType: 'builtin', agentType: 'gemini', env: {} },
  'custom-devnuc': { name: 'My agent', cliType: 'custom', agentType: 'custom-1', env: {} },
};

const instance = (
  id: string,
  machine: string,
  agentConfigId: string,
  alias?: string
): AgentRoleInstance => ({
  id: id as AgentRoleInstanceId,
  ...(alias ? { alias } : {}),
  machineId: machine as MachineId,
  agentConfigId: agentConfigId as AgentConfigId,
  runConfig: {},
});

const groupOf = (entry: AgentRoleInstance) => {
  const config = configs[entry.agentConfigId];
  return getAgentRoleInstanceGroup(entry, config && getAgentRoleAgentFamily(config));
};

describe('agent role instance groups', () => {
  it('names an agent family by its runtime, apart from a brand it fronts', () => {
    expect(getAgentRoleAgentFamily(configs['claude-devnuc']!)).toEqual({
      key: 'builtin:claude',
      name: 'Claude Code',
    });
    // Claude Code driving DeepSeek is not Claude.
    expect(getAgentRoleAgentFamily(configs['deepseek-n100']!)).toEqual({
      key: 'builtin:claude:deepseek',
      name: 'DeepSeek',
    });
    expect(getAgentRoleAgentFamily(configs['custom-devnuc']!)).toEqual({
      key: 'custom:custom-1',
      name: 'My agent',
    });
  });

  it('merges unaliased instances of one family across machines, whatever the config is called', () => {
    const groups = groupAgentRoleInstances(
      {
        instances: [
          instance('a', 'devnuc', 'claude-devnuc'),
          instance('b', 'n100', 'deepseek-n100'),
          instance('c', 'n100', 'claude-n100'),
        ],
      },
      groupOf
    );
    expect(groups.map((group) => [group.name, group.instances.map((entry) => entry.id)])).toEqual([
      ['Claude Code', ['a', 'c']],
      ['DeepSeek', ['b']],
    ]);
  });

  it('keeps an aliased instance apart from its agent, and merges one alias across machines', () => {
    const groups = groupAgentRoleInstances(
      {
        instances: [
          instance('plain', 'devnuc', 'claude-devnuc'),
          instance('strict-devnuc', 'devnuc', 'gemini-devnuc', 'Strict'),
          instance('strict-n100', 'n100', 'claude-n100', 'strict'),
        ],
      },
      groupOf
    );
    expect(groups.map((group) => [group.name, group.instances.map((entry) => entry.id)])).toEqual([
      ['Claude Code', ['plain']],
      // Aliases match regardless of case, even over different agents.
      ['Strict', ['strict-devnuc', 'strict-n100']],
    ]);
  });

  it('groups an instance whose agent is not known alone, with no name yet', () => {
    expect(getAgentRoleInstanceGroup(instance('x', 'mac', 'gone'), undefined)).toEqual({
      key: 'config:gone',
      name: undefined,
    });
  });

  it('finds two instances of one group on one machine', () => {
    const clash = findAgentRoleGroupClash(
      [
        instance('a', 'devnuc', 'claude-devnuc'),
        instance('b', 'n100', 'claude-n100'),
        instance('c', 'devnuc', 'claude-devnuc'),
      ],
      groupOf
    );
    expect(clash).toMatchObject({ machineId: 'devnuc', name: 'Claude Code' });
    expect(clash?.instances.map((entry) => entry.id)).toEqual(['a', 'c']);
    expect(
      findAgentRoleGroupClash(
        [
          instance('a', 'devnuc', 'claude-devnuc'),
          instance('c', 'devnuc', 'claude-devnuc', 'Second'),
        ],
        groupOf
      )
    ).toBeUndefined();
  });
});
