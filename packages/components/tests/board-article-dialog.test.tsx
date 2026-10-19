// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardArticleDialog } from '../src/components/boards/board-article-dialog';
import {
  createRelocatableHost,
  RelocatableSlot,
  type RelocatableHost,
} from '../src/components/boards/relocatable-host';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounts = 0;

/** Stands in for the thread's conversation: a composer whose draft lives in the DOM. */
function Conversation() {
  useEffect(() => {
    mounts += 1;
  }, []);
  return createElement('textarea', { 'aria-label': 'composer' });
}

function Page({
  host,
  open,
  onClose,
}: {
  host: RelocatableHost;
  open: boolean;
  onClose: () => void;
}) {
  const [, setPanel] = useState<HTMLElement | null>(null);
  return createElement(
    'div',
    null,
    createElement(
      'aside',
      { 'data-testid': 'board-panel' },
      createElement(RelocatableSlot, { host })
    ),
    createPortal(createElement(Conversation), host.node),
    open
      ? createElement(BoardArticleDialog, {
          title: 'report.md',
          article: createElement('article', null, 'Report'),
          threadHost: host,
          onPanelChange: setPanel,
          onClose,
        })
      : null
  );
}

describe('BoardArticleDialog', () => {
  let root: Root;
  let container: HTMLDivElement;
  let host: RelocatableHost;
  let open: boolean;
  const onClose = vi.fn(() => {
    open = false;
  });
  const render = () =>
    act(async () => {
      root.render(createElement(Page, { host, open, onClose }));
    });

  beforeEach(() => {
    mounts = 0;
    open = false;
    onClose.mockClear();
    host = createRelocatableHost();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('borrows the one conversation while open and gives it back, draft and all', async () => {
    await render();
    const composer = document.querySelector<HTMLTextAreaElement>('textarea')!;
    composer.value = '这里数据过时了';
    expect(document.querySelector('[data-testid="board-panel"]')?.contains(composer)).toBe(true);

    open = true;
    await render();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.contains(composer)).toBe(true);
    expect(dialog?.textContent).toContain('Report');
    expect(document.querySelectorAll('textarea')).toHaveLength(1);

    // The backdrop closes it, as Escape and the conversation's own close do.
    await act(async () => {
      document.querySelector<HTMLElement>('[data-article-dismiss]')!.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="board-panel"]')?.contains(composer)).toBe(true);

    open = true;
    await render();
    expect(document.querySelector('[role="dialog"]')?.contains(composer)).toBe(true);
    expect(composer.value).toBe('这里数据过时了');
    expect(mounts).toBe(1);
  });

  it('closes on Escape', async () => {
    open = true;
    await render();
    await act(async () => {
      document
        .querySelector('[role="dialog"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
