// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionInfoBar } from '../src/components/sessions/session-info-bar';
import {
  BtwInfoBarClearButton,
  BtwInfoBarToggle,
} from '../src/components/sessions/btw/btw-info-bar-toggle';
import { DocumentSelectionSurface } from '../src/components/sessions/document-selection-surface';
import type { DocumentSelection } from '../src/lib/document-selection';
import { createTestI18n, withTestI18n } from './test-i18n';

const testI18n = createTestI18n();

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CONTEXT_LESS_PROPS = {
  status: null,
  projectName: null,
  branch: null,
  workspaceLocation: null,
  pr: null,
  diffStat: null,
} as const;

describe('SessionInfoBar /btw toggle & DocumentSelectionSurface /btw action', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps chat-only SessionInfoBar visible when btwToggle is provided and renders it right after relations', () => {
    const onToggle = vi.fn();
    act(() => {
      root.render(
        withTestI18n(
          <SessionInfoBar
            {...CONTEXT_LESS_PROPS}
            relations={
              <button type="button" data-relations-stub="">
                9
              </button>
            }
            btwToggle={
              <BtwInfoBarToggle
                isOpen={false}
                isBtwStreaming={false}
                hasBtwUnread={false}
                btwTurnCount={0}
                mainStatus={{ kind: 'idle', tooltip: '返回主对话' }}
                onToggle={onToggle}
              />
            }
          />,
          testI18n
        )
      );
    });

    const surface = container.querySelector('[data-info-bar-surface]');
    expect(surface).not.toBeNull();
    const relationsBtn = surface!.querySelector('[data-relations-stub]');
    const btwBtn = surface!.querySelector<HTMLButtonElement>('[data-btw-toggle]');
    expect(relationsBtn).not.toBeNull();
    expect(btwBtn).not.toBeNull();
    expect(relationsBtn!.nextElementSibling).toBe(btwBtn);
    expect(btwBtn!.getAttribute('data-btw-status')).toBe('btw-idle');

    act(() => btwBtn!.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('renders chat-only SessionInfoBar without relations and shows quiet clear button when /btw is expanded', () => {
    const onClear = vi.fn();
    act(() => {
      root.render(
        withTestI18n(
          <SessionInfoBar
            {...CONTEXT_LESS_PROPS}
            surfaceTone="btw"
            btwToggle={
              <BtwInfoBarToggle
                isOpen
                isBtwStreaming={false}
                hasBtwUnread={false}
                btwTurnCount={2}
                mainStatus={{ kind: 'waiting', tooltip: '返回主对话 · 等待审批' }}
                onToggle={vi.fn()}
              />
            }
            btwClearAction={<BtwInfoBarClearButton onClear={onClear} />}
          />,
          testI18n
        )
      );
    });

    const surface = container.querySelector('[data-info-bar-surface]');
    expect(surface).not.toBeNull();
    const toggle = surface!.querySelector<HTMLButtonElement>('[data-btw-toggle]')!;
    expect(toggle.getAttribute('data-btw-status')).toBe('main-waiting');
    expect(toggle.getAttribute('aria-label')).toBe('返回主对话 · 等待审批');
    expect(toggle.className).toContain('text-status-warning');

    const clearBtn = surface!.querySelector<HTMLButtonElement>('[data-btw-clear]')!;
    expect(clearBtn).not.toBeNull();
    act(() => clearBtn.click());
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('renders /btw beside Comment in DocumentSelectionSurface prompt and hands off selection', async () => {
    const rect = new DOMRect(10, 10, 120, 16);
    Object.defineProperties(Range.prototype, {
      getBoundingClientRect: { configurable: true, value: () => rect },
      getClientRects: { configurable: true, value: () => [rect] },
    });
    const asked: DocumentSelection[] = [];
    try {
      await act(async () =>
        root.render(
          withTestI18n(
            <DocumentSelectionSurface
              path="files/btw-drawer/design.md"
              source="rev-1"
              active
              onAdd={() => true}
              onAskBtw={(selection) => asked.push(selection)}
              textSelectionPrompt
            >
              <p>Loro Streams RPC supports real-time onProgress frames.</p>
            </DocumentSelectionSurface>,
            testI18n
          )
        )
      );
      const paragraph = container.querySelector('p')!;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      await act(async () => paragraph.dispatchEvent(new Event('pointerup', { bubbles: true })));

      const buttons = Array.from(container.querySelectorAll('button'));
      const commentBtn = buttons.find((btn) => btn.textContent?.includes('Comment'));
      const btwBtn = buttons.find((btn) => btn.textContent?.trim() === '/btw');
      expect(commentBtn).toBeDefined();
      expect(btwBtn).toBeDefined();

      await act(async () => btwBtn!.click());
      expect(asked).toHaveLength(1);
      expect(asked[0]?.path).toBe('files/btw-drawer/design.md');
      expect(asked[0]?.text).toBe('Loro Streams RPC supports real-time onProgress frames.');
      expect(container.querySelector('[aria-label="Selection annotation"]')).toBeNull();
    } finally {
      delete (Range.prototype as Partial<Range>).getBoundingClientRect;
      delete (Range.prototype as Partial<Range>).getClientRects;
    }
  });
});
