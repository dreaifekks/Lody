// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceVoiceSetting } from '@lody/shared';

const catalog = vi.hoisted(() => ({ voice: null as WorkspaceVoiceSetting | null }));
vi.mock('@/hooks/use-workspace-catalog', () => ({
  useWorkspaceCatalog: () => ({ voice: catalog.voice }),
}));

const { useVoiceAgentSelection } = await import('../src/hooks/use-voice-agent-selection');
const { voiceAgentScopeAtom, voiceAgentSelectionAtom, voiceNameAtom } =
  await import('../src/atoms/settings');

let root: Root;
let latest: ReturnType<typeof useVoiceAgentSelection>;

function Probe() {
  latest = useVoiceAgentSelection();
  return null;
}

function render(store: ReturnType<typeof createStore>) {
  act(() => root.render(createElement(Provider, { store }, createElement(Probe))));
}

beforeEach(() => {
  catalog.voice = null;
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
  localStorage.clear();
});

describe('useVoiceAgentSelection', () => {
  it('takes the voice from the workspace row when every device shares the agent', () => {
    catalog.voice = {
      version: 1,
      configId: 'config-1',
      machineId: 'machine-1',
      voice: 'maple',
    } as WorkspaceVoiceSetting;
    const store = createStore();
    store.set(voiceNameAtom, 'cove');
    render(store);

    expect(latest).toEqual({ configId: 'config-1', machineId: 'machine-1', voice: 'maple' });
  });

  it("follows Codex's default when the shared row names no voice", () => {
    catalog.voice = {
      version: 1,
      configId: 'config-1',
      machineId: 'machine-1',
    } as WorkspaceVoiceSetting;
    render(createStore());

    expect(latest).toEqual({ configId: 'config-1', machineId: 'machine-1', voice: null });
  });

  it("takes this device's own voice with this device's own agent", () => {
    catalog.voice = {
      version: 1,
      configId: 'config-1',
      machineId: 'machine-1',
      voice: 'maple',
    } as WorkspaceVoiceSetting;
    const store = createStore();
    store.set(voiceAgentScopeAtom, 'device');
    store.set(voiceAgentSelectionAtom, 'config-2:machine-2');
    store.set(voiceNameAtom, 'juniper');
    render(store);

    expect(latest).toEqual({ configId: 'config-2', machineId: 'machine-2', voice: 'juniper' });
  });
});
