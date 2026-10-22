import {
  applyAgentRoleProposal,
  AgentRoleProposalCommandSchema,
  type AgentRoleProposalMeta,
} from '../src/agent-role-proposal';
import { describe, expect, it } from 'vitest';

import {
  AGENT_ROLE_VERSION,
  bindAgentRoleTarget,
  canManageAgentRole,
  formatAgentRoleMentionValue,
  getAgentRoleTargets,
  resolveAgentRoleMentionValue,
  canReadAgentRole,
  isAgentRoleContentEqual,
  isSensitiveAgentRoleConfigOptionKey,
  DEFAULT_AGENT_ROLE_EMOJI,
  getAgentRoleEmoji,
  getAgentRoleMentionSlug,
  listAccessibleAgentRoles,
  listAgentRoleInstancesOnMachine,
  normalizeAgentRole,
  normalizeAgentRoleEmoji,
  normalizeAgentRoleMentionSlug,
  normalizeAgentRoleRunConfig,
  serializeAgentRoleRow,
  resolveAgentRoleAvailability,
  selectAgentRoleInstance,
  withAgentRoleTargets,
  type AgentRole,
  type AgentRoleAvailabilityContext,
  type AgentRoleTarget,
} from '../src/agent-role';
import type { AgentConfigId, AgentRoleId, AgentRoleInstanceId, MachineId } from '../src/ids';

/** A row as a client that predates instances writes it: the legacy fields only. */
const legacyRow = (overrides: Partial<AgentRole> = {}) => {
  const { instances: _instances, ...row } = {
    v: AGENT_ROLE_VERSION,
    id: 'role-1' as AgentRoleId,
    ownerUserId: 'user-1',
    visibility: 'private' as const,
    name: 'Reviewer',
    machineId: 'machine-1' as MachineId,
    agentConfigId: 'config-1' as AgentConfigId,
    runConfig: { modelId: 'gpt-5.6' } as AgentRole['runConfig'],
    revision: 1,
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  };
  return row;
};

/** A single-instance Role, read the way the catalog reads its legacy fields. */
const role = (overrides: Partial<AgentRole> = {}): AgentRole =>
  normalizeAgentRole(legacyRow(overrides))!;
const targets = (value: AgentRole | undefined) => (value ? getAgentRoleTargets(value) : undefined);

const instance = (
  id: string,
  machine: string,
  overrides: Partial<AgentRoleTarget> = {}
): AgentRoleTarget => ({
  id: id as AgentRoleInstanceId,
  machineId: machine as MachineId,
  agentConfigId: `config-${id}` as AgentConfigId,
  runConfig: { modelId: `model-${id}` },
  ...overrides,
});

const multiRole = (...instances: AgentRoleTarget[]): AgentRole =>
  withAgentRoleTargets(legacyRow(), instances);

const context = (
  overrides: Partial<AgentRoleAvailabilityContext> = {}
): AgentRoleAvailabilityContext => ({
  authorizedMachineIds: new Set(['machine-1' as MachineId]),
  onlineMachineIds: new Set(['machine-1' as MachineId]),
  agentConfigMachineIds: new Map([['config-1' as AgentConfigId, 'machine-1' as MachineId]]),
  loadedAgentConfigMachineIds: new Set(['machine-1' as MachineId]),
  ...overrides,
});

describe('agent role description', () => {
  it('reads legacy roles as blank and bounds descriptions by Unicode code point', () => {
    expect(normalizeAgentRole(role())?.description ?? '').toBe('');
    for (const character of ['a', '中', '😀']) {
      const description = character.repeat(140);
      expect(normalizeAgentRole(role({ description }))?.description).toBe(description);
      expect(normalizeAgentRole(role({ description: description + character }))?.description).toBe(
        description
      );
    }
    expect(normalizeAgentRole({ ...role(), description: 42 })).toBeUndefined();
  });

  it('treats missing and blank as equal but detects description edits', () => {
    expect(isAgentRoleContentEqual(role(), role({ description: '' }))).toBe(true);
    expect(isAgentRoleContentEqual(role(), role({ description: 'Review changes' }))).toBe(false);
  });
});

describe('agent role mention slug', () => {
  it('keeps non-ASCII text but removes what an `@` token cannot carry', () => {
    expect(normalizeAgentRoleMentionSlug('  @Code Reviewer  ')).toBe('Code-Reviewer');
    expect(normalizeAgentRoleMentionSlug('代码 审阅')).toBe('代码-审阅');
    // A control character is invisible in the composer but still part of the
    // token, so a slug carrying one could never be typed back.
    expect(normalizeAgentRoleMentionSlug('a\u0007b')).toBe('ab');
    expect(normalizeAgentRoleMentionSlug('--x--')).toBe('x');
  });

  it('caps the slug by code point, not code unit', () => {
    const slug = normalizeAgentRoleMentionSlug('😀'.repeat(60));
    expect(Array.from(slug)).toHaveLength(40);
  });

  it('derives the mention token from the one authored name', () => {
    expect(getAgentRoleMentionSlug({ name: 'Code Reviewer' })).toBe('Code-Reviewer');
    // Renaming the Role renames its mention; the range still carries the id.
    expect(getAgentRoleMentionSlug({ name: 'Deep Reviewer' })).toBe('Deep-Reviewer');
  });
});

describe('agent role emoji', () => {
  it('keeps one short glyph and drops what would smuggle in a second line', () => {
    expect(normalizeAgentRoleEmoji('🔍')).toBe('🔍');
    expect(normalizeAgentRoleEmoji('  🧑\u200d💻  ')).toBe('🧑\u200d💻');
    expect(normalizeAgentRoleEmoji('a b')).toBe('ab');
    expect(normalizeAgentRoleEmoji('😀'.repeat(20))).toBe('😀'.repeat(8));
    expect(normalizeAgentRoleEmoji('   ')).toBeUndefined();
    expect(normalizeAgentRoleEmoji(42)).toBeUndefined();
  });

  it('falls back to one shared default so every Role reads the same', () => {
    expect(getAgentRoleEmoji({ emoji: '🔍' })).toBe('🔍');
    expect(getAgentRoleEmoji({})).toBe(DEFAULT_AGENT_ROLE_EMOJI);
    expect(getAgentRoleEmoji({ emoji: '' })).toBe(DEFAULT_AGENT_ROLE_EMOJI);
  });
});

describe('agent role run config', () => {
  it('refuses secret-shaped option keys on write and on read', () => {
    expect(isSensitiveAgentRoleConfigOptionKey('api_key')).toBe(true);
    expect(isSensitiveAgentRoleConfigOptionKey('bearer')).toBe(true);
    expect(isSensitiveAgentRoleConfigOptionKey('thought_level')).toBe(false);

    expect(
      normalizeAgentRoleRunConfig({
        modelId: 'gpt-5.6',
        configOptionValues: {
          thought_level: 'high',
          fast: true,
          openai_api_key: 'sk-live-value',
          nested: { leaked: true },
        },
      })
    ).toEqual({
      modelId: 'gpt-5.6',
      configOptionValues: { thought_level: 'high', fast: true },
    });
  });

  it('omits an empty option map rather than persisting one', () => {
    expect(normalizeAgentRoleRunConfig({ configOptionValues: {} })).toEqual({});
    expect(normalizeAgentRoleRunConfig(null)).toEqual({});
  });
});

describe('agent role rows', () => {
  it('normalizes a stored row and drops malformed ones', () => {
    const stored = {
      ...legacyRow({ name: '  Reviewer  ', emoji: ' 🔍 ', promptPrefix: '  Be strict.  ' }),
      runConfig: { modelId: 'gpt-5.6', configOptionValues: { auth_token: 'x' } },
    };
    expect(normalizeAgentRole(stored)).toEqual(
      role({
        name: 'Reviewer',
        emoji: '🔍',
        promptPrefix: 'Be strict.',
        runConfig: { modelId: 'gpt-5.6' },
      })
    );

    expect(normalizeAgentRole({ ...role(), v: 2 })).toBeUndefined();
    // A name with no mention token left is a Role that could never be used.
    expect(normalizeAgentRole({ ...role(), name: '---' })).toBeUndefined();
    expect(normalizeAgentRole({ ...role(), machineId: '  ' })).toBeUndefined();
    expect(normalizeAgentRole(null)).toBeUndefined();
  });

  it('reads a row without instances as one instance with an id derived from the row', () => {
    const read = normalizeAgentRole(legacyRow());
    expect(targets(read)).toEqual([
      {
        id: 'role-1:machine-1',
        machineId: 'machine-1',
        agentConfigId: 'config-1',
        runConfig: { modelId: 'gpt-5.6' },
      },
    ]);
    // Every member reads the row on its own: the same row, the same id.
    expect(targets(normalizeAgentRole(legacyRow()))?.[0]?.id).toBe(targets(read)?.[0]?.id);
  });

  it('turns lan.4 placements into instances, dropping switched-off ones', () => {
    const stored = {
      ...legacyRow(),
      placements: [
        { machineId: 'devnuc', agentConfigId: 'c-devnuc', enabled: true, runConfig: {} },
        {
          machineId: 'n100',
          agentConfigId: 'c-n100',
          enabled: true,
          runConfig: {
            modelId: 'gpt-6-astra',
            memory: { providerId: 'nowledge-mem', memoryId: 'vision' },
            configOptionValues: { reasoning_effort: 'high', api_key: 'sk-live' },
          },
        },
        { machineId: 'mac', agentConfigId: 'c-mac', enabled: false, runConfig: {} },
      ],
    };
    const first = normalizeAgentRole(stored);
    const second = normalizeAgentRole(structuredClone(stored));
    // No aliases: each instance groups with its agent.
    expect(targets(first)?.map((entry) => [entry.id, entry.alias, entry.machineId])).toEqual([
      ['role-1:devnuc', undefined, 'devnuc'],
      ['role-1:n100', undefined, 'n100'],
    ]);
    expect(targets(second)).toEqual(targets(first));
    // Secret-shaped options are dropped inside every instance; memory stays.
    expect(targets(first)?.[1]?.runConfig).toEqual({
      modelId: 'gpt-6-astra',
      memory: { providerId: 'nowledge-mem', memoryId: 'vision' },
      configOptionValues: { reasoning_effort: 'high' },
    });
    expect(first).toMatchObject({ machineId: 'devnuc', agentConfigId: 'c-devnuc' });
  });

  it('reads instances over every older field and mirrors the first one', () => {
    const read = normalizeAgentRole({
      ...legacyRow(),
      placements: [{ machineId: 'ignored', agentConfigId: 'ignored', enabled: true }],
      instances: [
        instance('claude', 'devnuc', { alias: ' Reviewer ' }),
        instance('gemini', 'devnuc', { alias: '  ' }),
        // A repeated id keeps the first; an entry without a machine is dropped.
        instance('claude', 'n100'),
        { ...instance('blank', 'n100'), machineId: '  ' as MachineId },
      ],
    });
    expect(targets(read)?.map((entry) => [entry.id, entry.alias])).toEqual([
      ['claude', 'Reviewer'],
      // A blank alias is no alias.
      ['gemini', undefined],
    ]);
    expect(read).toMatchObject({
      machineId: 'devnuc',
      agentConfigId: 'config-claude',
      runConfig: { modelId: 'model-claude' },
    });
    expect(listAgentRoleInstancesOnMachine(read!, 'devnuc' as MachineId)).toHaveLength(2);
  });

  it('treats option-key ordering as unchanged content', () => {
    const left = role({ runConfig: { configOptionValues: { a: '1', b: '2' } } });
    const right = role({ runConfig: { configOptionValues: { b: '2', a: '1' } } });
    expect(isAgentRoleContentEqual(left, right)).toBe(true);
    expect(isAgentRoleContentEqual(left, role({ ...left, promptPrefix: 'x' }))).toBe(false);
    expect(isAgentRoleContentEqual(left, role({ ...left, emoji: '🔍' }))).toBe(false);
  });

  it('treats instance order, aliases and run configs as edits', () => {
    const both = multiRole(instance('a', 'm1'), instance('b', 'm1'));
    expect(isAgentRoleContentEqual(both, multiRole(instance('a', 'm1'), instance('b', 'm1')))).toBe(
      true
    );
    expect(isAgentRoleContentEqual(both, multiRole(instance('b', 'm1'), instance('a', 'm1')))).toBe(
      false
    );
    expect(
      isAgentRoleContentEqual(
        both,
        multiRole(instance('a', 'm1'), instance('b', 'm1', { alias: 'x' }))
      )
    ).toBe(false);
  });
});

describe('agent role instance selection', () => {
  // Groups in first-appearance order: claude (n100, devnuc), gemini, codex.
  const fleet = multiRole(
    instance('claude-n100', 'n100'),
    instance('gemini-devnuc', 'devnuc'),
    instance('claude-devnuc', 'devnuc'),
    instance('codex-n100', 'n100')
  );
  const groupKeyOf = (entry: AgentRoleTarget) => entry.id.split('-')[0]!;
  const usable =
    (...ids: string[]) =>
    (entry: AgentRoleTarget) =>
      ids.includes(entry.id);
  const all = usable('claude-n100', 'gemini-devnuc', 'claude-devnuc', 'codex-n100');
  const pick = (request: Parameters<typeof selectAgentRoleInstance>[1], isUsable = all) =>
    selectAgentRoleInstance(fleet, request, isUsable, groupKeyOf);

  it('runs a named instance as named, or fails', () => {
    expect(pick({ instanceId: 'gemini-devnuc' })).toMatchObject({
      kind: 'selected',
      rule: 'instance',
      instance: { id: 'gemini-devnuc' },
    });
    expect(pick({ instanceId: 'gone' })).toMatchObject({
      kind: 'rejected',
      reason: 'instance_not_found',
    });
    expect(pick({ instanceId: 'gemini-devnuc', machineId: 'n100' as MachineId })).toMatchObject({
      kind: 'rejected',
      reason: 'instance_machine_mismatch',
    });
    expect(
      pick({ instanceId: 'gemini-devnuc', workContextMachineId: 'n100' as MachineId })
    ).toMatchObject({ kind: 'rejected', reason: 'instance_machine_mismatch' });
    expect(pick({ instanceId: 'gemini-devnuc' }, usable('claude-n100'))).toMatchObject({
      kind: 'rejected',
      reason: 'instance_unavailable',
    });
  });

  it('requires a target on a machine with several targets, even when only one is usable', () => {
    for (const isUsable of [all, usable('gemini-devnuc'), usable()]) {
      expect(pick({ machineId: 'devnuc' as MachineId }, isUsable)).toMatchObject({
        kind: 'rejected',
        reason: 'target_required',
      });
    }
    expect(pick({ machineId: 'laptop' as MachineId })).toMatchObject({
      kind: 'rejected',
      reason: 'machine_has_no_instance',
    });
  });

  it('requires a machine regardless of caller, ordering or availability', () => {
    for (const callerMachineId of ['devnuc', 'n100', 'elsewhere']) {
      expect(
        pick({ callerMachineId: callerMachineId as MachineId }, usable('gemini-devnuc'))
      ).toMatchObject({ kind: 'rejected', reason: 'machine_required' });
    }
    expect(pick({ workContextMachineId: 'n100' as MachineId })).toMatchObject({
      kind: 'rejected',
      reason: 'target_required',
    });
    expect(
      pick({ machineId: 'n100' as MachineId, workContextMachineId: 'devnuc' as MachineId })
    ).toMatchObject({ kind: 'rejected', reason: 'instance_machine_mismatch' });
  });

  it('resolves an alias only within the chosen machine and keeps unavailable pins failed', () => {
    const configuredRole = multiRole(
      instance('first', 'one', { alias: 'Review' }),
      instance('second', 'one', { alias: 'Build' }),
      instance('remote', 'two', { alias: 'Review' })
    );
    expect(
      selectAgentRoleInstance(
        configuredRole,
        { machineId: 'one' as MachineId, alias: 'Build' },
        () => true
      )
    ).toMatchObject({ kind: 'selected', instance: { id: 'second' } });
    expect(
      selectAgentRoleInstance(configuredRole, { instanceId: 'second' }, () => false)
    ).toMatchObject({
      kind: 'rejected',
      reason: 'instance_unavailable',
    });
    expect(
      selectAgentRoleInstance(configuredRole, { instanceId: 'deleted' }, () => true)
    ).toMatchObject({
      kind: 'rejected',
      reason: 'instance_not_found',
    });
  });
});

describe('agent role visibility', () => {
  const mine = role({ id: 'mine' as AgentRoleId, ownerUserId: 'user-1' });
  const theirsPrivate = role({ id: 'theirs' as AgentRoleId, ownerUserId: 'user-2' });
  const theirsShared = role({
    id: 'shared' as AgentRoleId,
    ownerUserId: 'user-2',
    visibility: 'workspace',
  });

  it('hides another member private role and exposes a shared one', () => {
    expect(canReadAgentRole(mine, 'user-1')).toBe(true);
    expect(canReadAgentRole(theirsPrivate, 'user-1')).toBe(false);
    expect(canReadAgentRole(theirsShared, 'user-1')).toBe(true);
    expect(listAccessibleAgentRoles([mine, theirsPrivate, theirsShared], 'user-1')).toEqual([
      mine,
      theirsShared,
    ]);
  });

  it('lets only the owner manage a shared role', () => {
    expect(canManageAgentRole(theirsShared, 'user-1')).toBe(false);
    expect(canManageAgentRole(theirsShared, 'user-2')).toBe(true);
    expect(canManageAgentRole(mine, null)).toBe(false);
  });
});

describe('agent role availability', () => {
  it('reports the precise reason instead of falling back', () => {
    expect(resolveAgentRoleAvailability(role(), context())).toEqual({ kind: 'available' });
    expect(
      resolveAgentRoleAvailability(role(), context({ authorizedMachineIds: new Set() }))
    ).toEqual({ kind: 'unavailable', reason: 'machine_unknown' });
    expect(resolveAgentRoleAvailability(role(), context({ onlineMachineIds: new Set() }))).toEqual({
      kind: 'unavailable',
      reason: 'machine_offline',
    });
    expect(
      resolveAgentRoleAvailability(role(), context({ agentConfigMachineIds: new Map() }))
    ).toEqual({ kind: 'unavailable', reason: 'agent_config_missing' });
    expect(
      resolveAgentRoleAvailability(
        role(),
        context({
          agentConfigMachineIds: new Map([['config-1' as AgentConfigId, 'machine-2' as MachineId]]),
        })
      )
    ).toEqual({ kind: 'unavailable', reason: 'agent_config_machine_mismatch' });
  });

  it('stays unknown while that machine configs are unread', () => {
    expect(
      resolveAgentRoleAvailability(role(), context({ loadedAgentConfigMachineIds: new Set() }))
    ).toEqual({ kind: 'unknown' });
  });

  it('is available while any instance can run it', () => {
    const both = multiRole(
      instance('two', 'machine-2', { agentConfigId: 'config-2' as AgentConfigId }),
      instance('one', 'machine-1', { agentConfigId: 'config-1' as AgentConfigId })
    );
    const configs = new Map([
      ['config-1' as AgentConfigId, 'machine-1' as MachineId],
      ['config-2' as AgentConfigId, 'machine-2' as MachineId],
    ]);
    const machines = new Set(['machine-1', 'machine-2'] as MachineId[]);
    const ctx = context({
      authorizedMachineIds: machines,
      loadedAgentConfigMachineIds: machines,
      agentConfigMachineIds: configs,
    });
    expect(resolveAgentRoleAvailability(both, ctx)).toEqual({ kind: 'available' });
    // Neither runs: the first machine's reason is the Role's.
    expect(resolveAgentRoleAvailability(both, { ...ctx, onlineMachineIds: new Set() })).toEqual({
      kind: 'unavailable',
      reason: 'machine_offline',
    });
  });
});

it('preserves memory references, revises identity changes, and gates older machines', () => {
  const binding = { providerId: 'nowledge-mem', memoryId: 'reviewer' };
  const configured = role({ runConfig: { memory: binding } });
  expect(normalizeAgentRole(configured)?.runConfig.memory).toEqual(binding);
  expect(
    isAgentRoleContentEqual(
      configured,
      role({ runConfig: { memory: { ...binding, memoryId: 'designer' } } })
    )
  ).toBe(false);
  expect(resolveAgentRoleAvailability(configured, context())).toEqual({
    kind: 'unavailable',
    reason: 'memory_unsupported',
  });
  expect(
    resolveAgentRoleAvailability(
      configured,
      context({ memoryProviderMachineIds: new Set([configured.machineId]) })
    )
  ).toEqual({ kind: 'available' });
  expect(
    normalizeAgentRole({ ...configured, runConfig: { memory: { providerId: 'nowledge-mem' } } })
  ).toBeUndefined();
});

describe('agent role machine targets', () => {
  const second = {
    machineId: 'machine-2' as MachineId,
    agentConfigId: 'config-2' as AgentConfigId,
    runConfig: { modelId: 'gpt-5.6-luna' },
    alias: 'Reviewer-Linux',
  };
  const multi = role({ alias: 'Reviewer-Mac', additionalTargets: [second] });

  it('reads all targets in a v2 row, including several on one machine', () => {
    const stored = {
      ...role(),
      v: 2,
      machineId: undefined,
      targets: [
        { machineId: 'machine-1', agentConfigId: 'config-1', runConfig: { modelId: 'gpt-5.6' } },
        second,
        { machineId: 'machine-2', agentConfigId: 'config-9', runConfig: {} },
      ],
    };
    const read = normalizeAgentRole(stored);
    expect(read && getAgentRoleTargets(read).map((target) => target.agentConfigId)).toEqual([
      'config-1',
      'config-2',
      'config-9',
    ]);
    // A v2 row with no usable target is not a Role.
    expect(normalizeAgentRole({ ...stored, targets: [] })).toBeUndefined();
    expect(normalizeAgentRole({ ...stored, targets: [{ machineId: 'm' }] })).toBeUndefined();
  });

  it('keeps aliases when targets are reduced to one', () => {
    expect(normalizeAgentRole(role({ alias: 'Solo' }))?.alias).toBe('Solo');
    expect(normalizeAgentRole(multi)?.alias).toBe('Reviewer-Mac');
  });

  it('binds only the selected target for execution', () => {
    const bound = bindAgentRoleTarget(multi, 'machine-2' as MachineId);
    expect(bound).toMatchObject({
      machineId: 'machine-2',
      agentConfigId: 'config-2',
      runConfig: { modelId: 'gpt-5.6-luna' },
      alias: 'Reviewer-Linux',
    });
    expect(bound?.additionalTargets).toBeUndefined();
    expect(bindAgentRoleTarget(multi, 'machine-3' as MachineId)).toBeUndefined();
  });

  it('treats a change on any machine as an edit', () => {
    expect(
      isAgentRoleContentEqual(multi, role({ alias: 'Reviewer-Mac', additionalTargets: [second] }))
    ).toBe(true);
    expect(
      isAgentRoleContentEqual(
        multi,
        role({ alias: 'Reviewer-Mac', additionalTargets: [{ ...second, runConfig: {} }] })
      )
    ).toBe(false);
    expect(isAgentRoleContentEqual(multi, role({ alias: 'Reviewer-Mac' }))).toBe(false);
  });

  it('resolves a mention to one machine and never guesses for a bare id', () => {
    const roles = [multi, role({ id: 'role-2' as AgentRoleId, name: 'Solo' })];
    expect(resolveAgentRoleMentionValue(roles, 'role-2')?.machineId).toBe('machine-1');
    expect(resolveAgentRoleMentionValue(roles, 'role-1')).toBeUndefined();
    expect(
      resolveAgentRoleMentionValue(
        roles,
        formatAgentRoleMentionValue('role-1' as AgentRoleId, 'machine-2' as MachineId)
      )?.agentConfigId
    ).toBe('config-2');
    expect(resolveAgentRoleMentionValue(roles, 'role-1@machine-3')).toBeUndefined();
  });
});

// Proposals share the same catalog rules as Settings while preserving unrelated fields.
describe('Agent Role proposals', () => {
  const proposal = (command: AgentRoleProposalMeta['command']): AgentRoleProposalMeta => ({
    command,
    roleId: 'role-1',
    requesterUserId: 'user-1',
  });
  it('creates a private role bound to the exact machine and Agent defaults', () => {
    const next = applyAgentRoleProposal(
      proposal({
        action: 'create',
        requestId: 'request',
        name: 'Reviewer',
        machineId: 'machine',
        agentConfigId: 'config',
        promptPrefix: 'Review carefully',
      }),
      [],
      'user-1',
      20
    );
    expect(next).toMatchObject({
      name: 'Reviewer',
      visibility: 'private',
      ownerUserId: 'user-1',
      machineId: 'machine',
      agentConfigId: 'config',
      runConfig: {},
      revision: 1,
      promptPrefix: 'Review carefully',
    });
    expect(next.createdAt).toBe(20);
  });
  it('patches the latest row, clears explicit empty fields and retains the execution snapshot', () => {
    const current = role({
      revision: 9,
      promptPrefix: 'Old',
      description: 'Keep this',
      emoji: '🐦',
      visibility: 'workspace',
    });
    const next = applyAgentRoleProposal(
      proposal({
        action: 'update',
        requestId: 'request',
        roleId: current.id,
        patch: { promptPrefix: '' },
      }),
      [current],
      'user-1',
      20
    );
    expect(next).toEqual({ ...current, promptPrefix: '', revision: 10, updatedAt: 20 });
    expect(current.promptPrefix).toBe('Old');
    expect(
      applyAgentRoleProposal(
        proposal({
          action: 'update',
          requestId: 'request',
          roleId: current.id,
          patch: { promptPrefix: '' },
        }),
        [next],
        'user-1',
        30
      )
    ).toBe(next);
  });
  it('normalizes instruction whitespace like Settings so file-based retries are no-ops', () => {
    const current = role({ promptPrefix: 'Review carefully' });
    const next = applyAgentRoleProposal(
      proposal({
        action: 'update',
        requestId: 'request',
        roleId: current.id,
        patch: { promptPrefix: '  Review carefully\n' },
      }),
      [current],
      'user-1',
      20
    );
    expect(next).toBe(current);
  });

  it('rejects deleted roles, unauthorized confirmation and duplicate mention names', () => {
    const update = proposal({
      action: 'update',
      requestId: 'request',
      roleId: 'role-1',
      patch: { name: 'New' },
    });
    expect(() => applyAgentRoleProposal(update, [], 'user-1', 20)).toThrow('no longer exists');
    expect(() => applyAgentRoleProposal(update, [role()], 'other', 20)).toThrow('requesting user');
    expect(() =>
      applyAgentRoleProposal(update, [role({ ownerUserId: 'other' })], 'user-1', 20)
    ).toThrow('not editable');
    expect(() =>
      applyAgentRoleProposal(
        update,
        [role(), role({ id: 'other' as AgentRoleId, name: 'New' })],
        'user-1',
        20
      )
    ).toThrow('already in use');
  });
  it('does not overwrite a previously created role when confirmation is retried', () => {
    const current = role({ name: 'Edited later' });
    expect(
      applyAgentRoleProposal(
        proposal({
          action: 'create',
          requestId: 'request',
          name: 'Original',
          machineId: 'machine',
          agentConfigId: 'config',
        }),
        [current],
        'user-1',
        20
      )
    ).toBe(current);
  });
  it('rejects unsupported fields, empty patches and oversized instructions', () => {
    const update = { action: 'update', requestId: 'request', roleId: 'role-1', patch: {} };
    expect(AgentRoleProposalCommandSchema.safeParse(update).success).toBe(false);
    expect(
      AgentRoleProposalCommandSchema.safeParse({ ...update, patch: { apiKey: 'synthetic' } })
        .success
    ).toBe(false);
    expect(
      AgentRoleProposalCommandSchema.safeParse({
        ...update,
        patch: { promptPrefix: 'x'.repeat(32769) },
      }).success
    ).toBe(false);
    expect(
      AgentRoleProposalCommandSchema.safeParse({
        ...update,
        patch: { description: '🐦'.repeat(140) },
      }).success
    ).toBe(true);
  });
});

describe('fork target data migration', () => {
  it('reads every legacy instance without mutating the row, then writes v2 and back to v1 with stable identity', () => {
    const instances = [
      instance('stable-a', 'one', {
        alias: 'Review',
        runConfig: {
          modelId: 'model-a',
          modeId: 'safe',
          configOptionValues: { plan_mode: true },
          memory: { providerId: 'nowledge-mem', memoryId: 'synthetic-a' },
        },
      }),
      instance('stable-b', 'one', {
        runConfig: {
          modelId: 'model-b',
          memory: { providerId: 'nowledge-mem', memoryId: 'synthetic-b' },
        },
      }),
      instance('stable-c', 'two', { alias: 'Review', runConfig: { modelId: 'model-c' } }),
    ];
    const stored = { ...legacyRow(), instances };
    const before = structuredClone(stored);
    const loaded = normalizeAgentRole(stored)!;
    expect(stored).toEqual(before);
    expect(getAgentRoleTargets(loaded)).toEqual(instances);
    const v2 = serializeAgentRoleRow(loaded);
    expect(v2).toMatchObject({ v: 2, targets: instances });
    expect(v2).not.toHaveProperty('instances');
    expect(getAgentRoleTargets(normalizeAgentRole(v2)!)).toEqual(instances);
    const single = withAgentRoleTargets(loaded, [instances[1]!]);
    const v1 = serializeAgentRoleRow(single);
    expect(v1).toMatchObject({ v: 1, targetId: 'stable-b', runConfig: instances[1]!.runConfig });
    expect(getAgentRoleTargets(normalizeAgentRole(v1)!)).toEqual([instances[1]]);
    expect(
      resolveAgentRoleMentionValue(
        [loaded],
        formatAgentRoleMentionValue(loaded.id, 'one' as MachineId)
      )
    ).toBeUndefined();
    expect(
      resolveAgentRoleMentionValue(
        [loaded],
        formatAgentRoleMentionValue(loaded.id, 'one' as MachineId, 'stable-b')
      )?.runConfig
    ).toEqual(instances[1]!.runConfig);
    expect(
      resolveAgentRoleMentionValue(
        [single],
        formatAgentRoleMentionValue(single.id, 'one' as MachineId, 'stable-a')
      )
    ).toBeUndefined();
  });
});
