import { resolveSessionMessageAuthor } from '../src/session/message-author';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalCloudPort } from '@lody/platform';
import {
  AGENT_ROLE_VERSION,
  getMachineFlockDocId,
  getMachineRoomId,
  getSessionRoomId,
  getWorkspaceFlockDocId,
  isLoroRepoDocDeleted,
  SESSION_CANCEL_NO_ACTIVE_TURN_ERROR,
  writeWorkspaceAgentRoleToFlock,
  deleteWorkspaceAgentRoleFromFlock,
  type AgentRoleId,
  type LocalProjectId,
  type MachineId,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import {
  createLocalSessionCommandEnvironment,
  runWithSessionCommandEnvironment,
} from '../src/lib/session-command-environment';
import {
  executeDaemonSessionTool,
  executeDaemonTerminalTool,
} from '../src/mcp/daemon-session-tools';
import { executeTerminalCommand } from '../src/commands/terminal-daemon';
import { buildLodyMcpServer, runWithMcpSessionContext } from '../src/mcp/lody-mcp-server';
import { LocalControlHandler } from '../src/lib/local-control-handler';
import {
  getLodyOperationStorePath,
  LodyOperationStore,
} from '../src/orchestration/operation-store';

import {
  applyLocalPlatformEnv,
  ensureImplicitLocalWorkspace,
  loadOrCreateLocalIdentity,
} from '../src/lib/cli-platform';
import { LoroDocumentManager } from '../src/lib/loro/doc';
import { upsertMachineLocalProject } from '../src/lib/local-project-meta';
import { WorkspaceSyncUnavailableError } from '../src/lib/command-runtime';
import { makeLocalWorkspaceCatalog } from '../src/lib/local-workspace-catalog';
import type { Logger } from '../src/utils/logger';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

describe('local platform zero-cloud integration', () => {
  let tempDir: string;
  let trapServer: http.Server;
  let cloudConnectionAttempts: number;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-zero-cloud-'));
    cloudConnectionAttempts = 0;
    trapServer = http.createServer((_request, response) => {
      cloudConnectionAttempts += 1;
      response.writeHead(503).end();
    });
    trapServer.on('connection', () => {
      cloudConnectionAttempts += 1;
    });
    await new Promise<void>((resolve, reject) => {
      trapServer.once('error', reject);
      trapServer.listen(0, '127.0.0.1', resolve);
    });
    const address = trapServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind the zero-cloud trap server');
    }
    const trapUrl = `http://127.0.0.1:${address.port}`;
    process.env.LODY_PLATFORM = 'local';
    process.env.LODY_DATA_DIR = path.join(tempDir, '.lody-oss');
    process.env.LODY_AUTH_URL = trapUrl;
    process.env.LODY_AUTH_SITE_URL = trapUrl;
    process.env.LODY_SERVER_URL = trapUrl;
  });

  afterEach(async () => {
    process.env = originalEnv;
    await new Promise<void>((resolve, reject) => {
      trapServer.close((error) => (error ? reject(error) : resolve()));
    });
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates a Role Session with the daemon repo, freezes its prompt and dispatches without cloud login', async () => {
    applyLocalPlatformEnv();
    const workspaceId = 'lw_role_test' as WorkspaceId;
    const machineId = 'local-role-machine' as MachineId;
    const userId = 'local:role-test';
    const manager = await LoroDocumentManager.create(workspaceId, userId, createSilentLogger());
    const dispatched: SessionId[] = [];
    try {
      await manager.registerMachine(machineId, {
        id: machineId,
        name: 'Local',
        ownerUserId: userId,
      });
      const configId = await manager.createAgentConfig('custom', 'claude', machineId, 'Synthetic');
      const sessionId = await manager.createSession(machineId, 'custom', 'claude');
      await manager.repo.upsertDocMeta(getSessionRoomId(sessionId), { agentConfigId: configId });
      const catalog = await manager.repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId));
      writeWorkspaceAgentRoleToFlock(catalog.flock, {
        v: AGENT_ROLE_VERSION,
        id: 'reviewer' as AgentRoleId,
        ownerUserId: userId,
        visibility: 'private',
        name: 'Reviewer',
        machineId,
        agentConfigId: configId,
        runConfig: {},
        promptPrefix: 'Review carefully.',
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      await manager.repo.flush();
      const environment = createLocalSessionCommandEnvironment({
        manager,
        workspaceId,
        machineId,
        machineName: 'Local',
        userId,
        host: {
          readInvocation: (id) => ({
            type: 'session/active-invocation-context',
            active: true,
            sessionId: id,
            requesterUserId: userId,
            sourceTurnId: 'source-turn',
            inputConfig: {
              cliType: 'custom',
              agentType: 'claude',
              modelId: 'source-model',
              agentRoleId: 'planner' as AgentRoleId,
              agentRoleRevision: 1,
              agentRoleSnapshot: { id: 'planner', revision: 1, name: 'Planner', emoji: '🧭' },
            },
          }),
          readLiveStatus: async (id) => ({
            sessionId: id,
            machineOnline: true,
            fresh: true,
            state: 'idle',
          }),
          cancelSession: async () => ({ success: true }),
          dispatchSession: async (id) => {
            dispatched.push(id);
          },
        },
      });
      const context = {
        machineId,
        workspaceId,
        sessionId,
        localControlSocketPath: undefined,
        workdir: tempDir,
      };
      const call = (name: string, args: unknown) =>
        runWithSessionCommandEnvironment(environment, () =>
          executeDaemonSessionTool(context, name, args)
        );
      const discovery = await call('lody_agent_role_list', {});
      expect(discovery.isError).not.toBe(true);
      expect(discovery.content[0]?.text).toContain('reviewer');
      const input = {
        operationId: 'role-create',
        agentRoleId: 'reviewer',
        prompt: 'Check the change.',
      };
      const control = new LocalControlHandler({
        machineId,
        logger: createSilentLogger(),
        dispatchSession: async () => {
          throw new Error('Unexpected session control');
        },
        dispatchProject: async () => {
          throw new Error('Unexpected project control');
        },
        dispatchMachineRpc: async (request) => {
          if (request.method !== 'session/call-tool') throw new Error('Unexpected RPC');
          return {
            ok: true,
            result: await runWithSessionCommandEnvironment(environment, () =>
              executeDaemonSessionTool(
                { ...context, sessionId: request.params.sessionId },
                request.params.name,
                request.params.arguments
              )
            ),
          };
        },
      });
      const socketPath =
        process.platform === 'win32'
          ? `\\\\.\\pipe\\lody-role-test-${process.pid}`
          : path.join(tempDir, 'control.sock');
      const socketServer = http.createServer((request, response) => {
        void (async () => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const result = await control.handle({
              path: request.url ?? '',
              rawBody: Buffer.concat(chunks).toString('utf8'),
              requestId: 1,
            });
            response
              .writeHead(result.status, { 'Content-Type': 'application/json' })
              .end(JSON.stringify(result.payload));
          } catch (error) {
            response.writeHead(500).end(String(error));
          }
        })();
      });
      await new Promise<void>((resolve, reject) => {
        socketServer.once('error', reject);
        socketServer.listen(socketPath, resolve);
      });
      const mcpServer = buildLodyMcpServer();
      const client = new Client({ name: 'local-role-test', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      let result;
      try {
        await mcpServer.connect(serverTransport);
        await client.connect(clientTransport);
        result = await runWithMcpSessionContext(
          { ...context, localControlSocketPath: socketPath },
          () => client.callTool({ name: 'lody_session_create', arguments: input })
        );
      } finally {
        await client.close();
        await mcpServer.close();
        await new Promise<void>((resolve, reject) =>
          socketServer.close((error) => (error ? reject(error) : resolve()))
        );
      }
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(dispatched).toHaveLength(1);
      const targetId = dispatched[0];
      if (!targetId) throw new Error('Role Session was not dispatched');
      const target = await manager.repo.getDocMeta(getSessionRoomId(targetId));
      expect(target?.meta).toMatchObject({
        agentRoleId: 'reviewer',
        agentRoleRevision: 1,
        openedBySessionId: sessionId,
      });
      const doc = await manager.getOrCreateSessionDoc(targetId);
      const history = await doc.sessionData.history.readAll();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        userId,
        author: {
          kind: 'agent',
          sessionId,
          turnId: 'source-turn',
          name: 'Synthetic',
          model: { id: 'source-model' },
          role: { id: 'planner', name: 'Planner', emoji: '🧭' },
        },
      });
      expect(history[0]?.inputConfig?.modelId).not.toBe('source-model');
      expect(history[0]?.items).toEqual([
        { type: 'text', text: 'Review carefully.\n\nCheck the change.' },
      ]);
      expect(target?.meta.latestUserMsgId).toBe(history[0]?.id);
      await call('lody_session_create', input);
      expect(dispatched).toEqual([targetId]);
      const store = new LodyOperationStore(getLodyOperationStorePath(machineId), undefined, {
        maintenance: false,
      });
      try {
        const operation = store.get(sessionId, 'role-create');
        expect(operation.items[0]).toMatchObject({
          inputDurable: true,
          target: { sessionId: targetId },
        });
        expect(operation.canonicalCommand).toMatchObject({ agentRoleRevision: 1 });
      } finally {
        store.close();
      }
      const targetMeta = target?.meta as import('@lody/shared').SessionMeta;
      const targetInput = history[0];
      if (!targetInput) throw new Error('Missing target input');
      deleteWorkspaceAgentRoleFromFlock(catalog.flock, 'reviewer' as AgentRoleId);
      const targetAuthor = await resolveSessionMessageAuthor(
        manager,
        targetMeta,
        targetInput.id,
        targetInput.inputConfig,
        undefined,
        workspaceId
      );
      await doc.sessionData.commands.appendTurn({
        id: `assistant:${targetInput.id}`,
        role: 'assistant',
        timestamp: targetInput.timestamp,
        userTurnId: targetInput.id,
        author: targetAuthor,
        items: [{ type: 'text', text: 'Synthetic response' }],
        finished: true,
        fileDiff: [],
      });
      const fromTarget = {
        ...environment,
        host: {
          ...environment.host,
          readInvocation: (id: SessionId) => ({
            type: 'session/active-invocation-context' as const,
            active: true as const,
            sessionId: id,
            requesterUserId: userId,
            sourceTurnId: targetInput.id,
            inputConfig: targetInput.inputConfig ?? {},
          }),
        },
      };
      const chat = await runWithSessionCommandEnvironment(fromTarget, () =>
        executeDaemonSessionTool({ ...context, sessionId: targetId }, 'lody_session_chat', {
          operationId: 'reply-to-source',
          sessionId,
          prompt: 'Review completed.',
        })
      );
      expect(chat.isError, JSON.stringify(chat)).not.toBe(true);
      const sourceDoc = await manager.getOrCreateSessionDoc(sessionId);
      const reply = (await sourceDoc.sessionData.history.readAll()).at(-1);
      expect(reply).toMatchObject({
        userId,
        author: {
          sessionId: targetId,
          turnId: targetInput.id,
          role: { id: 'reviewer', name: 'Reviewer' },
        },
      });

      const denied = await environment.checkMachineAccess({
        workspaceId,
        machineId: 'remote' as MachineId,
        requesterUserId: userId,
      });
      expect(denied.allowed).toBe(false);
      const deniedUser = await environment.checkMachineAccess({
        workspaceId,
        machineId,
        requesterUserId: 'another-user',
      });
      expect(deniedUser.allowed).toBe(false);
      await expect(
        runWithSessionCommandEnvironment(environment, () =>
          executeDaemonSessionTool(
            { ...context, workspaceId: 'wrong-workspace' },
            'lody_agent_role_list',
            {}
          )
        )
      ).rejects.toThrow('scope mismatch');
      await expect(
        runWithSessionCommandEnvironment(
          {
            ...environment,
            host: {
              ...environment.host,
              readInvocation: (id) => ({
                type: 'session/active-invocation-context',
                sessionId: id,
                active: false,
              }),
            },
          },
          () => executeDaemonSessionTool(context, 'lody_session_create', input)
        )
      ).rejects.toThrow('active local user Turn');
      await expect(call('lody_feedback', { feedback: 'not allowed' })).rejects.toThrow(
        'Unsupported daemon Session tool'
      );
      // An MCP server the user asked for lands in the workspace catalog on the daemon's replica.
      const configured = await call('lody_mcp_configure', {
        name: 'Docs',
        connection: { transport: 'stdio', command: 'docs-mcp' },
      });
      expect(configured.isError, JSON.stringify(configured)).not.toBe(true);
      const mcpServers = await call('lody_mcp_list', {});
      expect(mcpServers.content[0]?.text).toContain('Docs');
      expect(cloudConnectionAttempts).toBe(0);
    } finally {
      await manager.cleanUp({ fast: true, preserveSessionStatus: true });
    }
  });

  it('creates a Session on another machine of the LAN and asks that machine, not this one, to run it', async () => {
    applyLocalPlatformEnv();
    const workspaceId = 'lw_lan_test' as WorkspaceId;
    const machineId = 'lan-desk' as MachineId;
    const peerId = 'lan-server' as MachineId;
    const userId = 'local:lan-test';
    const manager = await LoroDocumentManager.create(workspaceId, userId, createSilentLogger());
    const dispatchedHere: SessionId[] = [];
    const askedPeer: Array<{ machineId: MachineId; method: string; sessionId: SessionId }> = [];
    const gitStateAsked: Array<{ machineId: MachineId; localProjectId: string }> = [];
    const cancelRequests: Array<{ sessionId: SessionId; turnId: string | undefined }> = [];
    let peerOnline: boolean | null = true;
    try {
      await manager.registerMachine(machineId, {
        id: machineId,
        name: 'Desk',
        ownerUserId: userId,
      });
      // The other machines of the LAN registered themselves; this replica holds what they wrote.
      for (const [id, owner] of [
        [peerId, userId],
        ['stranger', 'local:someone-else'],
      ] as const) {
        await manager.repo.upsertDocMeta(getMachineRoomId(id as MachineId), {
          id,
          name: id,
          ownerUserId: owner,
        } as Parameters<typeof manager.repo.upsertDocMeta>[1]);
      }
      const peerConfigId = await manager.createAgentConfig('custom', 'claude', peerId, 'Synthetic');
      await upsertMachineLocalProject(manager.repo, workspaceId, peerId, {
        id: 'peer-project' as LocalProjectId,
        name: 'Peer project',
        rootPath: '/srv/peer-project',
        createdAtMs: 1,
      });
      const sessionId = await manager.createSession(machineId, 'custom', 'claude');
      const catalog = await manager.repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId));
      writeWorkspaceAgentRoleToFlock(catalog.flock, {
        v: AGENT_ROLE_VERSION,
        id: 'peer-reviewer' as AgentRoleId,
        ownerUserId: userId,
        visibility: 'private',
        name: 'Peer reviewer',
        machineId: peerId,
        agentConfigId: peerConfigId,
        runConfig: {},
        promptPrefix: 'Review carefully.',
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      await manager.repo.flush();
      const environment = createLocalSessionCommandEnvironment({
        manager,
        workspaceId,
        machineId,
        machineName: 'Desk',
        userId,
        host: {
          readInvocation: (id) => ({
            type: 'session/active-invocation-context',
            active: true,
            sessionId: id,
            requesterUserId: userId,
            sourceTurnId: 'source-turn',
            inputConfig: { cliType: 'custom', agentType: 'claude' },
          }),
          readLiveStatus: async (id) => ({ sessionId: id, machineOnline: true, fresh: true }),
          cancelSession: async (id, turnId) => {
            cancelRequests.push({ sessionId: id, turnId });
            return { success: true };
          },
          dispatchSession: async (id) => {
            dispatchedHere.push(id);
          },
          remote: {
            isOnline: async () => peerOnline,
            withClient: async (target, fn) =>
              await fn({
                requestSessionDispatchTurn: async (options: { sessionId: SessionId }) => {
                  askedPeer.push({
                    machineId: target,
                    method: 'session/dispatch-turn',
                    sessionId: options.sessionId,
                  });
                  return null;
                },
                requestLocalProjectGitState: async (options: { localProjectId: string }) => {
                  gitStateAsked.push({ machineId: target, localProjectId: options.localProjectId });
                  return {
                    type: 'local-project/git-state_response',
                    machineId: target,
                    workspaceId,
                    localProjectId: options.localProjectId,
                    success: true,
                    state: {
                      git: true,
                      currentBranch: 'feature',
                      defaultBranch: 'main',
                      branches: ['main', 'feature'],
                      githubRepoFullName: null,
                      workingTree: {
                        clean: true,
                        staged: false,
                        unstaged: false,
                        untracked: false,
                        conflicted: false,
                      },
                    },
                    observedAtMs: 1,
                  };
                },
              } as unknown as Parameters<typeof fn>[0]),
          },
        },
      });
      const context = {
        machineId,
        workspaceId,
        sessionId,
        localControlSocketPath: undefined,
        workdir: tempDir,
      };
      const call = (name: string, args: unknown) =>
        runWithSessionCommandEnvironment(environment, () =>
          executeDaemonSessionTool(context, name, args)
        );

      const created = await call('lody_session_create', {
        operationId: 'peer-create',
        agentRoleId: 'peer-reviewer',
        prompt: 'Check the change.',
      });
      expect(created.isError, JSON.stringify(created)).not.toBe(true);
      expect(dispatchedHere).toEqual([]);
      expect(askedPeer).toHaveLength(1);
      expect(askedPeer[0]?.machineId).toBe(peerId);
      const target = await manager.repo.getDocMeta(getSessionRoomId(askedPeer[0]!.sessionId));
      expect(target?.meta).toMatchObject({ machineId: peerId, openedBySessionId: sessionId });
      expect(typeof target?.meta.latestUserMsgId).toBe('string');

      // A project of the other machine: its git state is read from that machine over the LAN.
      const inProject = await call('lody_session_create', {
        operationId: 'peer-project-create',
        machineId: peerId,
        agentConfigId: peerConfigId,
        prompt: 'Work in the project.',
        workContext: { kind: 'local', projectId: 'peer-project', worktree: true },
      });
      expect(inProject.isError, JSON.stringify(inProject)).not.toBe(true);
      expect(gitStateAsked).toContainEqual({ machineId: peerId, localProjectId: 'peer-project' });
      expect(gitStateAsked.every((ask) => ask.machineId === peerId)).toBe(true);
      expect(askedPeer).toHaveLength(2);
      const projectSession = await manager.repo.getDocMeta(
        getSessionRoomId(askedPeer[1]!.sessionId)
      );
      expect(projectSession?.meta).toMatchObject({
        machineId: peerId,
        project: {
          kind: 'local',
          localProjectId: 'peer-project',
          branch: 'feature',
          useWorktree: true,
        },
      });

      // A turn the other machine runs is cancelled through this machine's agent service.
      const peerSessionId = askedPeer[0]!.sessionId;
      const cancelled = await call('lody_session_cancel', { sessionId: peerSessionId });
      expect(cancelled.isError, JSON.stringify(cancelled)).not.toBe(true);
      expect(cancelRequests).toEqual([{ sessionId: peerSessionId, turnId: undefined }]);
      // Cancelling the Operation names the target's assistant turn, the id a machine matches.
      const operation = await call('lody_operation_cancel', { operationId: 'peer-create' });
      expect(operation.isError, JSON.stringify(operation)).not.toBe(true);
      const peerMeta = await manager.repo.getDocMeta(getSessionRoomId(peerSessionId));
      const peerUserTurnId = (peerMeta?.meta as SessionMeta | undefined)?.latestUserMsgId;
      expect(cancelRequests[1]).toEqual({
        sessionId: peerSessionId,
        turnId: `assistant:${peerUserTurnId}`,
      });

      peerOnline = false;
      const offline = await call('lody_session_create', {
        operationId: 'peer-create-offline',
        agentRoleId: 'peer-reviewer',
        prompt: 'Check it again.',
      });
      expect(JSON.stringify(offline)).toContain('offline');
      expect(askedPeer).toHaveLength(2);

      expect(
        (
          await environment.checkMachineAccess({
            workspaceId,
            machineId: 'stranger' as MachineId,
            requesterUserId: userId,
          })
        ).allowed
      ).toBe(false);
      expect(cloudConnectionAttempts).toBe(0);
    } finally {
      await manager.cleanUp({ fast: true, preserveSessionStatus: true });
    }
  });

  it("leaves another machine's state to that machine and reports a failed sync as one", async () => {
    applyLocalPlatformEnv();
    const workspaceId = 'lw_lan_peer_state' as WorkspaceId;
    const machineId = 'peer-state-desk' as MachineId;
    const peerId = 'peer-state-server' as MachineId;
    const userId = 'local:peer-state';
    const manager = await LoroDocumentManager.create(workspaceId, userId, createSilentLogger());
    const askedPeer: Array<{ method: string; sessionId: SessionId }> = [];
    const cancelRequests: Array<{ sessionId: SessionId; turnId: string | undefined }> = [];
    let peerAnswer: { success: boolean; error?: string } = { success: true };
    try {
      await manager.registerMachine(machineId, {
        id: machineId,
        name: 'Desk',
        ownerUserId: userId,
      });
      await manager.repo.upsertDocMeta(getMachineRoomId(peerId), {
        id: peerId,
        name: 'Server',
        ownerUserId: userId,
      } as Parameters<typeof manager.repo.upsertDocMeta>[1]);
      const sessionId = await manager.createSession(machineId, 'custom', 'claude');
      // A session on the other machine, in a project this replica has not received yet.
      const peerSessionId = await manager.createSession(peerId, 'custom', 'claude');
      await manager.repo.upsertDocMeta(getSessionRoomId(peerSessionId), {
        project: { kind: 'local', localProjectId: 'unsynced-project' },
      } as Parameters<typeof manager.repo.upsertDocMeta>[1]);
      await manager.repo.flush();
      const environment = createLocalSessionCommandEnvironment({
        manager,
        workspaceId,
        machineId,
        machineName: 'Desk',
        userId,
        host: {
          readInvocation: (id) => ({
            type: 'session/active-invocation-context',
            active: true,
            sessionId: id,
            requesterUserId: userId,
            sourceTurnId: 'source-turn',
            inputConfig: { cliType: 'custom', agentType: 'claude' },
          }),
          readLiveStatus: async (id) => ({ sessionId: id, machineOnline: true, fresh: true }),
          cancelSession: async (id, turnId) => {
            cancelRequests.push({ sessionId: id, turnId });
            return peerAnswer;
          },
          dispatchSession: async () => {},
          remote: {
            isOnline: async () => true,
            withClient: async (_target, fn) =>
              await fn({
                requestSessionDispatchTurn: async (options: { sessionId: SessionId }) => {
                  askedPeer.push({ method: 'session/dispatch-turn', sessionId: options.sessionId });
                  return null;
                },
              } as unknown as Parameters<typeof fn>[0]),
          },
        },
      });
      const call = (name: string, args: unknown) =>
        runWithSessionCommandEnvironment(environment, () =>
          executeDaemonSessionTool(
            {
              machineId,
              workspaceId,
              sessionId,
              localControlSocketPath: undefined,
              workdir: tempDir,
            },
            name,
            args
          )
        );
      const run = (command: Parameters<typeof executeTerminalCommand>[1]) =>
        runWithSessionCommandEnvironment(environment, () =>
          executeTerminalCommand({ machineId, workspaceId }, command)
        );

      // The project is the other machine's to know; this replica's copy does not decide.
      const chatted = await call('lody_session_chat', {
        operationId: 'peer-chat',
        sessionId: peerSessionId,
        prompt: 'Carry on.',
      });
      expect(chatted.isError, JSON.stringify(chatted)).not.toBe(true);
      expect(askedPeer).toEqual([{ method: 'session/dispatch-turn', sessionId: peerSessionId }]);

      // A terminal's cancel lets the machine that runs the session pick its turn,
      // whatever this replica's copy of the history shows.
      expect(await run({ command: 'cancel', sessionId: peerSessionId })).toMatchObject({
        sessionId: peerSessionId,
        response: { success: true },
      });
      expect(cancelRequests).toEqual([{ sessionId: peerSessionId, turnId: undefined }]);
      peerAnswer = { success: false, error: SESSION_CANCEL_NO_ACTIVE_TURN_ERROR };
      expect(await run({ command: 'cancel', sessionId: peerSessionId })).toEqual({
        sessionId: peerSessionId,
        alreadyStopped: true,
      });

      // A session the other machine just started reaches this replica with the sync.
      const lateSessionId = 'peer-state-late-session' as SessionId;
      vi.spyOn(manager, 'syncMetaOrThrow').mockImplementationOnce(async () => {
        await manager.repo.upsertDocMeta(getSessionRoomId(lateSessionId), {
          id: lateSessionId,
          machineId: peerId,
          userId,
        } as Parameters<typeof manager.repo.upsertDocMeta>[1]);
      });
      peerAnswer = { success: true };
      const cancelled = await call('lody_session_cancel', { sessionId: lateSessionId });
      expect(cancelled.isError, JSON.stringify(cancelled)).not.toBe(true);
      expect(cancelRequests.at(-1)).toEqual({ sessionId: lateSessionId, turnId: undefined });

      // A sync that fails is reported as one, to retry, not as a session that is not there.
      vi.spyOn(manager, 'syncMetaOrThrow').mockRejectedValueOnce(new Error('hub unreachable'));
      const unsynced = await call('lody_session_cancel', { sessionId: peerSessionId });
      expect(unsynced.isError).toBe(true);
      expect(JSON.stringify(unsynced)).toContain('SYNC_UNAVAILABLE');
      expect(JSON.stringify(unsynced)).not.toContain('not found');

      // An agent config written on the other machine is read after its document syncs.
      const peerFlockDocId = getMachineFlockDocId(workspaceId, peerId);
      const syncFlock = manager.syncFlockDocOrThrow.bind(manager);
      vi.spyOn(manager, 'syncFlockDocOrThrow').mockImplementation(async (id, options) => {
        if (id === peerFlockDocId && !(await manager.hasAgentConfig('custom', 'claude', peerId)))
          await manager.createAgentConfig('custom', 'claude', peerId, 'Server agent');
        await syncFlock(id, options);
      });
      expect(await run({ command: 'agent-config-show', selector: 'Server agent' })).toMatchObject({
        agentConfig: { name: 'Server agent', machineId: peerId },
      });
      vi.spyOn(manager, 'syncFlockDocOrThrow').mockRejectedValue(new Error('hub unreachable'));
      await expect(
        run({ command: 'agent-config-show', selector: 'Server agent' })
      ).rejects.toBeInstanceOf(WorkspaceSyncUnavailableError);
      const projects = await call('lody_project_list', { kind: 'local' });
      expect(projects.isError).toBe(true);
      expect(JSON.parse((projects.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
        ok: false,
        error: { code: 'SYNC_UNAVAILABLE', retryable: true },
      });
      expect(cloudConnectionAttempts).toBe(0);
    } finally {
      vi.restoreAllMocks();
      await manager.cleanUp({ fast: true, preserveSessionStatus: true });
    }
  });

  it("answers a terminal's read-only tools as the machine's user, with no Turn driving them", async () => {
    applyLocalPlatformEnv();
    const workspaceId = 'lw_terminal_test' as WorkspaceId;
    const machineId = 'terminal-desk' as MachineId;
    const userId = 'local:terminal-test';
    const manager = await LoroDocumentManager.create(workspaceId, userId, createSilentLogger());
    try {
      await manager.registerMachine(machineId, {
        id: machineId,
        name: 'Desk',
        ownerUserId: userId,
      });
      const configId = await manager.createAgentConfig('custom', 'claude', machineId, 'Synthetic');
      const sessionId = await manager.createSession(machineId, 'custom', 'claude');
      await manager.repo.flush();
      const environment = createLocalSessionCommandEnvironment({
        manager,
        workspaceId,
        machineId,
        machineName: 'Desk',
        userId,
        host: {
          // No Session of this machine is running a Turn.
          readInvocation: (id) => ({
            type: 'session/active-invocation-context',
            sessionId: id,
            active: false,
          }),
          readLiveStatus: async (id) => ({ sessionId: id, machineOnline: true, fresh: true }),
          cancelSession: async () => ({ success: true }),
          dispatchSession: async () => {
            throw new Error('A terminal read must not dispatch');
          },
        },
      });
      const scope: { machineId: string; workspaceId: string } = { machineId, workspaceId };
      const call = (name: string, args: unknown, target = scope) =>
        runWithSessionCommandEnvironment(environment, () =>
          executeDaemonTerminalTool(target, name, args)
        );
      const payload = (result: { content: Array<{ text: string }>; isError?: boolean }) => {
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        return JSON.parse(result.content.map((part) => part.text).join(''));
      };

      expect(payload(await call('lody_session_list', {})).items).toEqual([
        expect.objectContaining({ id: sessionId, machineId, isMine: true }),
      ]);
      expect(payload(await call('lody_session_history', { sessionId }))).toMatchObject({
        sessionId,
        items: [],
      });
      expect(
        payload(await call('lody_session_status_many', { sessionIds: [sessionId] })).items
      ).toEqual([expect.objectContaining({ sessionId, ok: true })]);
      expect(payload(await call('lody_agent_config_list', {})).items).toEqual([
        expect.objectContaining({ id: configId, machineId }),
      ]);
      expect(payload(await call('lody_machine_list', {})).items).toEqual([
        expect.objectContaining({ id: machineId, name: 'Desk' }),
      ]);

      const current = await call('lody_session_history', {});
      expect(current.isError).toBe(true);
      expect(current.content[0]?.text).toContain('no current Session');
      await expect(
        call('lody_session_create', { operationId: 'terminal', prompt: 'Not from here.' })
      ).rejects.toThrow('not available from a terminal');
      await expect(
        call('lody_session_list', {}, { ...scope, workspaceId: 'wrong-workspace' })
      ).rejects.toThrow('scope mismatch');
      expect(cloudConnectionAttempts).toBe(0);
    } finally {
      await manager.cleanUp({ fast: true, preserveSessionStatus: true });
    }
  });

  it("runs a terminal's session commands on the daemon replica as the machine's user", async () => {
    applyLocalPlatformEnv();
    const workspaceId = 'lw_terminal_write' as WorkspaceId;
    const machineId = 'terminal-write-desk' as MachineId;
    const userId = 'local:terminal-write';
    const manager = await LoroDocumentManager.create(workspaceId, userId, createSilentLogger());
    const dispatched: SessionId[] = [];
    let invocationActive = false;
    let githubToken: string | null = null;
    // GitHub as the LAN's credential sees it: one repository on a `trunk` branch.
    const githubRequests: string[] = [];
    const repository = {
      id: 7,
      name: 'tool',
      full_name: 'acme/tool',
      private: true,
      default_branch: 'trunk',
    };
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      githubRequests.push(`${new Headers(init?.headers).get('authorization')} ${url}`);
      if (url === 'https://api.github.com/repos/acme/tool') return Response.json(repository);
      if (url.startsWith('https://api.github.com/user/repos?')) return Response.json([repository]);
      return new Response('{}', { status: 404 });
    });
    try {
      await manager.registerMachine(machineId, {
        id: machineId,
        name: 'Desk',
        ownerUserId: userId,
      });
      const configId = await manager.createAgentConfig('custom', 'claude', machineId, 'Synthetic');
      await manager.repo.flush();
      const environment = createLocalSessionCommandEnvironment({
        manager,
        workspaceId,
        machineId,
        machineName: 'Desk',
        userId,
        host: {
          readInvocation: (id) =>
            invocationActive
              ? {
                  type: 'session/active-invocation-context',
                  active: true,
                  sessionId: id,
                  requesterUserId: userId,
                  sourceTurnId: 'source-turn',
                  inputConfig: { cliType: 'custom', agentType: 'claude' },
                }
              : { type: 'session/active-invocation-context', sessionId: id, active: false },
          readLiveStatus: async (id) => ({ sessionId: id, machineOnline: true, fresh: true }),
          cancelSession: async () => ({
            success: false,
            error: SESSION_CANCEL_NO_ACTIVE_TURN_ERROR,
          }),
          dispatchSession: async (id) => {
            dispatched.push(id);
          },
          githubToken: async () => githubToken,
        },
      });
      const run = (command: Parameters<typeof executeTerminalCommand>[1]) =>
        runWithSessionCommandEnvironment(environment, () =>
          executeTerminalCommand({ machineId, workspaceId }, command)
        );
      const meta = async (id: SessionId) =>
        (await manager.repo.getDocMeta(getSessionRoomId(id)))?.meta as SessionMeta | undefined;
      const userPrompts = async (id: SessionId) =>
        (await (await manager.getOrCreateSessionDoc(id)).sessionData.history.readAll())
          .filter((turn) => turn.role === 'user')
          .map((turn) => turn.items);

      const created = await run({ command: 'create', prompt: 'Start here.', title: 'Terminal' });
      const sessionId = created.sessionId as SessionId;
      expect(created).toMatchObject({ machineId, agentConfigId: configId, workspaceId });
      expect(dispatched).toEqual([sessionId]);
      expect(await meta(sessionId)).toMatchObject({ title: 'Terminal', userId });

      const chatted = await run({ command: 'chat', sessionId, prompt: 'And then this.' });
      expect(dispatched).toEqual([sessionId, sessionId]);
      expect(await userPrompts(sessionId)).toEqual([
        [{ type: 'text', text: 'Start here.' }],
        [{ type: 'text', text: 'And then this.' }],
      ]);
      expect(chatted.userTurnId).not.toBe(created.userTurnId);

      await run({ command: 'rename', sessionId, title: 'Renamed' });
      expect(await run({ command: 'show', sessionId })).toMatchObject({
        session: { id: sessionId, title: 'Renamed' },
        historyCount: 2,
      });
      // Nothing runs, so the machine answers that it has no turn to stop.
      expect(await run({ command: 'cancel', sessionId })).toEqual({
        sessionId,
        alreadyStopped: true,
      });
      expect(
        ((await run({ command: 'machine-list', includeAgents: true })).machines as unknown[])[0]
      ).toMatchObject({ id: machineId, agentConfigs: [expect.objectContaining({ id: configId })] });

      await run({ command: 'archive', sessionId });
      expect((await meta(sessionId))?.isArchived).toBe(true);
      await run({ command: 'restore', sessionId });
      expect((await meta(sessionId))?.isArchived).not.toBe(true);
      await expect(run({ command: 'delete', sessionId })).rejects.toThrow('is not archived');

      // An Agent archives through the same replica rather than a hosted command line.
      const requester = (await run({ command: 'create', prompt: 'Requester.' }))
        .sessionId as SessionId;
      invocationActive = true;
      const archived = await runWithSessionCommandEnvironment(environment, () =>
        executeDaemonSessionTool(
          {
            machineId,
            workspaceId,
            sessionId: requester,
            localControlSocketPath: undefined,
            workdir: tempDir,
          },
          'lody_session_archive',
          { sessionId }
        )
      );
      expect(archived.isError, JSON.stringify(archived)).not.toBe(true);
      expect((await meta(sessionId))?.isArchived).toBe(true);
      await run({ command: 'delete', sessionId });
      const deleted = await manager.repo.getDocMeta(getSessionRoomId(sessionId));
      expect(deleted && isLoroRepoDocDeleted(deleted)).toBe(true);

      // Agent configs and MCP servers are catalog edits on the same replica.
      const second = await run({
        command: 'agent-config-create',
        agentType: 'codex',
        name: 'Second',
        env: { OLD: '1' },
      });
      await run({
        command: 'agent-config-update',
        selector: second.agentConfigId as string,
        name: 'Renamed config',
        env: { set: { NEW: '2' }, unset: ['OLD'] },
        description: { value: 'Edited' },
      });
      expect(
        await run({ command: 'agent-config-show', selector: 'Renamed config', showSecrets: true })
      ).toMatchObject({
        agentConfig: { name: 'Renamed config', description: 'Edited', env: { NEW: '2' } },
      });
      await run({ command: 'agent-config-delete', selector: 'Renamed config' });
      await expect(
        run({ command: 'agent-config-show', selector: 'Renamed config' })
      ).rejects.toThrow('not found');
      const added = await run({
        command: 'mcp',
        action: 'add',
        selector: 'docs',
        offline: true,
        options: { command: 'docs-server', arg: ['--stdio'] },
      });
      expect(added).toMatchObject({
        payload: { server: { name: 'docs' } },
        result: { changed: true },
      });
      await run({
        command: 'mcp',
        action: 'set',
        selector: 'docs',
        offline: true,
        options: { default: true },
      });
      await run({ command: 'mcp', action: 'remove', selector: 'docs', offline: true, options: {} });

      // A repository opens through the LAN's GitHub credential, on its own default branch.
      await expect(run({ command: 'github-list' })).rejects.toThrow('no GitHub credential');
      await expect(
        run({ command: 'create', prompt: 'Fix it.', repo: 'acme/tool' })
      ).rejects.toThrow('no GitHub credential');
      githubToken = 'lan-token';
      expect(await run({ command: 'github-list' })).toMatchObject({
        repositories: [{ fullName: 'acme/tool', private: true }],
      });
      // Agents find the same repositories; the local platform keeps no registry of them.
      const githubProjects = await runWithSessionCommandEnvironment(environment, () =>
        executeDaemonTerminalTool({ machineId, workspaceId }, 'lody_project_list', {
          kind: 'github',
        })
      );
      expect(githubProjects.content[0]?.text).toContain('acme/tool');
      const repoSession = (await run({ command: 'create', prompt: 'Fix it.', repo: 'acme/tool' }))
        .sessionId as SessionId;
      expect((await meta(repoSession))?.project).toMatchObject({
        kind: 'github',
        repoFullName: 'acme/tool',
        branch: 'trunk',
      });
      await expect(
        run({ command: 'create', prompt: 'Fix it.', repo: 'acme/hidden' })
      ).rejects.toThrow('not available to this machine');
      expect(githubRequests.every((request) => request.startsWith('Bearer lan-token '))).toBe(true);

      expect(await run({ command: 'operation-list', session: requester })).toMatchObject({
        items: [],
      });
      expect(await run({ command: 'sync', concurrency: 2 })).toMatchObject({
        failed: { meta: 0, doc: 0, flock: 0 },
      });
      const exportDir = path.join(tempDir, 'export');
      const exported = await run({ command: 'export', outputDir: exportDir });
      expect(exported.sessionCount).toBeGreaterThan(0);
      await expect(
        fs.readFile(path.join(String(exported.outputDir), 'sessions', 'index.json'), 'utf8')
      ).resolves.toContain(requester);
      await expect(run({ command: 'export', outputDir: 'relative' })).rejects.toThrow('absolute');
      expect(cloudConnectionAttempts).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      await manager.cleanUp({ fast: true, preserveSessionStatus: true });
    }
  });

  it('starts and drives an auto review session as the machine, with no hosted account', async () => {
    applyLocalPlatformEnv();
    const workspaceId = 'lw_auto_review' as WorkspaceId;
    const machineId = 'auto-review-desk' as MachineId;
    const userId = 'local:auto-review';
    const manager = await LoroDocumentManager.create(workspaceId, userId, createSilentLogger());
    const dispatched: SessionId[] = [];
    let reviewerTurnRunning = false;
    try {
      await manager.registerMachine(machineId, {
        id: machineId,
        name: 'Desk',
        ownerUserId: userId,
      });
      const configId = await manager.createAgentConfig('custom', 'claude', machineId, 'Synthetic');
      await manager.repo.flush();
      const environment = createLocalSessionCommandEnvironment({
        manager,
        workspaceId,
        machineId,
        machineName: 'Desk',
        userId,
        host: {
          readInvocation: (id) =>
            reviewerTurnRunning
              ? {
                  type: 'session/active-invocation-context',
                  active: true,
                  sessionId: id,
                  requesterUserId: userId,
                  sourceTurnId: 'review-turn',
                  inputConfig: { cliType: 'custom', agentType: 'claude' },
                }
              : { type: 'session/active-invocation-context', sessionId: id, active: false },
          readLiveStatus: async (id) => ({ sessionId: id, machineOnline: true, fresh: true }),
          cancelSession: async () => ({ success: true }),
          dispatchSession: async (id) => {
            dispatched.push(id);
          },
          githubToken: async () => null,
        },
      });
      const { createSessionResult, resolveTurnDispatchConfig, sendSessionChatResult } =
        await import('../src/commands/session');
      const workspace = { id: workspaceId, name: 'LAN', slug: 'lan' } as Parameters<
        typeof createSessionResult
      >[1];
      // What auto review does: a reviewer under the authoring session, then a follow-up.
      const author = await runWithSessionCommandEnvironment(environment, () =>
        createSessionResult(
          environment.auth,
          workspace,
          manager,
          'Write it.',
          { agentConfig: configId },
          resolveTurnDispatchConfig({})
        )
      );
      const reviewer = await runWithSessionCommandEnvironment(environment, () =>
        createSessionResult(
          environment.auth,
          workspace,
          manager,
          'Review it.',
          { parent: author.sessionId, title: 'Review', agentConfig: configId },
          resolveTurnDispatchConfig({})
        )
      );
      await runWithSessionCommandEnvironment(environment, () =>
        sendSessionChatResult(
          environment.auth,
          workspace,
          manager,
          reviewer.sessionId as SessionId,
          'Look again.',
          resolveTurnDispatchConfig({})
        )
      );

      expect(dispatched).toEqual([author.sessionId, reviewer.sessionId, reviewer.sessionId]);
      expect(
        (await manager.repo.getDocMeta(getSessionRoomId(reviewer.sessionId as SessionId)))?.meta
      ).toMatchObject({ parentSessionId: author.sessionId, title: 'Review' });
      // Another identity than the environment's is refused, not checked against a hosted account.
      await expect(
        runWithSessionCommandEnvironment(environment, () =>
          createSessionResult(
            { ...environment.auth },
            workspace,
            manager,
            'Again.',
            { agentConfig: configId },
            resolveTurnDispatchConfig({})
          )
        )
      ).rejects.toThrow('identity mismatch');

      // The reviewer reports through the daemon, which answers from the workspace's
      // review runs instead of a hosted account; this one belongs to no run.
      reviewerTurnRunning = true;
      const submitted = await runWithSessionCommandEnvironment(environment, () =>
        executeDaemonSessionTool(
          {
            machineId,
            workspaceId,
            sessionId: reviewer.sessionId as SessionId,
            localControlSocketPath: undefined,
            workdir: os.tmpdir(),
          },
          'lody_review_submit',
          { verdict: 'approve' }
        )
      );
      expect(submitted.content[0]?.text).toContain('REVIEW_RUN_NOT_FOUND');
      expect(cloudConnectionAttempts).toBe(0);
    } finally {
      await manager.cleanUp({ fast: true, preserveSessionStatus: true });
    }
  });

  it('bootstraps identity, workspace, and the local data plane without touching cloud endpoints', async () => {
    applyLocalPlatformEnv();
    const logger = createSilentLogger();
    const identity = await loadOrCreateLocalIdentity(logger);
    const catalog = makeLocalWorkspaceCatalog({
      filePath: path.join(tempDir, '.lody-oss', 'workspace-catalog.json'),
      lockName: `zero-cloud-${process.pid}`,
      cacheTtlMs: Number.POSITIVE_INFINITY,
    });
    const workspace = await ensureImplicitLocalWorkspace({
      catalog,
      identity,
      machineId: 'local-machine',
      machineName: 'local-host',
      logger,
    });
    const cloudPort = createLocalCloudPort({
      identity: { userId: identity.userId },
      workspaces: [workspace],
    });

    const snapshot = await Effect.runPromise(catalog.read());
    expect(snapshot.identity?.userId).toBe(identity.userId);
    expect(snapshot.workspaces).toHaveLength(1);
    expect(cloudPort.streamsTokens).toBeNull();
    expect(cloudPort.attachmentUpload).toBeNull();
    expect(cloudPort.remotePreview).toBeNull();

    const documentManager = await LoroDocumentManager.create(
      workspace.id as WorkspaceId,
      identity.userId,
      logger,
      {
        streamsTokens: cloudPort.streamsTokens,
        cloudBilling: cloudPort.billing,
      }
    );
    try {
      expect(documentManager.isTransportConnected()).toBe(true);
      await expect(
        cloudPort.access.verifyMachineAccess({
          workspaceId: workspace.id as WorkspaceId,
          requesterUserId: identity.userId,
          machineId: 'local-machine',
        })
      ).resolves.toEqual({ allowed: true });
    } finally {
      await documentManager.cleanUp({ fast: true, preserveSessionStatus: true });
      await cloudPort.dispose();
    }

    expect(process.env.LODY_AUTH_URL).toBeUndefined();
    expect(process.env.LODY_AUTH_SITE_URL).toBeUndefined();
    expect(process.env.LODY_SERVER_URL).toBeUndefined();
    expect(cloudConnectionAttempts).toBe(0);
  });
});
