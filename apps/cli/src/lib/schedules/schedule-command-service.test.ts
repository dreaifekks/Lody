import { describe, expect, it, vi } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { withHistoryPort } from '../../../tests/history-port-fixture';
import {
  ScheduleRepository,
  ScheduleDefinitionSchema,
  getStaticBuiltinAcpCapabilities,
  normalizeAgentRole,
  scheduleDefinitionFingerprint,
  scheduleOwnSessionId,
  SCHEDULE_AGENT_ROLES_PROTOCOL_VERSION,
  SCHEDULES_PROTOCOL_VERSION,
  type ResolvedPermissionTier,
  type ScheduleCommand,
  type ScheduleRepositoryPort,
  type SessionMeta,
} from '@lody/shared';
import { executeScheduleCommand, type ScheduleCommandContext } from './schedule-command-service';
import {
  buildScheduleCreateDraft,
  buildScheduleEditDraft,
  scheduleDraftNow,
  type ScheduleCreateToolInput,
  type ScheduleUpdateToolInput,
} from '@/mcp/schedule-agent-writes';
import { readInvokingPermissionTier, type RuntimeConfigOption } from '../agent-permission-tier';
import { WorkspaceSyncUnavailableError } from '../command-runtime';

async function fixture() {
  const docs = new Map<string, LoroDoc>();
  const rows = new Map<string, unknown>();
  const registrySync = vi.fn(async () => {});
  const documentSync = vi.fn(async () => {});
  const notificationSync = vi.fn(async () => false);
  let failRegistryPublish = false;
  const port: ScheduleRepositoryPort = {
    openPersistedDoc: async (id) => {
      if (!docs.has(id)) docs.set(id, new LoroDoc());
      return { doc: docs.get(id)!, syncOnce: documentSync };
    },
    openFlockDoc: async () => ({
      syncOnce: registrySync,
      flock: {
        get: (key) => rows.get(JSON.stringify(key)),
        set: (key, value) => {
          if (failRegistryPublish && key[0] === 'schedule') {
            failRegistryPublish = false;
            throw new Error('Registry write failed');
          }
          return rows.set(JSON.stringify(key), value);
        },
        scan: () => [...rows].map(([key, value]) => ({ key: JSON.parse(key), value })),
      },
    }),
    flush: async () => {},
  };
  const repository = new ScheduleRepository(port, 'workspace' as never);
  const definition = ScheduleDefinitionSchema.parse({
    scheduleId: 'schedule',
    title: 'Daily',
    ownerId: 'owner',
    machineId: 'machine',
    enabled: true,
    activationId: 'initial',
    activeFrom: 0,
    trigger: { kind: 'once', at: '2026-09-10T00:00:00Z' },
    misfirePolicy: { kind: 'skip' },
    overlapPolicy: 'skip',
    agent: { agentConfigId: 'agent', modeId: 'safe' },
    project: { kind: 'github', repoFullName: 'example/project', branch: 'main' },
    retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86400000 },
    createdAt: 0,
    updatedAt: 0,
    createdBy: 'owner',
  });
  await repository.save({
    scheduleId: 'schedule',
    draft: { ...definition, prompt: 'Synthetic prompt' },
    actorId: 'owner',
    now: 1,
    activationId: 'initial',
    activityId: 'create',
    create: true,
  });
  let history: any[] = [];
  let owner = 'owner';
  let machinePresent = false;
  let agentPresent = true;
  let roleSupport = true;
  /** Further Agent configs on `machine`, by id. */
  const agents = new Map<string, Record<string, unknown>>();
  /** Fields of a Session meta beyond the invoking owner's, by Session id. */
  const sessions = new Map<string, Record<string, unknown>>();
  const missingSessions = new Set<string>();
  const runtimeReports = new Map<string, Record<string, unknown>>();
  const context = {
    manager: {
      repo: {
        ...port,
        getDocMeta: async (id: string) =>
          missingSessions.has(id)
            ? undefined
            : id.startsWith('session-')
              ? {
                  meta: {
                    id: 'session',
                    userId: owner,
                    machineId: 'machine',
                    processingUserMsgId: 'turn',
                    ...sessions.get(id.slice('session-'.length)),
                  },
                }
              : id.startsWith('agent-') && agents.has(id.slice('agent-'.length))
                ? { meta: agents.get(id.slice('agent-'.length)) }
                : id === 'machine-machine' && machinePresent
                  ? {
                      meta: {
                        id: 'machine',
                        ownerUserId: 'owner',
                        protocolCapabilities: {
                          schedules: SCHEDULES_PROTOCOL_VERSION,
                          ...(roleSupport
                            ? { scheduleAgentRoles: SCHEDULE_AGENT_ROLES_PROTOCOL_VERSION }
                            : {}),
                        },
                      },
                    }
                  : id === 'agent-agent' && agentPresent
                    ? {
                        meta: {
                          id: 'agent',
                          machineId: 'machine',
                          name: 'Agent',
                          cliType: 'builtin',
                          agentType: 'claude',
                        },
                      }
                    : undefined,
      },
      getOrCreateSessionDoc: async (sessionId: string) =>
        withHistoryPort({
          roomId: `session-${sessionId}`,
          getDocState: async () => ({ acpRuntimeConfig: runtimeReports.get(sessionId) }),
          waitUntilSynced: notificationSync,
          getHistory: () => [{ id: 'turn', role: 'user' }, ...history],
          updateHistory: async (update: (entries: any[]) => any[]) => {
            history = update(history);
          },
        }),
      syncDocOrThrow: vi.fn(),
      syncMetaOrThrow: vi.fn(async () => {}),
      syncFlockDocOrThrow: vi.fn(async () => {}),
    },
    workspace: { id: 'workspace' },
    auth: { userId: 'owner', machineId: 'machine' },
    localOnly: true,
    hostedAccess: false,
  } as unknown as ScheduleCommandContext;
  return {
    context,
    repository,
    registrySync,
    documentSync,
    notificationSync,
    history: () => history,
    missingSession: (id: string) => missingSessions.add(`session-${id}`),
    board: (id: string, archivedAtMs?: number) =>
      rows.set(JSON.stringify(['board', id]), {
        version: 1,
        id,
        name: 'Synthetic Board',
        coordinatorSessionId: 'main',
        createdAtMs: 1,
        createdByUserId: 'owner',
        archivedAtMs,
      }),
    addMcp: (id: string, name: string) =>
      rows.set(JSON.stringify(['mcpServer', id]), {
        id,
        name,
        transport: 'stdio',
        createdAt: 0,
        updatedAt: 0,
      }),
    removeMcp: (id: string) => rows.delete(JSON.stringify(['mcpServer', id])),
    owner: (value: string) => {
      owner = value;
    },
    addMachine: () => {
      machinePresent = true;
    },
    /** An Agent config and the capability its machine reported for it. */
    addAgent: (agentConfigId: string, agentType: string, capability?: object) => {
      if (agentConfigId !== 'agent')
        agents.set(agentConfigId, {
          id: agentConfigId,
          machineId: 'machine',
          name: agentType,
          cliType: 'builtin',
          agentType,
        });
      if (capability)
        rows.set(JSON.stringify(['acpCapability', agentConfigId]), {
          ...capability,
          cliType: 'builtin',
          agentType,
          fetchedAt: 1,
        });
    },
    /** A workspace-shared Role with one instance, on `machine`; `null` deletes it. */
    setRole: (
      roleId: string,
      instance: { id: string; agentConfigId: string; runConfig: Record<string, unknown> } | null
    ) => {
      const key = JSON.stringify(['agentRole', roleId]);
      if (!instance) return void rows.delete(key);
      const prior = rows.get(key) as { revision: number } | undefined;
      const row = {
        v: 1,
        id: roleId,
        ownerUserId: 'owner',
        visibility: 'workspace',
        name: 'Release manager',
        machineId: 'machine',
        agentConfigId: instance.agentConfigId,
        runConfig: instance.runConfig,
        instances: [{ ...instance, machineId: 'machine' }],
        revision: (prior?.revision ?? 0) + 1,
        createdAt: 1,
        updatedAt: 1,
      };
      rows.set(key, row);
      return normalizeAgentRole(row)!;
    },
    /** The next write lands its definition, then fails before its Registry row. */
    failNextRegistryPublish: () => {
      failRegistryPublish = true;
    },
    /** The target machine's daemon predates Role references. */
    withoutRoleSupport: () => {
      roleSupport = false;
    },
    session: (sessionId: string, meta: Record<string, unknown>) => {
      sessions.set(sessionId, meta);
    },
    runtimeReport: (sessionId: string, report: Record<string, unknown>) => {
      runtimeReports.set(sessionId, report);
    },
    /** The target machine's record and Agent reach this replica only with a sync. */
    deferTargetToSync: () => {
      agentPresent = false;
      const manager = context.manager as unknown as Record<
        string,
        ReturnType<typeof vi.fn<() => Promise<void>>>
      >;
      manager.syncMetaOrThrow!.mockImplementation(async () => {
        machinePresent = true;
      });
      manager.syncFlockDocOrThrow!.mockImplementation(async () => {
        agentPresent = true;
      });
      return manager;
    },
  };
}
describe('Schedule command authorization', () => {
  it('lets the owner pause/delete after the target machine disappears, without cloud requests', async () => {
    const h = await fixture();
    await executeScheduleCommand(h.context, {
      action: 'pause',
      scheduleId: 'schedule',
      requestId: 'pause',
    });
    expect((await h.repository.list())[0]?.enabled).toBe(false);
    await expect(
      executeScheduleCommand(h.context, {
        action: 'resume',
        scheduleId: 'schedule',
        requestId: 'resume',
      })
    ).rejects.toThrow('owned');
    await executeScheduleCommand(h.context, { action: 'delete', scheduleId: 'schedule' });
    expect(await h.repository.list()).toEqual([]);
    await executeScheduleCommand(h.context, { action: 'delete', scheduleId: 'schedule' });
    expect(h.context.manager.syncDocOrThrow).not.toHaveBeenCalled();
  });
  it('enforces the MCP action whitelist and invoking Session owner at the domain boundary', async () => {
    const h = await fixture();
    h.context.requesterSessionId = 'session' as never;
    for (const action of ['resume', 'run', 'delete'])
      await expect(
        executeScheduleCommand(h.context, {
          action,
          scheduleId: 'schedule',
          ...(action !== 'delete' ? { requestId: 'request' } : {}),
        } as ScheduleCommand)
      ).rejects.toThrow('human');
    h.owner('other');
    await expect(executeScheduleCommand(h.context, { action: 'list', limit: 30 })).rejects.toThrow(
      'owner'
    );
    h.owner('owner');
    await expect(
      executeScheduleCommand(h.context, { action: 'list', limit: 1 })
    ).resolves.toMatchObject({ matched: 1 });
  });
});

it('records attributable MCP pauses and an idempotent ordinary Session notice', async () => {
  const h = await fixture();
  h.context.requesterSessionId = 'session' as never;
  const command = {
    action: 'pause',
    scheduleId: 'schedule',
    requestId: 'pause-from-agent',
  } as const;
  await executeScheduleCommand(h.context, command);
  await executeScheduleCommand(h.context, command);
  expect(
    (await h.repository.read('schedule'))?.timeline.filter(
      (entry) => entry.id === 'pause-from-agent'
    )
  ).toMatchObject([{ requesterSessionId: 'session', actorId: 'owner' }]);
  expect(h.history()).toHaveLength(1);
  expect(h.history()[0]).toMatchObject({
    role: 'system',
    items: [{ type: 'text', text: expect.stringContaining('Paused scheduled task') }],
  });
});

it('publishes the pause gate before waiting for a failed notification sync', async () => {
  const h = await fixture();
  h.context.localOnly = false;
  h.context.requesterSessionId = 'session' as never;
  await expect(
    executeScheduleCommand(h.context, {
      action: 'pause',
      scheduleId: 'schedule',
      requestId: 'pause',
    })
  ).rejects.toThrow('notification sync pending');
  expect((await h.repository.list())[0]?.enabled).toBe(false);
  expect(h.documentSync).toHaveBeenCalledOnce();
  expect(h.registrySync).toHaveBeenCalled();
  expect(h.registrySync.mock.invocationCallOrder.at(-1)).toBeLessThan(
    h.notificationSync.mock.invocationCallOrder[0]!
  );
});

it('lets a LAN member create a schedule without a hosted access check', async () => {
  const h = await fixture();
  // A LAN member syncs through its hub but has no hosted backend to ask.
  h.context.localOnly = false;
  h.addMachine();
  const { definition } = (await h.repository.read('schedule'))!;
  await expect(
    executeScheduleCommand(h.context, {
      action: 'create',
      scheduleId: 'lan',
      requestId: 'lan-create',
      draft: {
        title: 'From a LAN member',
        machineId: definition.machineId,
        trigger: definition.trigger,
        misfirePolicy: definition.misfirePolicy,
        overlapPolicy: definition.overlapPolicy,
        agent: definition.agent,
        retryPolicy: definition.retryPolicy,
        prompt: 'Synthetic prompt',
      },
    })
  ).resolves.toEqual({ ok: true, scheduleId: 'lan' });
  expect((await h.repository.read('lan'))?.definition.title).toBe('From a LAN member');
});

it("reads the target machine's record and Agents after syncing them, and reports a failed sync as one", async () => {
  const h = await fixture();
  h.context.localOnly = false;
  const manager = h.deferTargetToSync();
  const { definition } = (await h.repository.read('schedule'))!;
  const create = (scheduleId: string) =>
    executeScheduleCommand(h.context, {
      action: 'create',
      scheduleId,
      requestId: `${scheduleId}-create`,
      draft: {
        title: 'For another machine',
        machineId: definition.machineId,
        trigger: definition.trigger,
        misfirePolicy: definition.misfirePolicy,
        overlapPolicy: definition.overlapPolicy,
        agent: definition.agent,
        retryPolicy: definition.retryPolicy,
        prompt: 'Synthetic prompt',
      },
    });
  manager.syncFlockDocOrThrow!.mockRejectedValueOnce(new Error('hub unreachable'));
  const failed = await create('unsynced').catch((error: unknown) => error);
  expect(failed).toBeInstanceOf(WorkspaceSyncUnavailableError);
  expect(String((failed as Error).message)).not.toContain('Agent is unavailable');
  expect(await h.repository.read('unsynced')).toBeNull();
  await expect(create('synced')).resolves.toEqual({ ok: true, scheduleId: 'synced' });
});

it('bounds MCP prompt output and returns usable Registry pagination metadata', async () => {
  const h = await fixture();
  const document = (await h.repository.read('schedule'))!;
  await h.repository.save({
    scheduleId: 'schedule',
    draft: { ...document.definition, prompt: 'x'.repeat(9000) },
    actorId: 'owner',
    now: 2,
    activationId: 'edit',
    activityId: 'edit',
  });
  h.context.requesterSessionId = 'session' as never;
  const result = (await executeScheduleCommand(h.context, {
    action: 'show',
    scheduleId: 'schedule',
  })) as { schedule: { prompt: string }; truncated: { promptCharsOmitted: number } };
  expect(result.schedule.prompt).toHaveLength(8000);
  expect(result.truncated.promptCharsOmitted).toBe(1000);
  expect(
    await executeScheduleCommand(h.context, { action: 'list', limit: 1, offset: 1 })
  ).toMatchObject({ schedules: [], matched: 1 });
});

describe('proposing a schedule from a conversation', () => {
  const propose = (h: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) =>
    executeScheduleCommand(h.context, {
      action: 'propose',
      requestId: 'nightly',
      title: 'Nightly review',
      prompt: 'Review today’s commits and list anything risky.',
      rule: { kind: 'daily', hour: 21, minute: 0 },
      ...extra,
    } as ScheduleCommand);

  it('resolves MCP names into ids on the proposal card', async () => {
    const h = await fixture();
    h.context.requesterSessionId = 'session' as never;
    h.addMcp('mcp-a', 'Mail');
    await propose(h, { mcpServerIds: ['Mail', 'mcp-a'] });
    expect(h.history()[0].items[0].meta.mcpServerIds).toEqual(['mcp-a']);
    await expect(propose(h, { mcpServerIds: ['Mail', 'mcp-a'] })).resolves.toMatchObject({
      pending: true,
    });
    await expect(propose(h, { mcpServerIds: [] })).rejects.toThrow('Idempotency');
  });

  it('writes one card into the invoking conversation, idempotently', async () => {
    const h = await fixture();
    h.context.requesterSessionId = 'session' as never;
    await expect(propose(h)).resolves.toMatchObject({ ok: true, pending: true, enabled: false });
    await expect(propose(h)).resolves.toMatchObject({ ok: true, pending: true });
    const cards = h.history().filter((entry) => entry.id === 'schedule-proposal-nightly');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      role: 'system',
      items: [
        {
          type: 'system_notice',
          name: 'schedule_proposal',
          meta: {
            proposalId: 'nightly',
            title: 'Nightly review',
            rule: { kind: 'daily', hour: 21, minute: 0 },
            proposedBy: { kind: 'agent' },
          },
        },
      ],
    });
  });

  it('refuses to reuse a request id for a different proposal', async () => {
    const h = await fixture();
    h.context.requesterSessionId = 'session' as never;
    await propose(h);
    await expect(propose(h, { title: 'Something else' })).rejects.toThrow('Idempotency');
  });

  it('reports the outcome once the person has acted on the card', async () => {
    const h = await fixture();
    h.context.requesterSessionId = 'session' as never;
    await propose(h);
    // The renderer writes the outcome back onto the same item.
    const session = await h.context.manager.getOrCreateSessionDoc('session' as never);
    await session.updateHistory((history) =>
      history.map((entry) =>
        entry.id === 'schedule-proposal-nightly'
          ? {
              ...entry,
              items: [
                {
                  ...entry.items![0]!,
                  meta: { ...entry.items![0]!.meta, outcome: 'created', scheduleId: 'nightly' },
                },
              ],
            }
          : entry
      )
    );
    await expect(propose(h)).resolves.toMatchObject({
      ok: true,
      pending: false,
      outcome: 'created',
      scheduleId: 'nightly',
    });
  });

  it('rejects a rule the editor could not show, before writing anything', async () => {
    const h = await fixture();
    h.context.requesterSessionId = 'session' as never;
    await expect(
      propose(h, { rule: { kind: 'weekly', weekdays: [], hour: 9, minute: 0 } })
    ).rejects.toThrow();
    await expect(
      propose(h, { rule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' } })
    ).rejects.toThrow();
    expect(h.history()).toHaveLength(0);
  });

  it('requires an invoking conversation', async () => {
    const h = await fixture();
    await expect(propose(h)).rejects.toThrow('invoking Session');
  });
});

describe('Agent writes within the invoking conversation’s permission tier', () => {
  const conversation = {
    session: {
      id: 'session',
      machineId: 'machine',
      agentConfigId: 'agent',
      cliType: 'builtin',
      agentType: 'claude',
    } as unknown as SessionMeta,
    runConfig: { modeId: 'acceptEdits' },
  };
  const agents = [{ id: 'agent', machineId: 'machine', cliType: 'builtin', agentType: 'claude' }];
  const draftContext = {
    now: Date.parse('2026-10-09T00:00:00Z'),
    conversation,
    agents,
    roles: [],
    machineTimeZone: () => 'Asia/Tokyo',
  };
  const staticCapability = (agentType: string) =>
    getStaticBuiltinAcpCapabilities('builtin', agentType)!;
  const asAgent = async (tier: ResolvedPermissionTier) => {
    const h = await fixture();
    h.addMachine();
    h.addAgent('agent', 'claude', staticCapability('claude'));
    h.context.requesterSessionId = 'session' as never;
    h.context.requesterPermissionTier = tier;
    return h;
  };
  const create = (
    h: Awaited<ReturnType<typeof fixture>>,
    requestId: string,
    target?: ScheduleCreateToolInput['target']
  ) =>
    executeScheduleCommand(h.context, {
      action: 'create',
      scheduleId: requestId,
      requestId,
      draft: buildScheduleCreateDraft(
        {
          requestId,
          title: 'Nightly review',
          prompt: 'Review today’s commits.',
          rule: { kind: 'daily', hour: 21, minute: 0 },
          ...(target ? { target } : {}),
        },
        draftContext
      ),
    });

  it('scopes Board writes to membership, preserves proposals and filters Registry listings', async () => {
    const h = await asAgent('full');
    h.board('bd_test');
    h.board('bd_other');
    const input: ScheduleCreateToolInput = {
      requestId: 'board-task',
      boardId: 'bd_test',
      title: 'Board task',
      prompt: 'Summarize commits.',
      rule: { kind: 'manual' },
    };
    const draft = buildScheduleCreateDraft(input, draftContext);
    expect(draft.destination).toEqual({ kind: 'own_session', epoch: 0 });
    h.missingSession(scheduleOwnSessionId('board-task', 0));
    const command = {
      action: 'create' as const,
      scheduleId: 'board-task',
      requestId: 'board-task',
      draft: { ...draft, destination: undefined },
    };
    await expect(executeScheduleCommand(h.context, command)).rejects.toThrow(
      'member of that Board'
    );
    h.session('session', { boardId: 'bd_other' });
    await expect(executeScheduleCommand(h.context, command)).rejects.toThrow(
      'member of that Board'
    );
    h.session('session', { boardId: 'bd_test' });
    await executeScheduleCommand(h.context, command);
    await executeScheduleCommand(h.context, command); // Idempotent Board definition replay.
    expect((await h.repository.read('board-task'))?.definition.boardId).toBe('bd_test');
    expect(
      await executeScheduleCommand(h.context, { action: 'list', boardId: 'bd_test', limit: 30 })
    ).toMatchObject({ matched: 1, schedules: [{ boardId: 'bd_test', scheduleId: 'board-task' }] });
    expect(await executeScheduleCommand(h.context, { action: 'list', limit: 30 })).toMatchObject({
      matched: 2,
    });
    await executeScheduleCommand(h.context, {
      action: 'propose',
      ...input,
      requestId: 'board-proposal',
    });
    expect(
      h.history().find((entry) => entry.id === 'schedule-proposal-board-proposal')
    ).toMatchObject({ items: [{ meta: { boardId: 'bd_test' } }] });
    h.session('session', { boardId: 'bd_other' });
    const current = (await h.repository.read('board-task'))!;
    await expect(
      executeScheduleCommand(h.context, {
        action: 'edit',
        scheduleId: 'board-task',
        requestId: 'foreign-edit',
        draft: buildScheduleEditDraft(
          { scheduleId: 'board-task', requestId: 'foreign-edit', boardId: 'bd_other' },
          current,
          draftContext
        ),
      })
    ).rejects.toThrow('member of that Board');
    await expect(
      executeScheduleCommand(h.context, {
        action: 'pause',
        scheduleId: 'board-task',
        requestId: 'foreign-pause',
      })
    ).rejects.toThrow('member of that Board');
    await expect(
      executeScheduleCommand(h.context, {
        action: 'resume',
        scheduleId: 'board-task',
        requestId: 'foreign-resume',
      })
    ).rejects.toThrow('member of that Board');
    await expect(
      executeScheduleCommand(h.context, {
        action: 'propose',
        ...input,
        requestId: 'foreign-proposal',
      })
    ).rejects.toThrow('member of that Board');
  });

  it('rejects archived Boards and archived, foreign or coordinator destinations at save', async () => {
    const h = await asAgent('full');
    h.session('session', { boardId: 'bd_test' });
    h.board('bd_test');
    const input: ScheduleCreateToolInput = {
      requestId: 'board-task',
      boardId: 'bd_test',
      title: 'Board task',
      prompt: 'Summarize commits.',
      rule: { kind: 'manual' },
      destination: { kind: 'existing_session', sessionId: 'thread' },
    };
    const draft = buildScheduleCreateDraft(input, draftContext);
    const command = {
      action: 'create' as const,
      scheduleId: 'board-task',
      requestId: 'board-task',
      draft,
    };
    for (const extra of [{ isArchived: true }, { boardId: 'bd_other' }, { id: 'main' }]) {
      h.session('thread', { id: 'thread', agentConfigId: 'agent', boardId: 'bd_test', ...extra });
      await expect(executeScheduleCommand(h.context, command)).rejects.toThrow(
        'Choose one of your own chats'
      );
    }
    h.session('thread', { id: 'thread', agentConfigId: 'agent', boardId: 'bd_test' });
    h.board('bd_test', 2);
    await expect(executeScheduleCommand(h.context, command)).rejects.toThrow('BOARD_UNAVAILABLE');
    h.board('bd_test');
    await executeScheduleCommand(h.context, command);
    expect((await h.repository.read('board-task'))?.definition.destination).toEqual(
      input.destination
    );
  });

  it('stores MCP ids from create/update and preserves omitted versus empty selections', async () => {
    const h = await asAgent('edit');
    h.addMcp('mcp-a', 'Mail');
    const input = {
      requestId: 'mcp-task',
      title: 'MCP task',
      prompt: 'Read updates.',
      rule: { kind: 'manual' as const },
      mcpServerIds: ['Mail'],
    };
    const command = {
      action: 'create' as const,
      scheduleId: 'mcp-task',
      requestId: input.requestId,
      draft: buildScheduleCreateDraft(input, draftContext),
    };
    await executeScheduleCommand(h.context, command);
    await executeScheduleCommand(h.context, command);
    const stored = (await h.repository.read('mcp-task'))!;
    expect(stored.definition.mcpServerIds).toEqual(['mcp-a']);
    expect(
      buildScheduleEditDraft(
        { scheduleId: 'mcp-task', requestId: 'unchanged', title: 'Renamed' },
        stored,
        draftContext
      ).mcpServerIds
    ).toEqual(['mcp-a']);
    await executeScheduleCommand(h.context, {
      action: 'edit',
      scheduleId: 'mcp-task',
      requestId: 'empty',
      draft: buildScheduleEditDraft(
        { scheduleId: 'mcp-task', requestId: 'empty', mcpServerIds: [] },
        stored,
        draftContext
      ),
    });
    expect(
      await executeScheduleCommand(h.context, { action: 'show', scheduleId: 'mcp-task' })
    ).toMatchObject({ schedule: { definition: { mcpServerIds: [] } } });
    expect(
      buildScheduleCreateDraft({ ...input, mcpServerIds: undefined }, draftContext)
    ).not.toHaveProperty('mcpServerIds');
    await expect(
      executeScheduleCommand(h.context, {
        ...command,
        scheduleId: 'missing',
        requestId: 'missing',
        draft: { ...command.draft, mcpServerIds: ['missing'] },
      })
    ).rejects.toThrow('MCP server not found');
    h.addMcp('mcp-b', 'Mail');
    await expect(
      executeScheduleCommand(h.context, {
        ...command,
        scheduleId: 'ambiguous',
        requestId: 'ambiguous',
      })
    ).rejects.toThrow('ambiguous');
  });

  it('keeps saved MCP ids whose server was removed, and null returns to workspace defaults', async () => {
    const h = await asAgent('edit');
    h.addMcp('mcp-a', 'Mail');
    h.addMcp('mcp-b', 'Search');
    await executeScheduleCommand(h.context, {
      action: 'create',
      scheduleId: 'mcp-task',
      requestId: 'mcp-task',
      draft: buildScheduleCreateDraft(
        {
          requestId: 'mcp-task',
          title: 'MCP task',
          prompt: 'Read updates.',
          rule: { kind: 'manual' },
          mcpServerIds: ['Mail', 'Search'],
        },
        draftContext
      ),
    });
    h.removeMcp('mcp-a');
    const edit = async (input: Omit<ScheduleUpdateToolInput, 'scheduleId'>) =>
      executeScheduleCommand(h.context, {
        action: 'edit',
        scheduleId: 'mcp-task',
        requestId: input.requestId,
        draft: buildScheduleEditDraft(
          { scheduleId: 'mcp-task', ...input },
          (await h.repository.read('mcp-task'))!,
          draftContext
        ),
      });
    await edit({ requestId: 'rename', title: 'Renamed' });
    // The replay rebuilds from the saved document and still matches.
    await edit({ requestId: 'rename', title: 'Renamed' });
    let stored = (await h.repository.read('mcp-task'))!;
    expect(stored.definition).toMatchObject({
      title: 'Renamed',
      mcpServerIds: ['mcp-a', 'mcp-b'],
    });
    // A newly named server is still looked up.
    await expect(edit({ requestId: 'gone', mcpServerIds: ['mcp-a', 'Mail'] })).rejects.toThrow(
      'MCP server not found: Mail'
    );
    await edit({ requestId: 'defaults', mcpServerIds: null });
    stored = (await h.repository.read('mcp-task'))!;
    expect(stored.definition.mcpServerIds).toBeUndefined();
    await edit({ requestId: 'still-defaults', title: 'Renamed again' });
    expect((await h.repository.read('mcp-task'))!.definition.mcpServerIds).toBeUndefined();
  });

  it('creates an enabled schedule with this conversation’s Agent and mode, attributed to it', async () => {
    const h = await asAgent('edit');
    // Every success, a retry included, hands back the one notice id devices alert on once.
    const notice = {
      id: 'config:workspace:schedule:nightly:create:nightly',
      action: 'create',
      title: 'Nightly review',
    };
    await expect(create(h, 'nightly')).resolves.toEqual({
      ok: true,
      scheduleId: 'nightly',
      notice,
    });
    await expect(create(h, 'nightly')).resolves.toEqual({
      ok: true,
      scheduleId: 'nightly',
      notice,
    });
    expect(h.history().filter((entry) => entry.id === notice.id)).toHaveLength(1);
    const saved = (await h.repository.read('nightly'))!;
    expect(saved.definition).toMatchObject({
      enabled: true,
      machineId: 'machine',
      agent: { agentConfigId: 'agent', modeId: 'acceptEdits' },
      trigger: { kind: 'cron', expression: '0 21 * * *', timeZone: 'Asia/Tokyo' },
    });
    expect(saved.timeline).toMatchObject([
      { id: 'nightly', kind: 'created', requesterSessionId: 'session' },
    ]);
    expect(h.history()).toMatchObject([
      {
        role: 'system',
        items: [{ type: 'text', text: expect.stringContaining('Created scheduled task') }],
      },
    ]);
  });

  it('refuses a schedule above the conversation’s tier or with an unknown mode, writing nothing', async () => {
    const h = await asAgent('edit');
    conversation.runConfig = { modeId: 'bypassPermissions' };
    try {
      await expect(create(h, 'elevated')).rejects.toThrow('lody_schedule_propose');
      conversation.runConfig = { modeId: 'experimental-mode' };
      await expect(create(h, 'unknown')).rejects.toThrow('lody_schedule_propose');
    } finally {
      conversation.runConfig = { modeId: 'acceptEdits' };
    }
    expect(await h.repository.read('elevated')).toBeNull();
    expect(await h.repository.read('unknown')).toBeNull();
    expect(h.history()).toEqual([]);
  });

  it('still leaves create to a person when no tier came with the request', async () => {
    const h = await asAgent('full');
    h.context.requesterPermissionTier = undefined;
    await expect(create(h, 'untiered')).rejects.toThrow('human');
  });

  it('edits only what was named, and not a schedule already above the tier', async () => {
    const h = await asAgent('edit');
    await create(h, 'nightly');
    const current = (await h.repository.read('nightly'))!;
    await executeScheduleCommand(h.context, {
      action: 'edit',
      scheduleId: 'nightly',
      requestId: 'retitle',
      draft: buildScheduleEditDraft(
        { scheduleId: 'nightly', requestId: 'retitle', title: 'Evening review' },
        current,
        draftContext
      ),
    });
    const edited = (await h.repository.read('nightly'))!;
    expect(edited.definition).toMatchObject({
      title: 'Evening review',
      trigger: current.definition.trigger,
      agent: current.definition.agent,
    });
    expect(edited.prompt).toBe(current.prompt);
    expect(edited.timeline.at(-1)).toMatchObject({
      kind: 'edited',
      requesterSessionId: 'session',
    });

    // A person raised it; a lower-tier Agent may not touch it, not even to lower it.
    await h.repository.save({
      scheduleId: 'nightly',
      draft: {
        ...edited.definition,
        agent: { agentConfigId: 'agent', modeId: 'bypassPermissions' },
        prompt: edited.prompt,
      },
      actorId: 'owner',
      now: 3,
      activationId: 'raise',
      activityId: 'raise',
    });
    const raised = (await h.repository.read('nightly'))!;
    await expect(
      executeScheduleCommand(h.context, {
        action: 'edit',
        scheduleId: 'nightly',
        requestId: 'lower',
        draft: buildScheduleEditDraft(
          { scheduleId: 'nightly', requestId: 'lower', prompt: 'Something else.' },
          {
            ...raised,
            definition: { ...raised.definition, agent: edited.definition.agent },
          },
          draftContext
        ),
      })
    ).rejects.toThrow('Only the user');
    expect((await h.repository.read('nightly'))?.prompt).toBe(edited.prompt);
  });

  describe('a schedule that runs as an Agent Role', () => {
    const roleInstance = (modeId: string) => ({
      id: 'instance-1',
      agentConfigId: 'agent',
      runConfig: { modeId, modelId: 'sonnet' },
    });
    /** A write as the MCP path builds it: against the catalog the caller read. */
    const createAs = (
      h: Awaited<ReturnType<typeof fixture>>,
      requestId: string,
      role: NonNullable<ReturnType<Awaited<ReturnType<typeof fixture>>['setRole']>>
    ) =>
      executeScheduleCommand(h.context, {
        action: 'create',
        scheduleId: requestId,
        requestId,
        draft: buildScheduleCreateDraft(
          {
            requestId,
            title: 'Nightly review',
            prompt: 'Review today’s commits.',
            rule: { kind: 'daily', hour: 21, minute: 0 },
            target: { agentRoleId: role.id },
          },
          { ...draftContext, roles: [role] }
        ),
      });
    const update = async (
      h: Awaited<ReturnType<typeof fixture>>,
      input: Omit<Parameters<typeof buildScheduleEditDraft>[0], 'scheduleId'>,
      roles: Parameters<typeof buildScheduleEditDraft>[2]['roles'] = []
    ) =>
      executeScheduleCommand(h.context, {
        action: 'edit',
        scheduleId: 'nightly',
        requestId: input.requestId,
        draft: buildScheduleEditDraft(
          { scheduleId: 'nightly', ...input },
          (await h.repository.read('nightly'))!,
          { ...draftContext, roles }
        ),
      });

    it('saves the reference, shows it, keeps it without a target and drops it with a plain one', async () => {
      const h = await asAgent('edit');
      const role = h.setRole('role-1', roleInstance('acceptEdits'))!;
      await createAs(h, 'nightly', role);
      expect((await h.repository.read('nightly'))!.definition).toMatchObject({
        agentRole: { roleId: 'role-1' },
        // What the Role resolved to at this write, for listing.
        agent: { agentConfigId: 'agent', modeId: 'acceptEdits', modelId: 'sonnet' },
      });
      await expect(
        executeScheduleCommand(h.context, { action: 'show', scheduleId: 'nightly' })
      ).resolves.toMatchObject({ schedule: { definition: { agentRole: { roleId: 'role-1' } } } });
      await expect(
        executeScheduleCommand(h.context, { action: 'list', limit: 30, query: 'Nightly' })
      ).resolves.toMatchObject({ schedules: [{ scheduleId: 'nightly', agentRoleId: 'role-1' }] });

      await update(h, { requestId: 'retitle', title: 'Evening review' });
      expect((await h.repository.read('nightly'))!.definition).toMatchObject({
        title: 'Evening review',
        agentRole: { roleId: 'role-1' },
      });

      // Naming the Agent itself ends the Role: the schedule keeps that Agent's config.
      await update(h, { requestId: 'plain', target: { agentConfigId: 'agent' } });
      const plain = (await h.repository.read('nightly'))!.definition;
      expect(plain.agentRole).toBeUndefined();
      expect(plain.agent).toEqual({ agentConfigId: 'agent', modeId: 'acceptEdits' });
      expect(
        (await h.repository.list()).find((row) => row.scheduleId === 'nightly')?.agentRoleId
      ).toBeUndefined();

      // And a target naming a Role binds it again, to the instance named.
      await update(
        h,
        {
          requestId: 'rebind',
          target: { agentRoleId: 'role-1', agentRoleInstanceId: 'instance-1' },
        },
        [role]
      );
      expect((await h.repository.read('nightly'))!.definition.agentRole).toEqual({
        roleId: 'role-1',
        instanceId: 'instance-1',
      });
    });

    it('ranks the schedule as the Role runs now, never as the Agent saved beside it', async () => {
      const h = await asAgent('edit');
      const role = h.setRole('role-1', roleInstance('acceptEdits'))!;
      await createAs(h, 'nightly', role);

      // The user raises the Role. The schedule's saved Agent still says acceptEdits.
      h.setRole('role-1', roleInstance('bypassPermissions'));
      expect((await h.repository.read('nightly'))!.definition.agent.modeId).toBe('acceptEdits');
      await expect(update(h, { requestId: 'retitle', title: 'Evening review' })).rejects.toThrow(
        'Only the user'
      );
      // A draft built from a catalog read before the change claims the old mode; the
      // write is still ranked, and would be saved, as the Role is now.
      await expect(createAs(h, 'stale', role)).rejects.toThrow('lody_schedule_propose');
      expect(await h.repository.read('stale')).toBeNull();
      h.context.requesterPermissionTier = undefined;
      await executeScheduleCommand(h.context, {
        action: 'pause',
        scheduleId: 'nightly',
        requestId: 'pause',
      });
      h.context.requesterPermissionTier = 'edit';
      await expect(
        executeScheduleCommand(h.context, {
          action: 'resume',
          scheduleId: 'nightly',
          requestId: 'resume',
        })
      ).rejects.toThrow('Only the user');

      // Lowered again, the same caller may change it, and the saved Agent follows the Role.
      h.setRole('role-1', { ...roleInstance('acceptEdits'), runConfig: { modeId: 'acceptEdits' } });
      await update(h, { requestId: 'retitle', title: 'Evening review' });
      expect((await h.repository.read('nightly'))!.definition).toMatchObject({
        title: 'Evening review',
        agentRole: { roleId: 'role-1' },
        agent: { agentConfigId: 'agent', modeId: 'acceptEdits' },
      });
      expect((await h.repository.read('nightly'))!.definition.agent).not.toHaveProperty('modelId');

      // A Role that is gone has no tier to compare: the schedule is the user's to change.
      h.setRole('role-1', null);
      await expect(update(h, { requestId: 'again', title: 'Night review' })).rejects.toThrow(
        'Only the user'
      );
    });

    it('completes a write whose Registry row failed, as it was first made, after the Role changed', async () => {
      const h = await asAgent('edit');
      const first = h.setRole('role-1', roleInstance('acceptEdits'))!;
      const published = async (scheduleId: string) => {
        const document = (await h.repository.read(scheduleId))!;
        const row = (await h.repository.list()).find((entry) => entry.scheduleId === scheduleId);
        return {
          document,
          matches: row?.definitionFingerprint === scheduleDefinitionFingerprint(document),
        };
      };
      const firstAgent = { agentConfigId: 'agent', modeId: 'acceptEdits', modelId: 'sonnet' };

      // Create: the definition lands, its Registry row does not.
      h.failNextRegistryPublish();
      await expect(createAs(h, 'nightly', first)).rejects.toThrow('Registry write failed');
      expect((await published('nightly')).matches).toBe(false);
      // The Role is edited before the caller retries the same request.
      const second = h.setRole('role-1', {
        ...roleInstance('acceptEdits'),
        runConfig: { modeId: 'acceptEdits', modelId: 'opus' },
      })!;
      await expect(createAs(h, 'nightly', second)).resolves.toMatchObject({ ok: true });
      const created = await published('nightly');
      expect(created.matches).toBe(true);
      expect(created.document.definition.agent).toEqual(firstAgent);
      expect(created.document.timeline).toHaveLength(1);

      // Edit: the same, with the Role changing again in between.
      h.failNextRegistryPublish();
      await expect(update(h, { requestId: 'retitle', title: 'Evening review' })).rejects.toThrow(
        'Registry write failed'
      );
      expect((await published('nightly')).matches).toBe(false);
      h.setRole('role-1', {
        ...roleInstance('acceptEdits'),
        runConfig: { modeId: 'acceptEdits', modelId: 'haiku' },
      });
      await expect(
        update(h, { requestId: 'retitle', title: 'Evening review' })
      ).resolves.toMatchObject({ ok: true });
      const edited = await published('nightly');
      expect(edited.matches).toBe(true);
      expect(edited.document.definition).toMatchObject({
        title: 'Evening review',
        agentRole: { roleId: 'role-1' },
        // What the Role resolved to when this request first landed.
        agent: { agentConfigId: 'agent', modeId: 'acceptEdits', modelId: 'opus' },
      });
      expect(edited.document.timeline.map((entry) => entry.id)).toEqual(['nightly', 'retitle']);

      // A new request is a new write: it saves what the Role says now.
      await update(h, { requestId: 'reprompt', prompt: 'Review this week’s commits.' });
      const fresh = await published('nightly');
      expect(fresh.matches).toBe(true);
      expect(fresh.document.definition.agent).toEqual({
        agentConfigId: 'agent',
        modeId: 'acceptEdits',
        modelId: 'haiku',
      });

      // A retry is still ranked as the Role runs now: raised above the caller, it is refused.
      h.failNextRegistryPublish();
      await expect(update(h, { requestId: 'again', title: 'Night review' })).rejects.toThrow(
        'Registry write failed'
      );
      h.setRole('role-1', roleInstance('bypassPermissions'));
      await expect(update(h, { requestId: 'again', title: 'Night review' })).rejects.toThrow(
        'Only the user'
      );
    });

    it('refuses a reference that cannot run: a picked chat, an older daemon, a missing Role', async () => {
      const h = await asAgent('edit');
      // A person's own command: no tier applies, the rules below still do.
      h.context.requesterSessionId = undefined;
      h.context.requesterPermissionTier = undefined;
      const { definition } = (await h.repository.read('schedule'))!;
      const draft = {
        title: 'As a Role',
        machineId: definition.machineId,
        trigger: definition.trigger,
        misfirePolicy: definition.misfirePolicy,
        overlapPolicy: definition.overlapPolicy,
        agent: definition.agent,
        agentRole: { roleId: 'role-1' },
        retryPolicy: definition.retryPolicy,
        prompt: 'Synthetic prompt',
      };
      const save = (overrides: Partial<typeof draft> & { destination?: object } = {}) =>
        executeScheduleCommand(h.context, {
          action: 'create',
          scheduleId: 'as-role',
          requestId: 'as-role',
          draft: { ...draft, ...overrides },
        } as ScheduleCommand);
      await expect(save()).rejects.toThrow('No Agent Role with that id');
      h.setRole('role-1', { ...roleInstance('acceptEdits'), agentConfigId: 'elsewhere' });
      await expect(save()).rejects.toThrow('no instance that can run on the target machine');
      h.setRole('role-1', roleInstance('acceptEdits'));
      h.session('chat', { id: 'chat', agentConfigId: 'agent' });
      await expect(
        save({ destination: { kind: 'existing_session', sessionId: 'chat' } })
      ).rejects.toThrow('cannot keep an Agent Role');
      h.withoutRoleSupport();
      await expect(save()).rejects.toThrow('Update the target machine CLI');
      expect(await h.repository.read('as-role')).toBeNull();
    });
  });

  it('resumes a paused schedule within the tier, and only that', async () => {
    const h = await asAgent('edit');
    await create(h, 'nightly');
    h.context.requesterPermissionTier = undefined;
    await executeScheduleCommand(h.context, {
      action: 'pause',
      scheduleId: 'nightly',
      requestId: 'pause',
    });
    h.context.requesterPermissionTier = 'ask';
    await expect(
      executeScheduleCommand(h.context, {
        action: 'resume',
        scheduleId: 'nightly',
        requestId: 'resume-low',
      })
    ).rejects.toThrow('Only the user');
    h.context.requesterPermissionTier = 'edit';
    await expect(
      executeScheduleCommand(h.context, {
        action: 'resume',
        scheduleId: 'nightly',
        requestId: 'resume',
      })
    ).resolves.toMatchObject({ ok: true, scheduleId: 'nightly' });
    const resumed = (await h.repository.read('nightly'))!;
    expect(resumed.definition.enabled).toBe(true);
    expect(resumed.timeline.at(-1)).toMatchObject({
      id: 'resume',
      kind: 'resumed',
      requesterSessionId: 'session',
    });
    expect(h.history().at(-1)).toMatchObject({
      items: [{ type: 'text', text: expect.stringContaining('Resumed scheduled task') }],
    });
  });
  it('counts what a chat the runs go into keeps, and an unset permission option beside the mode', async () => {
    const h = await asAgent('edit');
    // The person's chat with this Agent was last switched to Bypass Permissions.
    h.session('chat', { id: 'chat', agentConfigId: 'agent', latestUserMsgId: 'chat-turn' });
    await (
      await h.context.manager.getOrCreateSessionDoc('chat' as never)
    ).updateHistory((entries: any[]) => [
      ...entries,
      { id: 'chat-turn', role: 'user', inputConfig: { modeId: 'acceptEdits' } },
    ]);
    h.runtimeReport('chat', { basedOnUserTurnId: 'turn', modeId: 'bypassPermissions' });
    const intoChat = (requestId: string) =>
      executeScheduleCommand(h.context, {
        action: 'create',
        scheduleId: requestId,
        requestId,
        draft: buildScheduleCreateDraft(
          {
            requestId,
            title: 'Into the chat',
            prompt: 'Summarize the day.',
            rule: { kind: 'daily', hour: 21, minute: 0 },
            destination: { kind: 'existing_session', sessionId: 'chat' },
          },
          draftContext
        ),
      });
    await expect(intoChat('into-chat')).rejects.toThrow('the chat it sends into');
    h.runtimeReport('chat', { basedOnUserTurnId: 'turn', modeId: 'acceptEdits' });
    await expect(intoChat('into-calm-chat')).resolves.toMatchObject({
      ok: true,
      scheduleId: 'into-calm-chat',
    });

    // Grok keeps `permission_mode` apart from its mode; a run that does not set
    // it inherits whatever the chat had, so it cannot be ranked.
    h.addAgent('grok', 'grok', staticCapability('grok'));
    const grok = (requestId: string, configOptionValues?: Record<string, string>) =>
      executeScheduleCommand(h.context, {
        action: 'create',
        scheduleId: requestId,
        requestId,
        draft: {
          ...buildScheduleCreateDraft(
            { requestId, title: 'Grok', prompt: 'Review.', rule: { kind: 'manual' } },
            draftContext
          ),
          agent: {
            agentConfigId: 'grok',
            modeId: 'default',
            ...(configOptionValues ? { configOptionValues } : {}),
          },
        },
      });
    await expect(grok('grok-unset')).rejects.toThrow('permission_mode');
    await expect(grok('grok-ask', { permission_mode: 'ask' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(grok('grok-approve', { permission_mode: 'always-approve' })).rejects.toThrow(
      'more permissions'
    );
  });

  it('refuses a builtin default mode the Agent does not offer instead of assuming it', async () => {
    const h = await asAgent('auto');
    // An older Codex adapter without Auto review starts in its own default mode.
    const codex = staticCapability('codex');
    const offered = (value: string) => value !== 'agent-auto-review';
    h.addAgent('old-codex', 'codex', {
      ...codex,
      modes: codex.modes.filter((mode) => offered(mode.id)),
      configOptions: codex.configOptions.map((option) =>
        option.id === 'mode'
          ? { ...option, options: option.options.filter((choice) => offered(choice.value)) }
          : option
      ),
    });
    h.addAgent('codex', 'codex', codex);
    const withoutMode = (requestId: string, agentConfigId: string) =>
      executeScheduleCommand(h.context, {
        action: 'create',
        scheduleId: requestId,
        requestId,
        draft: {
          ...buildScheduleCreateDraft(
            { requestId, title: 'Codex', prompt: 'Review.', rule: { kind: 'manual' } },
            draftContext
          ),
          agent: { agentConfigId },
        },
      });
    await expect(withoutMode('old', 'old-codex')).rejects.toThrow('more permissions');
    // Where the default is offered, dispatch applies it and it ranks as Auto review.
    await expect(withoutMode('current', 'codex')).resolves.toMatchObject({ ok: true });
  });

  it('completes a retried interval write with the same request id, and still refuses another', async () => {
    const h = await asAgent('edit');
    const input = {
      requestId: 'every-seven',
      title: 'Every seven minutes',
      prompt: 'Check the queue.',
      rule: { kind: 'minutes' as const, every: 7 },
    };
    const attempt = async (now: number, overrides: Partial<typeof input> = {}) =>
      executeScheduleCommand(h.context, {
        action: 'create',
        scheduleId: input.requestId,
        requestId: input.requestId,
        draft: buildScheduleCreateDraft(
          { ...input, ...overrides },
          {
            ...draftContext,
            now: scheduleDraftNow(now, await h.repository.read(input.requestId), input.requestId),
          }
        ),
      });
    await attempt(draftContext.now);
    // The answer was lost; the Agent retries a minute later.
    await expect(attempt(draftContext.now + 60_000)).resolves.toMatchObject({
      ok: true,
      scheduleId: 'every-seven',
    });
    expect((await h.repository.read('every-seven'))?.definition.trigger).toEqual({
      kind: 'interval',
      everyMs: 7 * 60_000,
      anchorAt: new Date(draftContext.now).toISOString(),
    });
    await expect(attempt(draftContext.now + 60_000, { title: 'Changed' })).rejects.toThrow(
      'Idempotency'
    );
  });

  it('takes the caller’s tier from its live Agent, else the lower of dispatch and report', async () => {
    const h = await asAgent('edit');
    const manager = h.context.manager;
    const turn = { id: 'turn', inputConfig: { modeId: 'auto' } };
    const session = { id: 'session', machineId: 'machine', agentConfigId: 'agent' };
    // A newer Turn is queued, so the report for this one stayed at Auto while
    // the Agent went into Plan; only the live Agent knows.
    h.runtimeReport('session', { basedOnUserTurnId: 'turn', modeId: 'auto' });
    await expect(
      readInvokingPermissionTier({
        manager,
        workspaceId: 'workspace' as never,
        session,
        turn,
        runtimeConfigOptions: [{ id: 'mode', category: 'mode', currentValue: 'plan' }],
      })
    ).resolves.toBe('ask');
    // No live Agent here: the lower of the dispatch config and the report.
    h.runtimeReport('session', { basedOnUserTurnId: 'turn', modeId: 'plan' });
    await expect(
      readInvokingPermissionTier({
        manager,
        workspaceId: 'workspace' as never,
        session,
        turn,
        runtimeConfigOptions: undefined,
      })
    ).resolves.toBe('ask');
    h.runtimeReport('session', { basedOnUserTurnId: 'turn', modeId: 'bypassPermissions' });
    await expect(
      readInvokingPermissionTier({
        manager,
        workspaceId: 'workspace' as never,
        session,
        turn,
        runtimeConfigOptions: undefined,
      })
    ).resolves.toBe('auto');
  });
  it('never lets a live option that lags a mode switch raise the caller’s tier', async () => {
    const h = await asAgent('edit');
    const manager = h.context.manager;
    const readTier = (
      agentConfigId: string,
      inputConfig: Record<string, unknown>,
      runtimeConfigOptions: RuntimeConfigOption[]
    ) =>
      readInvokingPermissionTier({
        manager,
        workspaceId: 'workspace' as never,
        session: { id: 'session', machineId: 'machine', agentConfigId },
        turn: { id: 'turn', inputConfig },
        runtimeConfigOptions,
      });
    // Codex switched to Read-only through the legacy mode call; its cached
    // options still say Full access.
    h.addAgent('codex', 'codex', staticCapability('codex'));
    h.runtimeReport('session', { basedOnUserTurnId: 'turn', modeId: 'read-only' });
    await expect(
      readTier('codex', { modeId: 'read-only' }, [
        { id: 'mode', category: 'mode', currentValue: 'agent-full-access' },
      ])
    ).resolves.toBe('ask');
  });

  it('ranks the state an Agent reports as it is, without a dispatch default', async () => {
    const h = await asAgent('edit');
    const manager = h.context.manager;
    const readTier = (
      agentConfigId: string,
      inputConfig: Record<string, unknown>,
      runtimeConfigOptions: RuntimeConfigOption[]
    ) =>
      readInvokingPermissionTier({
        manager,
        workspaceId: 'workspace' as never,
        session: { id: 'session', machineId: 'machine', agentConfigId },
        turn: { id: 'turn', inputConfig },
        runtimeConfigOptions,
      });
    // Kimi asks for every step; a builtin default belongs to future dispatch,
    // not to the state the Agent reports.
    h.addAgent('kimi', 'kimi', staticCapability('kimi'));
    h.runtimeReport('session', {});
    await expect(
      readTier('kimi', { configOptionValues: { permission_mode: 'default' } }, [
        { id: 'permission_mode', category: '_permission', currentValue: 'default' },
      ])
    ).resolves.toBe('ask');
  });
  it('lets any caller write and resume a Pi schedule, the user having exempted Pi', async () => {
    const h = await asAgent('unknown');
    h.addAgent('pi', 'pi');
    const draft = {
      ...buildScheduleCreateDraft(
        { requestId: 'pi', title: 'Pi', prompt: 'Tidy notes.', rule: { kind: 'manual' } },
        draftContext
      ),
      agent: { agentConfigId: 'pi' },
    };
    await expect(
      executeScheduleCommand(h.context, {
        action: 'create',
        scheduleId: 'pi',
        requestId: 'pi',
        draft,
      })
    ).resolves.toMatchObject({ ok: true, scheduleId: 'pi' });
    await executeScheduleCommand(h.context, { action: 'pause', scheduleId: 'pi', requestId: 'p' });
    await expect(
      executeScheduleCommand(h.context, { action: 'resume', scheduleId: 'pi', requestId: 'r' })
    ).resolves.toMatchObject({ ok: true, scheduleId: 'pi' });
    expect((await h.repository.read('pi'))?.definition.enabled).toBe(true);
    // The exemption is Pi's, not its caller's: Claude stays capped.
    await expect(create(h, 'claude-from-unknown')).rejects.toThrow('more permissions');
  });
  it('names each write’s notice by its schedule, so equal request ids stay apart', async () => {
    const h = await asAgent('edit');
    await create(h, 'first');
    await create(h, 'second');
    const retitle = async (scheduleId: string) =>
      executeScheduleCommand(h.context, {
        action: 'edit',
        scheduleId,
        requestId: 'update-1',
        draft: buildScheduleEditDraft(
          { scheduleId, requestId: 'update-1', title: `Renamed ${scheduleId}` },
          (await h.repository.read(scheduleId))!,
          draftContext
        ),
      });
    const ids = [
      ((await retitle('first')) as { notice: { id: string } }).notice.id,
      ((await retitle('second')) as { notice: { id: string } }).notice.id,
    ];
    expect(ids).toEqual([
      'config:workspace:schedule:first:edit:update-1',
      'config:workspace:schedule:second:edit:update-1',
    ]);
  });

  it('hands back the notice again when a resume is retried after its notice failed to sync', async () => {
    const h = await asAgent('edit');
    await create(h, 'nightly');
    h.context.requesterPermissionTier = undefined;
    await executeScheduleCommand(h.context, {
      action: 'pause',
      scheduleId: 'nightly',
      requestId: 'pause',
    });
    h.context.requesterPermissionTier = 'edit';
    h.context.localOnly = false;
    const resume = () =>
      executeScheduleCommand(h.context, {
        action: 'resume',
        scheduleId: 'nightly',
        requestId: 'resume',
      });
    await expect(resume()).rejects.toThrow('notification sync pending');
    expect((await h.repository.read('nightly'))?.definition.enabled).toBe(true);
    h.notificationSync.mockResolvedValue(true);
    await expect(resume()).resolves.toMatchObject({
      notice: { id: 'config:workspace:schedule:nightly:resume:resume', action: 'resume' },
    });
  });
});
