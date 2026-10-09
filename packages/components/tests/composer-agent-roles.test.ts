import { describe, expect, it } from 'vitest';
import {
  AGENT_ROLE_VERSION,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleAvailability,
  type AgentRoleId,
  type AgentRoleInstance,
  type AgentRoleInstanceId,
  type CatalogAgentRole,
  type MachineId,
} from '@lody/shared';

import {
  buildAgentRoleTurnSelection,
  buildComposerAgentRoleItems,
  doesAgentRolePinPermissionMode,
  findComposerAgentRoleItem,
  findDefaultComposerAgentRoleItem,
  planNewChatAgentRolePick,
  isComposerAgentRoleApplied,
  resolveTurnAgentRoleForRunConfig,
  resolvePendingAgentRoleSelection,
} from '../src/lib/composer-agent-roles';
import { singleMachineRole } from './agent-role-fixture';

const makeRole = (
  overrides: Partial<AgentRole> & Pick<AgentRole, 'id' | 'name'>
): CatalogAgentRole =>
  singleMachineRole({
    v: AGENT_ROLE_VERSION,
    ownerUserId: 'user-1',
    visibility: 'private',
    machineId: 'machine-1' as MachineId,
    agentConfigId: 'config-1' as AgentConfigId,
    runConfig: {},
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });

const makeConfig = (id: string, machineId: string, agentType = 'codex'): AgentConfigMeta =>
  ({
    id: id as AgentConfigId,
    machineId: machineId as MachineId,
    name: id,
    cliType: 'builtin',
    agentType,
    env: {},
  }) as AgentConfigMeta;

const available: AgentRoleAvailability = { kind: 'available' };

const inst = (
  id: string,
  machineId: string,
  agentConfigId: string,
  runConfig: AgentRoleInstance['runConfig'] = {},
  alias?: string
): AgentRoleInstance => ({
  id: id as AgentRoleInstanceId,
  ...(alias ? { alias } : {}),
  machineId: machineId as MachineId,
  agentConfigId: agentConfigId as AgentConfigId,
  runConfig,
});

const names = {
  machine: (id: MachineId) => ({ 'machine-2': 'Build box', n100: 'n100' })[id as string],
  unknownAgent: 'Unknown agent',
};

const build = (
  roles: CatalogAgentRole[],
  machineId: string | null,
  agentConfigs: AgentConfigMeta[],
  resolveAvailability: (instance: AgentRoleInstance) => AgentRoleAvailability = () => available
) =>
  buildComposerAgentRoleItems({
    roles,
    machineId: machineId as MachineId | null,
    agentConfigs,
    resolveAvailability,
    names,
  });

describe('buildComposerAgentRoleItems', () => {
  const reviewer = makeRole({ id: 'r-2' as AgentRoleId, name: 'Reviewer' });
  const architect = makeRole({ id: 'r-1' as AgentRoleId, name: 'Architect' });
  const elsewhere = makeRole({
    id: 'r-3' as AgentRoleId,
    name: 'Elsewhere',
    machineId: 'machine-2' as MachineId,
    agentConfigId: 'config-3' as AgentConfigId,
  });
  const writer = makeRole({
    id: 'r-4' as AgentRoleId,
    name: 'Writer',
    agentConfigId: 'config-2' as AgentConfigId,
  });
  const configs = [
    makeConfig('config-1', 'machine-1'),
    makeConfig('config-2', 'machine-1', 'claude'),
    makeConfig('config-3', 'machine-2'),
  ];

  it("lists every Role, this machine's first, and names the machine of the others", () => {
    const items = build([reviewer, elsewhere, architect, writer], 'machine-1', configs);
    expect(items.map((item) => [item.title, item.local])).toEqual([
      ['Architect', true],
      ['Reviewer', true],
      ['Writer', true],
      ['Elsewhere · Build box', false],
    ]);
    expect(items[2]?.agentConfig?.agentType).toBe('claude');
  });

  it('shows one entry per group: the instance here, else the first that can run elsewhere', () => {
    const uiStyle = makeRole({
      id: 'r-5' as AgentRoleId,
      name: 'uiStyle',
      instances: [
        // Codex on two machines is one group; the local one stands for it.
        inst('ui-codex-2', 'machine-2', 'config-3', { modelId: 'gpt-5.6' }),
        inst('ui-claude', 'machine-1', 'config-2', { modelId: 'opus' }),
        inst('ui-codex', 'machine-1', 'config-1', { modelId: 'gpt-5.6' }),
        // Claude on n100 behind an alias: a group of its own, only elsewhere.
        inst('ui-strict', 'n100', 'config-n100', {}, 'Strict'),
        inst('ui-strict-off', 'machine-2', 'config-2b', {}, 'strict'),
      ],
    });
    const items = build(
      [uiStyle],
      'machine-1',
      [
        ...configs,
        makeConfig('config-n100', 'n100', 'claude'),
        makeConfig('config-2b', 'machine-2', 'claude'),
      ],
      (instance) =>
        instance.id === 'ui-strict-off'
          ? { kind: 'unavailable', reason: 'machine_offline' }
          : available
    );
    expect(items.map((item) => [item.instance.id, item.title, item.local])).toEqual([
      ['ui-codex', 'uiStyle · Codex', true],
      ['ui-claude', 'uiStyle · Claude Code', true],
      // The aliased group runs where it can, and says where.
      ['ui-strict', 'uiStyle · Strict · n100', false],
    ]);
    // A group keeps every member, this machine's first, for a bare pick.
    expect(items[0]?.group.map((entry) => entry.instance.id)).toEqual(['ui-codex', 'ui-codex-2']);
    expect(items[0]?.instance.runConfig.modelId).toBe('gpt-5.6');
    // A member can be found by its own id and reads as an entry of its own.
    expect(findComposerAgentRoleItem(items, 'ui-codex-2' as AgentRoleInstanceId)).toMatchObject({
      title: 'uiStyle · Codex · Build box',
      local: false,
    });
  });

  it('lists every Role elsewhere when no machine is chosen yet', () => {
    expect(build([reviewer], null, configs).map((item) => item.local)).toEqual([false]);
  });

  /*
   * The reported bug: a Role on devnuc first and n100 second, picked in a chat
   * on n100. The entry must be n100's instance, applied as picked, and the Turn
   * must record the Role with that instance — not the devnuc mirror.
   */
  it('selects a Role on its second machine and records that instance in the Turn', () => {
    const runConfig = {
      modeId: 'agent-auto-review',
      modelId: 'gpt-6-astra',
      configOptionValues: { 'fast-mode': false, reasoning_effort: 'high' },
    };
    const vision = makeRole({
      id: 'vision' as AgentRoleId,
      name: 'visionAgent',
      revision: 6,
      instances: [
        inst('vision:devnuc', 'devnuc', 'c-devnuc', runConfig),
        inst('vision:n100', 'n100', 'c-n100', runConfig),
      ],
    });
    const [item, ...rest] = build([vision], 'n100', [
      makeConfig('c-devnuc', 'devnuc'),
      makeConfig('c-n100', 'n100'),
    ]);
    expect(rest).toEqual([]);
    expect(item?.instance).toMatchObject({ id: 'vision:n100', agentConfigId: 'c-n100' });
    // What the composer sets when the entry is picked is what the check reads.
    expect(
      isComposerAgentRoleApplied(item!.instance, {
        agentSelection: { agentId: 'c-n100' as AgentConfigId, machineId: 'n100' as MachineId },
        modeId: runConfig.modeId,
        modelId: runConfig.modelId,
        configOptionValues: runConfig.configOptionValues,
      })
    ).toBe(true);
    expect(buildAgentRoleTurnSelection(item!)).toMatchObject({
      agentRoleId: 'vision',
      agentRoleRevision: 6,
      agentRoleSnapshot: { id: 'vision', instanceId: 'vision:n100', instanceLabel: 'Codex' },
    });
  });

  it('keeps an unavailable Role listed with its reason instead of hiding it', () => {
    const items = build([reviewer], 'machine-1', configs, () => ({
      kind: 'unavailable',
      reason: 'machine_offline',
    }));
    expect(items).toHaveLength(1);
    expect(items[0]?.availability).toEqual({ kind: 'unavailable', reason: 'machine_offline' });
  });

  it('reports a missing agent config rather than substituting another', () => {
    const items = build(
      [
        makeRole({
          id: 'r-4' as AgentRoleId,
          name: 'Gone',
          agentConfigId: 'config-9' as AgentConfigId,
        }),
      ],
      'machine-1',
      configs,
      () => ({ kind: 'unavailable', reason: 'agent_config_missing' })
    );
    expect(items[0]?.agentConfig).toBeUndefined();
  });
});

describe('picking an entry on the new-chat page', () => {
  const vision = makeRole({
    id: 'vision' as AgentRoleId,
    name: 'visionAgent',
    instances: [inst('vision:n100', 'n100', 'c-n100')],
  });
  const [entry] = build([vision], 'devnuc', [makeConfig('c-n100', 'n100')]);

  it('moves the chat to the machine of an entry elsewhere', () => {
    expect(entry?.local).toBe(false);
    expect(planNewChatAgentRolePick(entry!, 'devnuc' as MachineId)).toEqual({
      agentSelection: { agentId: 'c-n100', machineId: 'n100' },
      moveToMachineId: 'n100',
    });
  });

  it('stays on the chat machine for an entry there', () => {
    expect(planNewChatAgentRolePick(entry!, 'n100' as MachineId)).toEqual({
      agentSelection: { agentId: 'c-n100', machineId: 'n100' },
    });
  });
});

describe('picking a Role without an instance', () => {
  // Groups in list order: Claude (n100, devnuc), Gemini (devnuc).
  const uiStyle = makeRole({
    id: 'ui' as AgentRoleId,
    name: 'uiStyle',
    instances: [
      inst('claude-n100', 'n100', 'c-claude-n100'),
      inst('gemini-devnuc', 'devnuc', 'c-gemini'),
      inst('claude-devnuc', 'devnuc', 'c-claude-devnuc'),
    ],
  });
  const configs = [
    makeConfig('c-claude-n100', 'n100', 'claude'),
    makeConfig('c-claude-devnuc', 'devnuc', 'claude'),
    makeConfig('c-gemini', 'devnuc', 'gemini'),
  ];
  const pick = (machineId: string, canRun: (id: string) => boolean = () => true) =>
    findDefaultComposerAgentRoleItem(
      build([uiStyle], machineId, configs, (instance) =>
        canRun(instance.id) ? available : { kind: 'unavailable', reason: 'machine_offline' }
      ),
      'ui'
    )?.instance.id;

  it("runs the first group, this machine's instance first", () => {
    expect(pick('devnuc')).toBe('claude-devnuc');
    expect(pick('mac')).toBe('claude-n100');
  });

  it('tries the group on other machines before the next group', () => {
    // The local Claude cannot run: the group goes on elsewhere before Gemini.
    expect(pick('devnuc', (id) => id !== 'claude-devnuc')).toBe('claude-n100');
    // No Claude can run: the next group.
    expect(pick('devnuc', (id) => id === 'gemini-devnuc')).toBe('gemini-devnuc');
  });
});

describe('isComposerAgentRoleApplied', () => {
  const {
    instances: [role],
  } = makeRole({
    id: 'r-1' as AgentRoleId,
    name: 'Reviewer',
    runConfig: {
      modelId: 'gpt-5.6-sol',
      modeId: 'plan',
      configOptionValues: { thought_level: 'high' },
    },
  });
  const matching = {
    agentSelection: { agentId: 'config-1' as AgentConfigId, machineId: 'machine-1' as MachineId },
    modelId: 'gpt-5.6-sol',
    modeId: 'plan',
    configOptionValues: { thought_level: 'high' },
  };

  it('holds while every pinned value is what will run', () => {
    expect(isComposerAgentRoleApplied(role!, matching)).toBe(true);
  });

  it('ignores options the Role does not pin', () => {
    expect(
      isComposerAgentRoleApplied(role!, {
        ...matching,
        configOptionValues: { thought_level: 'high', fast_mode: true },
      })
    ).toBe(true);
  });

  it('stops holding when a pinned option falls back to the agent value', () => {
    expect(
      isComposerAgentRoleApplied(role!, {
        ...matching,
        configOptionValues: { thought_level: 'low' },
      })
    ).toBe(false);
  });

  it('stops holding when the model or mode is changed by hand', () => {
    expect(isComposerAgentRoleApplied(role!, { ...matching, modelId: 'gpt-5.6-thor' })).toBe(false);
    expect(isComposerAgentRoleApplied(role!, { ...matching, modeId: 'default' })).toBe(false);
  });

  it('never holds for another agent config or machine', () => {
    expect(
      isComposerAgentRoleApplied(role!, {
        ...matching,
        agentSelection: {
          agentId: 'config-2' as AgentConfigId,
          machineId: 'machine-1' as MachineId,
        },
      })
    ).toBe(false);
    expect(
      isComposerAgentRoleApplied(role!, {
        ...matching,
        agentSelection: {
          agentId: 'config-1' as AgentConfigId,
          machineId: 'machine-2' as MachineId,
        },
      })
    ).toBe(false);
    expect(isComposerAgentRoleApplied(role!, { ...matching, agentSelection: null })).toBe(false);
  });
});

describe('resolveTurnAgentRoleForRunConfig', () => {
  const role = makeRole({
    id: 'r-1' as AgentRoleId,
    name: 'Planner',
    runConfig: { modeId: 'plan', configOptionValues: { collaboration_mode: 'plan' } },
  });
  const turnSelection = { agentRoleId: role.id, agentRoleRevision: role.revision };
  const item = { role, instance: role.instances[0]!, groupName: 'Codex' };
  const current = {
    modeId: 'plan',
    modelId: null,
    configOptionValues: { collaboration_mode: 'plan' },
  };

  it('freezes explicit None when execute-plan overrides a pinned Role value', () => {
    expect(
      resolveTurnAgentRoleForRunConfig({
        turnSelection,
        item,
        current,
        overrides: {
          modeIdOverride: 'default',
          configOptionValuesOverride: { collaboration_mode: 'default' },
        },
      })
    ).toBeNull();
  });
});

describe('doesAgentRolePinPermissionMode', () => {
  const pinning = makeRole({
    id: 'r-1' as AgentRoleId,
    name: 'Reviewer',
    runConfig: { modeId: 'read-only', configOptionValues: { permission_mode: 'ask' } },
  }).runConfig;
  const bare = makeRole({ id: 'r-2' as AgentRoleId, name: 'Bare' }).runConfig;

  it('holds for a legacy ACP mode the Role stored', () => {
    expect(doesAgentRolePinPermissionMode(pinning, { kind: 'modeId' })).toBe(true);
    expect(doesAgentRolePinPermissionMode(bare, { kind: 'modeId' })).toBe(false);
  });

  it('holds for the agent own permission option when the Role stored it', () => {
    const source = { kind: 'configOption', configId: 'permission_mode' } as const;
    expect(doesAgentRolePinPermissionMode(pinning, source)).toBe(true);
    expect(doesAgentRolePinPermissionMode(bare, source)).toBe(false);
  });

  // An agent that publishes no permission control leaves a Role nothing to own,
  // so the composer must keep its own permission button rather than hide a knob
  // the Role never had.
  it('never holds when the agent exposes no permission control', () => {
    expect(doesAgentRolePinPermissionMode(pinning, null)).toBe(false);
  });
});

describe('resolvePendingAgentRoleSelection', () => {
  const roleId = 'r-1' as AgentRoleId;
  const role = makeRole({ id: roleId, name: 'Reviewer' });
  const items = (availability: AgentRoleAvailability) =>
    build([role], 'machine-1', [makeConfig('config-1', 'machine-1')], () => availability);

  // A create resolves on the durable local write; the catalog snapshot the
  // composer reads from arrives on its own tick.
  it('waits while the Role has not reached the composer yet', () => {
    expect(resolvePendingAgentRoleSelection({ roleId, items: [], isInCatalog: false })).toEqual({
      kind: 'wait',
    });
  });

  it('waits while the binding cannot be judged', () => {
    expect(
      resolvePendingAgentRoleSelection({
        roleId,
        items: items({ kind: 'unknown' }),
        isInCatalog: true,
      })
    ).toEqual({ kind: 'wait' });
  });

  it('selects the Role once the composer can offer it', () => {
    expect(
      resolvePendingAgentRoleSelection({
        roleId,
        items: items({ kind: 'available' }),
        isInCatalog: true,
      })
    ).toEqual({ kind: 'select', instanceId: role.instances[0]!.id });
  });

  it('gives up on a Role the catalog knows but the composer does not offer', () => {
    expect(resolvePendingAgentRoleSelection({ roleId, items: [], isInCatalog: true })).toEqual({
      kind: 'give-up',
    });
  });

  it('gives up rather than waiting on a Role that cannot run', () => {
    expect(
      resolvePendingAgentRoleSelection({
        roleId,
        items: items({ kind: 'unavailable', reason: 'machine_offline' }),
        isInCatalog: true,
      })
    ).toEqual({ kind: 'give-up' });
  });
});
