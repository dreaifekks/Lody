import { resolvePendingAgentRoleSelection } from '../src/lib/composer-agent-roles';
import { getAgentRoleTargets } from '@lody/shared';
import { describe, expect, it } from 'vitest';
import {
  AGENT_ROLE_VERSION,
  buildSessionTurnInputConfig,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleAvailability,
  type AgentRoleId,
  type AgentRoleTarget,
  type AgentRoleInstanceId,
  type MachineId,
} from '@lody/shared';

import {
  buildAgentRoleConfigPreferences,
  buildAgentRoleTurnSelection,
  buildComposerAgentRoleItems,
  doesAgentRolePinPermissionMode,
  findComposerAgentRoleItem,
  findDefaultComposerAgentRoleItem,
  findRecordedComposerAgentRoleItem,
  planNewChatAgentRolePick,
  isComposerAgentRoleApplied,
  resolveTurnAgentRoleForRunConfig,
} from '../src/lib/composer-agent-roles';
import { buildAcpSelectorOptions } from '../src/components/shared/acp-selector-options';
import { buildAgentPrompt } from '../src/lib';
import { resolvePermissionModeFace } from '../src/lib/permission-mode-face';
import {
  buildAcpSessionConfigCandidates,
  filterAcpSessionConfigOptionValues,
  resolveAcpSessionConfigSelection,
  type AcpSessionConfigPreferences,
  type AcpSessionUserConfigEdits,
} from '../src/lib/acp-session-config-selection';
import {
  reportedAntigravityCapabilities,
  reportedClaudeCapabilities,
  singleMachineRole,
} from './agent-role-fixture';

const makeRole = (overrides: Partial<AgentRole> & Pick<AgentRole, 'id' | 'name'>): AgentRole =>
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
  runConfig: AgentRoleTarget['runConfig'] = {},
  alias?: string
): AgentRoleTarget => ({
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
  roles: AgentRole[],
  machineId: string | null,
  agentConfigs: AgentConfigMeta[],
  resolveAvailability: (instance: AgentRoleTarget) => AgentRoleAvailability = () => available
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
      ['Architect · Codex · machine-1', true],
      ['Reviewer · Codex · machine-1', true],
      ['Writer · Claude Code · machine-1', true],
      ['Elsewhere · Codex · Build box', false],
    ]);
    expect(items[2]?.agentConfig?.agentType).toBe('claude');
  });

  it('lists every target, including same-family and unavailable targets', () => {
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
    expect(items.map((item) => item.instance.id)).toEqual([
      'ui-claude',
      'ui-codex',
      'ui-codex-2',
      'ui-strict',
      'ui-strict-off',
    ]);
    expect(items.find((item) => item.instance.id === 'ui-strict-off')?.availability).toEqual({
      kind: 'unavailable',
      reason: 'machine_offline',
    });
    expect(items.find((item) => item.instance.id === 'ui-codex')?.instance.runConfig.modelId).toBe(
      'gpt-5.6'
    );
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
    expect(rest.map((entry) => entry.instance.id)).toEqual(['vision:devnuc']);
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

  it('reads a record with an instance as exactly that one, and one without as a bare pick', () => {
    const items = build([uiStyle], 'devnuc', configs);
    expect(
      findRecordedComposerAgentRoleItem(items, 'ui', 'gemini-devnuc' as AgentRoleInstanceId)
        ?.instance.id
    ).toBe('gemini-devnuc');
    // Deleted: nothing, not another instance of the Role.
    expect(
      findRecordedComposerAgentRoleItem(items, 'ui', 'deleted' as AgentRoleInstanceId)
    ).toBeUndefined();
    expect(findRecordedComposerAgentRoleItem(items, 'ui', undefined)).toBeUndefined();
  });

  it('keeps a bare selection ambiguous regardless of caller or availability', () => {
    expect(pick('devnuc')).toBeUndefined();
    expect(pick('mac')).toBeUndefined();
    expect(pick('devnuc', (id) => id === 'gemini-devnuc')).toBeUndefined();
  });
});

describe('isComposerAgentRoleApplied', () => {
  const [role] = getAgentRoleTargets(
    makeRole({
      id: 'r-1' as AgentRoleId,
      name: 'Reviewer',
      runConfig: {
        modelId: 'gpt-5.6-sol',
        modeId: 'plan',
        configOptionValues: { thought_level: 'high' },
      },
    })
  );
  const matching = {
    agentSelection: { agentId: 'config-1' as AgentConfigId, machineId: 'machine-1' as MachineId },
    modelId: 'gpt-5.6-sol',
    modeId: 'plan',
    configOptionValues: { thought_level: 'high' },
    configOptionSelectors: [{ configId: 'thought_level' }],
  };

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

/**
 * A Role as real ones are stored, through the derivation the new-chat page and
 * a draft Tab both run: its run config seeds the selection, the agent's own
 * capabilities resolve it, and the composer names it while that still holds.
 */
describe('a stored Role resolved against what its agent reports', () => {
  const agentConfigId = 'claude-here' as AgentConfigId;
  const machine = { acpCapabilities: { [agentConfigId]: reportedClaudeCapabilities } };
  const seeded = (
    runConfig: AgentRoleTarget['runConfig'],
    edits: AcpSessionUserConfigEdits = { configOptions: {} },
    /** What the agent last reported it is running, in a live session. */
    runtimePreferences?: AcpSessionConfigPreferences
  ) => {
    const [instance] = getAgentRoleTargets(
      makeRole({ id: 'r-real' as AgentRoleId, name: 'uiStyle', agentConfigId, runConfig })
    );
    const inputs = {
      edits,
      preferences: {
        modeId: runConfig.modeId ?? null,
        modelId: runConfig.modelId ?? null,
        configOptionValues: runConfig.configOptionValues,
      },
      runtimePreferences,
    };
    const candidates = buildAcpSessionConfigCandidates(inputs);
    const target = { cliType: 'builtin', agentType: 'claude' } as const;
    const resolved = resolveAcpSessionConfigSelection(
      inputs,
      buildAcpSelectorOptions({
        ...target,
        configId: agentConfigId,
        selectedModeId: candidates.modeId,
        selectedModelId: candidates.modelId,
        configOptionValues: candidates.configOptionValues,
        machine,
      }),
      target
    );
    return {
      resolved,
      applied: isComposerAgentRoleApplied(instance!, {
        agentSelection: { agentId: agentConfigId, machineId: 'machine-1' as MachineId },
        modeId: resolved.selectedModeId,
        modelId: resolved.selectedModelId,
        configOptionValues: resolved.configOptionValues,
        configOptionSelectors: resolved.configOptionSelectors,
      }),
    };
  };
  const fable = { modeId: 'auto', modelId: 'claude-fable-5-1' };

  it('is the Role though it pins Fast off on a model that has no Fast toggle', () => {
    // uiStyle, uxAgent and companion as stored: Fable has no Fast, so the
    // resolved selection carries no `fast` at all — and Fast is off.
    const { resolved, applied } = seeded({
      ...fable,
      configOptionValues: { effort: 'high', fast: false },
    });
    expect(resolved.configOptionValues).toEqual({ effort: 'high' });
    expect(applied).toBe(true);
  });

  it('is the Role with Fast pinned off where the model has the toggle', () => {
    expect(
      seeded({
        modeId: 'auto',
        modelId: 'opus',
        configOptionValues: { effort: 'high', fast: false },
      }).applied
    ).toBe(true);
  });

  it('is not the Role when it pins Fast on for a model that cannot run it', () => {
    expect(seeded({ ...fable, configOptionValues: { effort: 'high', fast: true } }).applied).toBe(
      false
    );
  });

  it('is not the Role when Fast is merely missing for a model that has the toggle', () => {
    // An Opus Role with Fast off, in a session the agent last reported running
    // Fable: that snapshot has no `fast`. Back on Opus the toggle exists, the
    // snapshot still owns the table, and nothing says Fast is off there.
    const { resolved, applied } = seeded(
      { modeId: 'auto', modelId: 'opus', configOptionValues: { effort: 'high', fast: false } },
      { model: { value: 'opus' }, configOptions: {} },
      { ...fable, configOptionValues: { effort: 'high' } }
    );
    expect(resolved.selectedModelId).toBe('opus');
    expect(resolved.configOptionValues).not.toHaveProperty('fast');
    expect(resolved.configOptionSelectors.map((selector) => selector.configId)).toContain('fast');
    expect(applied).toBe(false);
  });

  it('stops being the Role once a pinned knob is moved by hand', () => {
    const pins = { ...fable, configOptionValues: { effort: 'high', fast: false } };
    expect(seeded(pins, { configOptions: { effort: 'low' } }).applied).toBe(false);
    expect(seeded(pins, { model: { value: 'opus' }, configOptions: {} }).applied).toBe(false);
    // On Opus the toggle exists, so turning Fast on there is a real difference.
    expect(
      seeded(
        { modeId: 'auto', modelId: 'opus', configOptionValues: { fast: false } },
        { configOptions: { fast: true } }
      ).applied
    ).toBe(false);
  });
});

describe('a stored registry ACP Role (Antigravity YOLO) resolved against reported capabilities', () => {
  const agentConfigId = 'agy-here' as AgentConfigId;
  const machine = { acpCapabilities: { [agentConfigId]: reportedAntigravityCapabilities } };
  const target = { cliType: 'registry', agentType: 'antigravity-acp' } as const;

  const seededAgy = (
    runConfig: AgentRoleTarget['runConfig'],
    edits: AcpSessionUserConfigEdits = { configOptions: {} },
    runtimePreferences?: AcpSessionConfigPreferences
  ) => {
    const [instance] = getAgentRoleTargets(
      makeRole({ id: 'r-agy' as AgentRoleId, name: 'Global Review', agentConfigId, runConfig })
    );
    const inputs = {
      edits,
      preferences: buildAgentRoleConfigPreferences(runConfig, {
        cliType: target.cliType,
        capability: reportedAntigravityCapabilities,
      }),
      runtimePreferences,
    };
    const candidates = buildAcpSessionConfigCandidates(inputs);
    const selectorOptions = buildAcpSelectorOptions({
      ...target,
      configId: agentConfigId,
      selectedModeId: candidates.modeId,
      selectedModelId: candidates.modelId,
      configOptionValues: candidates.configOptionValues,
      machine,
    });
    const resolved = resolveAcpSessionConfigSelection(inputs, selectorOptions, target);
    const permissionFace = resolvePermissionModeFace({
      modeOptions: selectorOptions.modeOptions,
      selectedModeId: resolved.selectedModeId,
      configOptionSelectors: resolved.configOptionSelectors,
      configOptionValues: resolved.configOptionValues,
    });
    return {
      resolved,
      permissionFace,
      pinsPermission: doesAgentRolePinPermissionMode(instance!.runConfig, permissionFace.source),
      applied: isComposerAgentRoleApplied(instance!, {
        agentSelection: { agentId: agentConfigId, machineId: 'machine-1' as MachineId },
        modeId: resolved.selectedModeId,
        modelId: resolved.selectedModelId,
        configOptionValues: resolved.configOptionValues,
        configOptionSelectors: resolved.configOptionSelectors,
      }),
    };
  };

  it('stays applied when modeId/modelId and configOptionValues both pin YOLO and the model', () => {
    const { resolved, applied, pinsPermission, permissionFace } = seededAgy({
      modeId: 'yolo',
      modelId: 'gemini-4-neon',
      configOptionValues: { mode: 'yolo', model: 'gemini-4-neon', thought_level: 'xhigh' },
    });
    expect(resolved.selectedModeId).toBeNull();
    expect(resolved.selectedModelId).toBeNull();
    expect(resolved.configOptionValues).toEqual({
      mode: 'yolo',
      model: 'gemini-4-neon',
      thought_level: 'xhigh',
    });
    expect(applied).toBe(true);
    expect(pinsPermission).toBe(true);
    expect(permissionFace.value).toBe('yolo');

    // End-to-end first-turn submission freezes promptPrefix, memory, configOptionValues,
    // and Role provenance intact.
    const roleWithPrompt = makeRole({
      id: 'r-agy-send' as AgentRoleId,
      name: 'Global Review',
      agentConfigId,
      promptPrefix: 'Inspect security and regression boundaries first.',
      runConfig: {
        modeId: 'yolo',
        modelId: 'gemini-4-neon',
        memory: { providerId: 'nowledge-mem', memoryId: 'mem-review' },
        configOptionValues: { mode: 'yolo', model: 'gemini-4-neon', thought_level: 'xhigh' },
      },
    });
    const [sendInstance] = getAgentRoleTargets(roleWithPrompt);
    const dispatchValues = filterAcpSessionConfigOptionValues(
      resolved.configOptionValues,
      resolved.configOptionSelectors
    );
    const inputConfig = buildSessionTurnInputConfig({
      prompt: buildAgentPrompt('Review this diff', roleWithPrompt.promptPrefix ?? ''),
      cliType: target.cliType,
      agentType: target.agentType,
      modeId: resolved.selectedModeId,
      modelId: resolved.selectedModelId,
      configOptionValues: dispatchValues,
      ...buildAgentRoleTurnSelection({
        role: roleWithPrompt,
        instance: sendInstance!,
        groupName: 'Google Antigravity',
      }),
    });
    expect(inputConfig.modeId).toBeUndefined();
    expect(inputConfig.modelId).toBeUndefined();
    expect(inputConfig).toMatchObject({
      configOptionValues: {
        mode: 'yolo',
        model: 'gemini-4-neon',
        thought_level: 'xhigh',
      },
      agentRoleId: 'r-agy-send',
      memory: { providerId: 'nowledge-mem', memoryId: 'mem-review' },
      agentRoleSnapshot: {
        id: 'r-agy-send',
        instanceId: sendInstance!.id,
      },
    });
    expect(inputConfig.prompt).toContain('Inspect security and regression boundaries first.');
    expect(inputConfig.prompt).toContain('Review this diff');
  });

  it('bridges modeId/modelId-only Roles onto registry configOption selectors', () => {
    const { resolved, applied, pinsPermission } = seededAgy({
      modeId: 'yolo',
      modelId: 'gemini-4-neon',
      configOptionValues: { thought_level: 'xhigh' },
    });
    expect(resolved.configOptionValues).toEqual({
      mode: 'yolo',
      model: 'gemini-4-neon',
      thought_level: 'xhigh',
    });
    expect(applied).toBe(true);
    expect(pinsPermission).toBe(true);
  });

  it('keeps configOption-only registry Roles applied and unnames them on any manual knob edit', () => {
    const runConfig = {
      configOptionValues: { mode: 'yolo', model: 'gemini-4-neon', thought_level: 'xhigh' },
    };
    expect(seededAgy(runConfig).applied).toBe(true);
    expect(seededAgy(runConfig, { configOptions: { mode: 'auto' } }).applied).toBe(false);
    expect(seededAgy(runConfig, { configOptions: { model: 'gemini-4-carbon' } }).applied).toBe(
      false
    );
    expect(seededAgy(runConfig, { configOptions: { thought_level: 'high' } }).applied).toBe(false);
  });

  it('uses canonical configOption precedence when a registry Role has stale top-level modeId', () => {
    // A Role whose configOption mode is YOLO and stale top-level modeId is auto
    // must agree across projection, application, and manual detachment instead
    // of applying YOLO while immediately dropping Role identity.
    const conflicting = {
      modeId: 'auto',
      modelId: 'gemini-4-neon',
      configOptionValues: { mode: 'yolo', model: 'gemini-4-neon', thought_level: 'xhigh' },
    };
    const picked = seededAgy(conflicting);
    expect(picked.resolved.configOptionValues.mode).toBe('yolo');
    expect(picked.applied).toBe(true);
    expect(seededAgy(conflicting, { configOptions: { mode: 'auto' } }).applied).toBe(false);
  });

  it('bridges legacy modes/models-only registry probes onto synthesized configOption selectors', () => {
    const legacyProbe = {
      ...reportedAntigravityCapabilities,
      configOptions: undefined,
    };
    const runConfig = { modeId: 'yolo', modelId: 'gemini-4-carbon' };
    const [instance] = getAgentRoleTargets(
      makeRole({ id: 'r-legacy-agy' as AgentRoleId, name: 'Legacy Agy', agentConfigId, runConfig })
    );
    const inputs = {
      edits: { configOptions: {} },
      preferences: buildAgentRoleConfigPreferences(runConfig, {
        cliType: 'registry',
        capability: legacyProbe,
      }),
    };
    const candidates = buildAcpSessionConfigCandidates(inputs);
    const selectorOptions = buildAcpSelectorOptions({
      ...target,
      configId: agentConfigId,
      selectedModeId: candidates.modeId,
      selectedModelId: candidates.modelId,
      configOptionValues: candidates.configOptionValues,
      machine: { acpCapabilities: { [agentConfigId]: legacyProbe } },
    });
    const resolved = resolveAcpSessionConfigSelection(inputs, selectorOptions, target);
    expect(resolved.configOptionValues).toEqual({ mode: 'yolo', model: 'gemini-4-carbon' });
    expect(
      isComposerAgentRoleApplied(instance!, {
        agentSelection: { agentId: agentConfigId, machineId: 'machine-1' as MachineId },
        modeId: resolved.selectedModeId,
        modelId: resolved.selectedModelId,
        configOptionValues: resolved.configOptionValues,
        configOptionSelectors: resolved.configOptionSelectors,
      })
    ).toBe(true);
  });

  it('resolves target model before binding top-level modeId when the target model renames the mode option id', () => {
    const customConfigId = 'custom-renamed-mode' as AgentConfigId;
    const customTarget = { cliType: 'custom', agentType: 'custom-acp' } as const;
    const customCapability = {
      ...reportedAntigravityCapabilities,
      cliType: 'custom',
      agentType: 'custom-acp',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gemini-4-argon',
          options: [
            { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
            { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
          ],
        },
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'default',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'yolo', name: 'YOLO' },
          ],
        },
      ],
      observedModelConfigOptions: {
        'gemini-4-neon': [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'gemini-4-neon',
            options: [
              { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
              { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
            ],
          },
          {
            id: 'access-policy',
            name: 'Access Policy',
            category: 'mode',
            type: 'select',
            currentValue: 'default',
            options: [
              { value: 'default', name: 'Default' },
              { value: 'yolo', name: 'YOLO' },
            ],
          },
        ],
      },
    } as unknown as import('@lody/shared').AcpCapabilityCacheEntry;
    const runConfig = { modelId: 'gemini-4-neon', modeId: 'yolo' };
    const [instance] = getAgentRoleTargets(
      makeRole({
        id: 'r-renamed-mode' as AgentRoleId,
        name: 'Renamed Mode',
        agentConfigId: customConfigId,
        runConfig,
      })
    );
    const inputs = {
      edits: { configOptions: {} },
      preferences: buildAgentRoleConfigPreferences(runConfig, {
        cliType: customTarget.cliType,
        capability: customCapability,
      }),
    };
    const candidates = buildAcpSessionConfigCandidates(inputs);
    const selectorOptions = buildAcpSelectorOptions({
      ...customTarget,
      configId: customConfigId,
      selectedModeId: candidates.modeId,
      selectedModelId: candidates.modelId,
      configOptionValues: candidates.configOptionValues,
      machine: { acpCapabilities: { [customConfigId]: customCapability } },
    });
    const resolved = resolveAcpSessionConfigSelection(inputs, selectorOptions, customTarget);
    expect(resolved.configOptionValues).toEqual({
      model: 'gemini-4-neon',
      'access-policy': 'yolo',
    });
    expect(
      isComposerAgentRoleApplied(instance!, {
        agentSelection: { agentId: customConfigId, machineId: 'machine-1' as MachineId },
        modeId: resolved.selectedModeId,
        modelId: resolved.selectedModelId,
        configOptionValues: resolved.configOptionValues,
        configOptionSelectors: resolved.configOptionSelectors,
      })
    ).toBe(true);
  });

  it('bridges configOption-only mode/model on a static builtin Claude catalog and never trusts stale provisional copies', () => {
    const claudeConfigId = 'claude-static' as AgentConfigId;
    const claudeTarget = { cliType: 'builtin', agentType: 'claude' } as const;
    const runConfig = { configOptionValues: { mode: 'default', model: 'opus' } };
    const [instance] = getAgentRoleTargets(
      makeRole({
        id: 'r-claude-static' as AgentRoleId,
        name: 'Claude Static',
        agentConfigId: claudeConfigId,
        runConfig,
      })
    );
    const preferences = buildAgentRoleConfigPreferences(runConfig, {
      cliType: 'builtin',
      capability: undefined,
    });
    expect(preferences).toMatchObject({ modeId: 'default', modelId: 'opus' });
    const selectorOptions = buildAcpSelectorOptions({
      ...claudeTarget,
      configId: claudeConfigId,
      selectedModeId: preferences.modeId,
      selectedModelId: preferences.modelId,
      configOptionValues: preferences.configOptionValues,
      machine: null,
    });
    const resolved = resolveAcpSessionConfigSelection(
      { edits: { configOptions: {} }, preferences },
      selectorOptions,
      claudeTarget
    );
    expect(resolved.selectedModeId).toBe('default');
    expect(resolved.selectedModelId).toBe('opus');
    expect(
      isComposerAgentRoleApplied(instance!, {
        agentSelection: { agentId: claudeConfigId, machineId: 'machine-1' as MachineId },
        modeId: resolved.selectedModeId,
        modelId: resolved.selectedModelId,
        configOptionValues: resolved.configOptionValues,
        configOptionSelectors: resolved.configOptionSelectors,
      })
    ).toBe(true);
    // Even if a provisional selection retains stale configOptionValues.mode/model,
    // mismatched dedicated modeId/modelId must never claim the Role is applied.
    expect(
      isComposerAgentRoleApplied(instance!, {
        agentSelection: { agentId: claudeConfigId, machineId: 'machine-1' as MachineId },
        modeId: 'auto',
        modelId: 'default',
        configOptionValues: { mode: 'default', model: 'opus' },
        configOptionSelectors: resolved.configOptionSelectors,
      })
    ).toBe(false);
  });

  it('keeps permission pinning distinct for _permission options like Grok permission_mode', () => {
    expect(
      doesAgentRolePinPermissionMode(
        { modeId: 'plan' },
        { kind: 'configOption', configId: 'permission_mode', category: '_permission' }
      )
    ).toBe(false);
    expect(
      doesAgentRolePinPermissionMode(
        { configOptionValues: { permission_mode: 'always-approve' } },
        { kind: 'configOption', configId: 'permission_mode', category: '_permission' }
      )
    ).toBe(true);
  });

  it('matches duplicated mode/model configOptionValues on a builtin agent and drops on edit', () => {
    const [instance] = getAgentRoleTargets(
      makeRole({
        id: 'r-builtin-dup' as AgentRoleId,
        name: 'Migrated',
        runConfig: {
          modeId: 'yolo',
          modelId: 'gemini-4-neon',
          configOptionValues: { mode: 'yolo', model: 'gemini-4-neon', thought_level: 'xhigh' },
        },
      })
    );
    const baseSelection = {
      agentSelection: { agentId: 'config-1' as AgentConfigId, machineId: 'machine-1' as MachineId },
      modeId: 'yolo',
      modelId: 'gemini-4-neon',
      configOptionValues: { thought_level: 'xhigh' },
      configOptionSelectors: [{ configId: 'thought_level', category: 'thought_level' }],
    };
    expect(isComposerAgentRoleApplied(instance!, baseSelection)).toBe(true);
    expect(isComposerAgentRoleApplied(instance!, { ...baseSelection, modeId: 'auto' })).toBe(false);
  });
});

describe('resolveTurnAgentRoleForRunConfig', () => {
  const role = makeRole({
    id: 'r-1' as AgentRoleId,
    name: 'Planner',
    runConfig: { modeId: 'plan', configOptionValues: { collaboration_mode: 'plan' } },
  });
  const turnSelection = { agentRoleId: role.id, agentRoleRevision: role.revision };
  const item = { role, instance: getAgentRoleTargets(role)[0]!, groupName: 'Codex' };
  const current = {
    modeId: 'plan',
    modelId: null,
    configOptionValues: { collaboration_mode: 'plan' },
    configOptionSelectors: [{ configId: 'collaboration_mode' }],
  };

  it.each([
    ['plan_mode', true, false],
    ['collaboration_mode', 'plan', 'default'],
  ] as const)(
    'preserves Role metadata when execute-plan overrides %s',
    (configId, before, after) => {
      const planningRole = {
        ...role,
        runConfig: { configOptionValues: { [configId]: before, permission_mode: 'ask' } },
      };
      const config = {
        ...current,
        modeId: null,
        configOptionValues: { [configId]: before, permission_mode: 'ask' },
      };
      expect(
        resolveTurnAgentRoleForRunConfig({
          turnSelection,
          item: { role: planningRole, instance: getAgentRoleTargets(planningRole)[0]! },
          current: config,
          overrides: { configOptionValuesOverride: { [configId]: after, permission_mode: 'ask' } },
        })
      ).toEqual(turnSelection);
      expect(
        resolveTurnAgentRoleForRunConfig({
          turnSelection,
          item: { role: planningRole, instance: getAgentRoleTargets(planningRole)[0]! },
          current: config,
          overrides: { configOptionValuesOverride: { [configId]: after, permission_mode: 'yolo' } },
        })
      ).toBeNull();
    }
  );

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

  it('preserves structural mode/model bindings when a programmatic override changes an unpinned model', () => {
    const builtinMigratedRole = makeRole({
      id: 'r-migrated-mode' as AgentRoleId,
      name: 'Mode Only',
      runConfig: { configOptionValues: { mode: 'auto' } },
    });
    const migratedSelection = {
      agentRoleId: builtinMigratedRole.id,
      agentRoleRevision: builtinMigratedRole.revision,
    };
    expect(
      resolveTurnAgentRoleForRunConfig({
        turnSelection: migratedSelection,
        item: {
          role: builtinMigratedRole,
          instance: getAgentRoleTargets(builtinMigratedRole)[0]!,
        },
        current: {
          modeId: 'auto',
          modelId: 'opus',
          configOptionValues: {},
          configOptionSelectors: [{ configId: 'effort', category: 'thought_level' }],
        },
        overrides: { modelIdOverride: 'claude-fable-5-1' },
      })
    ).toEqual(migratedSelection);

    const registryModeOnlyRole = makeRole({
      id: 'r-reg-mode' as AgentRoleId,
      name: 'YOLO Mode Only',
      runConfig: { modeId: 'yolo' },
    });
    const registrySelection = {
      agentRoleId: registryModeOnlyRole.id,
      agentRoleRevision: registryModeOnlyRole.revision,
    };
    expect(
      resolveTurnAgentRoleForRunConfig({
        turnSelection: registrySelection,
        item: {
          role: registryModeOnlyRole,
          instance: getAgentRoleTargets(registryModeOnlyRole)[0]!,
        },
        current: {
          modeId: null,
          modelId: null,
          configOptionValues: { mode: 'yolo', model: 'gemini-4-argon' },
          configOptionSelectors: [
            { configId: 'mode', category: 'mode' },
            { configId: 'model', category: 'model' },
          ],
        },
        overrides: {
          configOptionValuesOverride: { mode: 'yolo', model: 'gemini-4-neon' },
        },
      })
    ).toEqual(registrySelection);
  });
});

describe('a programmatic Turn of a Role that pins Fast off', () => {
  const role = makeRole({
    id: 'r-fast' as AgentRoleId,
    name: 'Reviewer',
    runConfig: { modelId: 'opus', configOptionValues: { fast: false } },
  });
  const args = {
    turnSelection: { agentRoleId: role.id, agentRoleRevision: role.revision },
    item: { role, instance: getAgentRoleTargets(role)[0]!, groupName: 'Claude Code' },
    overrides: { modeIdOverride: 'default' },
  };
  // What the composer runs carries no Fast value in either case.
  const current = { modeId: 'plan', modelId: 'opus', configOptionValues: {} };

  it('keeps the Role where the model has no Fast toggle', () => {
    expect(
      resolveTurnAgentRoleForRunConfig({
        ...args,
        current: { ...current, configOptionSelectors: [{ configId: 'effort' }] },
      })
    ).toEqual(args.turnSelection);
  });

  it('drops the Role where the toggle exists and nothing says it is off', () => {
    expect(
      resolveTurnAgentRoleForRunConfig({
        ...args,
        current: { ...current, configOptionSelectors: [{ configId: 'fast' }] },
      })
    ).toBeNull();
  });

  it('drops the Role when the Turn runs a model whose controls are not known here', () => {
    const unpinned = makeRole({
      id: 'r-any-model' as AgentRoleId,
      name: 'Any model',
      runConfig: { configOptionValues: { fast: false } },
    });
    expect(
      resolveTurnAgentRoleForRunConfig({
        turnSelection: { agentRoleId: unpinned.id, agentRoleRevision: unpinned.revision },
        item: {
          role: unpinned,
          instance: getAgentRoleTargets(unpinned)[0]!,
          groupName: 'Claude Code',
        },
        current: { ...current, configOptionSelectors: [{ configId: 'effort' }] },
        overrides: { modelIdOverride: 'claude-fable-5-1' },
      })
    ).toBeNull();
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
    ).toEqual({ kind: 'select', instanceId: getAgentRoleTargets(role)[0]!.id });
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

import { filterFuzzyOptions } from '../src/lib/fuzzy-option-filter';
it('ranks a match on the visible label above one only in the id or blurb', () => {
  // `codex` is the label of one option and the description word of none; `cod`
  // hits the GPT label. A hit on the hidden id must not outrank a visible name.
  const ranked = filterFuzzyOptions(
    [
      { value: 'anthropic-fastest', label: 'Opus 5' },
      { value: 'x-1', label: 'Fastest Mini' },
    ],
    'fastest',
    (option) => ({ primary: option.label, secondary: [option.value] })
  ).map((option) => option.value);
  expect(ranked).toEqual(['x-1', 'anthropic-fastest']);
});
