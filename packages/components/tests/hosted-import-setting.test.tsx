// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedConfigItem, HostedConfigSource } from '@lody/shared/hosted-config';

import { HostedImportSettingView } from '../src/components/settings/hosted-import-setting';
import type { HostedImportOutcome } from '../src/hooks/use-hosted-import';
import { initI18n } from '../src/i18n';

const toasts = vi.hoisted(() => ({
  success: [] as string[],
  error: [] as string[],
  info: [] as string[],
}));
vi.mock('@/lib/toast', () => ({
  toast: {
    success: (message: string) => toasts.success.push(message),
    error: (message: string) => toasts.error.push(message),
    info: (message: string) => toasts.info.push(message),
  },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const items: HostedConfigItem[] = [
  { category: 'agentConfigs', id: 'codex', name: 'Codex', action: 'create', needsSignIn: true },
  { category: 'agentConfigs', id: 'claude', name: 'Claude Code', action: 'unchanged' },
  { category: 'localProjects', id: 'p1', name: 'mizuki', action: 'create' },
  {
    category: 'localProjects',
    id: 'p2',
    name: 'gone',
    action: 'skip',
    reason: 'missing_directory',
  },
];

const hosted: HostedConfigSource = { workspaceId: 'hosted', name: 'Team', items };

describe('Import settings', () => {
  let container: HTMLDivElement;
  let root: Root;
  let requests: unknown[];
  let outcome: HostedImportOutcome;

  const render = async (sources: HostedConfigSource[]) => {
    await act(async () => {
      root.render(
        <HostedImportSettingView
          sources={sources}
          run={async (input) => {
            requests.push(input);
            return outcome;
          }}
        />
      );
    });
  };

  const button = (name: string) =>
    [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes(name));

  const click = async (element: Element | null | undefined) => {
    expect(element).toBeTruthy();
    await act(async () => {
      element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  beforeEach(async () => {
    await initI18n('en');
    toasts.success.length = 0;
    toasts.error.length = 0;
    toasts.info.length = 0;
    requests = [];
    outcome = { ok: true, result: { workspaceId: 'lw_local', items } };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('says what an import adds, keeps and cannot use', async () => {
    await render([hosted]);

    expect(container.textContent).toContain('From Team');
    expect(container.textContent).toContain('Agents (2)');
    expect(container.textContent).toContain('New: Codex');
    expect(container.textContent).toContain('Already here: Claude Code');
    expect(container.textContent).toContain('Cannot be used here: gone');
    expect(button('Import (2)')).toBeTruthy();
  });

  it('imports the categories that stay switched on', async () => {
    await render([hosted]);

    await click(container.querySelector('[aria-label="Projects (2)"]'));
    await click(button('Import (1)'));

    expect(requests).toEqual([{ sourceWorkspaceId: 'hosted', categories: ['agentConfigs'] }]);
    expect(toasts.success).toEqual(['Imported: 2']);
    expect(toasts.info).toHaveLength(1);
  });

  it('reports a failed import and offers nothing when nothing is new', async () => {
    outcome = { ok: false, message: 'agent service stopped' };
    await render([hosted]);
    await click(button('Import (2)'));
    expect(toasts.error).toEqual(['Import failed: agent service stopped']);

    await render([
      { ...hosted, items: items.map((item) => ({ ...item, action: 'unchanged' as const })) },
    ]);
    expect(button('Up to date')?.disabled).toBe(true);
  });

  it('says so when this machine has no hosted installation', async () => {
    await render([]);
    expect(container.textContent).toContain('No hosted Lody was found on this machine.');
  });
});
