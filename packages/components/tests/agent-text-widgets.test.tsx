// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getDefaultStore, type PrimitiveAtom } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string, params?: Record<string, string>) =>
      (fallback ?? _key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => params?.[name] ?? ''),
  }),
}));

type Preview = Record<string, unknown>;
const requests: Array<{ machineId: string; path: string; ownerSessionId: unknown }> = [];
let nextPreview: Preview = {};

const atoms = vi.hoisted(() => ({ enabled: null as unknown }));
vi.mock('../src/atoms/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/atoms/settings')>();
  const { atom } = await import('jotai');
  const enabled = atom(false);
  atoms.enabled = enabled;
  return { ...actual, inlineWidgetFeatureEnabledAtom: enabled };
});
vi.mock('../src/atoms/runtime', async () => {
  const { atom } = await import('jotai');
  return {
    activeWorkspaceRuntimeAtom: atom({
      requestFilePreview: async (
        machineId: string,
        request: { path: string },
        options: { ownerSessionId?: unknown }
      ) => {
        requests.push({ machineId, path: request.path, ownerSessionId: options.ownerSessionId });
        return nextPreview;
      },
    }),
  };
});
vi.mock('../src/atoms/doc-meta', async () => {
  const { atom } = await import('jotai');
  const meta = atom({ machineId: 'member-2', parentSessionId: 'parent-1' });
  return { sessionMetaAtomFamily: () => meta };
});

const { AgentTextWidgets } = await import('../src/components/agent-surfaces/agent-text-widgets');

const REPLY =
  'Here is the flow.\n\nvisualize{"path":"/work/flow.html","title":"Flow"}\n\nClick a step.';

describe('AgentTextWidgets', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    requests.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    getDefaultStore().set(atoms.enabled as PrimitiveAtom<boolean>, false);
  });

  const render = async (text = REPLY) => {
    await act(async () => {
      root.render(
        React.createElement(AgentTextWidgets, {
          text,
          sessionId: 'child-1' as SessionId,
          renderText: (value: string) => React.createElement('p', null, value),
        })
      );
    });
    // Let the file read settle.
    await act(async () => {});
  };

  const paragraphs = () => [...container.querySelectorAll('p')].map((p) => p.textContent);

  it('shows the reply exactly as written while the experiment is off', async () => {
    await render();
    expect(paragraphs()).toEqual([REPLY]);
    expect(requests).toEqual([]);
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('reads the file from the agent machine and frames it', async () => {
    getDefaultStore().set(atoms.enabled as PrimitiveAtom<boolean>, true);
    nextPreview = {
      status: 'ok',
      v: 3,
      path: 'flow.html',
      kind: 'text',
      content: { encoding: 'utf8-plain', text: '<p>flow</p>' },
      sizeBytes: 11,
    };
    await render();
    expect(paragraphs()).toEqual(['Here is the flow.\n', '\nClick a step.']);
    // The member that ran the agent, scoped to the tab's owning session.
    expect(requests).toEqual([
      { machineId: 'member-2', path: '/work/flow.html', ownerSessionId: 'parent-1' },
    ]);
    expect(container.querySelector('iframe')?.getAttribute('title')).toBe('Flow');
  });

  it('refuses a file outside the session folder', async () => {
    getDefaultStore().set(atoms.enabled as PrimitiveAtom<boolean>, true);
    nextPreview = {
      status: 'ok',
      v: 3,
      path: '/tmp/flow.html',
      external: true,
      kind: 'text',
      content: { encoding: 'utf8-plain', text: '<p>flow</p>' },
      sizeBytes: 11,
    };
    await render();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).toContain('outside this session’s folder');
  });
});
