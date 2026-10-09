import { describe, expect, it } from 'vitest';
import { reconcileAgentRoleSchema } from '../src/lib/agent-role-schema-reconciliation';
import {
  AGENT_ROLE_VERSION,
  buildAgentRoleFormValue,
  buildAgentRoleFromForm,
  EMPTY_AGENT_ROLE_FORM_VALUE,
  validateAgentRoleForm,
  type AgentRoleFormInstance,
  type AgentRoleFormValue,
  type AcpCapabilityCacheEntry,
  type AgentConfigId,
  type AgentRole,
  type AgentRoleId,
  type AgentRoleInstanceId,
  type CatalogAgentRole,
  type MachineId,
} from '@lody/shared';
import type { AcpSelectorOptions } from '../src/components/shared/acp-selector-options';
import {
  applyAgentRoleRunConfigDefaults,
  carryAgentRoleOptionsToModel,
  findAgentRoleRunConfigIssues,
  selectAuthorableAgentRoleConfigOptions,
} from '../src/lib/agent-role-form';
import { singleMachineRole } from './agent-role-fixture';

const role = (overrides: Partial<AgentRole> = {}): CatalogAgentRole =>
  singleMachineRole({
    v: AGENT_ROLE_VERSION,
    id: 'role-1' as AgentRoleId,
    ownerUserId: 'user-1',
    visibility: 'private',
    name: 'Reviewer',
    machineId: 'machine-1' as MachineId,
    agentConfigId: 'config-1' as AgentConfigId,
    runConfig: { modelId: 'gpt-5.6' },
    revision: 1,
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  });

const formInstance = (overrides: Partial<AgentRoleFormInstance> = {}): AgentRoleFormInstance => ({
  id: 'instance-1' as AgentRoleInstanceId,
  label: 'Codex',
  machineId: 'machine-1' as MachineId,
  agentConfigId: 'config-1' as AgentConfigId,
  modeId: null,
  modelId: 'gpt-5.6',
  configOptionValues: {},
  ...overrides,
});

const formValue = (
  overrides: Partial<AgentRoleFormValue> = {},
  instance: Partial<AgentRoleFormInstance> = {}
): AgentRoleFormValue => ({
  ...EMPTY_AGENT_ROLE_FORM_VALUE,
  name: 'Reviewer',
  instances: [formInstance(instance)],
  ...overrides,
});

const createId = () => 'new-role' as AgentRoleId;

describe('role description authoring', () => {
  it('preserves legacy no-op saves and round-trips edits and clearing', () => {
    const existing = role();
    const options = { existing, ownerUserId: 'user-1', now: 20, createId };
    const value = buildAgentRoleFormValue(existing);
    expect(value.description).toBe('');
    expect(buildAgentRoleFromForm(value, options)).toBe(existing);
    const edited = buildAgentRoleFromForm({ ...value, description: 'Review changes' }, options);
    expect(edited.description).toBe('Review changes');
    expect(edited.revision).toBe(2);
    expect(buildAgentRoleFormValue(edited).description).toBe('Review changes');
    const cleared = buildAgentRoleFromForm(
      { ...buildAgentRoleFormValue(edited), description: '' },
      { ...options, existing: edited }
    );
    expect(cleared.description).toBe('');
    expect(cleared.revision).toBe(3);
  });

  it('caps newly saved descriptions at 140 Unicode code points', () => {
    const saved = buildAgentRoleFromForm(formValue({ description: '😀'.repeat(141) }), {
      ownerUserId: 'user-1',
      now: 20,
      createId,
    });
    expect(saved.description).toBe('😀'.repeat(140));
  });
});

describe('automatic role schema reconciliation', () => {
  // The fixture's one instance, on machine-1.
  const instanceId = 'role-1:machine-1' as AgentRoleInstanceId;
  const capability: AcpCapabilityCacheEntry = {
    cliType: 'builtin',
    agentType: 'codex',
    provenance: 'runtime',
    fetchedAt: 1,
    modes: [],
    models: [],
    configOptions: [
      {
        id: 'model',
        category: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'retired-model',
        options: [],
      },
      { id: 'plan_mode', name: 'Plan', type: 'boolean', currentValue: false },
      {
        id: 'effort',
        name: 'Effort',
        type: 'select',
        currentValue: 'high',
        options: [{ value: 'high', name: 'High' }],
      },
    ],
  };

  it('removes retired fields, migrates Plan and preserves model, permissions and invalid values', () => {
    const before = role({
      runConfig: {
        modelId: 'retired-model',
        modeId: 'strict',
        configOptionValues: {
          interaction_mode: 'code',
          collaboration_mode: 'plan',
          effort: 'invalid',
          _permission: 'ask',
          sandbox: 'read-only',
          future_removed: false,
        },
      },
    });
    const after = reconcileAgentRoleSchema(before, instanceId, capability);
    expect(after.runConfig).toEqual({
      modelId: 'retired-model',
      modeId: 'strict',
      configOptionValues: {
        effort: 'invalid',
        _permission: 'ask',
        sandbox: 'read-only',
        plan_mode: true,
      },
    });
    expect(before.runConfig.configOptionValues?.collaboration_mode).toBe('plan');
    expect(reconcileAgentRoleSchema(after, instanceId, capability)).toBe(after);
  });

  it('keeps an explicit new Plan value and leaves advertised legacy fields intact', () => {
    const before = role({
      runConfig: { configOptionValues: { plan_mode: false, collaboration_mode: 'plan' } },
    });
    expect(
      reconcileAgentRoleSchema(before, instanceId, capability).runConfig.configOptionValues
    ).toEqual({
      plan_mode: false,
    });
    expect(
      reconcileAgentRoleSchema(before, instanceId, {
        ...capability,
        configOptions: [
          ...capability.configOptions!,
          {
            id: 'collaboration_mode',
            name: 'Plan',
            type: 'select',
            currentValue: 'default',
            options: [],
          },
        ],
      })
    ).toBe(before);
  });

  it('does not infer removals from absent or provisional schemas', () => {
    const before = role({ runConfig: { configOptionValues: { unknown: 'keep' } } });
    expect(
      reconcileAgentRoleSchema(before, instanceId, { ...capability, configOptions: undefined })
    ).toBe(before);
    expect(
      reconcileAgentRoleSchema(before, instanceId, { ...capability, provenance: undefined })
    ).toBe(before);
    expect(
      reconcileAgentRoleSchema(before, instanceId, { ...capability, configOptions: [] }).runConfig
        .configOptionValues
    ).toEqual({});
  });

  it('preserves model-dependent options when the probe describes another model', () => {
    const before = role({
      runConfig: {
        modelId: 'another-model',
        configOptionValues: {
          model_specific: true,
          collaboration_mode: 'plan',
        },
      },
    });
    expect(reconcileAgentRoleSchema(before, instanceId, capability).runConfig).toEqual({
      modelId: 'another-model',
      configOptionValues: { model_specific: true, plan_mode: true },
    });
  });

  it('reconciles only the probed instance, even beside another on the same machine', () => {
    const stale = { configOptionValues: { future_removed: true } };
    const entry = (id: string, machineId: string) => ({
      id: id as AgentRoleInstanceId,
      label: id,
      machineId: machineId as MachineId,
      agentConfigId: `config-${id}` as AgentConfigId,
      runConfig: stale,
    });
    const before = singleMachineRole({
      ...role(),
      instances: [entry('a', 'machine-2'), entry('b', 'machine-1'), entry('c', 'machine-1')],
    });
    const after = reconcileAgentRoleSchema(before, 'b' as AgentRoleInstanceId, capability);
    expect(after.instances.map((item) => item.runConfig.configOptionValues)).toEqual([
      { future_removed: true },
      {},
      { future_removed: true },
    ]);
    // The mirror still follows the first instance, which was not probed.
    expect(after.machineId).toBe('machine-2');
    expect(after.runConfig).toEqual(stale);
    expect(reconcileAgentRoleSchema(before, 'gone' as AgentRoleInstanceId, capability)).toBe(
      before
    );
  });

  it.each([
    [{ interaction_mode: 'plan' }, true],
    [{ interaction_mode: 'plan', collaboration_mode: 'default' }, false],
    [{ interaction_mode: 'plan', plan_mode: false }, false],
  ] as const)(
    'preserves legacy interaction Plan with explicit newer choices taking precedence: %j',
    (values, enabled) => {
      const before = role({ runConfig: { configOptionValues: values } });
      expect(
        reconcileAgentRoleSchema(before, instanceId, capability).runConfig.configOptionValues
      ).toEqual({
        plan_mode: enabled,
      });
    }
  );
});

const selectorOptions = (overrides: Partial<AcpSelectorOptions> = {}): AcpSelectorOptions => ({
  capabilityAuthority: 'authoritative',
  defaultModeId: 'default',
  defaultModelId: 'gpt-5.6',
  modeOptions: [{ value: 'default', label: 'Default' }],
  modelOptions: [{ value: 'gpt-5.6', label: 'GPT-5.6' }],
  configOptionSelectors: [
    {
      type: 'select',
      configId: 'thought_level',
      label: 'Reasoning',
      currentValue: 'medium',
      options: [
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
      ],
    },
    { type: 'boolean', configId: 'fast-mode', label: 'Fast', options: [], currentValue: false },
  ],
  ...overrides,
});

describe('agent role form validation', () => {
  it('requires a name, an instance, and a machine, an agent and a label on each', () => {
    expect(validateAgentRoleForm(EMPTY_AGENT_ROLE_FORM_VALUE, { accessibleRoles: [] })).toEqual([
      'name_required',
      'instance_required',
    ]);
    expect(validateAgentRoleForm(formValue(), { accessibleRoles: [] })).toEqual([]);
    const unfinished = formInstance({
      id: 'instance-2' as AgentRoleInstanceId,
      label: ' ',
      machineId: null,
      agentConfigId: null,
    });
    expect(
      validateAgentRoleForm(formValue({ instances: [formInstance(), unfinished] }), {
        accessibleRoles: [],
      })
    ).toEqual(['machine_required', 'agent_config_required', 'label_required']);
  });

  it('allows several instances on one machine, but not two with one label', () => {
    const second = formInstance({
      id: 'instance-2' as AgentRoleInstanceId,
      label: 'Claude',
      agentConfigId: 'config-2' as AgentConfigId,
    });
    expect(
      validateAgentRoleForm(formValue({ instances: [formInstance(), second] }), {
        accessibleRoles: [],
      })
    ).toEqual([]);
    expect(
      validateAgentRoleForm(
        formValue({ instances: [formInstance(), { ...second, label: ' codex ' }] }),
        { accessibleRoles: [] }
      )
    ).toEqual(['label_taken']);
  });

  it('rejects a name with no mention token left in it', () => {
    expect(validateAgentRoleForm(formValue({ name: '  ---  ' }), { accessibleRoles: [] })).toEqual([
      'name_required',
    ]);
  });

  it('rejects a name that collides on the derived mention token, but not its own', () => {
    const existing = role({ id: 'other' as AgentRoleId, name: 'Reviewer' });
    // "Code Reviewer" and "Code-Reviewer" would both complete as one token.
    expect(
      validateAgentRoleForm(formValue({ name: 'Reviewer' }), { accessibleRoles: [existing] })
    ).toEqual(['name_taken']);
    expect(
      validateAgentRoleForm(formValue({ name: 'Reviewer' }), {
        accessibleRoles: [existing],
        editingRoleId: 'other' as AgentRoleId,
      })
    ).toEqual([]);
  });
});

describe('name check exemption', () => {
  it('ignores the row an in-flight create already wrote', () => {
    // The local write lands while the dialog is still open, so the catalog now
    // contains the very Role being created. The editor has carried that id
    // since the form opened, so the form does not report its own name as taken.
    const justWritten = role({ id: 'new-role' as AgentRoleId, name: 'Reviewer' });
    expect(
      validateAgentRoleForm(formValue({ name: 'Reviewer' }), {
        accessibleRoles: [justWritten],
        editingRoleId: justWritten.id,
      })
    ).toEqual([]);
  });

  it('still catches a real clash while a save is in flight', () => {
    const other = role({ id: 'other' as AgentRoleId, name: 'Reviewer' });
    expect(
      validateAgentRoleForm(formValue({ name: 'Reviewer' }), {
        accessibleRoles: [other],
        editingRoleId: 'new-role' as AgentRoleId,
      })
    ).toEqual(['name_taken']);
  });
});

describe('building a role from the form', () => {
  it('creates a private role with revision 1', () => {
    const created = buildAgentRoleFromForm(formValue(), {
      ownerUserId: 'user-1',
      now: 100,
      createId,
    });
    expect(created).toMatchObject({
      id: 'new-role',
      ownerUserId: 'user-1',
      visibility: 'private',
      revision: 1,
      createdAt: 100,
      updatedAt: 100,
    });
  });

  it('keeps the authored emoji and drops one that is only whitespace', () => {
    expect(
      buildAgentRoleFromForm(formValue({ emoji: ' 🔍 ' }), {
        ownerUserId: 'user-1',
        now: 100,
        createId,
      }).emoji
    ).toBe('🔍');
    expect(
      buildAgentRoleFromForm(formValue({ emoji: '   ' }), {
        ownerUserId: 'user-1',
        now: 100,
        createId,
      }).emoji
    ).toBeUndefined();
  });

  it('refuses to store a secret-shaped option the surface somehow offered', () => {
    const created = buildAgentRoleFromForm(
      formValue({}, { configOptionValues: { thought_level: 'high', api_key: 'sk-live' } }),
      { ownerUserId: 'user-1', now: 100, createId }
    );
    expect(created.instances[0]?.runConfig.configOptionValues).toEqual({ thought_level: 'high' });
  });

  it('keeps every instance with its own memory, in order, and mirrors the first', () => {
    const memory = { providerId: 'nowledge-mem', memoryId: 'reviewer' };
    const created = buildAgentRoleFromForm(
      formValue({
        instances: [
          formInstance({ label: ' Codex ' }),
          formInstance({
            id: 'instance-2' as AgentRoleInstanceId,
            label: 'Claude',
            agentConfigId: 'config-2' as AgentConfigId,
            modelId: 'opus',
            memory,
          }),
        ],
      }),
      { ownerUserId: 'user-1', now: 100, createId }
    );
    expect(
      created.instances.map((entry) => [entry.id, entry.label, entry.machineId, entry.runConfig])
    ).toEqual([
      ['instance-1', 'Codex', 'machine-1', { modelId: 'gpt-5.6' }],
      ['instance-2', 'Claude', 'machine-1', { modelId: 'opus', memory }],
    ]);
    expect(created).toMatchObject({
      machineId: 'machine-1',
      agentConfigId: 'config-1',
      runConfig: { modelId: 'gpt-5.6' },
    });
    // Reopening and saving without a change keeps the row as it is.
    expect(
      buildAgentRoleFromForm(buildAgentRoleFormValue(created), {
        existing: created,
        ownerUserId: 'user-1',
        now: 200,
        createId,
      })
    ).toBe(created);
  });

  it('leaves an unchanged edit untouched so its revision does not move', () => {
    const existing = role();
    const saved = buildAgentRoleFromForm(buildAgentRoleFormValue(existing), {
      existing,
      ownerUserId: 'user-1',
      now: 200,
      createId,
    });
    expect(saved).toBe(existing);
  });

  it('bumps the revision exactly once for a real edit', () => {
    const existing = role({ revision: 4 });
    const saved = buildAgentRoleFromForm(
      { ...buildAgentRoleFormValue(existing), promptPrefix: 'Be strict.' },
      { existing, ownerUserId: 'user-1', now: 200, createId }
    );
    expect(saved).toMatchObject({
      id: existing.id,
      revision: 5,
      updatedAt: 200,
      createdAt: 10,
      promptPrefix: 'Be strict.',
    });
  });

  it('keeps the original owner when someone else saves a shared role', () => {
    const existing = role({ ownerUserId: 'user-2', visibility: 'workspace' });
    const saved = buildAgentRoleFromForm(
      { ...buildAgentRoleFormValue(existing), name: 'Renamed' },
      { existing, ownerUserId: 'user-1', now: 200, createId }
    );
    expect(saved.ownerUserId).toBe('user-2');
  });

  it('shares and unshares through the same row', () => {
    const existing = role();
    const shared = buildAgentRoleFromForm(
      { ...buildAgentRoleFormValue(existing), shareWithWorkspace: true },
      { existing, ownerUserId: 'user-1', now: 200, createId }
    );
    expect(shared).toMatchObject({ id: existing.id, visibility: 'workspace', revision: 2 });

    const unshared = buildAgentRoleFromForm(
      { ...buildAgentRoleFormValue(shared), shareWithWorkspace: false },
      { existing: shared, ownerUserId: 'user-1', now: 300, createId }
    );
    expect(unshared).toMatchObject({ id: existing.id, visibility: 'private', revision: 3 });
  });
});

describe('run config defaults', () => {
  it('writes the agent own defaults into the unset fields', () => {
    expect(
      applyAgentRoleRunConfigDefaults(formInstance({ modelId: null }), selectorOptions())
    ).toEqual(
      formInstance({
        modelId: 'gpt-5.6',
        modeId: 'default',
        configOptionValues: { thought_level: 'medium', 'fast-mode': false },
      })
    );
  });

  it('never overwrites a stored selection, so an incompatible one stays visible', () => {
    const stored = formInstance({
      modelId: 'retired-model',
      modeId: 'default',
      configOptionValues: { thought_level: 'ultra', 'fast-mode': true },
    });
    expect(applyAgentRoleRunConfigDefaults(stored, selectorOptions())).toBe(stored);
  });

  it('fills nothing while the agent capabilities are unknown', () => {
    const value = formInstance({ modelId: null });
    expect(
      applyAgentRoleRunConfigDefaults(
        value,
        selectorOptions({ capabilityAuthority: 'unavailable' })
      )
    ).toBe(value);
    expect(applyAgentRoleRunConfigDefaults(value, null)).toBe(value);
  });

  it('offers no default for a secret-shaped option, because it is never authorable', () => {
    const seeded = applyAgentRoleRunConfigDefaults(
      formInstance({ modelId: null }),
      selectorOptions({
        configOptionSelectors: [
          { type: 'select', configId: 'api_key', label: 'Key', currentValue: 'x', options: [] },
        ],
      })
    );
    expect(seeded.configOptionValues).toEqual({});
  });
});

describe('run config model switch', () => {
  it('keeps the values the new model still accepts and drops the rest', () => {
    const effort = (values: string[]) => ({
      type: 'select' as const,
      configId: 'effort',
      label: 'Effort',
      currentValue: values[0],
      options: values.map((value) => ({ value, label: value })),
    });
    const fast = { type: 'boolean' as const, configId: 'fast', label: 'Fast', options: [] };
    const outgoing = [effort(['high', 'xhigh']), fast];
    const incoming = [effort(['high'])];
    const values = { effort: 'high', permission_mode: 'acceptEdits', fast: true };

    expect(carryAgentRoleOptionsToModel(values, outgoing, incoming)).toEqual({
      effort: 'high',
      permission_mode: 'acceptEdits',
    });
    expect(
      carryAgentRoleOptionsToModel({ ...values, effort: 'xhigh' }, outgoing, incoming)
    ).not.toHaveProperty('effort');
  });
});

describe('run config compatibility', () => {
  it('reports every setting the agent no longer publishes', () => {
    expect(
      findAgentRoleRunConfigIssues(
        {
          modeId: 'retired-mode',
          modelId: 'retired-model',
          configOptionValues: { thought_level: 'ultra', legacy: 'x' },
        },
        selectorOptions()
      )
    ).toEqual([
      { kind: 'mode_unsupported', value: 'retired-mode' },
      { kind: 'model_unsupported', value: 'retired-model' },
      { kind: 'option_value_unsupported', configId: 'thought_level', value: 'ultra' },
      { kind: 'option_unsupported', configId: 'legacy' },
    ]);
  });

  it('accepts a run config the agent still publishes', () => {
    expect(
      findAgentRoleRunConfigIssues(
        { modeId: 'default', modelId: 'gpt-5.6', configOptionValues: { 'fast-mode': true } },
        selectorOptions()
      )
    ).toEqual([]);
  });

  it('will not call a stored selection compatible while capabilities are unknown', () => {
    const unavailable = selectorOptions({ capabilityAuthority: 'unavailable' });
    expect(findAgentRoleRunConfigIssues({ modelId: 'gpt-5.6' }, unavailable)).toEqual([
      { kind: 'capabilities_unknown' },
    ]);
    // Nothing pinned means nothing to be wrong about.
    expect(findAgentRoleRunConfigIssues({}, unavailable)).toEqual([]);
  });

  it('never offers a secret-shaped option as something to author', () => {
    expect(
      selectAuthorableAgentRoleConfigOptions([
        { configId: 'thought_level' },
        { configId: 'openai_api_key' },
      ])
    ).toEqual([{ configId: 'thought_level' }]);
  });
});
