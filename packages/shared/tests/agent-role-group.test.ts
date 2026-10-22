import { describe, expect, it } from 'vitest';

import type { AgentRoleTarget } from '../src/agent-role';
import {
  findAgentRoleGroupClash,
  getAgentRoleAgentFamily,
  getAgentRoleInstanceGroup,
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
): AgentRoleTarget => ({
  id: id as AgentRoleInstanceId,
  ...(alias ? { alias } : {}),
  machineId: machine as MachineId,
  agentConfigId: agentConfigId as AgentConfigId,
  runConfig: {},
});

const groupOf = (entry: AgentRoleTarget) => {
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

  it('permits different unaliased families on one machine and repeated aliases across machines', () => {
    expect(
      findAgentRoleGroupClash(
        [
          instance('a', 'one', 'claude-devnuc'),
          instance('b', 'one', 'gemini-devnuc'),
          instance('c', 'one', 'deepseek-n100', 'Review'),
          instance('d', 'two', 'claude-n100', 'Review'),
        ],
        groupOf
      )
    ).toBeUndefined();
    expect(
      findAgentRoleGroupClash(
        [
          instance('a', 'one', 'claude-devnuc', 'Review'),
          instance('b', 'one', 'gemini-devnuc', 'review'),
        ],
        groupOf
      )
    ).toMatchObject({ machineId: 'one' });
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
