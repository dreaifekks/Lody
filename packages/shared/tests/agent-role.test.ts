import { describe, expect, it } from 'vitest';

import {
  AGENT_ROLE_VERSION,
  canManageAgentRole,
  canReadAgentRole,
  isAgentRoleContentEqual,
  isSensitiveAgentRoleConfigOptionKey,
  DEFAULT_AGENT_ROLE_EMOJI,
  getAgentRoleEmoji,
  getAgentRoleMentionSlug,
  listAccessibleAgentRoles,
  normalizeAgentRole,
  normalizeAgentRoleEmoji,
  normalizeAgentRoleMentionSlug,
  normalizeAgentRoleRunConfig,
  agentRoleOnMachine,
  resolveAgentRoleAvailability,
  selectAgentRolePlacement,
  withAgentRolePlacements,
  type AgentRole,
  type AgentRoleAvailabilityContext,
  type AgentRolePlacement,
} from '../src/agent-role';
import type { AgentConfigId, AgentRoleId, MachineId } from '../src/ids';

/** A row as a client that predates placements writes it: the legacy fields only. */
const legacyRow = (overrides: Partial<AgentRole> = {}) => {
  const { placements: _placements, ...row } = {
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

/** A single-machine Role whose placement is its legacy fields. */
const role = (overrides: Partial<AgentRole> = {}): AgentRole => {
  const row = legacyRow(overrides);
  return withAgentRolePlacements(row, [
    {
      machineId: row.machineId,
      agentConfigId: row.agentConfigId,
      enabled: true,
      runConfig: row.runConfig,
    },
  ]);
};

const placement = (
  machine: string,
  overrides: Partial<AgentRolePlacement> = {}
): AgentRolePlacement => ({
  machineId: machine as MachineId,
  agentConfigId: `config-${machine}` as AgentConfigId,
  enabled: true,
  runConfig: { modelId: `model-${machine}` },
  ...overrides,
});

const multiRole = (...placements: AgentRolePlacement[]): AgentRole =>
  withAgentRolePlacements(legacyRow(), placements);

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

  it('reads a row without placements as the one machine its legacy fields name', () => {
    expect(normalizeAgentRole(legacyRow())?.placements).toEqual([
      {
        machineId: 'machine-1',
        agentConfigId: 'config-1',
        enabled: true,
        runConfig: { modelId: 'gpt-5.6' },
      },
    ]);
  });

  it('reads placements over the legacy fields and mirrors the first enabled one', () => {
    const read = normalizeAgentRole({
      ...legacyRow(),
      placements: [
        placement('a', { enabled: false }),
        placement('b', {
          runConfig: {
            modelId: 'model-b',
            memory: { providerId: 'nowledge-mem', memoryId: 'reviewer' },
            configOptionValues: { thought_level: 'high', api_key: 'sk-live' },
          },
        }),
        // A second entry for one machine is dropped: one row per machine.
        placement('b', { agentConfigId: 'other' as AgentConfigId }),
        { machineId: 'c' },
      ],
    });
    expect(read?.placements.map((entry) => [entry.machineId, entry.enabled])).toEqual([
      ['a', false],
      ['b', true],
    ]);
    // Secret-shaped options are dropped inside every placement.
    expect(read?.placements[1]?.runConfig.configOptionValues).toEqual({ thought_level: 'high' });
    expect(read).toMatchObject({
      machineId: 'b',
      agentConfigId: 'config-b',
      runConfig: {
        modelId: 'model-b',
        memory: { providerId: 'nowledge-mem', memoryId: 'reviewer' },
      },
    });
  });

  it('falls back to the legacy fields when no placement is enabled', () => {
    const read = normalizeAgentRole({
      ...legacyRow(),
      placements: [placement('a', { enabled: false })],
    });
    expect(read?.placements.map((entry) => entry.machineId)).toEqual(['machine-1']);
  });

  it('treats option-key ordering as unchanged content', () => {
    const left = role({ runConfig: { configOptionValues: { a: '1', b: '2' } } });
    const right = role({ runConfig: { configOptionValues: { b: '2', a: '1' } } });
    expect(isAgentRoleContentEqual(left, right)).toBe(true);
    expect(isAgentRoleContentEqual(left, role({ ...left, promptPrefix: 'x' }))).toBe(false);
    expect(isAgentRoleContentEqual(left, role({ ...left, emoji: '🔍' }))).toBe(false);
  });

  it('treats placement order and switching a machine off as edits', () => {
    const both = multiRole(placement('a'), placement('b'));
    expect(isAgentRoleContentEqual(both, multiRole(placement('a'), placement('b')))).toBe(true);
    expect(isAgentRoleContentEqual(both, multiRole(placement('b'), placement('a')))).toBe(false);
    expect(
      isAgentRoleContentEqual(both, multiRole(placement('a'), placement('b', { enabled: false })))
    ).toBe(false);
  });
});

describe('agent role placements', () => {
  const both = multiRole(placement('a'), placement('b'), placement('c', { enabled: false }));
  const usable =
    (...machines: string[]) =>
    (entry: AgentRolePlacement) =>
      machines.includes(entry.machineId);

  it('views the Role on one enabled machine only', () => {
    expect(agentRoleOnMachine(both, 'b' as MachineId)).toMatchObject({
      machineId: 'b',
      agentConfigId: 'config-b',
      runConfig: { modelId: 'model-b' },
      placements: [placement('b')],
    });
    expect(agentRoleOnMachine(both, 'c' as MachineId)).toBeUndefined();
    expect(agentRoleOnMachine(both, 'z' as MachineId)).toBeUndefined();
  });

  it('runs an explicit machine only where the Role is enabled and usable', () => {
    expect(
      selectAgentRolePlacement(both, { machineId: 'b' as MachineId }, usable('a', 'b'))
    ).toMatchObject({ kind: 'selected', rule: 'explicit', placement: { machineId: 'b' } });
    expect(
      selectAgentRolePlacement(both, { machineId: 'c' as MachineId }, usable('a', 'b', 'c'))
    ).toEqual({
      kind: 'rejected',
      reason: 'machine_not_enabled',
      machineId: 'c',
      rule: 'explicit',
      usableMachineIds: ['a', 'b'],
    });
    // Unusable there: an error, never a quiet move to the caller's machine.
    expect(
      selectAgentRolePlacement(
        both,
        { machineId: 'b' as MachineId, callerMachineId: 'a' as MachineId },
        usable('a')
      )
    ).toMatchObject({ kind: 'rejected', reason: 'machine_unavailable', machineId: 'b' });
  });

  it('runs where the work is, or fails', () => {
    expect(
      selectAgentRolePlacement(
        both,
        { workContextMachineId: 'b' as MachineId, callerMachineId: 'a' as MachineId },
        usable('a', 'b')
      )
    ).toMatchObject({ kind: 'selected', rule: 'work_context', placement: { machineId: 'b' } });
    expect(
      selectAgentRolePlacement(
        both,
        { workContextMachineId: 'b' as MachineId, callerMachineId: 'a' as MachineId },
        usable('a')
      )
    ).toMatchObject({ kind: 'rejected', reason: 'machine_unavailable', rule: 'work_context' });
  });

  it('prefers the caller machine, then the first usable one in list order', () => {
    expect(
      selectAgentRolePlacement(both, { callerMachineId: 'b' as MachineId }, usable('a', 'b'))
    ).toMatchObject({ kind: 'selected', rule: 'caller', placement: { machineId: 'b' } });
    expect(
      selectAgentRolePlacement(both, { callerMachineId: 'b' as MachineId }, usable('a'))
    ).toMatchObject({ kind: 'selected', rule: 'first_available', placement: { machineId: 'a' } });
    expect(
      selectAgentRolePlacement(both, { callerMachineId: 'c' as MachineId }, usable('b', 'c'))
    ).toMatchObject({ kind: 'selected', rule: 'first_available', placement: { machineId: 'b' } });
    expect(selectAgentRolePlacement(both, {}, usable())).toEqual({
      kind: 'rejected',
      reason: 'no_machine_available',
      usableMachineIds: [],
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

  it('is available while any enabled machine can run it', () => {
    const both = multiRole(
      placement('machine-2', { agentConfigId: 'config-2' as AgentConfigId }),
      placement('machine-1', { agentConfigId: 'config-1' as AgentConfigId })
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
    // A switched-off machine does not make the Role available.
    const offOnly = multiRole(
      placement('machine-1', { agentConfigId: 'config-1' as AgentConfigId, enabled: false }),
      placement('machine-2', { agentConfigId: 'config-2' as AgentConfigId })
    );
    expect(
      resolveAgentRoleAvailability(offOnly, {
        ...ctx,
        onlineMachineIds: new Set(['machine-1' as MachineId]),
      })
    ).toEqual({ kind: 'unavailable', reason: 'machine_offline' });
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
