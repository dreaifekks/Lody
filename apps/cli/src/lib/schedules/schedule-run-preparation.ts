import {
  composeAgentRolePrompt,
  getWorkspaceFlockDocId,
  listAccessibleAgentRoles,
  listWorkspaceAgentRoles,
  readWorkspaceFlockRowsFromFlock,
  resolveScheduleAgentRole,
  scheduleOwnSessionId,
  snapshotAgentRole,
  normalizeLegacyScheduleAgent,
  type AgentRole,
  type AgentRoleInstance,
  type ScheduleAgentRoleRef,
  type ScheduleDefinition,
  type WorkspaceId,
  type AgentConfigMeta,
  type LocalProjectId,
  type MachineMeta,
  type ProjectRef,
  type ScheduleDestination,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';

import { ScheduleConfigurationError } from './schedule-engine';
import { buildProjectOptions } from './schedule-project-options';

/**
 * The two decisions that turn a Schedule definition into one Session's inputs:
 * which selectors describe its workspace, and which target owns it.
 *
 * They are pure and separate from `schedule-workspace.ts` because this is where
 * "no project" has to hold: a chat-only schedule must reach `prepareSessionInput`
 * with no repository, local project, branch or worktree selector at all, and
 * with no `project` on the target — not with a default filled in behind it.
 */
export type ScheduleRunIdentity = {
  sessionId: SessionId;
  userTurnId: string;
  agentConfigId: string;
  title: string;
  project?: ProjectRef;
  /** The Role this run resolved, recorded on the Session and its Turn as provenance. */
  role?: ScheduleRunRole;
};

/** A Role as one run resolved it: the Role then, and its instance on this machine. */
export type ScheduleRunRole = {
  role: AgentRole;
  instance: AgentRoleInstance;
  /** The instance's group name: its alias, else its agent's. */
  groupName?: string;
};

/**
 * The prompt a run sends. A Role's instruction belongs to the first Turn of a
 * chat it creates, so only the run that creates the chat carries it; a later
 * run into the same chat takes the Role's run config alone.
 */
export function buildScheduleRunPrompt(args: {
  prompt: string;
  role?: ScheduleRunRole;
  createsSession: boolean;
}): string {
  return args.role && args.createsSession
    ? composeAgentRolePrompt(args.role.role.promptPrefix, args.prompt)
    : args.prompt;
}

export function buildScheduleSessionCreateOptions(
  run: ScheduleRunIdentity
): Record<string, unknown> {
  return {
    agentConfig: run.agentConfigId,
    sessionId: run.sessionId,
    userTurnId: run.userTurnId,
    title: run.title,
    // The Schedule engine has already refreshed workspace meta for this run.
    workspaceMetaPrewriteSatisfied: true,
    ...buildProjectOptions(run.project),
    ...(run.role
      ? {
          agentRoleId: run.role.role.id,
          agentRoleRevision: run.role.role.revision,
          agentRoleSnapshot: snapshotAgentRole(run.role.role, {
            id: run.role.instance.id,
            label: run.role.groupName,
          }),
        }
      : {}),
  };
}

export function buildScheduleRunTarget(target: {
  targetMachine: MachineMeta;
  agentConfig: AgentConfigMeta;
  project?: ProjectRef;
}): { targetMachine: MachineMeta; agentConfig: AgentConfigMeta; project?: ProjectRef } {
  return {
    targetMachine: target.targetMachine,
    agentConfig: target.agentConfig,
    ...(target.project ? { project: target.project } : {}),
  };
}

/**
 * The local project id a run requires on its owning machine before handoff, or
 * `undefined` when there is nothing to look up.
 */
export function scheduleRequiredLocalProjectId(
  project: ProjectRef | undefined
): LocalProjectId | undefined {
  return project?.kind === 'local' ? project.localProjectId : undefined;
}

/** The chat a destination sends into, or `undefined` for a fresh chat per run. */
export function scheduleDestinationSessionId(
  scheduleId: string,
  destination: ScheduleDestination
): SessionId | undefined {
  if (destination.kind === 'own_session')
    return scheduleOwnSessionId(scheduleId, destination.epoch);
  if (destination.kind === 'existing_session') return destination.sessionId as SessionId;
  return undefined;
}

export type DestinationSessionState =
  | { kind: 'absent' }
  | { kind: 'deleted' }
  | { kind: 'present'; meta: SessionMeta };

/**
 * Why a shared chat cannot take this schedule's runs, or `null` when it can.
 *
 * A chat the person picked must exist; a chat the schedule owns may not exist
 * yet (it is created by the first run). Either way, once it exists it must be
 * this owner's, on this machine, driven by this schedule's Agent — those are
 * exactly the fields `materializePreparedSessionInput` refuses to change, so
 * checking them here turns a late identity conflict into a named, recoverable
 * configuration problem.
 */
export function destinationSessionProblem(args: {
  destination: ScheduleDestination;
  session: DestinationSessionState;
  userId: string;
  machineId: string;
  agentConfigId: string;
}): 'SESSION_UNAVAILABLE' | null {
  const { destination, session } = args;
  if (destination.kind === 'new_session') return null;
  if (session.kind === 'deleted') return 'SESSION_UNAVAILABLE';
  if (session.kind === 'absent')
    return destination.kind === 'existing_session' ? 'SESSION_UNAVAILABLE' : null;
  const meta = session.meta;
  return meta.userId === args.userId &&
    meta.machineId === args.machineId &&
    meta.agentConfigId === args.agentConfigId
    ? null
    : 'SESSION_UNAVAILABLE';
}

/**
 * What a Schedule's Role reference resolves to on its machine, from the catalog
 * and Agent configs as this daemon holds them now. Callers that need them
 * current sync first. Only a Role the owner can read counts.
 */
export async function readScheduleAgentRole(args: {
  manager: import('../loro/doc').LoroDocumentManager;
  workspaceId: WorkspaceId;
  machineId: MachineMeta['id'];
  userId: string;
  ref: ScheduleAgentRoleRef;
}): Promise<ReturnType<typeof resolveScheduleAgentRole<AgentConfigMeta>>> {
  const { manager, workspaceId, machineId, ref } = args;
  const { readMergedAgentConfigById } = await import('../agent-config-machine-flock');
  const catalog = await manager.repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId));
  const roles = listAccessibleAgentRoles(
    listWorkspaceAgentRoles(readWorkspaceFlockRowsFromFlock(catalog.flock)),
    args.userId
  ).filter((role) => role.id === ref.roleId);
  // Only the Role's own Agents on this machine can run it: read those, by id.
  const agents: AgentConfigMeta[] = [];
  for (const agentConfigId of new Set(
    roles.flatMap((role) =>
      role.instances
        .filter((instance) => instance.machineId === machineId)
        .map((instance) => instance.agentConfigId)
    )
  )) {
    const { config } = await readMergedAgentConfigById(
      manager.repo,
      workspaceId,
      machineId,
      agentConfigId
    );
    if (config) agents.push(config);
  }
  return resolveScheduleAgentRole({ ref, machineId, roles, agents });
}

/**
 * The Role one run resolves, or `undefined` for a Schedule without one. A Role
 * that is gone, or has no instance to run on this machine, blocks the run under
 * its own code; the Agent saved beside the reference is never run instead.
 */
export async function resolveScheduleRunRole(
  args: Omit<Parameters<typeof readScheduleAgentRole>[0], 'ref'> & {
    ref: ScheduleAgentRoleRef | undefined;
  }
) {
  const { ref } = args;
  if (!ref) return undefined;
  const resolved = await readScheduleAgentRole({ ...args, ref });
  if (!resolved.ok)
    throw new ScheduleConfigurationError(
      resolved.problem === 'role_not_found' ? 'ROLE_NOT_FOUND' : 'ROLE_INSTANCE_UNAVAILABLE'
    );
  return resolved;
}

/** Adapt legacy persisted values only at the Schedule-to-Session boundary. */
export async function resolveScheduleAgentRunConfig(
  manager: import('../loro/doc').LoroDocumentManager,
  workspaceId: WorkspaceId,
  machineId: MachineMeta['id'],
  agent: ScheduleDefinition['agent']
): Promise<ScheduleDefinition['agent']> {
  if (!agent.configOptionValues) return agent;
  const { readAgentAcpCapability } = await import('@/commands/session');
  const capability = await readAgentAcpCapability({
    manager,
    workspaceId,
    machineId,
    agentConfigId: agent.agentConfigId as AgentConfigMeta['id'],
    localOnly: true,
  });
  return normalizeLegacyScheduleAgent(agent, capability?.configOptions);
}
