// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRuntime } from '../src/atoms/runtime';

const catalog = vi.hoisted(() => ({ promptSuggestions: true }));
vi.mock('@/hooks/use-workspace-catalog', () => ({
  useWorkspaceCatalog: () => ({ promptSuggestions: catalog.promptSuggestions, voice: null }),
}));

const { GeneralSettingsComponent } = await import('../src/components/settings');
const { experimentalFeaturesEnabledAtom } = await import('../src/atoms/settings');
const { runtimeAtom } = await import('../src/atoms/runtime');
const { RoutedStory, SettingsStoryProviders } = await import('../src/stories/settings-story-shell');
const { initI18n } = await import('../src/i18n');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('General settings sections', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(async () => {
    await initI18n('en');
  });

  beforeEach(() => {
    catalog.promptSuggestions = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
  });

  const render = async (experimental: boolean) => {
    const store = createStore();
    store.set(experimentalFeaturesEnabledAtom, experimental);
    // Only the switch's availability reads the runtime; nothing here writes through it.
    store.set(runtimeAtom, {
      workspaceId: 'workspace-1',
      workspaceSlug: null,
    } as unknown as WorkspaceRuntime);
    await act(async () => {
      root.render(
        <SettingsStoryProviders>
          <Provider store={store}>
            <RoutedStory>
              <GeneralSettingsComponent />
            </RoutedStory>
          </Provider>
        </SettingsStoryProviders>
      );
    });
    return store;
  };

  /** Each section's title and the labels of its rows, in page order. */
  const sections = () =>
    [...container.querySelectorAll('section')].map((section) => ({
      title: section.querySelector('header p')?.textContent ?? '',
      switches: [...section.querySelectorAll('[role="switch"]')].map(
        (control) => control.getAttribute('aria-label') ?? ''
      ),
      text: section.textContent ?? '',
    }));
  const section = (title: string) => sections().find((entry) => entry.title === title);
  const switchNamed = (label: string) =>
    container.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`);

  it('keeps next message suggestions outside the experimental switch, with its value', async () => {
    const store = await render(true);
    const titles = sections().map((entry) => entry.title);
    expect(titles.indexOf('Agent features')).toBe(titles.indexOf('Conversations') + 1);
    expect(section('Agent features')?.switches).toEqual(['Next message suggestions']);
    expect(section('Agent features')?.text).toContain('Claude only');

    await act(async () => switchNamed('Enable experimental features')?.click());
    expect(store.get(experimentalFeaturesEnabledAtom)).toBe(false);

    const suggestions = switchNamed('Next message suggestions');
    expect(suggestions?.getAttribute('aria-checked')).toBe('true');
    expect(suggestions?.hasAttribute('data-disabled')).toBe(false);
    expect(section('Experimental · Sessions')).toBeUndefined();
  });

  it('groups experimental features by use and leaves Advanced with clearing the cache', async () => {
    await render(true);
    const titles = sections().map((entry) => entry.title);
    expect(titles.slice(-4)).toEqual([
      'Experimental features',
      'Experimental · Sessions',
      'Experimental · Agent tools',
      'Advanced',
    ]);
    expect(section('Experimental features')?.switches).toEqual(['Enable experimental features']);
    expect(section('Experimental · Sessions')?.switches).toEqual(['Review agent', 'Voice']);
    expect(section('Experimental · Agent tools')?.switches).toEqual([
      'Notifications from agents',
      'Plan review',
      'Interactive widgets',
    ]);
    const advanced = section('Advanced');
    expect(advanced?.switches).toEqual([]);
    expect(advanced?.text).toContain('Clear');
  });
});
