// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '@lody/shared';

const catalog = vi.hoisted(() => ({ promptSuggestions: true }));
vi.mock('@/hooks/use-workspace-catalog', () => ({
  useWorkspaceCatalog: () => ({ promptSuggestions: catalog.promptSuggestions }),
}));

const { useSessionPromptSuggestion } =
  await import('../src/components/sessions/use-session-prompt-suggestion');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let shown: string | null = null;

const session = (id: string, text: string, agentType = 'claude'): SessionMeta =>
  ({
    id,
    agentType,
    latestUserMsgId: 'user-1',
    lastHandledUserMsgId: 'user-1',
    promptSuggestion: { text, afterUserMsgId: 'user-1' },
  }) as unknown as SessionMeta;

function Probe(props: { session: SessionMeta; inputEmpty?: boolean; agentBusy?: boolean }) {
  shown = useSessionPromptSuggestion(props.session, {
    inputEmpty: props.inputEmpty ?? true,
    agentBusy: props.agentBusy ?? false,
  });
  return null;
}

function render(store: ReturnType<typeof createStore>, props: Parameters<typeof Probe>[0]) {
  act(() => root.render(createElement(Provider, { store }, createElement(Probe, props))));
}

beforeEach(() => {
  catalog.promptSuggestions = true;
  shown = null;
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
  localStorage.clear();
});

describe('useSessionPromptSuggestion', () => {
  it('offers the guess only for Claude, with the switch on, while idle', () => {
    // Not an experimental feature: the experimental switch does not gate it.
    const store = createStore();
    render(store, { session: session('a', 'run the tests') });
    expect(shown).toBe('run the tests');

    render(store, { session: session('a', 'run the tests'), agentBusy: true });
    expect(shown).toBeNull();
    render(store, { session: session('a', 'run the tests', 'codex') });
    expect(shown).toBeNull();

    catalog.promptSuggestions = false;
    render(store, { session: session('a', 'run the tests') });
    expect(shown).toBeNull();
  });

  it('lets the guess go once something is typed, even if the text is cleared again', () => {
    const store = createStore();
    render(store, { session: session('a', 'run the tests') });
    render(store, { session: session('a', 'run the tests'), inputEmpty: false });
    render(store, { session: session('a', 'run the tests') });
    expect(shown).toBeNull();

    // The next turn's guess is offered again.
    render(store, { session: session('a', 'commit it') });
    expect(shown).toBe('commit it');
  });

  it('lets the guess go when the composer switches to another session', () => {
    const store = createStore();
    render(store, { session: session('a', 'run the tests') });
    render(store, { session: session('b', 'open a PR') });
    expect(shown).toBe('open a PR');

    render(store, { session: session('a', 'run the tests') });
    expect(shown).toBeNull();
  });
});
