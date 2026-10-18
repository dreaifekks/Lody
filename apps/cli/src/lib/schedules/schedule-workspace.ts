import type { RepoRoomSubscription } from 'loro-repo';
import type { CloudNotificationsPort } from '@lody/platform';
import {
  canonicalScheduleJson,
  getScheduleRegistryFlockDocId,
  getScheduleRoomId,
  getServerNow,
  getSessionRoomId,
  getWorkspaceFlockDocId,
  isLoroRepoDocDeleted,
  ScheduleRepository,
  scheduleDefinitionFingerprint,
  scheduleRegistryKeys,
  ScheduleRuntimeRowSchema,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
  getMachineRoomId,
  getMachineFlockDocId,
  getMachineFlockLocalProjects,
  readMachineFlockRowsFromFlock,
  type MachineMeta,
  type AgentConfigId,
  hasPendingUserTurnActivation,
} from '@lody/shared';
import type { AuthContext } from '../command-runtime';
import type { WorkspaceSummary } from '../workspace';
import type { LoroDocumentManager } from '../loro/doc';
import type { Logger } from '@/utils/logger';
import { createSessionBackend } from '@/session/session-backend';
import { lanAlertProjectId } from '../lan/lan-push-protocol';
import { streamsRoomBinding } from '../loro/streams-room-binding';
import {
  resolveScheduleMcpSelection,
  buildScheduleRunPrompt,
  buildScheduleRunTarget,
  resolveScheduleAgentRunConfig,
  resolveScheduleRunRole,
  buildScheduleSessionCreateOptions,
  destinationSessionProblem,
  resolveScheduleDestinationSession,
  readScheduleBoard,
  type DestinationSessionState,
  scheduleDestinationSessionState,
  scheduleRequiredLocalProjectId,
} from './schedule-run-preparation';
import { AgentExecutionSlots } from '../agent-execution-slots';
import { readMergedAgentConfigById } from '../agent-config-machine-flock';
import {
  commitPreparedSessionDispatch,
  isPreparedSessionDispatched,
  materializePreparedSessionInput,
  type PreparedSessionInput,
} from '../prepared-session-input';
import { createScheduleSyncGate } from './schedule-sync-gate';
import { ScheduleStore } from './schedule-store';
import { ScheduleEngine, ScheduleConfigurationError } from './schedule-engine';

export type ScheduleWorkspaceHandle = {
  evaluate: () => Promise<void>;
  dispose: () => Promise<void>;
};

export async function createScheduleWorkspace(args: {
  manager: LoroDocumentManager;
  workspace: WorkspaceSummary;
  auth: AuthContext;
  localOnly: boolean;
  slots: AgentExecutionSlots;
  logger: Logger;
  hasSessionWork: (sessionId: SessionId) => boolean;
  notifications?: CloudNotificationsPort | null;
}): Promise<ScheduleWorkspaceHandle> {
  const { manager, workspace, auth, slots } = args;
  const workspaceId = workspace.id as WorkspaceId;
  const repository = new ScheduleRepository(manager.repo, workspaceId);
  const store = new ScheduleStore<PreparedSessionInput>();
  const registry = await manager.repo.openFlockDoc(getScheduleRegistryFlockDocId(workspaceId));
  const subscriptions: RepoRoomSubscription[] = [];
  const cleanups: (() => void)[] = [];
  let disposed = false;
  let cloudGate: ReturnType<typeof createScheduleSyncGate> | undefined;
  const isReady = () => args.localOnly || cloudGate?.isReady() === true;
  const disabled = process.env.LODY_SCHEDULES_DISABLED === '1';
  /**
   * The Role a run resolves, once: `prepare` freezes what it returns, so a
   * retry of that run ignores later edits to the Role.
   */
  const resolveRunRole = async (
    run: import('./schedule-store').ScheduleRun<PreparedSessionInput>
  ) => {
    const ref = run.definition.agentRole;
    if (ref && !args.localOnly)
      await manager.syncFlockDocOrThrow(getWorkspaceFlockDocId(workspaceId), {
        reason: 'schedule:agent-role',
      });
    return resolveScheduleRunRole({
      manager,
      workspaceId,
      machineId: auth.machineId,
      userId: auth.userId,
      ref,
    });
  };
  const readSession = async (id: SessionId): Promise<DestinationSessionState> => {
    const record = await manager.repo.getDocMeta(getSessionRoomId(id));
    return scheduleDestinationSessionState(record);
  };
  const resolveTarget = async (
    run: import('./schedule-store').ScheduleRun<PreparedSessionInput>,
    agentConfigId: string
  ) => {
    const board = await readScheduleBoard({
      manager,
      workspaceId,
      boardId: run.definition.boardId,
      localOnly: args.localOnly,
    });
    const machineRecord = await manager.repo.getDocMeta(getMachineRoomId(auth.machineId));
    const machine = machineRecord?.meta as MachineMeta | undefined;
    const agentConfig = await readMergedAgentConfigById(
      manager.repo,
      workspaceId,
      auth.machineId,
      agentConfigId as AgentConfigId
    );
    if (
      !machine ||
      isLoroRepoDocDeleted(machineRecord!) ||
      machine.ownerUserId !== auth.userId ||
      !agentConfig.config ||
      agentConfig.config.machineId !== auth.machineId
    )
      throw new ScheduleConfigurationError('OWNER_OR_AGENT_UNAVAILABLE');
    // A schedule without a project is a plain chat run; there is no working
    // directory to validate, and no local ledger entry to require.
    const project = run.definition.project;
    const requiredLocalProjectId = scheduleRequiredLocalProjectId(project);
    if (requiredLocalProjectId !== undefined) {
      const flock = await manager.repo.openFlockDoc(
        getMachineFlockDocId(workspaceId, auth.machineId)
      );
      const projects = getMachineFlockLocalProjects(
        readMachineFlockRowsFromFlock(flock.flock, { families: ['localProject'] })
      );
      if (!projects[requiredLocalProjectId])
        throw new ScheduleConfigurationError('PROJECT_UNAVAILABLE');
    }
    const { sessionId, session } = run.prepared
      ? { sessionId: run.prepared.sessionId, session: await readSession(run.prepared.sessionId) }
      : await resolveScheduleDestinationSession({
          scheduleId: run.scheduleId,
          boardId: run.definition.boardId,
          destination: run.definition.destination,
          plannedSessionId: run.sessionId as SessionId,
          readSession,
        });
    const problem = destinationSessionProblem({
      destination: run.definition.destination,
      session,
      board,
      userId: auth.userId,
      machineId: auth.machineId,
      agentConfigId,
    });
    if (problem) throw new ScheduleConfigurationError(problem);
    const createsSession = session.kind === 'absent';
    return {
      sessionId,
      createsSession,
      target: buildScheduleRunTarget({
        targetMachine: machine,
        agentConfig: agentConfig.config,
        project,
      }),
    };
  };
  const engine = new ScheduleEngine<PreparedSessionInput>({
    workspaceId,
    machineId: auth.machineId,
    userId: auth.userId,
    store,
    slots,
    now: getServerNow,
    disabled: () => disabled || disposed,
    ready: isReady,
    list: () => repository.list(),
    read: async (id) => {
      if (!args.localOnly)
        await manager.syncDocOrThrow(getScheduleRoomId(id), { reason: 'schedule:definition' });
      return repository.read(id);
    },
    validateTarget: async (run) => {
      // A prepared run checks the Agent it froze, not what its Role says now.
      await resolveTarget(
        run,
        run.prepared?.meta.agentConfigId ?? run.definition.agent.agentConfigId
      );
    },
    prepare: async (run) => {
      const { prepareSessionInput, resolveTurnDispatchConfig } = await import('@/commands/session');
      const role = await resolveRunRole(run);
      const { target, createsSession, sessionId } = await resolveTarget(
        run,
        (role?.agent ?? run.definition.agent).agentConfigId
      );
      const agent = await resolveScheduleAgentRunConfig(
        manager,
        workspaceId,
        auth.machineId,
        role?.agent ?? run.definition.agent
      );
      const prepared = await prepareSessionInput(
        auth,
        workspace,
        manager,
        buildScheduleRunPrompt({ prompt: run.prompt, role, createsSession }),
        buildScheduleSessionCreateOptions({
          sessionId,
          userTurnId: run.userTurnId,
          agentConfigId: agent.agentConfigId,
          title: run.definition.title,
          boardId: run.definition.boardId,
          project: run.definition.project,
          role,
        }),
        {
          ...resolveTurnDispatchConfig({}),
          ...agent,
          inheritSessionDefaults: false,
          mcpServerIds: await resolveScheduleMcpSelection({
            manager,
            workspaceId,
            localOnly: args.localOnly,
            definition: run.definition,
            sessionId,
          }),
        },
        target
      );
      if (prepared.meta.machineId !== run.machineId || prepared.meta.userId !== auth.userId)
        throw new Error('Schedule target ownership changed');
      prepared.meta.scheduleId = run.scheduleId;
      prepared.userTurn.inputConfig = {
        ...prepared.userTurn.inputConfig,
        _lodyScheduleId: run.scheduleId,
      };
      prepared.source = {
        id: run.sourceEntryId,
        role: 'system',
        timestamp: new Date(run.plannedAt).toISOString(),
        items: [
          {
            type: 'text',
            text: `Scheduled task: ${run.definition.title}\nSchedule: ${run.scheduleId}\nScheduled for: ${new Date(run.scheduledFor).toISOString()}`,
          },
        ],
        fileDiff: [],
        finished: true,
      };
      return prepared;
    },
    materialize: (prepared) => materializePreparedSessionInput(manager, prepared),
    isDispatched: (prepared) => isPreparedSessionDispatched(manager, prepared),
    dispatch: (prepared) => commitPreparedSessionDispatch(manager, prepared),
    isFinished: (run) => isScheduleRunFinished(manager, run, args.hasSessionWork),
    publish: async (runtime) => {
      const key = scheduleRegistryKeys.runtime(runtime.scheduleId, auth.machineId);
      const prior = ScheduleRuntimeRowSchema.safeParse(registry.flock.get(key));
      // Keep the last accepted Session while updating queue/next-fire fields.
      const next = {
        ...runtime,
        lastDispatch: runtime.lastDispatch ?? (prior.success ? prior.data.lastDispatch : undefined),
      };
      if (
        prior.success &&
        canonicalScheduleJson({ ...prior.data, updatedAt: 0 }) ===
          canonicalScheduleJson({ ...next, updatedAt: 0 })
      )
        return;
      registry.flock.set(key, JSON.parse(JSON.stringify(next)));
      await manager.repo.flush();
    },
    // Do not log prompts, config values, credentials or provider exception text.
    onEvent: ({ runKey, ...event }) => {
      const run = runKey ? store.get(runKey) : undefined;
      args.logger.debug(
        `[schedules] ${JSON.stringify({
          workspaceId,
          ...event,
          runKeyHash: runKey?.slice(0, 12),
          activationId: run?.activationId,
          attempt: run?.attempts,
          scheduledFor: run?.scheduledFor ?? event.scheduledFor,
          latencyMs: run ? Math.max(0, getServerNow() - run.scheduledFor) : undefined,
        })}`
      );
      const notify = args.notifications?.notifyScheduleEvent;
      if (
        notify &&
        run &&
        runKey &&
        (event.type === 'dispatched' || event.type === 'blocked' || event.type === 'skipped')
      ) {
        void notify
          .call(args.notifications, {
            phase: event.type,
            scheduleId: run.scheduleId,
            runKey,
            title: run.definition.title,
            sessionId: run.sessionId || null,
            code: event.code ?? null,
            workspaceId,
            workspaceSlug: workspace.slug?.trim() || workspaceId,
            userId: auth.userId,
            projectId: lanAlertProjectId(run.definition),
          })
          .catch(() => {});
      }
    },
    onError: () =>
      args.logger.warn(
        `[schedules] evaluation failed workspaceId=${workspaceId}; see Schedule runtime state`
      ),
  });
  engine.restoreOccupancy();

  const pass = async (): Promise<void> => {
    if (disposed) return;
    if (isReady() && !disabled) {
      const rows = await repository.list();
      for (const entry of registry.flock.scan({ prefix: ['manual'] })) {
        const request = entry.value as unknown as {
          scheduleId: string;
          actorId: string;
          manualRunId: string;
          activationId: string;
          requestedAt: number;
        };
        if (
          !request ||
          entry.key.length !== 3 ||
          entry.key[1] !== request.scheduleId ||
          entry.key[2] !== request.manualRunId ||
          request.actorId !== auth.userId ||
          !/^[a-zA-Z0-9_-]{1,50}$/.test(request.manualRunId) ||
          !Number.isFinite(request.requestedAt) ||
          request.requestedAt > getServerNow()
        )
          continue;
        const row = rows.find(
          (r) =>
            r.scheduleId === request.scheduleId &&
            r.ownerId === auth.userId &&
            r.machineId === auth.machineId &&
            r.activationId === request.activationId
        );
        if (!row || getServerNow() - request.requestedAt > 24 * 60 * 60 * 1000) continue;
        const document = await repository.read(request.scheduleId);
        if (document && scheduleDefinitionFingerprint(document) === row.definitionFingerprint)
          store.planManual(
            workspaceId,
            document,
            row.definitionFingerprint,
            request.manualRunId,
            request.requestedAt
          );
      }
    }
    await engine.evaluate();
  };
  let evaluating: Promise<void> | undefined;
  let dirty = false;
  const evaluate = (): Promise<void> => {
    dirty = true;
    return (evaluating ??= (async () => {
      while (dirty) {
        if (disposed) break;
        dirty = false;
        await pass();
      }
    })().finally(() => {
      evaluating = undefined;
    }));
  };
  const wake = (): void => {
    void evaluate().catch(() => args.logger.warn('[schedules] wake failed'));
  };
  cleanups.push(registry.flock.subscribe(wake), slots.subscribe(wake));

  // One short timer is also the wake-from-sleep clock check. No per-Schedule
  // timer survives a definition edit, and evaluation coalesces in the engine.
  const timer = setInterval(wake, 15_000);
  timer.unref();
  const registrySubscription = await registry.joinRoom();
  subscriptions.push(registrySubscription);
  if (!args.localOnly) {
    const binding = streamsRoomBinding(registrySubscription);
    cloudGate = createScheduleSyncGate(binding, wake, () =>
      args.logger.warn('[schedules] Registry synchronization pending')
    );
    cleanups.push(cloudGate.dispose);
  }
  wake();
  return {
    evaluate,
    dispose: async () => {
      disposed = true;
      clearInterval(timer);
      for (const cleanup of cleanups) cleanup();
      for (const sub of subscriptions) sub.unsubscribe();
      await evaluating;
      await engine.stop();
      store.close();
    },
  };
}

/** Admission ends for an archived target once its actual local work has drained. */
export async function isScheduleRunFinished(
  manager: LoroDocumentManager,
  run: Pick<import('./schedule-store').ScheduleRun, 'sessionId' | 'userTurnId'>,
  hasSessionWork: (id: SessionId) => boolean
): Promise<boolean> {
  const id = run.sessionId as SessionId;
  if (hasSessionWork(id)) return false;
  const record = await manager.repo.getDocMeta(getSessionRoomId(id));
  if (!record) return false;
  if (isLoroRepoDocDeleted(record)) return true;
  const meta = record.meta as SessionMeta;
  if (meta.isArchived) return true;
  if (
    hasPendingUserTurnActivation(meta) ||
    (meta.messageQueueUpdatedAt ?? 0) > (meta.messageQueueCheckedAt ?? 0)
  )
    return false;
  const session = await manager.getOrCreateSessionDoc(id);
  const backend = await createSessionBackend(session, meta);
  if ((await backend.getMessageQueue()).length) return false;
  const [userRead, assistantRead] = await Promise.all([
    backend.readTurn(run.userTurnId),
    backend.readTurn(`assistant:${run.userTurnId}`),
  ]);
  const userTurn = userRead.state === 'ready' ? userRead.turn : undefined;
  const assistantTurn = assistantRead.state === 'ready' ? assistantRead.turn : undefined;
  return (
    !hasSessionWork(id) &&
    ((userTurn?.id === run.userTurnId &&
      ['handled', 'failed', 'canceled'].includes(userTurn.status ?? '')) ||
      (assistantTurn?.role === 'assistant' &&
        assistantTurn.userTurnId === run.userTurnId &&
        (assistantTurn.finished === true || typeof assistantTurn.endedAt === 'number')))
  );
}
