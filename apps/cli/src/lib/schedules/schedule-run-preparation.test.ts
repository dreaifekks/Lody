import { describe, expect, it } from 'vitest';
import {
  getWorkspaceFlockDocId,
  type AgentConfigMeta,
  type MachineMeta,
  type ProjectRef,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';

import type { LoroDocumentManager } from '../loro/doc';
import { ScheduleConfigurationError } from './schedule-engine';
import {
  buildScheduleRunPrompt,
  buildScheduleRunTarget,
  buildScheduleSessionCreateOptions,
  destinationSessionProblem,
  resolveScheduleRunRole,
  scheduleDestinationSessionId,
  scheduleRequiredLocalProjectId,
} from './schedule-run-preparation';

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

describe('Session inputs for one scheduled run', () => {
  it('carries a GitHub project onto the create selectors', () => {
    expect(
      buildScheduleSessionCreateOptions(
        run({ kind: 'github', repoFullName: 'loro-dev/lody', branch: 'main' })
      )
    ).toMatchObject({ repo: 'loro-dev/lody', branch: 'main' });
  });

  it('carries a local project and its worktree choice', () => {
    expect(
      buildScheduleSessionCreateOptions(
        run({ kind: 'local', localProjectId: 'p1' as never, useWorktree: true })
      )
    ).toMatchObject({ localProject: 'p1', worktree: true });
    expect(
      buildScheduleSessionCreateOptions(
        run({ kind: 'local', localProjectId: 'p1' as never, useWorktree: false })
      )
    ).not.toHaveProperty('worktree');
  });

  it('sends no workspace selector at all for a chat-only run', () => {
    const options = buildScheduleSessionCreateOptions(run());
    for (const selector of WORKSPACE_SELECTORS) expect(options).not.toHaveProperty(selector);
    // The rest of the run identity is still there, so this is "no project",
    // not "no options".
    expect(options).toEqual({
      agentConfig: 'agent',
      sessionId: 'session',
      userTurnId: 'turn',
      title: 'Daily review',
      workspaceMetaPrewriteSatisfied: true,
    });
  });

  it('freezes the identity the engine planned, not a fresh one', () => {
    expect(buildScheduleSessionCreateOptions(run())).toMatchObject({
      sessionId: 'session',
      userTurnId: 'turn',
      agentConfig: 'agent',
    });
  });
});

describe('Target for one scheduled run', () => {
  it('omits the project key entirely for a chat-only run', () => {
    const target = buildScheduleRunTarget({ targetMachine: machine, agentConfig });
    expect(Object.keys(target).sort()).toEqual(['agentConfig', 'targetMachine']);
    expect('project' in target).toBe(false);
  });

  it('passes a chosen project through unchanged', () => {
    const project: ProjectRef = { kind: 'github', repoFullName: 'loro-dev/lody', branch: 'main' };
    expect(buildScheduleRunTarget({ targetMachine: machine, agentConfig, project })).toEqual({
      targetMachine: machine,
      agentConfig,
      project,
    });
  });
});

describe('What a run requires from the owning machine', () => {
  it('asks for a local project ledger entry only when one was chosen', () => {
    expect(scheduleRequiredLocalProjectId(undefined)).toBeUndefined();
    expect(
      scheduleRequiredLocalProjectId({
        kind: 'github',
        repoFullName: 'loro-dev/lody',
        branch: 'main',
      })
    ).toBeUndefined();
    expect(scheduleRequiredLocalProjectId({ kind: 'local', localProjectId: 'p1' as never })).toBe(
      'p1'
    );
  });
});

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

  it('names the same chat for every run of an owned-chat schedule, and a new one per epoch', () => {
    const own = { kind: 'own_session', epoch: 0 } as const;
    expect(scheduleDestinationSessionId('sched', own)).toBe(
      scheduleDestinationSessionId('sched', own)
    );
    expect(scheduleDestinationSessionId('sched', { kind: 'own_session', epoch: 1 })).not.toBe(
      scheduleDestinationSessionId('sched', own)
    );
    expect(scheduleDestinationSessionId('other', own)).not.toBe(
      scheduleDestinationSessionId('sched', own)
    );
    expect(scheduleDestinationSessionId('sched', { kind: 'new_session' })).toBeUndefined();
    expect(
      scheduleDestinationSessionId('sched', { kind: 'existing_session', sessionId: 'picked' })
    ).toBe('picked');
  });

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
    expect(destinationSessionProblem({ ...base, destination, session: { kind: 'deleted' } })).toBe(
      'SESSION_UNAVAILABLE'
    );
    for (const wrong of [{ userId: 'other' }, { machineId: 'laptop' }, { agentConfigId: 'writer' }])
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
      instances: [{ id: 'instance-1', machineId: 'laptop', agentConfigId: 'agent', runConfig: {} }],
    });
    expect(await h.resolve(ref).catch(code)).toBe('ROLE_INSTANCE_UNAVAILABLE');
    h.roles.clear();
    expect(await h.resolve(ref).catch(code)).toBe('ROLE_NOT_FOUND');
  });

  it('puts the Role’s instruction before the prompt only on the run that creates the chat', async () => {
    const role = (await daemon().resolve({ roleId: 'role-1' }))!;
    expect(buildScheduleRunPrompt({ prompt: 'Cut the release.', role, createsSession: true })).toBe(
      'You are the release manager.\n\nCut the release.'
    );
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
