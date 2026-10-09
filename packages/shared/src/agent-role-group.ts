import { REGISTRY_ACP_AGENTS } from './acp/registry-generated';
import { resolveAgentBrandId } from './agent-brand';
import type { AgentRole, AgentRoleInstance } from './agent-role';
import { getBuiltinAgentByAgentType } from './ai';
import type { MachineId } from './ids';
import type { AgentConfigMeta } from './schema';

/**
 * Role instance groups.
 *
 * An instance the user gave an alias belongs to that alias's group; one
 * without an alias belongs to its agent family's. A group is one entry in
 * every Role list and one queue for a bare Role: its instances on different
 * machines stand in for each other. An alias is how a user says "these are the
 * same thing" for instances whose agents are configured differently, so an
 * aliased instance never joins the unaliased ones of its agent.
 */

/**
 * What grouping reads from an instance's Agent config. `env` only infers a
 * brand an older config did not record; a summary that resolved it passes
 * `brandId` alone.
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
  instance: Pick<AgentRoleInstance, 'alias' | 'agentConfigId'>,
  family: AgentRoleAgentFamily | undefined
): AgentRoleInstanceGroupId => {
  if (instance.alias) return { key: `alias:${instance.alias.toLowerCase()}`, name: instance.alias };
  if (!family) return { key: `config:${instance.agentConfigId}`, name: undefined };
  return { key: `agent:${family.key}`, name: family.name };
};

export type AgentRoleInstanceGroup = AgentRoleInstanceGroupId & {
  /** In list order. */
  instances: AgentRoleInstance[];
};

/** A Role's groups, in the order each first appears in its list. */
export const groupAgentRoleInstances = (
  role: Pick<AgentRole, 'instances'>,
  groupOf: (instance: AgentRoleInstance) => AgentRoleInstanceGroupId
): AgentRoleInstanceGroup[] => {
  const groups = new Map<string, AgentRoleInstanceGroup>();
  for (const instance of role.instances) {
    const id = groupOf(instance);
    const group = groups.get(id.key);
    if (group) group.instances.push(instance);
    else groups.set(id.key, { ...id, instances: [instance] });
  }
  return [...groups.values()];
};

/**
 * Two instances of one group on one machine, if any: a machine runs a group
 * through exactly one instance, so the second needs an alias of its own.
 */
export const findAgentRoleGroupClash = (
  instances: readonly AgentRoleInstance[],
  groupOf: (instance: AgentRoleInstance) => AgentRoleInstanceGroupId
):
  | {
      machineId: MachineId;
      name: string | undefined;
      instances: [AgentRoleInstance, AgentRoleInstance];
    }
  | undefined => {
  const seen = new Map<string, AgentRoleInstance>();
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
