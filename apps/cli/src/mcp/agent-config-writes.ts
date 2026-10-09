import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  agentConfigNoticeId,
  canonicalScheduleJson,
  canReadAgentRole,
  getMachineRoomId,
  getScheduleRoomId,
  getServerNow,
  getWorkspaceFlockDocId,
  listWorkspaceAgentRoles,
  readWorkspaceFlockRowsFromFlock,
  ScheduleRepository,
  type AgentRole,
  type AgentRoleId,
  type AgentRoleInstanceId,
  type MachineId,
  type MachineMeta,
  type ProposalTargetAgent,
  type ResolvedPermissionTier,
  type ScheduleCommand,
  type ScheduleProposalMeta,
  type SessionId,
  type SessionMeta,
  type SessionTurnInputConfig,
  type WorkspaceId,
} from '@lody/shared';
import {
  getAuthContextOrThrow,
  resolveWorkspaceOrThrow,
  syncDocForRead,
  syncFlockDocForRead,
  WORKSPACE_SYNC_UNAVAILABLE_MESSAGE,
  WorkspaceSyncUnavailableError,
  withWorkspaceManager,
} from '@/lib/command-runtime';
import {
  readAgentRunConfigTier,
  readInvokingPermissionTier,
  readInvokingRunConfig,
  type InvokingRunConfig,
  type RuntimeConfigOption,
} from '@/lib/agent-permission-tier';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { createResourceDiscovery } from '@/lib/resource-discovery-runtime';
import type { ResourceDiscovery } from '@/lib/resource-discovery';
import { syncMcpCatalog, upsertWorkspaceAgentRoleEntry } from '@/lib/workspace-mcp-store';
import { createSessionBackend } from '@/session/session-backend';
import { buildAgentRoleFromAgent, type AgentRoleWrite } from './agent-role-tools';
import {
  buildScheduleCreateDraft,
  buildScheduleEditDraft,
  scheduleDraftNow,
} from './schedule-agent-writes';
import type { ScheduleAgentWrite } from './schedule-tools';
import { withWorkspaceConfigureLock } from './workspace-mcp-configure';

/** The Session and Turn driving an Agent tool call, as the MCP server resolves them. */
export type InvokingAgentCall = {
  session: SessionMeta;
  turn: { id: string; userId: string; inputConfig: SessionTurnInputConfig };
  /** The live Agent's current options, where this process runs it. */
  runtimeConfigOptions: readonly RuntimeConfigOption[] | undefined;
};

type Invoking = InvokingAgentCall & { runConfig: InvokingRunConfig; tier: ResolvedPermissionTier };

const readInvoking = async (
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId,
  call: InvokingAgentCall
): Promise<Invoking> => {
  const runConfig = await readInvokingRunConfig(manager, call.session.id, call.turn);
  const tier = await readInvokingPermissionTier({
    manager,
    workspaceId,
    session: call.session,
    turn: call.turn,
    runtimeConfigOptions: call.runtimeConfigOptions,
  });
  return { ...call, runConfig, tier };
};

const readRoles = async (manager: LoroDocumentManager, workspaceId: WorkspaceId) =>
  listWorkspaceAgentRoles(
    readWorkspaceFlockRowsFromFlock(
      (await manager.repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId))).flock
    )
  );

/** A readable Agent config, or `undefined` when this user cannot read one with that id. */
const readAgent = async (
  discovery: ResourceDiscovery,
  agentConfigId: string
): Promise<(ProposalTargetAgent & { name: string }) | undefined> => {
  try {
    const { item } = await discovery.get('agent_config', agentConfigId);
    return item as unknown as ProposalTargetAgent & { name: string };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('RESOURCE_NOT_FOUND')) return undefined;
    throw error;
  }
};

/**
 * A system line in the calling conversation, so the user sees what its Agent
 * changed. With `append` false it only reports whether that line exists: a
 * retry of a write that left it.
 */
const ensureNotice = async (
  manager: LoroDocumentManager,
  sessionId: SessionId,
  entryId: string,
  text: string,
  append: boolean
): Promise<boolean> => {
  const session = await manager.getOrCreateSessionDoc(sessionId);
  const record = await manager.repo.getDocMeta(session.roomId);
  const backend = await createSessionBackend(session, record?.meta as SessionMeta | undefined);
  if ((await backend.readTurn(entryId)).state === 'ready') return true;
  if (!append) return false;
  await backend.appendHistoryTurn({
    id: entryId,
    role: 'system',
    timestamp: new Date(getServerNow()).toISOString(),
    items: [{ type: 'text', text }],
    fileDiff: [],
    finished: true,
  });
  await manager.repo.flush();
  return true;
};

/** A Role write's identity: its revision and a digest of what it holds. */
export const agentRoleWriteId = (role: AgentRole): string => {
  const { name, description, emoji, visibility, instances, promptPrefix } = role;
  const content = canonicalScheduleJson({
    name,
    description,
    emoji,
    visibility,
    instances,
    promptPrefix,
  });
  return `r${role.revision}-${createHash('sha256').update(content).digest('hex').slice(0, 16)}`;
};

const SCHEDULE_VERBS = { create: 'created', edit: 'changed', resume: 'resumed' } as const;
const ScheduleWriteResultSchema = z.object({
  notice: z
    .object({ id: z.string(), action: z.enum(['create', 'edit', 'resume']), title: z.string() })
    .optional(),
});

const jsonResult = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});

/**
 * Agent writes of Roles and Schedules. They run where the Session tools run
 * (the daemon, on the local platform), because the bound is the invoking
 * Session's permission tier, read from its active Turn.
 */
export function createAgentConfigWrites(deps: {
  readInvokingCall: (manager: LoroDocumentManager) => Promise<InvokingAgentCall>;
  errorResult: (error: unknown) => CallToolResult;
  /** Desktop alert and phone push to the user; nothing where no port delivers them. */
  notifyConfigChange: (
    sessionId: SessionId,
    notice: { id: string; title: string; body: string }
  ) => Promise<void> | undefined;
}) {
  /** Who changed what, once per first write: the notice in the conversation marks it. */
  const notifyUser = async (session: SessionMeta, id: string, title: string, name: string) =>
    deps.notifyConfigChange(session.id as SessionId, {
      id,
      title,
      body: `${name}, by an Agent in “${session.title || 'a conversation'}”`,
    });
  const withManager = async <T>(
    workspaceSelector: string,
    run: (manager: LoroDocumentManager, workspaceId: WorkspaceId, userId: string) => Promise<T>
  ) => {
    const auth = getAuthContextOrThrow('mcp');
    const workspace = await resolveWorkspaceOrThrow(auth, workspaceSelector);
    return withWorkspaceManager(auth, workspace, 'mcp', (manager) =>
      run(manager, workspace.id as WorkspaceId, auth.userId)
    );
  };

  const schedule = async (workspaceSelector: string, request: ScheduleAgentWrite) =>
    withManager(workspaceSelector, async (manager, workspaceId, userId) => {
      const invoking = await readInvoking(
        manager,
        workspaceId,
        await deps.readInvokingCall(manager)
      );
      const { sendScheduleCommand } = await import('@/lib/schedules/schedule-command-client');
      const send = (command: ScheduleCommand) =>
        sendScheduleCommand(command, {
          workspace: workspaceId,
          requesterSessionId: invoking.session.id as SessionId,
          requesterPermissionTier: invoking.tier,
        });
      const sendAndNotify = async (command: ScheduleCommand) => {
        const result = await send(command);
        const notice = ScheduleWriteResultSchema.parse(result).notice;
        // Every success alerts, a retry included; devices alert once per notice id.
        if (notice)
          await notifyUser(
            invoking.session,
            notice.id,
            `Scheduled task ${SCHEDULE_VERBS[notice.action]}`,
            notice.title
          );
        return result;
      };
      if (request.action === 'resume') return sendAndNotify({ action: 'resume', ...request.input });

      const target: ScheduleProposalMeta['target'] = request.input.target;
      const discovery = await createResourceDiscovery({
        manager,
        auth: getAuthContextOrThrow('mcp'),
        workspaceId,
        delegatedRequester: { userId: invoking.turn.userId },
      });
      await syncFlockDocForRead(manager, getWorkspaceFlockDocId(workspaceId), 'mcp.schedule_write');
      const roles = (await readRoles(manager, workspaceId)).filter((role) =>
        canReadAgentRole(role, userId)
      );
      const role = target?.agentRoleId
        ? roles.find((entry) => entry.id === target.agentRoleId)
        : undefined;
      const agents: ProposalTargetAgent[] = [];
      for (const agentConfigId of new Set(
        [
          ...(role?.instances.map((instance) => instance.agentConfigId) ?? []),
          target?.agentConfigId,
          invoking.session.agentConfigId,
        ].filter((value): value is string => Boolean(value))
      )) {
        const agent = await readAgent(discovery, agentConfigId);
        if (agent) agents.push(agent);
      }

      const repository = new ScheduleRepository(manager.repo, workspaceId);
      const current =
        request.action === 'update'
          ? await (async () => {
              await syncDocForRead(
                manager,
                getScheduleRoomId(request.input.scheduleId),
                'mcp.schedule_write'
              );
              const document = await repository.read(request.input.scheduleId);
              if (!document) throw new Error('Schedule not found');
              return document;
            })()
          : undefined;
      // The create's schedule id is its request id: a retry finds its own first write.
      const stored = current ?? (await repository.read(request.input.requestId));
      const timeZones = new Map<string, string>();
      for (const machineId of new Set([
        ...agents.map((agent) => agent.machineId),
        ...(current ? [current.definition.machineId] : []),
      ])) {
        const meta = (await manager.repo.getDocMeta(getMachineRoomId(machineId as MachineId)))
          ?.meta as MachineMeta | undefined;
        if (meta?.timeZone) timeZones.set(machineId, meta.timeZone);
      }
      const context = {
        now: scheduleDraftNow(getServerNow(), stored, request.input.requestId),
        conversation: { session: invoking.session, runConfig: invoking.runConfig },
        agents,
        roles,
        machineTimeZone: (machineId: string) => timeZones.get(machineId),
      };
      if (request.action === 'create')
        return sendAndNotify({
          action: 'create',
          scheduleId: request.input.requestId,
          requestId: request.input.requestId,
          draft: buildScheduleCreateDraft(request.input, context),
        });
      return sendAndNotify({
        action: 'edit',
        scheduleId: request.input.scheduleId,
        requestId: request.input.requestId,
        draft: buildScheduleEditDraft(request.input, current!, context),
      });
    });

  const role = async (workspaceSelector: string, request: AgentRoleWrite) =>
    withManager(workspaceSelector, (manager, workspaceId, userId) =>
      withWorkspaceConfigureLock(workspaceId, async () => {
        try {
          await syncMcpCatalog(manager, workspaceId);
        } catch (error) {
          throw new WorkspaceSyncUnavailableError({
            message: WORKSPACE_SYNC_UNAVAILABLE_MESSAGE,
            cause: error,
          });
        }
        const invoking = await readInvoking(
          manager,
          workspaceId,
          await deps.readInvokingCall(manager)
        );
        const discovery = await createResourceDiscovery({
          manager,
          auth: getAuthContextOrThrow('mcp'),
          workspaceId,
          delegatedRequester: { userId: invoking.turn.userId },
        });
        const next = await buildAgentRoleFromAgent(request, {
          userId,
          callerTier: invoking.tier,
          roles: () => readRoles(manager, workspaceId),
          agentConfig: async (agentConfigId) => {
            const agent = await readAgent(discovery, agentConfigId);
            if (!agent) throw new Error('No readable Agent config with that id.');
            return { machineId: agent.machineId as MachineId, name: agent.name };
          },
          tierOf: (candidate) =>
            readAgentRunConfigTier({
              manager,
              workspaceId,
              machineId: candidate.machineId,
              agentConfigId: candidate.agentConfigId,
              runConfig: candidate.runConfig,
              localOnly: false,
            }),
          now: getServerNow,
          createId: () => randomUUID() as AgentRoleId,
          createInstanceId: () => randomUUID() as AgentRoleInstanceId,
        });
        const write = await upsertWorkspaceAgentRoleEntry(manager.repo, workspaceId, next);
        // The revision and the content a write produced identify it: two
        // daemons may each make the same revision of one Role with other
        // content. An unchanged Role is a retry (its line exists, so alert
        // again) or a no-op.
        const entryId = agentConfigNoticeId({
          workspaceId,
          kind: 'agent-role',
          objectId: next.id,
          action: request.action,
          requestId: agentRoleWriteId(next),
        });
        if (
          await ensureNotice(
            manager,
            invoking.session.id as SessionId,
            entryId,
            `${request.action === 'create' ? 'Created' : 'Changed'} Agent Role from this conversation: ${next.name} (${next.id}, revision ${next.revision}). Review or edit it in Settings → Agent Roles.`,
            write.changed
          )
        )
          await notifyUser(
            invoking.session,
            entryId,
            `Agent Role ${request.action === 'create' ? 'created' : 'changed'}`,
            next.name
          );
        return { write, role: next };
      })
    );

  return {
    schedule,
    role: async (workspaceSelector: string, request: AgentRoleWrite): Promise<CallToolResult> => {
      try {
        const { write, role: saved } = await role(workspaceSelector, request);
        return jsonResult({
          ok: true,
          ...write,
          role: summarizeRole(saved),
          ...(!write.synced
            ? {
                warning: `Saved on this machine but not synced to the workspace (${write.syncError ?? 'unknown error'}).`,
              }
            : {}),
        });
      } catch (error) {
        return deps.errorResult(error);
      }
    },
  };
}

const summarizeRole = (role: AgentRole) => ({
  id: role.id,
  name: role.name,
  visibility: role.visibility,
  revision: role.revision,
  instances: role.instances,
});
