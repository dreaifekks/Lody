import {
  DEFAULT_SCHEDULE_DESTINATION,
  getMachineRoomId,
  getMachineFlockDocId,
  getMachineFlockLocalProjects,
  getScheduleRegistryFlockDocId,
  getScheduleRoomId,
  getServerNow,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  higherPermissionTier,
  isPermissionTierWithin,
  machineSupportsSchedulesProtocol,
  normalizeSessionTurnInputConfig,
  ScheduleRuntimeRowSchema,
  previewSchedule,
  readMachineFlockRowsFromFlock,
  ScheduleCommandSchema,
  ScheduleRepository,
  scheduleProposalRuleToTrigger,
  validateSchedulePrompt,
  type AgentConfigId,
  type MachineId,
  type MachineMeta,
  type PermissionTierRunConfig,
  type ResolvedPermissionTier,
  type ScheduleCommand,
  type ScheduleDefinition,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import {
  syncFlockDocForRead,
  syncWorkspaceMetaForRead,
  type AuthContext,
} from '../command-runtime';
import type { LoroDocumentManager } from '../loro/doc';
import type { WorkspaceSummary } from '../workspace';
import { createSessionBackend } from '@/session/session-backend';
import { readMergedAgentConfigById } from '../agent-config-machine-flock';
import { readAgentRunConfigTier } from '../agent-permission-tier';
import { publishScheduleProposal } from './schedule-proposal';
import {
  destinationSessionProblem,
  scheduleDestinationSessionId,
} from './schedule-run-preparation';

export type ScheduleCommandContext = {
  manager: LoroDocumentManager;
  workspace: WorkspaceSummary;
  auth: AuthContext;
  localOnly: boolean;
  /**
   * Whether a hosted backend answers machine access. A LAN member syncs
   * through its hub (`localOnly` false) yet has no such backend: the ownership,
   * Agent and Project checks here are its whole gate.
   */
  hostedAccess: boolean;
  requesterSessionId?: SessionId;
  /**
   * The invoking Agent Session's permission tier. With it the Agent may also
   * create, edit and resume, but only Schedules that run within that tier.
   */
  requesterPermissionTier?: ResolvedPermissionTier;
};

const AGENT_NOTICES = {
  create: 'Created',
  edit: 'Changed',
  pause: 'Paused',
  resume: 'Resumed',
} as const;

/** Same domain operations for human CLI and the bounded MCP surface, on either transport. */
export async function executeScheduleCommand(
  context: ScheduleCommandContext,
  input: ScheduleCommand
): Promise<unknown> {
  const command = ScheduleCommandSchema.parse(input);
  const { manager, auth, localOnly, requesterSessionId } = context;
  const workspaceId = context.workspace.id as WorkspaceId;
  const repository = new ScheduleRepository(manager.repo, workspaceId);
  const sync = async (room: string) => {
    if (!localOnly) await manager.syncDocOrThrow(room, { reason: 'schedule:command' });
  };
  /**
   * What an existing chat runs with now: its latest Turn's config, and what its
   * runtime last reported, whichever is higher. A chat not created yet keeps
   * nothing, so it adds no tier.
   */
  const readSessionTier = async (sessionId: SessionId): Promise<ResolvedPermissionTier> => {
    await sync(getSessionRoomId(sessionId));
    const record = await manager.repo.getDocMeta(getSessionRoomId(sessionId));
    const meta = record?.meta as SessionMeta | undefined;
    if (!meta || isLoroRepoDocDeleted(record!)) return 'ask';
    if (!meta.agentConfigId) return 'unknown';
    const session = await manager.getOrCreateSessionDoc(sessionId);
    const latest = meta.latestUserMsgId
      ? await (await createSessionBackend(session, meta)).readTurn(meta.latestUserMsgId)
      : undefined;
    const latestConfig =
      (latest?.state === 'ready' ? normalizeSessionTurnInputConfig(latest.turn.inputConfig) : {}) ??
      {};
    const reported = (await session.getDocState())?.acpRuntimeConfig;
    const tierOfSession = (runConfig: PermissionTierRunConfig) =>
      readAgentRunConfigTier({
        manager,
        workspaceId,
        machineId: meta.machineId as MachineId,
        agentConfigId: meta.agentConfigId as AgentConfigId,
        runConfig,
        localOnly,
      });
    const dispatched = await tierOfSession({
      modeId: latestConfig.modeId,
      configOptionValues: latestConfig.configOptionValues,
    });
    if (!reported) return dispatched;
    return higherPermissionTier(
      dispatched,
      await tierOfSession({
        modeId: reported.modeId ?? latestConfig.modeId,
        configOptionValues: {
          ...latestConfig.configOptionValues,
          ...(reported.configOptionValues ?? {}),
        },
      })
    );
  };
  const requesterPermissionTier = context.requesterPermissionTier;
  if (requesterSessionId) {
    const agentWrite =
      requesterPermissionTier !== undefined &&
      ['create', 'edit', 'resume'].includes(command.action);
    if (!agentWrite && !['list', 'show', 'pause', 'propose'].includes(command.action))
      throw new Error('Schedule enablement requires a human action');
    const record = await manager.repo.getDocMeta(getSessionRoomId(requesterSessionId));
    const meta = record?.meta as SessionMeta | undefined;
    if (
      !meta ||
      isLoroRepoDocDeleted(record!) ||
      meta.userId !== auth.userId ||
      meta.machineId !== auth.machineId
    )
      throw new Error('Schedule tools require the invoking Session owner');
    // Proposal and pause notices are idempotent by entry id; read them from a
    // synced Session so a repeated call sees the notice it already published.
    const session = await manager.getOrCreateSessionDoc(requesterSessionId);
    await sync(session.roomId);
  }
  const registry = await manager.repo.openFlockDoc(getScheduleRegistryFlockDocId(workspaceId));
  if (!localOnly) await registry.syncOnce();
  if (command.action === 'list') {
    const rows = (await repository.list()).filter(
      (row) => !command.query || row.title.toLowerCase().includes(command.query.toLowerCase())
    );
    rows.sort((a, b) => a.scheduleId.localeCompare(b.scheduleId));
    const offset = command.offset ?? 0;
    const nextOffset = offset + command.limit;
    return {
      schedules: rows.slice(offset, nextOffset),
      matched: rows.length,
      nextOffset: nextOffset < rows.length ? nextOffset : undefined,
    };
  }
  if (command.action === 'propose') {
    if (!requesterSessionId) throw new Error('A proposal requires an invoking Session');
    // The rule must already be a schedule the editor could show, so a card the
    // person confirms cannot fail validation afterwards.
    scheduleProposalRuleToTrigger(command.rule, getServerNow());
    validateSchedulePrompt(command.prompt);
    const session = await manager.getOrCreateSessionDoc(requesterSessionId);
    const sessionRecord = await manager.repo.getDocMeta(getSessionRoomId(requesterSessionId));
    const sessionMeta = sessionRecord?.meta as SessionMeta | undefined;
    const backend = await createSessionBackend(session, sessionMeta);
    const actorConfig = sessionMeta?.agentConfigId
      ? await readMergedAgentConfigById(
          manager.repo,
          workspaceId,
          auth.machineId as MachineId,
          sessionMeta.agentConfigId as AgentConfigId
        ).catch(() => undefined)
      : undefined;
    const outcome = await publishScheduleProposal(
      backend,
      {
        proposalId: command.requestId,
        title: command.title,
        prompt: command.prompt,
        rule: command.rule,
        ...(command.destination ? { destination: command.destination } : {}),
        ...(command.target ? { target: command.target } : {}),
      },
      {
        ...(sessionMeta?.agentConfigId ? { agentConfigId: sessionMeta.agentConfigId } : {}),
        ...(actorConfig?.config?.name ? { name: actorConfig.config.name } : {}),
      }
    );
    await manager.repo.flush();
    if (!localOnly && (!(await backend.waitUntilSynced()) || !(await session.waitUntilSynced())))
      throw new Error('Proposal saved locally; sync pending. Retry with the same requestId.');
    return { ok: true, requestId: command.requestId, enabled: false, ...outcome };
  }
  const id = command.scheduleId;
  if (command.action !== 'create' || (await repository.list()).some((row) => row.scheduleId === id))
    await sync(getScheduleRoomId(id));
  if (command.action === 'show') {
    if (!(await repository.list()).some((row) => row.scheduleId === id))
      throw new Error('Schedule not found');
    const document = await repository.read(id);
    if (!document) throw new Error('Schedule not found');
    const runtimes = [...registry.flock.scan({ prefix: ['runtime', id] })].flatMap((row) => {
      const parsed = ScheduleRuntimeRowSchema.safeParse(row.value);
      return parsed.success ? [parsed.data] : [];
    });
    return {
      runtimes,
      schedule: {
        ...document,
        prompt: requesterSessionId ? document.prompt.slice(0, 8000) : document.prompt,
        timeline: document.timeline.slice(-20),
      },
      truncated: {
        promptCharsOmitted: requesterSessionId ? Math.max(0, document.prompt.length - 8000) : 0,
        timelineEntriesOmitted: Math.max(0, document.timeline.length - 20),
      },
      next: previewSchedule(
        document.definition.trigger,
        document.definition.activeFrom,
        getServerNow()
      ),
    };
  }
  const machineId =
    command.action === 'create' || command.action === 'edit'
      ? command.draft.machineId
      : (await repository.read(id))?.definition.machineId;
  if (!machineId) throw new Error('Schedule not found');
  const needsTarget = command.action !== 'pause' && command.action !== 'delete';
  if (needsTarget && !localOnly) {
    // The target machine's record, Agents and Projects are its documents; read them current.
    await syncWorkspaceMetaForRead(manager, 'schedule:command:prewrite');
    if (command.action === 'create' || command.action === 'edit')
      await syncFlockDocForRead(
        manager,
        getMachineFlockDocId(workspaceId, machineId as MachineId),
        'schedule:command:prewrite'
      );
  }
  const machineRecord = await manager.repo.getDocMeta(getMachineRoomId(machineId as MachineId));
  const machine = machineRecord?.meta as MachineMeta | undefined;
  if (
    needsTarget &&
    (!machine || isLoroRepoDocDeleted(machineRecord!) || machine.ownerUserId !== auth.userId)
  )
    throw new Error('Schedules can run only on a machine owned by the creator');
  if (needsTarget && !machineSupportsSchedulesProtocol(machine))
    throw new Error('Update the target machine CLI to manage schedules');
  // An Agent changes only Schedules that run within its own Session's tier,
  // and only into Schedules that do; the rest is the user's to decide.
  const tierOf = (definition: Pick<ScheduleDefinition, 'machineId' | 'agent'>) =>
    readAgentRunConfigTier({
      manager,
      workspaceId,
      machineId: definition.machineId as MachineId,
      agentConfigId: definition.agent.agentConfigId as AgentConfigId,
      runConfig: definition.agent,
      localOnly,
    });
  if (
    requesterSessionId &&
    requesterPermissionTier &&
    (command.action === 'create' || command.action === 'edit' || command.action === 'resume')
  ) {
    const current =
      command.action === 'create' ? undefined : (await repository.read(id))?.definition;
    if (current && !isPermissionTierWithin(await tierOf(current), requesterPermissionTier))
      throw new Error(
        'This schedule runs with more permissions than this conversation has. Only the user can change or resume it, in Schedules.'
      );
    const result = command.action === 'resume' ? current : command.draft;
    if (result) {
      // A chat the runs go into keeps what its Agent was last set to for any
      // option a run leaves alone, so that chat counts as well.
      const destinationSessionId = scheduleDestinationSessionId(
        id,
        result.destination ?? DEFAULT_SCHEDULE_DESTINATION
      );
      const tier = higherPermissionTier(
        await tierOf(result),
        destinationSessionId ? await readSessionTier(destinationSessionId) : 'ask'
      );
      if (!isPermissionTierWithin(tier, requesterPermissionTier))
        throw new Error(
          'The schedule, or the chat it sends into, would run with more permissions than this conversation has. Unknown counts as more: set every permission option of the Agent (such as permission_mode) explicitly, or use lody_schedule_propose so the user can confirm it.'
        );
    }
  }
  const now = getServerNow();
  if (command.action === 'create' || command.action === 'edit') {
    if (!machine) throw new Error('Target machine is unavailable');
    const { resolveTurnDispatchConfig, validateSessionCreateOptions } =
      await import('@/commands/session');
    const draft = command.draft;
    const configId = draft.agent.agentConfigId as AgentConfigId;
    const agent = await readMergedAgentConfigById(manager.repo, workspaceId, machine.id, configId);
    if (!agent.config || agent.config.machineId !== machine.id)
      throw new Error('Selected Agent is unavailable on the target machine');
    if (draft.project?.kind === 'local') {
      const flock = await manager.repo.openFlockDoc(getMachineFlockDocId(workspaceId, machine.id));
      const projects = getMachineFlockLocalProjects(
        readMachineFlockRowsFromFlock(flock.flock, { families: ['localProject'] })
      );
      if (!projects[draft.project.localProjectId])
        throw new Error('Choose a Project on the target machine');
    }
    const destination = draft.destination ?? DEFAULT_SCHEDULE_DESTINATION;
    const destinationSessionId = scheduleDestinationSessionId(id, destination);
    if (destinationSessionId) {
      // A shared chat carries its own workspace; a schedule sending into one
      // must not also claim a project of its own.
      if (draft.project) throw new Error('A schedule that sends into a chat has no project');
      await sync(getSessionRoomId(destinationSessionId));
      const sessionRecord = await manager.repo.getDocMeta(getSessionRoomId(destinationSessionId));
      const problem = destinationSessionProblem({
        destination,
        session: !sessionRecord?.meta
          ? { kind: 'absent' }
          : isLoroRepoDocDeleted(sessionRecord)
            ? { kind: 'deleted' }
            : { kind: 'present', meta: sessionRecord.meta as SessionMeta },
        userId: auth.userId,
        machineId: machine.id,
        agentConfigId: configId,
      });
      if (problem)
        throw new Error(
          destination.kind === 'existing_session'
            ? 'Choose one of your own chats on the target machine, driven by the same Agent'
            : 'This schedule’s chat uses a different Agent; start a new chat to change it'
        );
    }
    if (!localOnly && context.hostedAccess) {
      const { buildProjectOptions } = await import('./schedule-project-options');
      await validateSessionCreateOptions({
        auth,
        workspace: context.workspace,
        manager,
        options: {
          machine: machine.id,
          agentConfig: configId,
          ...buildProjectOptions(draft.project),
        },
        dispatchConfig: { ...resolveTurnDispatchConfig({}), ...draft.agent },
        skipMachineAvailabilityCheck: true,
      });
    }
    await repository.save({
      scheduleId: id,
      draft,
      actorId: auth.userId,
      now,
      activationId: command.requestId,
      activityId: command.requestId,
      requesterSessionId,
      create: command.action === 'create',
    });
  } else if (command.action === 'pause' || command.action === 'resume') {
    await repository.setEnabled({
      scheduleId: id,
      enabled: command.action === 'resume',
      actorId: auth.userId,
      now,
      activationId: command.requestId,
      requestId: command.requestId,
      requesterSessionId,
    });
  } else if (command.action === 'run')
    await repository.requestRun({
      scheduleId: id,
      actorId: auth.userId,
      manualRunId: command.requestId,
      now,
    });
  else await repository.delete(id, auth.userId, now);
  if (!localOnly) {
    await (await manager.repo.openPersistedDoc(getScheduleRoomId(id))).syncOnce();
    await registry.syncOnce();
  }
  let notice: { action: keyof typeof AGENT_NOTICES; title: string } | undefined;
  if (
    requesterSessionId &&
    (command.action === 'create' ||
      command.action === 'edit' ||
      command.action === 'pause' ||
      command.action === 'resume')
  ) {
    const action = command.action;
    const session = await manager.getOrCreateSessionDoc(requesterSessionId);
    const sessionRecord = await manager.repo.getDocMeta(getSessionRoomId(requesterSessionId));
    const backend = await createSessionBackend(
      session,
      sessionRecord?.meta as SessionMeta | undefined
    );
    const entryId =
      action === 'pause'
        ? `schedule-paused-${command.requestId}`
        : `schedule-${action}-${command.requestId}`;
    const title = (await repository.read(id))?.definition.title ?? id;
    const existing = await backend.readTurn(entryId);
    if (existing.state !== 'ready') {
      // Only a first write leaves a notice, so its caller alerts the user once.
      notice = { action, title };
      await backend.appendHistoryTurn({
        id: entryId,
        role: 'system',
        timestamp: new Date(now).toISOString(),
        items: [
          {
            type: 'text',
            text:
              action === 'pause'
                ? `Paused scheduled task: ${title}. Future runs stop after the owner machine syncs. Already submitted Sessions continue.`
                : `${AGENT_NOTICES[action]} scheduled task from this conversation: ${title} (${id}). Review, pause or edit it in Schedules.`,
          },
        ],
        fileDiff: [],
        finished: true,
      });
    }
    await manager.repo.flush();
    if (!localOnly && (!(await backend.waitUntilSynced()) || !(await session.waitUntilSynced())))
      throw new Error(
        `${AGENT_NOTICES[action]} schedule saved; notification sync pending. Retry with the same requestId.`
      );
  }
  return { ok: true, scheduleId: id, ...(notice ? { notice } : {}) };
}
