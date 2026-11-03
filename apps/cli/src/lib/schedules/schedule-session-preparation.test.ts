import { withScheduledMessageInput } from './schedule-run-preparation';
import { projectTurnAttention } from '@lody/shared/notifications';
import { turnNotificationAudience } from '../notifications/turn-notification-audience';
import { describe, expect, it } from 'vitest';
import { withHistoryPort } from '../../../tests/history-port-fixture';
import {
  ScheduleAgentSchema,
  type AcpCapabilityCacheEntry,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleTarget,
  type MachineMeta,
  type McpServerId,
  type ProjectRef,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';

import { prepareSessionInput, resolveTurnDispatchConfig } from '@/commands/session';
import type { AuthContext } from '../command-runtime';
import type { LoroDocumentManager } from '../loro/doc';
import type { WorkspaceSummary } from '../workspace';
import {
  buildScheduleRunPrompt,
  buildScheduleRunTarget,
  resolveScheduleAgentRunConfig,
  resolveScheduleMcpSelection,
  buildScheduleSessionCreateOptions,
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
