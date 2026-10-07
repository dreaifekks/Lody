import { AsyncLocalStorage } from 'node:async_hooks';
import {
  getMachineRoomId,
  isLoroRepoDocDeleted,
  type MachineId,
  type MachineMeta,
  type WorkspaceId,
  type SessionId,
  type SessionActiveInvocationContextResult,
  type LodyNotifyUserInput,
  type LodyNotifyUserResult,
} from '@lody/shared';
import type { LoroStreamsMachineRpcClient } from '@lody/loro-streams-rpc';
import type { AuthContext } from './command-runtime';
import type { LoroDocumentManager } from './loro/doc';
import type { MachineAccessCheckResult, WorkspaceSummary } from './workspace';
import { readMachineLocalProjects } from './local-project-meta';
import type { SessionLiveStatusBatchItem } from '@/commands/session';

export interface SessionCommandHost {
  readInvocation(sessionId: SessionId): SessionActiveInvocationContextResult;
  readLiveStatus(sessionId: SessionId): Promise<SessionLiveStatusBatchItem>;
  cancelSession(
    sessionId: SessionId,
    turnId?: string
  ): Promise<{ success: boolean; error?: string }>;
  dispatchSession(sessionId: SessionId): Promise<void>;
  /**
   * The GitHub credential this machine uses for a repository: its own `gh`
   * login, else the LAN host's token; `null` when it has neither.
   */
  githubToken?(repoFullName: string): Promise<string | null>;
  /** `lody_notify_user`; absent where this machine sends no alerts. */
  notifyUser?(sessionId: SessionId, input: LodyNotifyUserInput): Promise<LodyNotifyUserResult>;
  /**
   * The other machines of a LAN's workspace, reached through the LAN's hub.
   * Absent where the workspace has no machine but this one.
   */
  remote?: SessionCommandRemote;
}

export interface SessionCommandRemote {
  /** Whether the machine is online, as the hub says; `null` while it cannot tell. */
  isOnline(machineId: MachineId): Promise<boolean | null>;
  withClient<T>(
    machineId: MachineId,
    fn: (client: LoroStreamsMachineRpcClient) => Promise<T>
  ): Promise<T>;
}

/** A daemon-owned workspace, never a second replica opened by an MCP process. */
export interface SessionCommandEnvironment {
  auth: AuthContext;
  workspace: WorkspaceSummary;
  manager: LoroDocumentManager;
  host: SessionCommandHost;
  checkMachineAccess(args: {
    workspaceId: WorkspaceId;
    machineId: MachineId;
    requesterUserId: string;
    localProjectId?: string;
  }): Promise<MachineAccessCheckResult>;
}

const environments = new AsyncLocalStorage<SessionCommandEnvironment>();
export const getSessionCommandEnvironment = () => environments.getStore();
export const runWithSessionCommandEnvironment = <T>(
  environment: SessionCommandEnvironment,
  run: () => T
): T => environments.run(environment, run);

export function createLocalSessionCommandEnvironment(args: {
  manager: LoroDocumentManager;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  machineName: string;
  userId: string;
  host: SessionCommandHost;
}): SessionCommandEnvironment {
  const { manager, workspaceId, machineId, userId } = args;
  return {
    auth: {
      token: '',
      userId,
      userName: userId,
      userEmail: '',
      machineId,
      machineName: args.machineName,
    },
    workspace: { id: workspaceId, name: 'Lody', slug: 'local', role: 'owner' },
    manager,
    host: args.host,
    async checkMachineAccess(target) {
      if (target.workspaceId !== workspaceId || target.requesterUserId !== userId)
        return { allowed: false, reason: 'requester_not_member' };
      // The other machines of a LAN are this user's too; nothing else is reached.
      if (target.machineId !== machineId && !args.host.remote)
        return { allowed: false, reason: 'machine_not_registered' };
      const row = await manager.repo.getDocMeta(getMachineRoomId(target.machineId));
      if (
        !row?.meta ||
        isLoroRepoDocDeleted(row) ||
        (row.meta as MachineMeta).ownerUserId !== userId
      )
        return { allowed: false, reason: 'not_visible' };
      // Only this machine's own projects are known here. Another machine's are in
      // its document, which this replica may hold an old copy of; that machine
      // answers for them when it runs the request.
      if (target.localProjectId && target.machineId === machineId) {
        const projects = await readMachineLocalProjects(manager.repo, workspaceId, machineId);
        if (!Object.values(projects).some((entry) => entry.id === target.localProjectId))
          return { allowed: false, reason: 'project_not_shared' };
      }
      return { allowed: true };
    },
  };
}
