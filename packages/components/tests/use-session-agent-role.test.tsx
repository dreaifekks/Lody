// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_ROLE_EMOJI } from '@lody/shared';
import type {
  AgentConfigId,
  AgentConfigMeta,
  AgentRole,
  AgentRoleId,
  AgentRoleInstanceId,
  MachineId,
  SessionId,
} from '@lody/shared';

const catalog = vi.hoisted(() => ({
  roles: [] as AgentRole[],
  agentConfigs: [] as AgentConfigMeta[],
  synced: true,
}));

vi.mock('jotai', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAtomValue: () => catalog.agentConfigs,
}));

vi.mock('../src/hooks/use-workspace-agent-roles', () => ({
  useWorkspaceAgentRoles: () => ({ roles: catalog.roles, synced: catalog.synced }),
  useAgentRoleAvailability: () => ({
    resolve: () => ({ kind: 'available' }),
    resolveInstance: () => ({ kind: 'available' }),
  }),
  useComposerAgentRoleNames: () => names,
}));
const names = { machine: () => undefined, unknownAgent: 'Unknown agent' };

import {
  useSessionAgentRole,
  type SessionAgentRoleControl,
} from '../src/hooks/use-session-agent-role';
import { resolveProgrammaticTurnAgentRole } from '../src/lib/composer-agent-roles';
import {
  sessionAgentRoleDurableSnapshotAtomFamily,
  sessionAgentRoleSelectionAtomFamily,
} from '../src/atoms/session-agent-roles';
import { buildAcpSelectorOptions } from '../src/components/shared/acp-selector-options';
import {
  buildAcpSessionConfigCandidates,
  resolveAcpSessionConfigSelection,
  type AcpSessionUserConfigEdits,
  type ResolvedAcpSessionConfigSelection,
} from '../src/lib/acp-session-config-selection';
import { reportedClaudeCapabilities, singleMachineRole } from './agent-role-fixture';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const role = (id: string, modelId: string): AgentRole =>
  singleMachineRole({
    v: 1,
    id: id as AgentRoleId,
    revision: 1,
    name: id,
    visibility: 'private',
    ownerUserId: 'user-1',
    machineId: 'machine-1' as MachineId,
    agentConfigId: 'agent-1' as AgentConfigId,
    runConfig: { modelId },
    createdAt: Date.UTC(2026, 7, 25),
    updatedAt: Date.UTC(2026, 7, 25),
  });

/** The id a single-machine fixture's instance gets on machine-1. */
const iid = (roleId: string) => `${roleId}:machine-1` as AgentRoleInstanceId;

const agentConfig = {
  id: 'agent-1',
  name: 'Codex',
  machineId: 'machine-1',
  cliType: 'builtin',
  agentType: 'codex',
} as AgentConfigMeta;

describe('useSessionAgentRole', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let control: SessionAgentRoleControl | null = null;
  let hookProps: {
    sessionId: string;
    provenanceRoleId?: AgentRoleId;
    durableRoleId?: AgentRoleId | null;
    durableRoleRevision?: number;
    durableInstanceId?: AgentRoleInstanceId;
    durableSourceTurnKey?: string;
    durableKnownSourceTurnKeys?: readonly string[];
    durableRoleReady?: boolean;
    runConfigHasUserEdits?: boolean;
    selectedModelId: string;
  };

  function Harness() {
    control = useSessionAgentRole({
      sessionId: hookProps.sessionId as SessionId,
      provenanceRoleId: hookProps.provenanceRoleId,
      durableRoleId: hookProps.durableRoleId,
      durableRoleRevision: hookProps.durableRoleRevision,
      durableInstanceId: hookProps.durableInstanceId,
      durableSourceTurnKey: hookProps.durableSourceTurnKey,
      durableKnownSourceTurnKeys: hookProps.durableKnownSourceTurnKeys,
      durableRoleReady: hookProps.durableRoleReady,
      runConfigHasUserEdits: hookProps.runConfigHasUserEdits,
      machineId: 'machine-1' as MachineId,
      agentConfigId: 'agent-1' as AgentConfigId,
      modelOptions: [{ value: 'model-1', label: 'Model 1' }],
      selectedModelId: hookProps.selectedModelId,
      modeOptions: [],
      selectedModeId: null,
      configOptionSelectors: [],
      configOptionValues: {},
    });
    return null;
  }

  const render = async ({
    sessionId = 'session-1',
    provenanceRoleId,
    durableRoleId,
    durableRoleRevision,
    durableInstanceId,
    durableSourceTurnKey,
    durableKnownSourceTurnKeys,
    durableRoleReady,
    runConfigHasUserEdits,
    selectedModelId = 'model-1',
  }: {
    sessionId?: string;
    provenanceRoleId?: AgentRoleId;
    durableRoleId?: AgentRoleId | null;
    durableRoleRevision?: number;
    durableInstanceId?: AgentRoleInstanceId;
    durableSourceTurnKey?: string;
    durableKnownSourceTurnKeys?: readonly string[];
    durableRoleReady?: boolean;
    runConfigHasUserEdits?: boolean;
    selectedModelId?: string;
  }) => {
    hookProps = {
      sessionId,
      provenanceRoleId,
      durableRoleId,
      durableRoleRevision,
      durableInstanceId,
      durableSourceTurnKey,
      durableKnownSourceTurnKeys,
      durableRoleReady,
      runConfigHasUserEdits,
      selectedModelId,
    };
    await act(async () => root?.render(createElement(Harness)));
  };

  beforeEach(() => {
    sessionAgentRoleSelectionAtomFamily.remove('session-1' as SessionId);
    sessionAgentRoleSelectionAtomFamily.remove('session-2' as SessionId);
    sessionAgentRoleDurableSnapshotAtomFamily.remove('session-1' as SessionId);
    sessionAgentRoleDurableSnapshotAtomFamily.remove('session-2' as SessionId);
    catalog.roles = [];
    catalog.agentConfigs = [agentConfig];
    catalog.synced = true;
    control = null;
    hookProps = { sessionId: 'session-1', selectedModelId: 'model-1' };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  it('names a picked Role that pins Fast off on a model without a Fast toggle', async () => {
    // A live Claude session on its defaults, its run config resolved as the
    // composer resolves it: unsent edits over what the agent reports.
    const claude = { cliType: 'builtin', agentType: 'claude' } as const;
    const machine = { acpCapabilities: { 'agent-1': reportedClaudeCapabilities } };
    let resolved: ResolvedAcpSessionConfigSelection | null = null;
    function LiveSession() {
      const [edits, setEdits] = useState<AcpSessionUserConfigEdits>({ configOptions: {} });
      const inputs = { edits, preferences: {} };
      const candidates = buildAcpSessionConfigCandidates(inputs);
      const selectorOptions = buildAcpSelectorOptions({
        ...claude,
        configId: 'agent-1' as AgentConfigId,
        selectedModeId: candidates.modeId,
        selectedModelId: candidates.modelId,
        configOptionValues: candidates.configOptionValues,
        machine,
      });
      resolved = resolveAcpSessionConfigSelection(inputs, selectorOptions, claude);
      control = useSessionAgentRole({
        sessionId: 'session-1' as SessionId,
        machineId: 'machine-1' as MachineId,
        agentConfigId: 'agent-1' as AgentConfigId,
        modelOptions: selectorOptions.modelOptions,
        selectedModelId: resolved.selectedModelId,
        onModelChange: (value) => setEdits((prev) => ({ ...prev, model: { value } })),
        modeOptions: selectorOptions.modeOptions,
        selectedModeId: resolved.selectedModeId,
        onModeChange: (value) => setEdits((prev) => ({ ...prev, mode: { value } })),
        configOptionSelectors: selectorOptions.configOptionSelectors,
        configOptionValues: resolved.configOptionValues,
        onConfigOptionChange: (configId, value) =>
          setEdits((prev) => ({
            ...prev,
            configOptions: { ...prev.configOptions, [configId]: value },
          })),
      });
      return null;
    }
    // uiStyle's instance as stored: Fable, effort high, Fast off.
    catalog.agentConfigs = [{ ...agentConfig, ...claude, name: 'Claude Code' } as AgentConfigMeta];
    catalog.roles = [
      singleMachineRole({
        ...role('ui-style', 'claude-fable-5-1'),
        instances: undefined,
        runConfig: {
          modeId: 'auto',
          modelId: 'claude-fable-5-1',
          configOptionValues: { effort: 'max', fast: false },
        },
      }),
    ];
    await act(async () => root?.render(createElement(LiveSession)));
    expect(resolved).toMatchObject({
      selectedModelId: 'opus',
      configOptionValues: { fast: false },
    });

    await act(async () => control?.onSelect(iid('ui-style')));
    // The session now runs what the Role pins; Fable has no Fast to carry.
    expect(resolved).toMatchObject({
      selectedModeId: 'auto',
      selectedModelId: 'claude-fable-5-1',
      configOptionValues: { effort: 'max' },
    });
    expect(resolved!.configOptionValues).not.toHaveProperty('fast');
    expect(control?.selectedInstanceId).toBe(iid('ui-style'));
    expect(control?.turnSelection).toMatchObject({ agentRoleId: 'ui-style' });
  });

  it('offers a Role picked on its second machine and records that instance', async () => {
    // devnuc first, this machine second: the entry and the Turn are this machine's.
    catalog.roles = [
      singleMachineRole({
        ...role('vision', 'model-1'),
        instances: [
          {
            id: 'vision:devnuc' as AgentRoleInstanceId,
            machineId: 'devnuc' as MachineId,
            agentConfigId: 'agent-devnuc' as AgentConfigId,
            runConfig: { modelId: 'model-other' },
          },
          {
            id: 'vision:here' as AgentRoleInstanceId,
            machineId: 'machine-1' as MachineId,
            agentConfigId: 'agent-1' as AgentConfigId,
            runConfig: { modelId: 'model-1' },
          },
        ],
      }),
    ];
    // Both run Codex: one group, shown by this machine's instance.
    catalog.agentConfigs = [
      agentConfig,
      { ...agentConfig, id: 'agent-devnuc', machineId: 'devnuc' } as AgentConfigMeta,
    ];
    await render({});
    expect(control?.items.map((item) => item.instance.id)).toEqual(['vision:here']);
    await act(async () => control?.onSelect('vision:here' as AgentRoleInstanceId));
    expect(control?.selectedInstanceId).toBe('vision:here');
    expect(control?.turnSelection).toMatchObject({
      agentRoleId: 'vision',
      agentRoleSnapshot: { instanceId: 'vision:here' },
    });
  });

  it('lists a Role on another machine but will not select it: the Session cannot move', async () => {
    catalog.roles = [
      singleMachineRole({
        ...role('vision', 'model-1'),
        instances: [
          {
            id: 'vision:devnuc' as AgentRoleInstanceId,
            machineId: 'devnuc' as MachineId,
            agentConfigId: 'agent-devnuc' as AgentConfigId,
            runConfig: { modelId: 'model-1' },
          },
        ],
      }),
    ];
    await render({});
    expect(control?.items.map((item) => [item.instance.id, item.availability])).toEqual([
      ['vision:devnuc', { kind: 'unavailable', reason: 'other_machine' }],
    ]);
    await act(async () => control?.onSelect('vision:devnuc' as AgentRoleInstanceId));
    expect(control?.selectedInstanceId).toBeNull();
  });

  it('drops a recorded instance once deleted or moved, never handing the Role to another', async () => {
    const memory = (memoryId: string) => ({ providerId: 'nowledge-mem', memoryId });
    const withInstances = (...instances: AgentRole['instances']) =>
      singleMachineRole({ ...role('pair', 'model-1'), instances });
    const first = {
      id: 'pair:first' as AgentRoleInstanceId,
      machineId: 'machine-1' as MachineId,
      agentConfigId: 'agent-1' as AgentConfigId,
      runConfig: { modelId: 'model-1', memory: memory('first') },
    };
    const second = {
      ...first,
      id: 'pair:second' as AgentRoleInstanceId,
      alias: 'Second',
      runConfig: { modelId: 'model-1', memory: memory('second') },
    };
    const recorded = {
      durableRoleId: 'pair' as AgentRoleId,
      durableRoleRevision: 1,
      durableInstanceId: second.id,
      durableSourceTurnKey: 'turn:turn-1',
    };
    catalog.roles = [withInstances(first, second)];
    await render(recorded);
    expect(control?.selectedInstanceId).toBe('pair:second');

    // Deleted: same agent, model and mode remain in `first`, but it is not
    // what was picked, and its memory must not ride along.
    catalog.roles = [withInstances(first)];
    await render(recorded);
    expect(control?.selectedInstanceId).toBeNull();
    expect(control?.turnSelection).toBeNull();

    // Moved to another machine: listed there, disabled, and no longer picked.
    catalog.roles = [
      withInstances(first, {
        ...second,
        machineId: 'machine-2' as MachineId,
        runConfig: { modelId: 'model-1', memory: memory('elsewhere') },
      }),
    ];
    await render(recorded);
    expect(control?.selectedInstanceId).toBeNull();
    expect(control?.turnSelection).toBeNull();
  });

  it('restores the instance a Turn recorded among two on this machine and config', async () => {
    const both = singleMachineRole({
      ...role('pair', 'model-1'),
      // The second needs an alias to share this machine and agent with the first.
      instances: ['first', 'second'].map((name) => ({
        id: `pair:${name}` as AgentRoleInstanceId,
        ...(name === 'second' ? { alias: 'Second' } : {}),
        machineId: 'machine-1' as MachineId,
        agentConfigId: 'agent-1' as AgentConfigId,
        runConfig: { modelId: 'model-1' },
      })),
    });
    catalog.roles = [both];
    await render({
      durableRoleId: 'pair' as AgentRoleId,
      durableRoleRevision: 1,
      durableInstanceId: 'pair:second' as AgentRoleInstanceId,
      durableSourceTurnKey: 'turn:turn-1',
    });
    expect(control?.selectedInstanceId).toBe('pair:second');
    // A Turn recorded before instances names only the Role: its default here.
    await render({
      durableRoleId: 'pair' as AgentRoleId,
      durableRoleRevision: 1,
      durableSourceTurnKey: 'turn:turn-2',
    });
    expect(control?.selectedInstanceId).toBe('pair:first');
  });

  it('shows the creating Role after the workspace catalog loads', async () => {
    const provenanceRoleId = 'role-1' as AgentRoleId;
    await render({ provenanceRoleId });
    expect(control?.selectedInstanceId).toBeNull();

    catalog.roles = [role('role-1', 'model-1')];
    await render({ provenanceRoleId });

    expect(control?.selectedInstanceId).toBe(iid(provenanceRoleId));
  });

  it('keeps an explicit None selection and scopes it to the current session', async () => {
    const provenanceRoleId = 'role-1' as AgentRoleId;
    catalog.roles = [role('role-1', 'model-1')];
    await render({ provenanceRoleId });
    expect(control?.selectedInstanceId).toBe(iid(provenanceRoleId));

    await act(async () => control?.onSelect(null));
    expect(control?.selectedInstanceId).toBeNull();

    await render({ provenanceRoleId });
    expect(control?.selectedInstanceId).toBeNull();

    await render({ sessionId: 'session-2', provenanceRoleId });
    expect(control?.selectedInstanceId).toBe(iid(provenanceRoleId));
  });

  it('keeps explicit Role choices independently while switching Sessions', async () => {
    catalog.roles = [role('role-1', 'model-1'), role('role-2', 'model-1')];
    await render({ sessionId: 'session-1' });
    await act(async () => control?.onSelect(iid('role-1')));
    expect(control?.selectedInstanceId).toBe(iid('role-1'));

    await render({ sessionId: 'session-2' });
    await act(async () => control?.onSelect(iid('role-2')));
    expect(control?.selectedInstanceId).toBe(iid('role-2'));

    await render({ sessionId: 'session-1' });
    expect(control?.selectedInstanceId).toBe(iid('role-1'));
  });

  it('restores from the latest durable Turn and lets a newer Turn supersede a local draft', async () => {
    catalog.roles = [role('role-1', 'model-1'), role('role-2', 'model-1')];
    await render({
      durableRoleId: 'role-1' as AgentRoleId,
      durableRoleRevision: 1,
      durableSourceTurnKey: 'turn:turn-1',
    });
    expect(control?.selectedInstanceId).toBe(iid('role-1'));

    await act(async () => control?.onSelect(iid('role-2')));
    expect(control?.selectedInstanceId).toBe(iid('role-2'));

    await render({ durableRoleId: null, durableSourceTurnKey: 'turn:turn-2' });
    expect(control?.selectedInstanceId).toBeNull();

    // Consuming the superseded draft is permanent: if a queue item disappears
    // and the resolver returns to the old history source, role-2 cannot revive.
    await render({
      durableRoleId: 'role-1' as AgentRoleId,
      durableRoleRevision: 1,
      durableSourceTurnKey: 'turn:turn-1',
    });
    expect(control?.selectedInstanceId).toBe(iid('role-1'));
  });

  it('keeps a history-based draft visible while the Session doc remount hydrates', async () => {
    catalog.roles = [role('role-1', 'model-1'), role('role-2', 'model-1')];
    await render({
      durableRoleId: 'role-1' as AgentRoleId,
      durableRoleRevision: 1,
      durableSourceTurnKey: 'turn:turn-1',
    });
    await act(async () => control?.onSelect(iid('role-2')));

    await act(async () => root?.unmount());
    root = createRoot(container!);
    await render({ durableRoleReady: false });
    expect(control?.selectedInstanceId).toBe(iid('role-2'));

    await render({
      durableRoleId: 'role-1' as AgentRoleId,
      durableRoleRevision: 1,
      durableSourceTurnKey: 'turn:turn-1',
      durableRoleReady: true,
    });
    expect(control?.selectedInstanceId).toBe(iid('role-2'));
  });

  it('does not mistake transient hydration defaults for manual Role drift', async () => {
    catalog.roles = [role('role-special', 'model-special')];
    await render({
      durableRoleId: 'role-special' as AgentRoleId,
      durableRoleRevision: 1,
      durableSourceTurnKey: 'turn:turn-1',
      selectedModelId: 'model-special',
    });

    await act(async () => root?.unmount());
    root = createRoot(container!);
    await render({ durableRoleReady: false, selectedModelId: 'provider-default' });

    expect(control?.selectedInstanceId).toBe(iid('role-special'));
    expect(control?.turnSelection).toEqual({
      agentRoleId: 'role-special',
      agentRoleRevision: 1,
      agentRoleSnapshot: {
        id: 'role-special',
        revision: 1,
        name: 'role-special',
        emoji: DEFAULT_AGENT_ROLE_EMOJI,
        instanceId: 'role-special:machine-1',
        instanceLabel: 'Codex',
      },
    });
  });

  it('keeps an unsent Role through queue lifecycle and older backfill', async () => {
    catalog.roles = [role('role-1', 'model-1'), role('role-2', 'model-1')];
    await render({
      durableRoleId: 'role-1' as AgentRoleId,
      durableRoleRevision: 1,
      durableSourceTurnKey: 'turn:turn-2',
      durableKnownSourceTurnKeys: ['turn:turn-2', 'turn:turn-1'],
    });
    await act(async () => control?.onSelect(iid('role-2')));

    // Older backfill extends the lineage without changing its current Turn.
    await render({
      durableRoleId: 'role-1' as AgentRoleId,
      durableRoleRevision: 1,
      durableSourceTurnKey: 'turn:turn-2',
      durableKnownSourceTurnKeys: ['turn:turn-2', 'turn:turn-1', 'turn:turn-0'],
    });
    expect(control?.selectedInstanceId).toBe(iid('role-2'));

    // Falling back to an older Turn that was already known is not a new Turn.
    await render({
      durableRoleId: 'role-1' as AgentRoleId,
      durableRoleRevision: 1,
      durableSourceTurnKey: 'turn:turn-1',
      durableKnownSourceTurnKeys: ['turn:turn-1'],
    });
    expect(control?.selectedInstanceId).toBe(iid('role-2'));
  });

  it('preserves durable Role metadata while its catalog row is still syncing', async () => {
    catalog.synced = false;
    catalog.roles = [];
    await render({
      durableRoleId: 'role-1' as AgentRoleId,
      durableRoleRevision: 5,
      durableSourceTurnKey: 'turn:turn-1',
    });
    expect(control?.selectedInstanceId).toBeNull();
    expect(control?.turnSelection).toEqual({
      agentRoleId: 'role-1',
      agentRoleRevision: 5,
    });

    await render({
      durableRoleId: 'role-1' as AgentRoleId,
      durableRoleRevision: 5,
      durableSourceTurnKey: 'turn:turn-1',
      runConfigHasUserEdits: true,
      selectedModelId: 'model-2',
    });
    expect(control?.turnSelection).toBeNull();
    expect(
      resolveProgrammaticTurnAgentRole({
        composer: control?.turnSelection,
        durableRoleId: 'role-1' as AgentRoleId,
        durableRoleRevision: 5,
        durableMemory: { providerId: 'nowledge-mem', memoryId: 'synthetic-memory' },
      })
    ).toBeNull();
  });

  it('does not name the provenance Role after its run config changes', async () => {
    const provenanceRoleId = 'role-1' as AgentRoleId;
    catalog.roles = [role('role-1', 'model-1')];

    await render({ provenanceRoleId, selectedModelId: 'model-2' });

    expect(control?.selectedInstanceId).toBeNull();
  });
});
