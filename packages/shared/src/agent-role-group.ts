import { REGISTRY_ACP_AGENTS } from './acp/registry-generated';
import { resolveAgentBrandId } from './agent-brand';
import type { AgentRoleTarget } from './agent-role';
import { getBuiltinAgentByAgentType } from './ai';
import type { MachineId } from './ids';
import type { AgentConfigMeta } from './schema';

/** Target identity keys for display and per-Role/per-machine uniqueness.
 * These keys never group dispatch candidates or authorize fallback.
 */
export type AgentRoleAgentConfig = Pick<
  AgentConfigMeta,
  'name' | 'cliType' | 'agentType' | 'brandId'
> &
  Partial<Pick<AgentConfigMeta, 'env'>>;

export type AgentRoleInstanceGroupId = {
  /** Unique per machine within a Role; equal keys are one group. */
  key: string;
  /** The alias, else the agent family's name; unknown while the config is. */
  name: string | undefined;
};

/**
 * The family an Agent config belongs to: its runtime plus the provider brand
 * it fronts, so a DeepSeek-over-Claude config is not Claude. A custom agent's
 * type is unique to its config, so it is a family of its own.
 */
export type AgentRoleAgentFamily = { key: string; name: string };

export const getAgentRoleAgentFamily = (config: AgentRoleAgentConfig): AgentRoleAgentFamily => {
  const brand = resolveAgentBrandId(config);
  const key = [config.cliType, config.agentType, brand].filter(Boolean).join(':');
  if (brand || config.cliType === 'custom') return { key, name: config.name };
  const name =
    config.cliType === 'builtin'
      ? getBuiltinAgentByAgentType(config.agentType)?.displayName
      : REGISTRY_ACP_AGENTS.find((agent) => agent.id === config.agentType)?.name;
  return { key, name: name ?? config.name };
};

/**
 * An instance's group, given its agent's family (`getAgentRoleAgentFamily`).
 * One whose Agent config is not known groups alone until it is.
 */
export const getAgentRoleInstanceGroup = (
  instance: Pick<AgentRoleTarget, 'alias' | 'agentConfigId'>,
  family: AgentRoleAgentFamily | undefined
): AgentRoleInstanceGroupId => {
  if (instance.alias) return { key: `alias:${instance.alias.toLowerCase()}`, name: instance.alias };
  if (!family) return { key: `config:${instance.agentConfigId}`, name: undefined };
  return { key: `agent:${family.key}`, name: family.name };
};

/**
 * Two instances of one group on one machine, if any: a machine runs a group
 * through exactly one instance, so the second needs an alias of its own.
 */
export const findAgentRoleGroupClash = (
  instances: readonly AgentRoleTarget[],
  groupOf: (instance: AgentRoleTarget) => AgentRoleInstanceGroupId
):
  | {
      machineId: MachineId;
      name: string | undefined;
      instances: [AgentRoleTarget, AgentRoleTarget];
    }
  | undefined => {
  const seen = new Map<string, AgentRoleTarget>();
  for (const instance of instances) {
    const group = groupOf(instance);
    const slot = `${instance.machineId}\u0000${group.key}`;
    const earlier = seen.get(slot);
    if (earlier)
      return { machineId: instance.machineId, name: group.name, instances: [earlier, instance] };
    seen.set(slot, instance);
  }
  return undefined;
};
