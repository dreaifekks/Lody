// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineMeta } from '@lody/shared';
import { machineMetaCacheAtom } from '../src/atoms/doc-meta';
import { MarkdownRenderer } from '../src/components/ai-gui/markdown-renderer';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('machine file links in agent Markdown', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
  });

  const render = async (text: string) => {
    const store = createStore();
    store.set(machineMetaCacheAtom, {
      'machine-m-mini': { id: 'm-mini', name: 'Mac-mini.local', lanAlias: 'mini' } as MachineMeta,
    });
    const onAgentFileLinkClick = vi.fn();
    await act(async () => {
      root?.render(
        createElement(
          Provider,
          { store },
          createElement(MarkdownRenderer, { text, onAgentFileLinkClick })
        )
      );
    });
    const links = [...(container?.querySelectorAll('button[title]') ?? [])];
    return { links, onAgentFileLinkClick };
  };

  it('opens a path on a known machine, and leaves an unknown prefix as it was', async () => {
    const { links, onAgentFileLinkClick } = await render(
      '见 mini:~/out/report.md 和 nobody:/tmp/agent.log。'
    );

    expect(links.map((link) => link.getAttribute('title'))).toEqual([
      'mini:~/out/report.md',
      '/tmp/agent.log',
    ]);
    expect(container?.textContent).toContain('nobody:/tmp/agent.log');
    await act(async () => {
      links[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(onAgentFileLinkClick).toHaveBeenCalledWith('mini:~/out/report.md');
  });

  it('opens a Markdown link whose target names the machine', async () => {
    const { links } = await render('[报告](mini:~/out/report.md)');

    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('title')).toBe('mini:~/out/report.md');
    expect(links[0]?.textContent).toContain('报告');
  });
});
