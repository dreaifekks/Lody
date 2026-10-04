import type {
  AgentConfigId,
  MachineId,
  MachineMeta,
  SessionId,
  TerminalCommand,
  WorkspaceId,
} from '@lody/shared';
import {
  getMachineRoomId,
  getSessionRoomId,
  negotiatedAcpCapabilitiesRefreshForce,
  type SessionMeta,
} from '@lody/shared';
import { ensureWorkspaceMetaSynced } from '@/lib/command-runtime';
import { getSessionCommandEnvironment } from '@/lib/session-command-environment';
import {
  buildSessionShowResult,
  createSessionResult,
  resolveRunningAssistantTurnId,
  resolveSessionMetaOrThrow,
  resolveTurnDispatchConfig,
  runSessionOperationWithSyncedMetadata,
  sendSessionChatResult,
} from './session';
import { waitForTurnCompletion } from './session-output';
import { createSessionBackend } from '@/session/session-backend';
import { readDetailedMachineList } from './machine';
import {
  createAgentConfig,
  deleteAgentConfig,
  resolveAgentConfigTarget,
  showAgentConfig,
  updateAgentConfig,
} from './agent-config';
import { applyMcpCatalogAction } from './mcp';
import { syncWorkspaceReplica } from './sync';
import { exportWorkspaceReplica } from './export';
import { listRequesterOperations } from './operation';
import { OperationListQuerySchema } from '@/orchestration/operation-store';
import path from 'node:path';
import { listGitHubRepositories } from '@/lib/lan/lan-github-repos';

/**
 * The daemon side of a local-platform `lody` command that works on the
 * workspace: the same bodies the hosted command line runs, here on the
 * daemon's own replica as the machine's user. Another machine of the LAN is
 * reached the way an Agent's Session tools reach it.
 */
export async function executeTerminalCommand(
  scope: { machineId: string; workspaceId: string },
  command: TerminalCommand
): Promise<Record<string, unknown>> {
  const environment = getSessionCommandEnvironment();
  if (
    !environment ||
    scope.machineId !== environment.auth.machineId ||
    scope.workspaceId !== environment.workspace.id
  )
    throw new Error('Session command scope mismatch');
  const { auth, workspace, manager, host } = environment;
  const context = { auth, workspace, manager };

  switch (command.command) {
    case 'create': {
      const { command: _, prompt, mode, model, configOption, ...selection } = command;
      const result = await createSessionResult(
        auth,
        workspace,
        manager,
        prompt,
        {
          ...selection,
          workspace: workspace.id,
          currentSessionId: selection.currentSessionId as SessionId | undefined,
        },
        resolveTurnDispatchConfig({ mode, model, configOption })
      );
      return {
        sessionId: result.sessionId,
        workspaceId: result.workspaceId,
        machineId: result.machineId,
        agentConfigId: result.agentConfigId,
        userTurnId: result.userTurnId,
        ...(result.parentSessionId ? { parentSessionId: result.parentSessionId } : {}),
        ...(result.openedBySessionId ? { openedBySessionId: result.openedBySessionId } : {}),
        ...(result.openedByRootSessionId
          ? { openedByRootSessionId: result.openedByRootSessionId }
          : {}),
      };
    }
    case 'chat': {
      const result = await sendSessionChatResult(
        auth,
        workspace,
        manager,
        command.sessionId as SessionId,
        command.prompt,
        resolveTurnDispatchConfig({
          mode: command.mode,
          model: command.model,
          configOption: command.configOption,
        })
      );
      return {
        sessionId: result.sessionId,
        workspaceId: result.workspaceId,
        machineId: result.machineId,
        userTurnId: result.userTurnId,
      };
    }
    case 'wait': {
      const sessionId = command.sessionId as SessionId;
      await resolveSessionMetaOrThrow(manager, sessionId);
      const sessionDoc = await manager.getOrCreateSessionDoc(sessionId);
      const turn = await waitForTurnCompletion({
        sessionDoc,
        backend: await createSessionBackend(sessionDoc, await sessionDoc.getMetaState()),
        userTurnId: command.userTurnId,
        outputMode: 'json',
        timeoutMs: command.timeoutMs,
      });
      return { turnId: turn.turnId, content: turn.content, durationMs: turn.durationMs };
    }
    case 'cancel': {
      const sessionId = command.sessionId as SessionId;
      const session = await resolveSessionMetaOrThrow(manager, sessionId);
      const access = await environment.checkMachineAccess({
        workspaceId: workspace.id as WorkspaceId,
        machineId: session.machineId as MachineId,
        requesterUserId: auth.userId,
        ...(session.project?.kind === 'local'
          ? { localProjectId: session.project.localProjectId }
          : {}),
      });
      if (!access.allowed) throw new Error(`Machine ${session.machineId} is not available to you.`);
      const turnId = await resolveRunningAssistantTurnId(manager, sessionId);
      if (!turnId) return { sessionId, alreadyStopped: true };
      if (command.turnId && command.turnId !== turnId)
        return {
          sessionId,
          alreadyStopped: true,
          expectedTurnId: command.turnId,
          activeTurnId: turnId,
        };
      const response = await host.cancelSession(sessionId, turnId);
      if (!response.success) throw new Error(response.error ?? `Failed to cancel ${sessionId}.`);
      return { sessionId, response };
    }
    case 'rename': {
      const sessionId = command.sessionId as SessionId;
      await resolveSessionMetaOrThrow(manager, sessionId);
      await manager.repo.upsertDocMeta(getSessionRoomId(sessionId), {
        title: command.title,
      } satisfies Partial<SessionMeta>);
      await ensureWorkspaceMetaSynced(manager, `session.rename:${sessionId}`);
      return { sessionId, title: command.title };
    }
    case 'archive':
    case 'restore':
    case 'delete': {
      const sessionId = command.sessionId as SessionId;
      const children = await runSessionOperationWithSyncedMetadata(
        manager,
        sessionId,
        command.command
      );
      const key = {
        archive: 'archivedChildSessionIds',
        restore: 'restoredChildSessionIds',
        delete: 'deletedChildSessionIds',
      }[command.command];
      return { sessionId, [key]: children };
    }
    case 'agent-config-show': {
      const { command: _, ...input } = command;
      return await showAgentConfig(context, input);
    }
    case 'agent-config-target': {
      const { command: _, ...input } = command;
      return await resolveAgentConfigTarget(context, input);
    }
    case 'agent-config-refresh': {
      // This machine refreshes through its own local control; only another
      // machine of the LAN comes here.
      if (!host.remote) throw new Error('This workspace has no other machine to refresh.');
      const machine = (
        await manager.repo.getDocMeta(getMachineRoomId(command.machineId as MachineId))
      )?.meta as MachineMeta | undefined;
      if (!machine) throw new Error(`Machine not found: ${command.machineId}`);
      const response = await host.remote.withClient(
        command.machineId as MachineId,
        async (client) =>
          await client.requestMachineAcpCapabilitiesRefresh({
            configId: command.configId as AgentConfigId,
            ...negotiatedAcpCapabilitiesRefreshForce(machine, true),
          })
      );
      if (!response) throw new Error(`Machine ${command.machineId} did not answer the refresh.`);
      return response as unknown as Record<string, unknown>;
    }
    case 'agent-config-create': {
      const { command: _, ...input } = command;
      return await createAgentConfig(context, input);
    }
    case 'agent-config-update': {
      const { command: _, ...input } = command;
      return await updateAgentConfig(context, input);
    }
    case 'agent-config-delete': {
      const { command: _, ...input } = command;
      return await deleteAgentConfig(context, input);
    }
    case 'mcp': {
      const { command: _, ...action } = command;
      return await applyMcpCatalogAction(context, action);
    }
    case 'github-list': {
      const token = await host.githubToken?.('');
      if (!token)
        throw new Error(
          'This machine has no GitHub credential: log in with `gh auth login`, or give the LAN host a token with `lan github setup`.'
        );
      return { workspaceId: workspace.id, repositories: await listGitHubRepositories(token) };
    }
    case 'sync':
      return await syncWorkspaceReplica(manager, workspace.id, {
        concurrency: command.concurrency,
        outputMode: 'json',
      });
    case 'export': {
      if (!path.isAbsolute(command.outputDir))
        throw new Error('The export directory must be an absolute path.');
      return await exportWorkspaceReplica(context, {
        outputDir: command.outputDir,
        offline: command.offline,
        hosted: false,
      });
    }
    case 'operation-list': {
      const { command: _, session, ...query } = command;
      return await listRequesterOperations(context, session, OperationListQuerySchema.parse(query));
    }
    case 'machine-list': {
      const { command: _, ...options } = command;
      return await readDetailedMachineList(
        {
          manager,
          workspaceId: workspace.id as WorkspaceId,
          machineId: auth.machineId as MachineId,
        },
        options
      );
    }
    case 'show': {
      // A JSON copy: the stored metadata may hold values JSON does not carry.
      return JSON.parse(
        JSON.stringify(
          await buildSessionShowResult(workspace, manager, command.sessionId as SessionId)
        )
      ) as Record<string, unknown>;
    }
  }
}
