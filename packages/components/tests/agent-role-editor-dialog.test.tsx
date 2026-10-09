// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { atom } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_ROLE_VERSION,
  withAgentRoleInstances,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRoleId,
  type AgentRoleInstanceId,
  type CatalogAgentRole,
  type MachineId,
} from '@lody/shared';

const mocks = vi.hoisted(() => ({
  saved: [] as unknown[],
  configs: [] as unknown[],
}));

vi.mock('../src/atoms/agents', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAllAgentConfigAtom: atom(() => mocks.configs),
}));
vi.mock('../src/hooks/use-workspace-agent-roles', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useWorkspaceAgentRoleActions: () => ({
    upsert: async (role: unknown) => {
      mocks.saved.push(role);
    },
    remove: async () => undefined,
  }),
}));
vi.mock('../src/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => ({
    machines: new Map(['machine-a', 'machine-b', 'machine-c'].map((id) => [id, { id, name: id }])),
  }),
}));
vi.mock('@posthog/react', () => ({ usePostHog: () => null }));

import { userAtom } from '../src/atoms';
import {
  AgentRoleEditorDialog,
  openAgentRoleEditorById,
  openAgentRoleEditorForEdit,
  type AgentRoleEditorState,
} from '../src/components/settings/agent-role-editor-dialog';
import { buildComposerAgentRoleItems } from '../src/lib/composer-agent-roles';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const machineA = 'machine-a' as MachineId;
const memory = { providerId: 'nowledge-mem', memoryId: 'reviewer' };

/** Two instances on A and an aliased one on B, each with its own run config; B's carries memory. */
const catalogRole: CatalogAgentRole = withAgentRoleInstances(
  {
    v: AGENT_ROLE_VERSION,
    id: 'reviewer' as AgentRoleId,
    ownerUserId: 'user-1',
    visibility: 'private',
    name: 'Reviewer',
    description: 'Reviews diffs',
    revision: 3,
    createdAt: 1,
    updatedAt: 1,
  },
  [
    {
      id: 'reviewer-a' as AgentRoleInstanceId,
      machineId: machineA,
      agentConfigId: 'config-a' as AgentConfigId,
      runConfig: { modelId: 'model-a' },
    },
    {
      id: 'reviewer-b' as AgentRoleInstanceId,
      alias: 'Strict',
      machineId: 'machine-b' as MachineId,
      agentConfigId: 'config-b' as AgentConfigId,
      runConfig: { modelId: 'model-b', modeId: 'plan', memory },
    },
    {
      id: 'reviewer-c' as AgentRoleInstanceId,
      machineId: machineA,
      agentConfigId: 'config-c' as AgentConfigId,
      runConfig: { modelId: 'model-c', configOptionValues: { effort: 'high' } },
    },
  ]
);

// Agents whose capabilities were never reported: the editor seeds no defaults,
// so the saved instances must be exactly the stored ones.
mocks.configs = [
  ['a', machineA],
  ['b', 'machine-b'],
  ['c', machineA],
].map(
  ([suffix, machineId]) =>
    ({
      id: `config-${suffix}`,
      machineId,
      name: `Agent ${suffix}`,
      cliType: 'custom',
      agentType: `custom-${suffix}`,
      env: {},
    }) as unknown as AgentConfigMeta
);

function Harness({ initial }: { initial: AgentRoleEditorState }) {
  const [editor, setEditor] = useState<AgentRoleEditorState | null>(initial);
  return createElement(AgentRoleEditorDialog, {
    editor,
    accessibleRoles: [catalogRole],
    onChange: setEditor,
    onClose: () => setEditor(null),
    source: 'chat_landing',
  });
}

describe('editing a Role opened from a composer', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    mocks.saved = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    document.body.innerHTML = '';
  });

  const editDescriptionAndSave = async (initial: AgentRoleEditorState) => {
    const store = createStore();
    store.set(userAtom, { id: 'user-1' } as never);
    await act(async () =>
      root?.render(createElement(Provider, { store }, createElement(Harness, { initial })))
    );
    const description = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Description"]'
    );
    if (!description) throw new Error('Missing description field');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        description,
        'Reviews diffs before merging'
      );
      description.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save'
    );
    if (!save) throw new Error('Missing save button');
    await act(async () => save.click());
    expect(mocks.saved).toHaveLength(1);
    return mocks.saved[0] as CatalogAgentRole;
  };

  it('saves the catalog row with every instance and its memory, edited from one instance', async () => {
    // The chat landing menu lists machine A's two instances of the Role…
    const items = buildComposerAgentRoleItems({
      roles: [catalogRole],
      machineId: machineA,
      agentConfigs: mocks.configs as AgentConfigMeta[],
      resolveAvailability: () => ({ kind: 'available' }),
      names: { machine: (id) => id, unknownAgent: 'Unknown agent' },
    });
    expect(items.map((item) => item.title)).toEqual([
      'Reviewer · Agent a',
      'Reviewer · Agent c',
      'Reviewer · Strict · machine-b',
    ]);
    // …and the second one's edit button opens the catalog row by its Role id.
    const editor = openAgentRoleEditorById([catalogRole], items[1]!.role.id);
    if (!editor) throw new Error('Role not found');

    const saved = await editDescriptionAndSave(editor);
    expect(saved.description).toBe('Reviews diffs before merging');
    expect(saved.revision).toBe(4);
    expect(saved.instances).toEqual(catalogRole.instances);
    expect(saved).toMatchObject({ machineId: machineA, agentConfigId: 'config-a' });
  });

  it('keeps every instance when Settings opens the row directly', async () => {
    const saved = await editDescriptionAndSave(openAgentRoleEditorForEdit(catalogRole));
    expect(saved.instances).toEqual(catalogRole.instances);
  });

  it('opens nothing for a Role the catalog no longer has', () => {
    expect(openAgentRoleEditorById([], catalogRole.id)).toBeNull();
  });
});
