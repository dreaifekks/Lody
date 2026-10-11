import {
  getBuiltinDefaultModeId,
  type AcpConfigOptionValue,
  type ScheduleProposalMeta,
} from './ai';
import {
  selectAgentRoleInstance,
  type AgentRole,
  type AgentRoleInstance,
  type CatalogAgentRole,
} from './agent-role';
import { getAgentRoleAgentFamily, getAgentRoleInstanceGroup } from './agent-role-group';
import type { AgentConfigId, MachineId } from './ids';
import type { AgentConfigMeta, SessionMeta } from './schema';
import type { ProjectRef } from './project';
import type {
  ScheduleAgentRoleRef,
  ScheduleDefinition,
  ScheduleDestination,
} from './schedule-types';
import { isSensitiveAcpConfigOptionId } from './session-preparation';

/** The Agent a schedule run is entrusted to; the machine follows from its config. */
type ProposalRunRef = Omit<ScheduleDefinition['agent'], 'agentConfigId'> & {
  agentConfigId: AgentConfigId;
};

/** What the resolver reads of an Agent config. */
export type ProposalTargetAgent = Pick<
  AgentConfigMeta,
  'id' | 'machineId' | 'name' | 'cliType' | 'agentType' | 'brandId'
> &
  Partial<Pick<AgentConfigMeta, 'env'>>;

/** What the conversation the proposal came from was running with. */
export type ProposalConversation = {
  session: SessionMeta;
  /** Effective run config of the conversation's latest user turn. */
  runConfig: {
    modeId?: string;
    modelId?: string;
    configOptionValues?: Record<string, AcpConfigOptionValue>;
  };
};

/**
 * Preserve the conversation/Role ACP value types while excluding credentials.
 */
function scheduleOptionValues(
  values: Record<string, AcpConfigOptionValue> | undefined
): ProposalRunRef['configOptionValues'] {
  if (!values) return undefined;
  const entries = Object.entries(values).filter(
    ([id, value]) => value !== undefined && value !== null && !isSensitiveAcpConfigOptionId(id)
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** The run config a Role instance gives a schedule. */
const scheduleAgentOfRoleInstance = (instance: AgentRoleInstance): ProposalRunRef => {
  const { memory, modeId, modelId } = instance.runConfig;
  const configOptionValues = scheduleOptionValues(instance.runConfig.configOptionValues);
  return {
    ...(memory ? { memory } : {}),
    agentConfigId: instance.agentConfigId,
    ...(modeId ? { modeId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(configOptionValues ? { configOptionValues } : {}),
  };
};

const roleInstanceGroup = (instance: AgentRoleInstance, agents: readonly ProposalTargetAgent[]) => {
  const agent = agents.find((entry) => entry.id === instance.agentConfigId);
  return getAgentRoleInstanceGroup(instance, agent && getAgentRoleAgentFamily(agent));
};

/** The shared dispatch rules over the Agents that exist: one on its own machine is usable. */
const selectRoleInstance = (
  role: Pick<AgentRole, 'instances'>,
  request: Parameters<typeof selectAgentRoleInstance>[1],
  agents: readonly ProposalTargetAgent[]
) =>
  selectAgentRoleInstance(
    role,
    request,
    (candidate) =>
      agents.some(
        (agent) => agent.id === candidate.agentConfigId && agent.machineId === candidate.machineId
      ),
    (candidate) => roleInstanceGroup(candidate, agents).key
  );

export type ScheduleAgentRoleProblem = 'role_not_found' | 'instance_unavailable';

/**
 * What a schedule's Role reference runs now, on the schedule's own machine: the
 * Role as the catalog holds it, and the named instance or else the first one
 * that can run there. Never an instance on another machine, and never the
 * config saved beside the reference: a Role that is gone, or has nothing to
 * run there, is a problem to report.
 */
export function resolveScheduleAgentRole<A extends ProposalTargetAgent>(args: {
  ref: ScheduleAgentRoleRef;
  machineId: string;
  roles: readonly AgentRole[];
  agents: readonly A[];
}):
  | {
      ok: true;
      role: AgentRole;
      instance: AgentRoleInstance;
      /** The instance's group name: its alias, else its agent's. */
      groupName?: string;
      agentConfig: A;
      agent: ProposalRunRef;
    }
  | { ok: false; problem: ScheduleAgentRoleProblem } {
  const role = args.roles.find((entry) => entry.id === args.ref.roleId);
  if (!role) return { ok: false, problem: 'role_not_found' };
  const choice = selectRoleInstance(
    role,
    { instanceId: args.ref.instanceId, machineId: args.machineId as MachineId },
    args.agents
  );
  if (choice.kind === 'rejected') return { ok: false, problem: 'instance_unavailable' };
  const { instance } = choice;
  const agentConfig = args.agents.find((entry) => entry.id === instance.agentConfigId)!;
  const groupName = roleInstanceGroup(instance, args.agents).name;
  return {
    ok: true,
    role,
    instance,
    ...(groupName ? { groupName } : {}),
    agentConfig,
    agent: scheduleAgentOfRoleInstance(instance),
  };
}

export type ResolvedProposalTarget<A extends ProposalTargetAgent = AgentConfigMeta> = {
  agent: ProposalRunRef;
  agentConfig: A;
  project: ProjectRef | null;
  destination: ScheduleDestination;
  /** Where each value came from, for the card to say so. */
  source: { agent: 'conversation' | 'role' | 'named'; project: 'conversation' | 'named' | 'none' };
  role?: AgentRole;
  /** The instance of `role` the schedule runs. */
  roleInstance?: AgentRoleInstance;
  /** The reference a schedule keeps to `role`; it names an instance only when one was named. */
  agentRole?: ScheduleAgentRoleRef;
};

export type ProposalTargetProblem =
  | 'role_not_found'
  | 'agent_not_found'
  | 'machine_mismatch'
  | 'no_agent'
  | 'role_with_chat';

/**
 * Turn a proposal's optional `target` into the concrete configuration a
 * schedule needs.
 *
 * The rule is the one the person agreed to: everything defaults to the
 * conversation the proposal was made in — the Agent, its permission mode, its
 * machine, its project — and a named Role, Agent, machine or project overrides
 * only that part. A Role brings its own pinned run config, so it also replaces
 * the mode. An Agent named without a Role gets the conversation's mode when it
 * is the same Agent, otherwise Lody's builtin default for that Agent; never an
 * elevated mode the person did not choose somewhere.
 *
 * A picked chat follows that chat's Agent, so a Role cannot be named with one.
 */
export function resolveScheduleProposalTarget<A extends ProposalTargetAgent>(args: {
  meta: Pick<ScheduleProposalMeta, 'target' | 'destination'>;
  conversation: ProposalConversation | null;
  agents: readonly A[];
  roles: readonly CatalogAgentRole[];
}):
  | { ok: true; target: ResolvedProposalTarget<A> }
  | { ok: false; problem: ProposalTargetProblem } {
  const { meta, conversation, agents, roles } = args;
  const named = meta.target ?? {};

  // The Role's instance follows the shared dispatch rules: the named instance,
  // else one on the named machine, else the first group with a known agent,
  // the conversation's machine first.
  let role: AgentRole | undefined;
  let instance: AgentRoleInstance | undefined;
  if (named.agentRoleId) {
    role = roles.find((entry) => entry.id === named.agentRoleId);
    if (!role) return { ok: false, problem: 'role_not_found' };
    if (meta.destination?.kind === 'existing_session')
      return { ok: false, problem: 'role_with_chat' };
    const choice = selectRoleInstance(
      role,
      {
        instanceId: named.agentRoleInstanceId,
        machineId: named.machineId as MachineId | undefined,
        callerMachineId: conversation?.session.machineId,
      },
      agents
    );
    if (choice.kind === 'rejected')
      return {
        ok: false,
        problem:
          choice.reason === 'instance_not_found'
            ? 'role_not_found'
            : choice.reason === 'machine_has_no_instance' ||
                choice.reason === 'instance_machine_mismatch'
              ? 'machine_mismatch'
              : 'agent_not_found',
      };
    instance = choice.instance;
  }

  const agentConfigId =
    instance?.agentConfigId ?? named.agentConfigId ?? conversation?.session.agentConfigId;
  if (!agentConfigId) return { ok: false, problem: 'no_agent' };
  const agentConfig = agents.find((entry) => entry.id === agentConfigId);
  if (!agentConfig) return { ok: false, problem: 'agent_not_found' };

  // A named machine is a constraint, not a lookup key: the Agent decides the
  // machine, so naming a different one is a contradiction to surface.
  const machineId = named.machineId ?? instance?.machineId;
  if (machineId && machineId !== agentConfig.machineId)
    return { ok: false, problem: 'machine_mismatch' };

  const sameAgentAsConversation = conversation?.session.agentConfigId === agentConfig.id;
  const runConfig = sameAgentAsConversation
    ? (conversation?.runConfig ?? {})
    : { modeId: getBuiltinDefaultModeId(agentConfig.cliType, agentConfig.agentType) };
  const configOptionValues = scheduleOptionValues(runConfig.configOptionValues);
  const agent: ProposalRunRef = instance
    ? scheduleAgentOfRoleInstance(instance)
    : {
        agentConfigId: agentConfig.id as AgentConfigId,
        ...(runConfig.modeId ? { modeId: runConfig.modeId } : {}),
        ...(runConfig.modelId ? { modelId: runConfig.modelId } : {}),
        ...(configOptionValues ? { configOptionValues } : {}),
      };

  const destination: ScheduleDestination =
    meta.destination?.kind === 'own_session'
      ? { kind: 'own_session', epoch: 0 }
      : meta.destination?.kind === 'existing_session'
        ? { kind: 'existing_session', sessionId: meta.destination.sessionId }
        : { kind: 'new_session' };

  // A shared chat carries its own workspace; only a fresh chat takes a project.
  const conversationProject =
    conversation?.session.project ??
    (conversation?.session.repoFullName
      ? ({
          kind: 'github',
          repoFullName: conversation.session.repoFullName,
          branch: conversation.session.baseBranch ?? 'main',
        } satisfies ProjectRef)
      : undefined);
  const project =
    destination.kind !== 'new_session' ? null : (named.project ?? conversationProject ?? null);

  return {
    ok: true,
    target: {
      agent,
      agentConfig,
      project,
      destination,
      role,
      ...(instance ? { roleInstance: instance } : {}),
      ...(role
        ? {
            agentRole: {
              roleId: role.id,
              ...(named.agentRoleInstanceId ? { instanceId: named.agentRoleInstanceId } : {}),
            },
          }
        : {}),
      source: {
        agent: role ? 'role' : named.agentConfigId ? 'named' : 'conversation',
        project:
          destination.kind !== 'new_session' || !project
            ? 'none'
            : named.project
              ? 'named'
              : 'conversation',
      },
    },
  };
}
