import {
  getBuiltinDefaultModeId,
  type AcpConfigOptionValue,
  type ScheduleProposalMeta,
} from './ai';
import { agentRoleOnMachine, selectAgentRolePlacement, type AgentRole } from './agent-role';
import type { AgentConfigId, MachineId } from './ids';
import type { AgentConfigMeta, SessionMeta } from './schema';
import type { ProjectRef } from './project';
import type { ScheduleDefinition, ScheduleDestination } from './schedule-types';
import { isSensitiveAcpConfigOptionId } from './session-preparation';

/** The Agent a schedule run is entrusted to; the machine follows from its config. */
type ProposalRunRef = Omit<ScheduleDefinition['agent'], 'agentConfigId'> & {
  agentConfigId: AgentConfigId;
};

/** What the resolver reads of an Agent config. */
export type ProposalTargetAgent = Pick<
  AgentConfigMeta,
  'id' | 'machineId' | 'cliType' | 'agentType'
>;

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

export type ResolvedProposalTarget<A extends ProposalTargetAgent = AgentConfigMeta> = {
  agent: ProposalRunRef;
  agentConfig: A;
  project: ProjectRef | null;
  destination: ScheduleDestination;
  /** Where each value came from, for the card to say so. */
  source: { agent: 'conversation' | 'role' | 'named'; project: 'conversation' | 'named' | 'none' };
  role?: AgentRole;
};

export type ProposalTargetProblem =
  | 'role_not_found'
  | 'agent_not_found'
  | 'machine_mismatch'
  | 'no_agent';

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
 */
export function resolveScheduleProposalTarget<A extends ProposalTargetAgent>(args: {
  meta: Pick<ScheduleProposalMeta, 'target' | 'destination'>;
  conversation: ProposalConversation | null;
  agents: readonly A[];
  roles: readonly AgentRole[];
}):
  | { ok: true; target: ResolvedProposalTarget<A> }
  | { ok: false; problem: ProposalTargetProblem } {
  const { meta, conversation, agents, roles } = args;
  const named = meta.target ?? {};

  // The Role's machine follows the shared dispatch rules: the named machine,
  // else the conversation's, else the first enabled one whose agent is known.
  // `role` is then that machine's view of the Role.
  let role: AgentRole | undefined;
  if (named.agentRoleId) {
    const catalogRole = roles.find((entry) => entry.id === named.agentRoleId);
    if (!catalogRole) return { ok: false, problem: 'role_not_found' };
    const choice = selectAgentRolePlacement(
      catalogRole,
      {
        machineId: named.machineId as MachineId | undefined,
        callerMachineId: conversation?.session.machineId,
      },
      (placement) =>
        agents.some(
          (agent) => agent.id === placement.agentConfigId && agent.machineId === placement.machineId
        )
    );
    if (choice.kind === 'rejected')
      return {
        ok: false,
        problem: choice.reason === 'machine_not_enabled' ? 'machine_mismatch' : 'agent_not_found',
      };
    role = agentRoleOnMachine(catalogRole, choice.placement.machineId);
  }

  const agentConfigId =
    role?.agentConfigId ?? named.agentConfigId ?? conversation?.session.agentConfigId;
  if (!agentConfigId) return { ok: false, problem: 'no_agent' };
  const agentConfig = agents.find((entry) => entry.id === agentConfigId);
  if (!agentConfig) return { ok: false, problem: 'agent_not_found' };

  // A named machine is a constraint, not a lookup key: the Agent decides the
  // machine, so naming a different one is a contradiction to surface.
  const machineId = named.machineId ?? role?.machineId;
  if (machineId && machineId !== agentConfig.machineId)
    return { ok: false, problem: 'machine_mismatch' };

  const sameAgentAsConversation = conversation?.session.agentConfigId === agentConfig.id;
  const runConfig = role
    ? {
        modeId: role.runConfig.modeId,
        modelId: role.runConfig.modelId,
        configOptionValues: role.runConfig.configOptionValues,
      }
    : sameAgentAsConversation
      ? (conversation?.runConfig ?? {})
      : { modeId: getBuiltinDefaultModeId(agentConfig.cliType, agentConfig.agentType) };

  const configOptionValues = scheduleOptionValues(runConfig.configOptionValues);
  const agent: ProposalRunRef = {
    memory: role?.runConfig.memory,
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
