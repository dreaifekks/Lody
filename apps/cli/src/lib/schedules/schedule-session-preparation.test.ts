import { findNextDispatchableUserTurn } from '@/session/session-dispatch-logic';
import {
  buildScheduleRegistryRow,
  getSessionRoomId,
  getWorkspaceFlockDocId,
  normalizeBoardMeta,
  ScheduleAgentSchema,
  ScheduleDefinitionSchema,
  scheduleOwnSessionId,
  sessionDocSchema,
  type AcpCapabilityCacheEntry,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleTarget,
  type MachineMeta,
  type McpServerId,
  type ProjectRef,
  type ScheduleDefinition,
  type ScheduleDocument,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { projectTurnAttention } from '@lody/shared/notifications';
import { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withHistoryPort } from '../../../tests/history-port-fixture';
import type { StreamsRoomBinding } from '../loro/streams-room-binding';
import { turnNotificationAudience } from '../notifications/turn-notification-audience';
import {
  commitPreparedSessionDispatch,
  isPreparedSessionDispatched,
  materializePreparedSessionInput,
  type PreparedSessionInput,
} from '../prepared-session-input';
import {
  ScheduleConfigurationError,
  ScheduleEngine,
  type ScheduleEnginePorts,
} from './schedule-engine';
import {
  destinationSessionProblem,
  readScheduleBoard,
  resolveScheduleDestinationSession,
  resolveScheduleRunRole,
  scheduleDestinationSessionId,
  scheduleDestinationSessionState,
  withScheduledMessageInput,
  type DestinationSessionState,
} from './schedule-run-preparation';
import { ScheduleStore, type ScheduleRun } from './schedule-store';
import { createScheduleSyncGate } from './schedule-sync-gate';

import { prepareSessionInput, resolveTurnDispatchConfig } from '@/commands/session';
import type { AuthContext } from '../command-runtime';
import type { LoroDocumentManager } from '../loro/doc';
import type { WorkspaceSummary } from '../workspace';
import {
  buildScheduleRunPrompt,
  buildScheduleRunTarget,
  buildScheduleSessionCreateOptions,
  resolveScheduleAgentRunConfig,
  resolveScheduleMcpSelection,
} from './schedule-run-preparation';

/**
 * The PRODUCTION `prepareSessionInput`, not a stand-in for it.
 *
 * Only the pieces a scheduled run genuinely does not reach are absent: the
 * workspace-meta prewrite is already satisfied by the engine, and the quota
 * check short-circuits without a billing entitlement. Everything that decides
 * where a run happens — the target, the create options, and the `SessionMeta`
 * they produce — is the real code path.
 */
const auth = { userId: 'owner', machineId: 'machine' } as unknown as AuthContext;
const workspace = { id: 'workspace' } as unknown as WorkspaceSummary;
const targetMachine = {
  id: 'machine',
  ownerUserId: 'owner',
  protocolCapabilities: {},
} as unknown as MachineMeta;
const agentConfig = {
  id: 'agent',
  machineId: 'machine',
  cliType: 'claude',
  agentType: 'claude',
} as unknown as AgentConfigMeta;

/** No billing entitlement, so the quota check returns before any scan. */
const manager = {
  repo: {
    getDocMeta: async () => undefined,
    getWorkspaceMeta: async () => undefined,
    openFlockDoc: async () => ({ flock: { scan: () => [] } }),
  },
  syncMetaOrThrow: async () => {},
} as unknown as LoroDocumentManager;

const prepare = (
  project?: ProjectRef,
  {
    prompt = 'Say good morning.',
    title = 'Morning check-in',
    boardId = undefined as string | undefined,
    mcpServerIds = [] as McpServerId[],
  } = {}
) =>
  prepareSessionInput(
    auth,
    workspace,
    manager,
    prompt,
    buildScheduleSessionCreateOptions({
      sessionId: 'session-1' as SessionId,
      userTurnId: 'turn-1',
      agentConfigId: 'agent',
      title,
      boardId,
      project,
    }),
    {
      ...resolveTurnDispatchConfig({}),
      inheritSessionDefaults: false,
      mcpServerIds,
    },
    buildScheduleRunTarget({ targetMachine, agentConfig, project })
  );

describe('Session preparation for a scheduled run', () => {
  it('creates an ordinary Board member without a coordinator role', async () => {
    const prepared = await prepare(undefined, { boardId: 'bd_test' });
    expect(prepared.meta.boardId).toBe('bd_test');
    expect(prepared.meta.boardRole).toBeUndefined();
  });
  it.each([{ selection: ['chat-mcp'] }, { selection: [] }])(
    'retains an existing chat MCP choice $selection instead of Schedule defaults',
    async ({ selection }) => {
      const existingManager = {
        repo: { getDocMeta: async () => ({ meta: (await prepare()).meta }) },
        getOrCreateSessionDoc: async () =>
          withHistoryPort({
            getHistory: () => [
              { id: 'previous', role: 'user', inputConfig: { mcpServerIds: selection } },
            ],
          }),
      } as unknown as LoroDocumentManager;
      const mcpServerIds = await resolveScheduleMcpSelection({
        manager: existingManager,
        workspaceId: 'workspace' as WorkspaceId,
        localOnly: true,
        definition: {
          destination: { kind: 'existing_session', sessionId: 'session-1' as SessionId },
          mcpServerIds: ['schedule-mcp'],
        },
        sessionId: 'session-1' as SessionId,
      });
      const prepared = await prepare(undefined, { mcpServerIds });
      expect(prepared.userTurn.inputConfig?.mcpServerIds).toEqual(selection);
    }
  );

  it('produces no project, repository or branch for a chat-only schedule', async () => {
    const prepared = await prepare();
    for (const field of ['project', 'repoFullName', 'baseBranch'] as const)
      expect(prepared.meta).not.toHaveProperty(field);
    expect(prepared.meta.machineId).toBe('machine');
    expect(prepared.meta.agentConfigId).toBe('agent');
    expect(prepared.userTurn.inputConfig?.mcpServerIds).toEqual([]);
  });

  it('hands complete message blocks to both history and frozen execution input', async () => {
    const base = await prepare();
    const blocks = [
      {
        type: 'file' as const,
        fileId: 'frozen-file',
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: 5,
        sha256: 'a'.repeat(64),
        textPreview: true,
        transport: 'local' as const,
        machineId: 'machine',
        uploadedAt: 1,
      },
      { type: 'text' as const, text: 'Say good morning.' },
    ];
    const prepared = withScheduledMessageInput(base, { inputBlocks: blocks });
    expect(prepared.userTurn.items).toContainEqual(
      expect.objectContaining({ type: 'file', fileId: 'frozen-file', transport: 'local' })
    );
    expect(prepared.userTurn.items).toContainEqual({ type: 'text', text: 'Say good morning.' });
    expect(prepared.userTurn.inputConfig?.inputBlocks).toEqual(blocks);
    expect(prepared.userTurn.inputConfig?.mcpServerIds).toEqual([]);
    expect(prepared.userTurn.status).toBe('prepared');
    expect(prepared.userTurn.id).toBe('turn-1');
    expect(base.userTurn.items).not.toContainEqual(expect.objectContaining({ type: 'file' }));
  });

  it('treats a prepared scheduled turn as an ordinary user notification source', async () => {
    const prepared = await prepare();
    expect(prepared.userTurn.role).toBe('user');
    const audience = turnNotificationAudience(prepared.userTurn.author);
    expect(audience).toEqual({ kind: 'user' });
    for (const outcome of [{ kind: 'succeeded' }, { kind: 'failed', code: 'synthetic' }] as const) {
      const item = projectTurnAttention({
        scope: { workspaceId: 'workspace' as WorkspaceId, recipientId: prepared.meta.userId },
        sessionId: prepared.sessionId,
        turnId: prepared.userTurn.id,
        audience,
        outcome,
      });
      expect(item?.source.turnId).toBe(prepared.userTurn.id);
      expect(item?.outcome).toBe(outcome.kind);
    }
  });
});

describe('Schedule ACP values reach ordinary Session preparation', () => {
  const capability: AcpCapabilityCacheEntry = {
    cliType: 'custom',
    agentType: 'acp',
    modes: [],
    models: [{ modelId: 'opus', name: 'Opus' }],
    fetchedAt: 0,
    configOptions: [
      { id: 'plan_mode', name: 'Plan', type: 'boolean', currentValue: false, options: [] },
      {
        id: 'select_flag',
        name: 'String choice',
        type: 'select',
        currentValue: 'false',
        options: [{ value: 'false', name: 'False' }],
      },
    ],
  };
  const config = { ...agentConfig, cliType: 'custom' as const, agentType: 'acp' };
  const localManager = {
    syncMetaOrThrow: async () => {},
    repo: {
      getDocMeta: async () => undefined,
      getWorkspaceMeta: async () => undefined,
      openFlockDoc: async () => ({
        flock: {
          scan: () => [{ key: ['acpCapability', 'agent'], value: capability }],
        },
      }),
    },
  } as unknown as LoroDocumentManager;
  const prepareOptions = async (
    planMode: string | boolean,
    fastValues: Record<string, string | boolean> = {}
  ) => {
    const stored = ScheduleAgentSchema.parse({
      agentConfigId: 'agent',
      modelId: Object.keys(fastValues).length > 0 ? 'opus' : undefined,
      configOptionValues: { plan_mode: planMode, select_flag: 'false', ...fastValues },
    });
    const agent = await resolveScheduleAgentRunConfig(
      localManager,
      'workspace' as WorkspaceId,
      targetMachine.id,
      stored
    );
    const prepared = await prepareSessionInput(
      auth,
      workspace,
      localManager,
      'Synthetic scheduled prompt',
      buildScheduleSessionCreateOptions({
        sessionId: 'session-1' as SessionId,
        userTurnId: 'turn-1',
        agentConfigId: 'agent',
        title: 'Schedule',
      }),
      { ...resolveTurnDispatchConfig({}), ...agent, inheritSessionDefaults: false },
      buildScheduleRunTarget({ targetMachine, agentConfig: config })
    );
    expect(stored.configOptionValues?.plan_mode).toBe(planMode);
    return prepared;
  };
  it.each([false, true, 'false', 'true'])(
    'prepares typed and legacy boolean %s without changing select strings',
    async (value) => {
      const prepared = await prepareOptions(value);
      expect(prepared.userTurn.status).toBe('prepared');
      expect(prepared.userTurn.inputConfig?.configOptionValues).toEqual({
        plan_mode: value === true || value === 'true',
        select_flag: 'false',
      });
    }
  );
  it.each([
    { fast: 'false', 'fast-mode': 'true', expected: { fast: false, 'fast-mode': true } },
    { fast: 'true', 'fast-mode': 'false', expected: { fast: true, 'fast-mode': false } },
  ])('prepares legacy Fast values when the probe omits both Fast controls', async (values) => {
    const { expected, ...fastValues } = values;
    const prepared = await prepareOptions(false, fastValues);

    expect(prepared.userTurn.inputConfig?.configOptionValues).toEqual({
      plan_mode: false,
      select_flag: 'false',
      ...expected,
    });
  });

  it('starts a Role’s Session as a dispatched Role does: instruction, run config, provenance', async () => {
    const role = {
      role: {
        id: 'role-1',
        revision: 3,
        name: 'Release manager',
        emoji: '🚀',
        promptPrefix: 'You are the release manager.',
      } as AgentRole,
      instance: {
        id: 'instance-1',
        machineId: 'machine',
        agentConfigId: 'agent',
        runConfig: { configOptionValues: { plan_mode: true } },
      } as AgentRoleTarget,
      groupName: 'Night shift',
    };
    const prepareRun = (createsSession: boolean) =>
      prepareSessionInput(
        auth,
        workspace,
        localManager,
        buildScheduleRunPrompt({ prompt: 'Cut the release.', role, createsSession }),
        buildScheduleSessionCreateOptions({
          sessionId: 'session-1' as SessionId,
          userTurnId: 'turn-1',
          agentConfigId: 'agent',
          title: 'Release',
          role,
        }),
        {
          ...resolveTurnDispatchConfig({}),
          agentConfigId: 'agent',
          ...role.instance.runConfig,
          inheritSessionDefaults: false,
        },
        buildScheduleRunTarget({ targetMachine, agentConfig: config })
      );
    const prepared = await prepareRun(true);
    expect(prepared.meta).toMatchObject({
      agentConfigId: 'agent',
      agentRoleId: 'role-1',
      agentRoleRevision: 3,
      agentRoleInstanceId: 'instance-1',
    });
    expect(prepared.userTurn.items).toEqual([
      { type: 'text', text: 'You are the release manager.\n\nCut the release.' },
    ]);
    expect(prepared.userTurn.inputConfig).toMatchObject({
      agentRoleId: 'role-1',
      agentRoleRevision: 3,
      agentRoleSnapshot: {
        id: 'role-1',
        revision: 3,
        name: 'Release manager',
        emoji: '🚀',
        instanceId: 'instance-1',
        instanceLabel: 'Night shift',
      },
      configOptionValues: { plan_mode: true },
    });
    // A later run into the schedule's own chat: the Role's config and record, no instruction.
    const later = await prepareRun(false);
    expect(later.userTurn.items).toEqual([{ type: 'text', text: 'Cut the release.' }]);
    expect(later.userTurn.inputConfig).toMatchObject({
      agentRoleId: 'role-1',
      configOptionValues: { plan_mode: true },
    });
  });
});

describe('Owned-chat schedule handoff', () => {
  const definition = (project?: ScheduleDefinition['project']): ScheduleDefinition =>
    ScheduleDefinitionSchema.parse({
      scheduleId: 'chat',
      title: 'Morning check-in',
      ownerId: 'owner',
      machineId: 'machine',
      enabled: true,
      activationId: 'activation',
      activeFrom: 0,
      trigger: { kind: 'once', at: '1970-01-01T00:01:00Z' },
      misfirePolicy: { kind: 'run_once' },
      overlapPolicy: 'queue_one',
      agent: { agentConfigId: 'agent', modeId: 'safe' },
      ...(project ? { project } : {}),
      retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
      createdAt: 0,
      updatedAt: 0,
      createdBy: 'owner',
    });

  it('sends two runs into one Session as two prepared turns', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'lody-schedule-own-'));
    const store = new ScheduleStore<PreparedSessionInput>(path.join(directory, 'runs.sqlite'));
    const metas = new Map<string, SessionMeta>();
    const mirrors = new Map<string, Mirror<typeof sessionDocSchema>>();
    const handoffManager = {
      repo: {
        getDocMeta: async (id: string) => (metas.has(id) ? { meta: metas.get(id) } : undefined),
        upsertDocMeta: async (id: string, patch: Partial<SessionMeta>) => {
          metas.set(id, { ...metas.get(id), ...patch } as SessionMeta);
        },
        flush: async () => {},
      },
      isEncryptedWorkspace: () => false,
      getOrCreateSessionDoc: async (id: string) => {
        if (!mirrors.has(id))
          mirrors.set(
            id,
            new Mirror({
              doc: new LoroDoc(),
              schema: sessionDocSchema,
              initialState: { history: [] },
            })
          );
        const mirror = mirrors.get(id)!;
        return withHistoryPort({
          getHistory: () => mirror.getState().history,
          updateHistory: async (update: (h: SessionHistoryInput[]) => SessionHistoryInput[]) => {
            mirror.setState({ ...mirror.getState(), history: update(mirror.getState().history) });
          },
        });
      },
    } as unknown as LoroDocumentManager;
    const document: ScheduleDocument = {
      definition: {
        ...definition(),
        scheduleId: 'own',
        trigger: { kind: 'manual' },
        destination: { kind: 'own_session', epoch: 0 },
      },
      prompt: 'Daily note.',
      timeline: [],
    };
    const fingerprint = buildScheduleRegistryRow(document).definitionFingerprint;
    const sessions = new Set<string>();
    const turns: string[] = [];
    const ports: ScheduleEnginePorts<PreparedSessionInput> = {
      workspaceId: 'workspace',
      machineId: 'machine',
      userId: 'owner',
      store,
      now: () => 60_000,
      ready: () => true,
      disabled: () => false,
      list: async () => [buildScheduleRegistryRow(document)],
      read: async () => document,
      validateTarget: async () => {},
      prepare: async (scheduled) => {
        sessions.add(scheduled.sessionId);
        turns.push(scheduled.userTurnId);
        return {
          sessionId: scheduled.sessionId as PreparedSessionInput['sessionId'],
          meta: {
            id: scheduled.sessionId,
            machineId: 'machine',
            userId: 'owner',
            agentConfigId: 'agent',
            title: 'Daily note',
            scheduleId: 'own',
          } as SessionMeta,
          userTurn: {
            id: scheduled.userTurnId,
            role: 'user',
            status: 'prepared',
            read: true,
            timestamp: new Date(60_000).toISOString(),
            items: [{ type: 'text', text: scheduled.prompt }],
            fileDiff: [],
          },
        } satisfies PreparedSessionInput;
      },
      materialize: (prepared) => materializePreparedSessionInput(handoffManager, prepared),
      isDispatched: (prepared) => isPreparedSessionDispatched(handoffManager, prepared),
      dispatch: (prepared) => commitPreparedSessionDispatch(handoffManager, prepared),
      isFinished: async () => true,
      publish: async () => {},
      onError: (error) => {
        throw error;
      },
    };
    const engine = new ScheduleEngine(ports);
    try {
      await engine.evaluate();
      expect(store.unfinished('workspace')).toHaveLength(0);
      store.planManual('workspace', document, fingerprint, 'first', 60_000);
      await engine.evaluate();
      store.planManual('workspace', document, fingerprint, 'second', 61_000);
      await engine.evaluate();

      expect(sessions.size).toBe(1);
      expect(new Set(turns).size).toBe(2);
      const [sessionId] = sessions;
      expect(sessionId).toBe(
        scheduleDestinationSessionId('own', { kind: 'own_session', epoch: 0 })
      );
      expect(mirrors.size).toBe(1);
      const history = mirrors.get(sessionId!)!.getState().history;
      expect(history.filter((entry) => entry.role === 'user').map((entry) => entry.id)).toEqual(
        turns
      );
      expect(metas.get(getSessionRoomId(sessionId as never))?.latestUserMsgId).toBe(turns[1]);
    } finally {
      await engine.stop();
      store.close();
      for (const mirror of mirrors.values()) mirror.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('Schedule to ordinary Session handoff', () => {
  for (const crashAt of ['prepared', 'pointer'] as const) {
    it(`restarts after ${crashAt} without creating a second Session or changing frozen input`, async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'lody-schedule-handoff-'));
      const filename = path.join(directory, 'runs.sqlite');
      let store = new ScheduleStore<PreparedSessionInput>(filename);
      const metaFile = path.join(directory, 'meta.json');
      const metas = new Map<string, SessionMeta>();
      const docs = new Map<string, Mirror<typeof sessionDocSchema>>();
      const loroDocs = new Map<string, LoroDoc>();
      const handoffManager = {
        repo: {
          getDocMeta: async (id: string) => (metas.has(id) ? { meta: metas.get(id) } : undefined),
          upsertDocMeta: async (id: string, patch: Partial<SessionMeta>) => {
            metas.set(id, { ...metas.get(id), ...patch } as SessionMeta);
            writeFileSync(metaFile, JSON.stringify([...metas]));
          },
          flush: async () => {
            for (const [id, doc] of loroDocs)
              writeFileSync(path.join(directory, id + '.loro'), doc.export({ mode: 'snapshot' }));
          },
        },
        isEncryptedWorkspace: () => false,
        getOrCreateSessionDoc: async (id: string) => {
          if (!docs.has(id)) {
            const doc = new LoroDoc();
            const snapshot = path.join(directory, id + '.loro');
            if (existsSync(snapshot)) doc.import(readFileSync(snapshot));
            loroDocs.set(id, doc);
            docs.set(
              id,
              new Mirror({ doc, schema: sessionDocSchema, initialState: { history: [] } })
            );
          }
          const mirror = docs.get(id)!;
          return withHistoryPort({
            getHistory: () => mirror.getState().history,
            updateHistory: async (
              update: (history: SessionHistoryInput[]) => SessionHistoryInput[]
            ) => {
              mirror.setState({ ...mirror.getState(), history: update(mirror.getState().history) });
            },
          });
        },
      } as unknown as LoroDocumentManager;
      const document: ScheduleDocument = {
        definition: ScheduleDefinitionSchema.parse({
          scheduleId: 'once',
          title: 'Once',
          ownerId: 'owner',
          machineId: 'machine',
          enabled: true,
          activationId: 'activation',
          activeFrom: 0,
          trigger: { kind: 'once', at: '1970-01-01T00:01:00Z' },
          misfirePolicy: { kind: 'run_once' },
          overlapPolicy: 'queue_one',
          agent: { agentConfigId: 'agent', modeId: 'safe' },
          project: { kind: 'github', repoFullName: 'example/project', branch: 'main' },
          retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
          createdAt: 0,
          updatedAt: 0,
          createdBy: 'owner',
        }),
        prompt: 'Frozen prompt',
        timeline: [],
      };
      let now = 60_000;
      let connected = true;
      let crash = true;
      const prepareRun = vi.fn(
        async (run: ScheduleRun<PreparedSessionInput>): Promise<PreparedSessionInput> => ({
          sessionId: run.sessionId as PreparedSessionInput['sessionId'],
          meta: {
            id: run.sessionId,
            machineId: 'machine',
            userId: 'owner',
            agentConfigId: 'agent',
            title: 'Once',
            scheduleId: 'once',
          } as SessionMeta,
          userTurn: {
            id: run.userTurnId,
            role: 'user',
            status: 'prepared',
            read: true,
            timestamp: new Date(now).toISOString(),
            items: [{ type: 'text', text: run.prompt }],
            fileDiff: [],
          },
        })
      );
      const dispatch = vi.fn(async (prepared: PreparedSessionInput) => {
        await commitPreparedSessionDispatch(handoffManager, prepared);
      });
      const ports = (): ScheduleEnginePorts<PreparedSessionInput> => ({
        workspaceId: 'workspace',
        machineId: 'machine',
        userId: 'owner',
        store,
        now: () => now,
        ready: () => connected,
        disabled: () => false,
        list: async () => [buildScheduleRegistryRow(document)],
        read: async () => document,
        validateTarget: async () => {},
        prepare: prepareRun,
        materialize: async (prepared) => {
          await materializePreparedSessionInput(handoffManager, prepared);
          if (crash && crashAt === 'prepared') {
            crash = false;
            connected = false;
          }
        },
        isDispatched: (prepared) => isPreparedSessionDispatched(handoffManager, prepared),
        dispatch,
        isFinished: async () => false,
        publish: async () => {},
        onError: () => {},
      });
      try {
        if (crashAt === 'pointer') {
          const transition = store.transition.bind(store);
          vi.spyOn(store, 'transition').mockImplementation((key, states, patch) => {
            if (patch.state === 'dispatched')
              throw new Error('process stopped before ledger acknowledgement');
            return transition(key, states, patch);
          });
        }
        let engine = new ScheduleEngine(ports());
        await engine.evaluate();
        const run = store.unfinished('workspace')[0]!;
        const history = docs.get(run.sessionId)!.getState().history;
        expect(history).toHaveLength(1);
        expect(
          findNextDispatchableUserTurn(history, metas.get(getSessionRoomId(run.sessionId))!)
        ).toEqual(crashAt === 'prepared' ? null : expect.objectContaining({ id: run.userTurnId }));
        await engine.stop();
        expect(store.get(run.runKey)?.state).toBe('session_prepared');
        store.close();
        for (const mirror of docs.values()) mirror.dispose();
        docs.clear();
        loroDocs.clear();
        metas.clear();
        for (const [id, meta] of JSON.parse(readFileSync(metaFile, 'utf8')) as [
          string,
          SessionMeta,
        ][])
          metas.set(id, meta);
        store = new ScheduleStore(filename);
        connected = true;
        now = 90_000;
        engine = new ScheduleEngine(ports());
        await engine.evaluate();
        await engine.evaluate();
        expect(prepareRun).toHaveBeenCalledOnce();
        expect(dispatch).toHaveBeenCalledOnce();
        expect(metas.size).toBe(1);
        expect(docs.size).toBe(1);
        expect(store.unfinished('workspace')[0]?.state).toBe('dispatched');
        expect(docs.get(run.sessionId)!.getState().history).toHaveLength(1);
        const prepared = store.get(run.runKey)!.prepared!;
        await handoffManager.repo.upsertDocMeta(getSessionRoomId(run.sessionId), {
          title: 'User renamed this chat',
        });
        await materializePreparedSessionInput(handoffManager, prepared);
        expect(metas.get(getSessionRoomId(run.sessionId))?.title).toBe('User renamed this chat');
        await expect(
          materializePreparedSessionInput(handoffManager, {
            ...prepared,
            userTurn: { ...prepared.userTurn, items: [{ type: 'text', text: 'different prompt' }] },
          })
        ).rejects.toThrow('identity conflict');
        await engine.stop();
      } finally {
        store.close();
        for (const mirror of docs.values()) mirror.dispose();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

describe('createScheduleSyncGate', () => {
  it('requires the initial and each current connection sync, ignoring stale completions and disposal', async () => {
    let status: StreamsRoomBinding['status'] = 'joined';
    let notify!: () => void;
    let initial!: () => void;
    let finish!: () => void;
    let waiting!: () => void;
    let started = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const ready = vi.fn();
    const binding: StreamsRoomBinding = {
      get status() {
        return status;
      },
      onStatusChange: (callback) => {
        notify = () => callback(status);
        return () => {};
      },
      firstSyncedWithRemote: new Promise<void>((resolve) => {
        initial = resolve;
      }),
      waitUntilSynced: () => {
        waiting();
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    };
    const gate = createScheduleSyncGate(binding, ready, vi.fn());
    expect(gate.isReady()).toBe(false);
    initial();
    await started;
    finish();
    await Promise.resolve();
    expect(gate.isReady()).toBe(true);
    status = 'disconnected';
    notify();
    expect(gate.isReady()).toBe(false);
    started = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    status = 'joined';
    notify();
    await started;
    expect(gate.isReady()).toBe(false);
    status = 'disconnected';
    notify();
    finish();
    await Promise.resolve();
    expect(gate.isReady()).toBe(false);
    expect(ready).toHaveBeenCalledTimes(1);
    started = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    status = 'joined';
    notify();
    await started;
    gate.dispose();
    finish();
    await Promise.resolve();
    expect(gate.isReady()).toBe(false);
  });
});

describe('Schedule destination and Role resolution', () => {
  const run = (project?: ProjectRef) => ({
    sessionId: 'session' as SessionId,
    userTurnId: 'turn',
    agentConfigId: 'agent',
    title: 'Daily review',
    project,
  });

  /** Every selector that can put a run in a working directory. */
  const WORKSPACE_SELECTORS = ['repo', 'branch', 'localProject', 'worktree'] as const;

  const machine = { id: 'machine', ownerUserId: 'owner' } as unknown as MachineMeta;

  const agentConfig = { id: 'agent', machineId: 'machine' } as unknown as AgentConfigMeta;

  describe('Where a run is sent', () => {
    const machineId = 'machine';
    const meta = (overrides: Partial<SessionMeta> = {}) =>
      ({
        id: 's1',
        userId: 'owner',
        machineId,
        agentConfigId: 'agent',
        ...overrides,
      }) as SessionMeta;

    it('lets an owned chat be created by the first run, but never a picked chat', () => {
      const base = { userId: 'owner', machineId, agentConfigId: 'agent' };
      expect(
        destinationSessionProblem({
          ...base,
          destination: { kind: 'own_session', epoch: 0 },
          session: { kind: 'absent' },
        })
      ).toBeNull();
      expect(
        destinationSessionProblem({
          ...base,
          destination: { kind: 'existing_session', sessionId: 's1' },
          session: { kind: 'absent' },
        })
      ).toBe('SESSION_UNAVAILABLE');
    });

    it('refuses a chat that is deleted, someone else’s, elsewhere, or driven by another Agent', () => {
      const base = { userId: 'owner', machineId, agentConfigId: 'agent' };
      const destination = { kind: 'existing_session', sessionId: 's1' } as const;
      expect(
        destinationSessionProblem({
          ...base,
          destination,
          session: { kind: 'present', meta: meta() },
        })
      ).toBeNull();
      expect(
        destinationSessionProblem({ ...base, destination, session: { kind: 'deleted' } })
      ).toBe('SESSION_UNAVAILABLE');
      for (const wrong of [
        { userId: 'other' },
        { machineId: 'laptop' },
        { agentConfigId: 'writer' },
        { isArchived: true },
      ])
        expect(
          destinationSessionProblem({
            ...base,
            destination,
            session: { kind: 'present', meta: meta(wrong) },
          })
        ).toBe('SESSION_UNAVAILABLE');
    });
  });

  describe('A run of a schedule bound to a Role', () => {
    /** The workspace catalog and the machine's Agent configs, as this daemon holds them. */
    const daemon = () => {
      const roles = new Map<string, Record<string, unknown>>();
      const agents = new Set(['agent', 'writer']);
      const manager = {
        isEncryptedWorkspace: () => false,
        repo: {
          openFlockDoc: async (docId: string) => ({
            flock: {
              scan: ({ prefix }: { prefix?: unknown[] } = {}) =>
                docId === getWorkspaceFlockDocId('workspace' as WorkspaceId) &&
                prefix?.[0] === 'agentRole'
                  ? [...roles].map(([id, value]) => ({ key: ['agentRole', id], value }))
                  : [],
            },
          }),
          getDocMeta: async (roomId: string) => {
            const id = roomId.replace(/^agent-/, '');
            return roomId.startsWith('agent-') && agents.has(id)
              ? {
                  meta: {
                    id,
                    machineId: 'machine',
                    name: id,
                    cliType: 'builtin',
                    agentType: 'claude',
                  },
                }
              : undefined;
          },
        },
      } as unknown as LoroDocumentManager;
      const setRole = (overrides: Record<string, unknown> = {}) =>
        roles.set('role-1', {
          v: 1,
          id: 'role-1',
          ownerUserId: 'owner',
          visibility: 'private',
          name: 'Release manager',
          emoji: '🚀',
          promptPrefix: 'You are the release manager.',
          machineId: 'machine',
          agentConfigId: 'agent',
          runConfig: {},
          instances: [
            {
              id: 'instance-1',
              alias: 'Night shift',
              machineId: 'machine',
              agentConfigId: 'agent',
              runConfig: { modeId: 'plan', modelId: 'sonnet' },
            },
          ],
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
          ...overrides,
        });
      setRole();
      return {
        roles,
        agents,
        setRole,
        resolve: (ref: { roleId: string; instanceId?: string } | undefined, userId = 'owner') =>
          resolveScheduleRunRole({
            manager,
            workspaceId: 'workspace' as never,
            machineId: 'machine' as never,
            userId,
            ref,
          }),
      };
    };
    const code = (error: unknown) =>
      error instanceof ScheduleConfigurationError ? error.code : `unexpected: ${String(error)}`;

    it('reads the Role as it is at that run, so an edit reaches the next one', async () => {
      const h = daemon();
      const ref = { roleId: 'role-1' };
      expect(await h.resolve(ref)).toMatchObject({
        role: { revision: 1 },
        instance: { id: 'instance-1' },
        groupName: 'Night shift',
        agent: { agentConfigId: 'agent', modeId: 'plan', modelId: 'sonnet' },
      });
      // The Role moves to another Agent and model; the schedule was not saved again.
      h.setRole({
        revision: 2,
        instances: [
          {
            id: 'instance-1',
            machineId: 'machine',
            agentConfigId: 'writer',
            runConfig: { modelId: 'opus', configOptionValues: { effort: 'high' } },
          },
        ],
      });
      const next = (await h.resolve(ref))!;
      expect(next.role.revision).toBe(2);
      expect(next.agentConfig.id).toBe('writer');
      expect(next.agent).toEqual({
        agentConfigId: 'writer',
        modelId: 'opus',
        configOptionValues: { effort: 'high' },
      });
      expect(await h.resolve(undefined)).toBeUndefined();
    });

    it('blocks the run under its own code when the Role is gone or cannot run here', async () => {
      const h = daemon();
      const ref = { roleId: 'role-1' };
      // Someone else's private Role is not this owner's to run.
      expect(await h.resolve(ref, 'other').catch(code)).toBe('ROLE_NOT_FOUND');
      // The named instance was removed from the Role.
      expect(await h.resolve({ roleId: 'role-1', instanceId: 'gone' }).catch(code)).toBe(
        'ROLE_INSTANCE_UNAVAILABLE'
      );
      // Its Agent config was deleted from this machine.
      h.agents.delete('agent');
      expect(await h.resolve(ref).catch(code)).toBe('ROLE_INSTANCE_UNAVAILABLE');
      h.agents.add('agent');
      // Its only instance now lives on another machine: the run does not follow it there.
      h.setRole({
        instances: [
          { id: 'instance-1', machineId: 'laptop', agentConfigId: 'agent', runConfig: {} },
        ],
      });
      expect(await h.resolve(ref).catch(code)).toBe('ROLE_INSTANCE_UNAVAILABLE');
      h.roles.clear();
      expect(await h.resolve(ref).catch(code)).toBe('ROLE_NOT_FOUND');
    });

    it('puts the Role’s instruction before the prompt only on the run that creates the chat', async () => {
      const role = (await daemon().resolve({ roleId: 'role-1' }))!;
      expect(
        buildScheduleRunPrompt({ prompt: 'Cut the release.', role, createsSession: true })
      ).toBe('You are the release manager.\n\nCut the release.');
      // A later run into the schedule's own chat continues a conversation already instructed.
      expect(
        buildScheduleRunPrompt({ prompt: 'Cut the release.', role, createsSession: false })
      ).toBe('Cut the release.');
      expect(buildScheduleRunPrompt({ prompt: 'Cut the release.', createsSession: true })).toBe(
        'Cut the release.'
      );
    });

    it('records the Role, its revision and the instance that ran as Session provenance', async () => {
      const role = (await daemon().resolve({ roleId: 'role-1' }))!;
      expect(buildScheduleSessionCreateOptions({ ...run(), role })).toMatchObject({
        agentRoleId: 'role-1',
        agentRoleRevision: 1,
        agentRoleSnapshot: {
          id: 'role-1',
          revision: 1,
          name: 'Release manager',
          emoji: '🚀',
          instanceId: 'instance-1',
          instanceLabel: 'Night shift',
        },
      });
      for (const field of ['agentRoleId', 'agentRoleRevision', 'agentRoleSnapshot'])
        expect(buildScheduleSessionCreateOptions(run())).not.toHaveProperty(field);
    });
  });

  describe('Board and archived schedule destinations', () => {
    const board = normalizeBoardMeta({
      version: 1,
      id: 'bd_test',
      name: 'Board',
      coordinatorSessionId: 'main',
      createdAtMs: 1,
      createdByUserId: 'owner',
    })!;
    const meta = {
      id: 'thread',
      boardId: board.id,
      userId: 'owner',
      machineId: 'machine',
      agentConfigId: 'agent',
    } as SessionMeta;
    it('preserves sequence zero and skips only archived owned sessions', async () => {
      const states = new Map<SessionId, DestinationSessionState>([
        [
          scheduleOwnSessionId('schedule', 0),
          { kind: 'present', meta: { ...meta, isArchived: true } },
        ],
        [
          scheduleOwnSessionId('schedule', 0, 1),
          { kind: 'present', meta: { ...meta, isArchived: true } },
        ],
      ]);
      const args = {
        scheduleId: 'schedule',
        destination: { kind: 'own_session', epoch: 0 } as const,
        plannedSessionId: scheduleOwnSessionId('schedule', 0),
        readSession: async (id: SessionId) => states.get(id) ?? ({ kind: 'absent' } as const),
      };
      expect(scheduleOwnSessionId('schedule', 0, 0)).toBe('565486d7-0121-84a7-93ad-304604a4f78f');
      const resolved = await resolveScheduleDestinationSession(args);
      expect(resolved).toEqual({
        sessionId: scheduleOwnSessionId('schedule', 0, 2),
        session: { kind: 'absent' },
      });
      states.set(resolved.sessionId, { kind: 'present', meta });
      expect((await resolveScheduleDestinationSession(args)).sessionId).toBe(resolved.sessionId);
    });
    it.each([
      { ...meta, isArchived: true },
      { ...meta, boardId: 'bd_other' },
      { ...meta, id: 'main' },
    ])('refuses archived, foreign and coordinator destinations', (invalid) => {
      expect(
        destinationSessionProblem({
          destination: { kind: 'existing_session', sessionId: invalid.id },
          session: { kind: 'present', meta: invalid as SessionMeta },
          board,
          userId: 'owner',
          machineId: 'machine',
          agentConfigId: 'agent',
        })
      ).toBe('SESSION_UNAVAILABLE');
    });
    it.each([{ deleted: true, meta }, { deleted: true }])(
      'skips deleted sequence zero even without metadata: %j',
      async (record) => {
        const zero = scheduleOwnSessionId('schedule', 0);
        const result = await resolveScheduleDestinationSession({
          scheduleId: 'schedule',
          destination: { kind: 'own_session', epoch: 0 },
          plannedSessionId: zero,
          readSession: async (id) =>
            scheduleDestinationSessionState(id === zero ? record : undefined),
        });
        expect(result).toEqual({
          sessionId: scheduleOwnSessionId('schedule', 0, 1),
          session: { kind: 'absent' },
        });
      }
    );
    it('skips detached Board threads but ordinary schedules can keep them', async () => {
      const zero = scheduleOwnSessionId('schedule', 0);
      const args = {
        scheduleId: 'schedule',
        destination: { kind: 'own_session', epoch: 0 } as const,
        plannedSessionId: zero,
        readSession: async (id: SessionId): Promise<DestinationSessionState> =>
          id === zero
            ? { kind: 'present', meta: { ...meta, boardId: undefined } }
            : { kind: 'absent' },
      };
      expect(
        (await resolveScheduleDestinationSession({ ...args, boardId: board.id })).sessionId
      ).toBe(scheduleOwnSessionId('schedule', 0, 1));
      expect((await resolveScheduleDestinationSession(args)).sessionId).toBe(zero);
    });
    it('reads the Board gate and rejects absent and archived Boards', async () => {
      let row: unknown = board;
      const manager = {
        repo: { openFlockDoc: async () => ({ flock: { get: () => row } }) },
      } as unknown as LoroDocumentManager;
      const args = {
        manager,
        workspaceId: 'workspace' as WorkspaceId,
        boardId: board.id,
        localOnly: true,
      };
      expect(await readScheduleBoard(args)).toEqual(board);
      row = { ...board, archivedAtMs: 2 };
      await expect(readScheduleBoard(args)).rejects.toMatchObject({ code: 'BOARD_UNAVAILABLE' });
      row = undefined;
      await expect(readScheduleBoard(args)).rejects.toMatchObject({ code: 'BOARD_UNAVAILABLE' });
    });
  });
});
