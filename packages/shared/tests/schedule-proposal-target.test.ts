import { describe, expect, it } from 'vitest';
import {
  ScheduleAgentSchema,
  type AgentConfigMeta,
  type CatalogAgentRole,
  type ScheduleProposalMeta,
  type SessionMeta,
} from '../src';
import {
  resolveScheduleAgentRole,
  resolveScheduleProposalTarget,
} from '../src/schedule-proposal-target';

const reviewer = {
  id: 'reviewer',
  machineId: 'macbook',
  name: 'Code reviewer',
  cliType: 'builtin',
  agentType: 'claude',
} as unknown as AgentConfigMeta;
const writer = {
  id: 'writer',
  machineId: 'studio',
  name: 'Writer',
  cliType: 'builtin',
  agentType: 'claude',
} as unknown as AgentConfigMeta;
const agents = [reviewer, writer];

const writerRunConfig = {
  modeId: 'plan',
  modelId: 'sonnet',
  configOptionValues: { verbose: true },
};
const role = {
  id: 'role-1',
  name: 'Release manager',
  emoji: '🚀',
  machineId: 'studio',
  agentConfigId: 'writer',
  runConfig: writerRunConfig,
  instances: [
    {
      id: 'release-studio',
      machineId: 'studio',
      agentConfigId: 'writer',
      runConfig: writerRunConfig,
    },
  ],
} as unknown as CatalogAgentRole;
/** Instances on the studio and the MacBook, studio first. */
const twoMachineRole = {
  ...role,
  instances: [
    ...role.instances,
    {
      id: 'release-mac',
      machineId: 'macbook',
      agentConfigId: 'reviewer',
      runConfig: {},
    },
  ],
} as unknown as CatalogAgentRole;

const session = {
  id: 's1',
  agentConfigId: 'reviewer',
  machineId: 'macbook',
  project: { kind: 'github', repoFullName: 'loro-dev/lody', branch: 'main' },
} as unknown as SessionMeta;
const conversation = { session, runConfig: { modeId: 'acceptEdits', modelId: 'opus' } };

const meta = (
  target?: ScheduleProposalMeta['target'],
  destination?: ScheduleProposalMeta['destination']
): ScheduleProposalMeta => ({
  proposalId: 'p1',
  title: 'Nightly review',
  prompt: 'Review today’s commits.',
  rule: { kind: 'daily', hour: 21, minute: 0 },
  ...(target ? { target } : {}),
  ...(destination ? { destination } : {}),
});

describe('where a proposed schedule runs', () => {
  it('defaults everything to the conversation it was proposed in', () => {
    const result = resolveScheduleProposalTarget({ meta: meta(), conversation, agents, roles: [] });
    expect(result).toMatchObject({
      ok: true,
      target: {
        agent: { agentConfigId: 'reviewer', modeId: 'acceptEdits', modelId: 'opus' },
        agentConfig: reviewer,
        project: { kind: 'github', repoFullName: 'loro-dev/lody' },
        destination: { kind: 'new_session' },
        source: { agent: 'conversation', project: 'conversation' },
      },
    });
  });

  it('carries the conversation’s options in the shape a schedule can store', () => {
    // Conversation options are ACP values (booleans too) and may include a
    // credential; the shared value types survive while credentials are removed.
    const result = resolveScheduleProposalTarget({
      meta: meta(),
      conversation: {
        session,
        runConfig: {
          modeId: 'acceptEdits',
          configOptionValues: {
            fast: true,
            plan_mode: false,
            select_flag: 'false',
            effort: 'high',
            api_key: 'secret',
          },
        },
      },
      agents,
      roles: [],
    });
    if (!result.ok) throw new Error(result.problem);
    expect(result.target.agent.configOptionValues).toEqual({
      fast: true,
      plan_mode: false,
      select_flag: 'false',
      effort: 'high',
    });
    expect(ScheduleAgentSchema.safeParse(result.target.agent).success).toBe(true);
  });

  it('lets a named Role replace the Agent, machine and run config together', () => {
    const result = resolveScheduleProposalTarget({
      meta: meta({ agentRoleId: 'role-1' }),
      conversation,
      agents,
      roles: [role],
    });
    expect(result).toMatchObject({
      ok: true,
      target: {
        agent: {
          agentConfigId: 'writer',
          modeId: 'plan',
          modelId: 'sonnet',
          configOptionValues: { verbose: true },
        },
        agentConfig: writer,
        source: { agent: 'role' },
      },
    });
  });

  it('runs a Role on the conversation machine when it has an instance there', () => {
    // The conversation runs on the MacBook, the second machine in the list.
    const result = resolveScheduleProposalTarget({
      meta: meta({ agentRoleId: 'role-1' }),
      conversation,
      agents,
      roles: [twoMachineRole],
    });
    expect(result).toMatchObject({ ok: true, target: { agentConfig: reviewer } });
    expect(result.ok && result.target.roleInstance?.id).toBe('release-mac');
  });

  it('runs a named instance, or a Role on a named machine only where it has one', () => {
    expect(
      resolveScheduleProposalTarget({
        meta: meta({ agentRoleId: 'role-1', agentRoleInstanceId: 'release-studio' }),
        conversation,
        agents,
        roles: [twoMachineRole],
      })
    ).toMatchObject({ ok: true, target: { roleInstance: { id: 'release-studio' } } });
    expect(
      resolveScheduleProposalTarget({
        meta: meta({ agentRoleId: 'role-1', machineId: 'studio' }),
        conversation,
        agents,
        roles: [twoMachineRole],
      })
    ).toMatchObject({ ok: true, target: { agentConfig: writer } });
    expect(
      resolveScheduleProposalTarget({
        meta: meta({ agentRoleId: 'role-1', machineId: 'macbook' }),
        conversation,
        agents,
        roles: [role],
      })
    ).toEqual({ ok: false, problem: 'machine_mismatch' });
  });

  it('keeps a reference to the Role, naming an instance only when one was named', () => {
    const bare = resolveScheduleProposalTarget({
      meta: meta({ agentRoleId: 'role-1' }),
      conversation,
      agents,
      roles: [twoMachineRole],
    });
    expect(bare.ok && bare.target.agentRole).toEqual({ roleId: 'role-1' });
    const pinned = resolveScheduleProposalTarget({
      meta: meta({ agentRoleId: 'role-1', agentRoleInstanceId: 'release-studio' }),
      conversation,
      agents,
      roles: [twoMachineRole],
    });
    expect(pinned.ok && pinned.target.agentRole).toEqual({
      roleId: 'role-1',
      instanceId: 'release-studio',
    });
    const plain = resolveScheduleProposalTarget({ meta: meta(), conversation, agents, roles: [] });
    expect(plain.ok && plain.target.agentRole).toBeUndefined();
  });

  it('refuses a Role for a picked chat, which follows its own Agent', () => {
    expect(
      resolveScheduleProposalTarget({
        meta: meta({ agentRoleId: 'role-1' }, { kind: 'existing_session', sessionId: 's9' }),
        conversation,
        agents,
        roles: [role],
      })
    ).toEqual({ ok: false, problem: 'role_with_chat' });
    expect(
      resolveScheduleProposalTarget({
        meta: meta({ agentRoleId: 'role-1' }, { kind: 'own_session' }),
        conversation,
        agents,
        roles: [role],
      })
    ).toMatchObject({ ok: true, target: { agentRole: { roleId: 'role-1' } } });
  });

  it('gives a named Agent the builtin default mode, never the conversation’s', () => {
    // The conversation's mode belongs to the conversation's Agent; carrying it
    // onto a different Agent could hand that Agent an elevated mode nobody chose.
    const result = resolveScheduleProposalTarget({
      meta: meta({ agentConfigId: 'writer' }),
      conversation,
      agents,
      roles: [],
    });
    expect(result.ok && result.target.agent.agentConfigId).toBe('writer');
    expect(result.ok && result.target.agent.modeId).not.toBe('acceptEdits');
    expect(result.ok && result.target.source.agent).toBe('named');
  });

  it('treats a named machine as a constraint the Agent must satisfy', () => {
    expect(
      resolveScheduleProposalTarget({
        meta: meta({ agentConfigId: 'writer', machineId: 'macbook' }),
        conversation,
        agents,
        roles: [],
      })
    ).toEqual({ ok: false, problem: 'machine_mismatch' });
    expect(
      resolveScheduleProposalTarget({
        meta: meta({ machineId: 'macbook' }),
        conversation,
        agents,
        roles: [],
      }).ok
    ).toBe(true);
  });

  it('drops the project when runs go into a chat, and takes a named one for a fresh chat', () => {
    expect(
      resolveScheduleProposalTarget({
        meta: meta(undefined, { kind: 'own_session' }),
        conversation,
        agents,
        roles: [],
      })
    ).toMatchObject({
      ok: true,
      target: { project: null, destination: { kind: 'own_session', epoch: 0 } },
    });
    expect(
      resolveScheduleProposalTarget({
        meta: meta({ project: { kind: 'local', localProjectId: 'p9' as never } }),
        conversation,
        agents,
        roles: [],
      })
    ).toMatchObject({
      ok: true,
      target: { project: { kind: 'local', localProjectId: 'p9' }, source: { project: 'named' } },
    });
  });

  it('names what is missing instead of guessing', () => {
    expect(
      resolveScheduleProposalTarget({
        meta: meta({ agentRoleId: 'gone' }),
        conversation,
        agents,
        roles: [],
      })
    ).toEqual({ ok: false, problem: 'role_not_found' });
    expect(
      resolveScheduleProposalTarget({
        meta: meta({ agentConfigId: 'ghost' }),
        conversation,
        agents,
        roles: [],
      })
    ).toEqual({ ok: false, problem: 'agent_not_found' });
    expect(
      resolveScheduleProposalTarget({ meta: meta(), conversation: null, agents, roles: [] })
    ).toEqual({ ok: false, problem: 'no_agent' });
  });
});

describe('what a schedule bound to a Role runs', () => {
  const resolve = (
    ref: { roleId: string; instanceId?: string },
    machineId: string,
    roles: CatalogAgentRole[],
    known = agents
  ) => resolveScheduleAgentRole({ ref, machineId, roles, agents: known });

  it('takes the Role’s instance on the schedule’s machine, never one elsewhere', () => {
    // The studio instance comes first in the Role, but the schedule is the MacBook's.
    expect(resolve({ roleId: 'role-1' }, 'macbook', [twoMachineRole])).toMatchObject({
      ok: true,
      instance: { id: 'release-mac' },
      agentConfig: reviewer,
      agent: { agentConfigId: 'reviewer' },
    });
    expect(resolve({ roleId: 'role-1' }, 'studio', [twoMachineRole])).toMatchObject({
      ok: true,
      instance: { id: 'release-studio' },
      agent: {
        agentConfigId: 'writer',
        modeId: 'plan',
        modelId: 'sonnet',
        configOptionValues: { verbose: true },
      },
    });
  });

  it('runs what the Role says at that moment, not what it said when saved', () => {
    const ref = { roleId: 'role-1', instanceId: 'release-studio' };
    const before = resolve(ref, 'studio', [role]);
    const edited = {
      ...role,
      revision: 2,
      instances: [
        {
          ...role.instances[0]!,
          runConfig: {
            modeId: 'bypassPermissions',
            modelId: 'opus',
            memory: { providerId: 'nmem', memoryId: 'm1' },
          },
        },
      ],
    } as unknown as CatalogAgentRole;
    const after = resolve(ref, 'studio', [edited]);
    expect(before.ok && before.agent.modelId).toBe('sonnet');
    expect(after).toMatchObject({
      ok: true,
      role: { revision: 2 },
      agent: {
        agentConfigId: 'writer',
        modeId: 'bypassPermissions',
        modelId: 'opus',
        memory: { providerId: 'nmem', memoryId: 'm1' },
      },
    });
    // Options the Role no longer pins are gone, not carried over from the old run config.
    expect(after.ok && after.agent.configOptionValues).toBeUndefined();
    expect(after.ok && ScheduleAgentSchema.safeParse(after.agent).success).toBe(true);
  });

  it('names the instance by its group, the way a dispatched Role is recorded', () => {
    const aliased = {
      ...role,
      instances: [{ ...role.instances[0]!, alias: 'Night shift' }],
    } as unknown as CatalogAgentRole;
    expect(resolve({ roleId: 'role-1' }, 'studio', [aliased])).toMatchObject({
      ok: true,
      groupName: 'Night shift',
    });
  });

  it('reports a deleted Role instead of running the saved Agent', () => {
    expect(resolve({ roleId: 'role-1' }, 'studio', [])).toEqual({
      ok: false,
      problem: 'role_not_found',
    });
  });

  it('reports a Role with nothing to run on that machine', () => {
    const unavailable = { ok: false, problem: 'instance_unavailable' };
    // No instance on the machine at all.
    expect(resolve({ roleId: 'role-1' }, 'macbook', [role])).toEqual(unavailable);
    // The named instance was removed, or lives on another machine.
    expect(resolve({ roleId: 'role-1', instanceId: 'gone' }, 'studio', [role])).toEqual(
      unavailable
    );
    expect(
      resolve({ roleId: 'role-1', instanceId: 'release-studio' }, 'macbook', [twoMachineRole])
    ).toEqual(unavailable);
    // Its Agent config no longer exists there.
    expect(resolve({ roleId: 'role-1' }, 'studio', [role], [reviewer])).toEqual(unavailable);
  });
});
