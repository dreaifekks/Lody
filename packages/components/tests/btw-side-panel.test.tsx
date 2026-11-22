// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';

vi.mock('../src/components/mentions/mention-session-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSessionMentionItems: () => [],
}));

vi.mock('../src/components/mentions/mention-agent-role-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgentRoleMentionItems: () => [],
}));

import {
  BTW_SIDE_PANEL_DEFAULT_WIDTH_PX,
  BTW_SIDE_PANEL_MIN_CONTAINER_WIDTH_PX,
  BTW_SIDE_PANEL_MIN_WIDTH_PX,
  BtwSidePanel,
  btwDraftAtomFamily,
  btwSidePanelWidthPxAtom,
  clampBtwSidePanelWidth,
  resolveBtwPresentationMode,
  useBtwContainerWidth,
  type BtwPresentationMode,
} from '../src/components/sessions/btw';
import { createTestI18n, withTestI18n } from './test-i18n';

const testI18n = createTestI18n();

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION_ID = 'session-btw-side-panel-1' as SessionId;

describe('btw-layout & BtwSidePanel', () => {
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

  it('resolves side-panel only on wide standalone desktop surfaces and falls back to overlay otherwise', () => {
    expect(
      resolveBtwPresentationMode({
        allowSidePanel: true,
        isMobile: false,
        containerWidth: BTW_SIDE_PANEL_MIN_CONTAINER_WIDTH_PX,
      })
    ).toBe('side-panel');
    expect(
      resolveBtwPresentationMode({
        allowSidePanel: true,
        isMobile: false,
        containerWidth: 1280,
      })
    ).toBe('side-panel');

    // Narrow container falls back to overlay
    expect(
      resolveBtwPresentationMode({
        allowSidePanel: true,
        isMobile: false,
        containerWidth: BTW_SIDE_PANEL_MIN_CONTAINER_WIDTH_PX - 1,
      })
    ).toBe('overlay');
    expect(
      resolveBtwPresentationMode({
        allowSidePanel: true,
        isMobile: false,
        containerWidth: null,
      })
    ).toBe('overlay');

    // Existing right sidebar / Board thread / Side Chat / Article or Review split -> overlay
    expect(
      resolveBtwPresentationMode({
        allowSidePanel: false,
        isMobile: false,
        containerWidth: 1600,
      })
    ).toBe('overlay');

    // Mobile -> overlay
    expect(
      resolveBtwPresentationMode({
        allowSidePanel: true,
        isMobile: true,
        containerWidth: 1200,
      })
    ).toBe('overlay');
  });

  it('clamps side-panel width within min width, main-column floor, and 50% ratio', () => {
    expect(clampBtwSidePanelWidth(200, 1200)).toBe(BTW_SIDE_PANEL_MIN_WIDTH_PX);
    expect(clampBtwSidePanelWidth(420, 1200)).toBe(420);
    // At 1000px container: maxByMain = 540, maxByRatio = 500 -> capped at 500
    expect(clampBtwSidePanelWidth(700, 1000)).toBe(500);
    // At 900px container: maxByMain = 440, maxByRatio = 450 -> capped at 440
    expect(clampBtwSidePanelWidth(600, 900)).toBe(440);
  });

  it('switches smoothly between side-panel and overlay on container resize and sidebar toggles', () => {
    let observedCallback: ResizeObserverCallback | null = null;
    const originalResizeObserver = globalThis.ResizeObserver;
    let measuredWidth = 1160;

    class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        observedCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    let latestMode: BtwPresentationMode = 'overlay';

    function Harness({ allowSidePanel }: { readonly allowSidePanel: boolean }) {
      const [el, setEl] = useState<HTMLDivElement | null>(null);
      const width = useBtwContainerWidth(el, allowSidePanel);
      latestMode = resolveBtwPresentationMode({
        allowSidePanel,
        isMobile: false,
        containerWidth: width,
      });
      return (
        <div
          ref={(node) => {
            if (node) {
              node.getBoundingClientRect = () => new DOMRect(0, 0, measuredWidth, 700);
            }
            setEl(node);
          }}
        />
      );
    }

    try {
      // Wide standalone desktop -> side-panel
      act(() => {
        root.render(<Harness allowSidePanel />);
      });
      expect(latestMode).toBe('side-panel');

      // Right sidebar opens -> immediate overlay fallback
      act(() => {
        root.render(<Harness allowSidePanel={false} />);
      });
      expect(latestMode).toBe('overlay');

      // Right sidebar closes while still wide -> restores side-panel
      act(() => {
        root.render(<Harness allowSidePanel />);
      });
      expect(latestMode).toBe('side-panel');

      // Drag window narrow below 900px -> degrades to overlay
      measuredWidth = 820;
      act(() => {
        observedCallback?.(
          [{ contentRect: { width: 820 } } as ResizeObserverEntry],
          {} as ResizeObserver
        );
      });
      expect(latestMode).toBe('overlay');

      // Widen window back above 900px -> restores side-panel
      measuredWidth = 1080;
      act(() => {
        observedCallback?.(
          [{ contentRect: { width: 1080 } } as ResizeObserverEntry],
          {} as ResizeObserver
        );
      });
      expect(latestMode).toBe('side-panel');
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('renders BtwSidePanel with header controls, real ChatComposer, shared draft, send/cancel/clear/close, and keyboard resize', () => {
    const store = createStore();
    store.set(btwDraftAtomFamily(SESSION_ID), 'initial shared draft');

    const onSend = vi.fn();
    const onCancel = vi.fn();
    const onClear = vi.fn();
    const onClose = vi.fn();
    const onToggleReadOnly = vi.fn();
    const onClearSelection = vi.fn();

    const renderPanel = (overrides?: {
      readonly isStreaming?: boolean;
      readonly canClear?: boolean;
    }) =>
      act(() => {
        root.render(
          <Provider store={store}>
            {withTestI18n(
              <BtwSidePanel
                sessionId={SESSION_ID}
                containerWidth={1200}
                isDark={false}
                isVisible
                turns={[
                  { id: 'u1', role: 'user', text: 'First question' },
                  { id: 'a1', role: 'assistant', text: 'First answer' },
                ]}
                streamingText=""
                isStreaming={overrides?.isStreaming ?? false}
                readOnlyTools={false}
                error={null}
                modelLabel="Hydrogen · Low"
                articleFileName="design.md"
                pendingSelection={{ path: 'docs/design.md', text: 'quoted snippet' }}
                canClear={overrides?.canClear ?? true}
                onToggleReadOnlyTools={onToggleReadOnly}
                onClearPendingSelection={onClearSelection}
                onSend={onSend}
                onCancel={onCancel}
                onClear={onClear}
                onClose={onClose}
              />,
              testI18n
            )}
          </Provider>
        );
      });

    renderPanel();

    const panel = container.querySelector<HTMLElement>('[data-btw-side-panel]');
    expect(panel).not.toBeNull();
    expect(panel!.style.width).toBe(`${BTW_SIDE_PANEL_DEFAULT_WIDTH_PX}px`);

    // Stream renders in side-panel variant (non-overlay flow)
    const stream = panel!.querySelector('[data-btw-stream-view]');
    expect(stream?.getAttribute('data-btw-stream-variant')).toBe('side-panel');

    // Model pill, article pill, and pending selection chip render inside composer
    expect(panel!.querySelector('[data-btw-model-pill]')?.textContent).toBe('Hydrogen · Low');
    expect(panel!.querySelector('[data-btw-article-pill]')?.textContent).toBe('design.md');
    expect(panel!.querySelector('[data-btw-pending-selection]')?.textContent).toContain(
      'design.md 选区'
    );

    // Preserved shared draft from btwDraftAtomFamily is rendered and submitted cleanly
    const sendBtn = panel!.querySelector<HTMLButtonElement>('[data-btw-send]');
    expect(sendBtn).not.toBeNull();
    expect(sendBtn!.getAttribute('aria-label')).toBe('Send');
    expect(sendBtn!.disabled).toBe(false);
    // Secondary /btw composer must not show a duplicate focus-hint badge
    expect(panel!.querySelector('[title*="to focus"]')).toBeNull();

    act(() => sendBtn!.click());
    expect(onSend).toHaveBeenCalledWith('initial shared draft');
    expect(store.get(btwDraftAtomFamily(SESSION_ID))).toBe('');

    // Sending via Enter strips optional `/btw ` prefix; Shift+Enter does not submit
    act(() => {
      store.set(btwDraftAtomFamily(SESSION_ID), '/btw follow up');
    });
    const composerInput = panel!.querySelector<HTMLElement>('[data-lody-composer-input]');
    expect(composerInput).not.toBeNull();
    act(() => {
      composerInput!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })
      );
    });
    expect(onSend).toHaveBeenCalledTimes(1);

    act(() => {
      composerInput!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
    });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenLastCalledWith('follow up');
    expect(store.get(btwDraftAtomFamily(SESSION_ID))).toBe('');

    // Header clear & close buttons work
    const clearBtn = panel!.querySelector<HTMLButtonElement>('[data-btw-clear]');
    const closeBtn = panel!.querySelector<HTMLButtonElement>('[data-btw-close]');
    expect(clearBtn).not.toBeNull();
    expect(closeBtn).not.toBeNull();
    act(() => clearBtn!.click());
    expect(onClear).toHaveBeenCalledTimes(1);
    act(() => closeBtn!.click());
    expect(onClose).toHaveBeenCalledTimes(1);

    // Keyboard resize widens/narrows and double-click resets width
    const handle = panel!.querySelector<HTMLElement>('[data-btw-resize-handle]')!;
    act(() => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(store.get(btwSidePanelWidthPxAtom)).toBe(BTW_SIDE_PANEL_DEFAULT_WIDTH_PX + 24);
    act(() => {
      handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(store.get(btwSidePanelWidthPxAtom)).toBe(BTW_SIDE_PANEL_DEFAULT_WIDTH_PX);

    // Streaming switches primary action to cancel button; canClear=false with empty draft hides clear button
    renderPanel({ isStreaming: true, canClear: false });
    expect(container.querySelector('[data-btw-clear]')).toBeNull();
    const cancelBtn = container.querySelector<HTMLButtonElement>('button[aria-label="停止 /btw"]');
    expect(cancelBtn).not.toBeNull();
    act(() => cancelBtn!.click());
    expect(onCancel).toHaveBeenCalledTimes(1);

    // Non-empty unsent draft reveals clear button even when canClear is false
    act(() => {
      store.set(btwDraftAtomFamily(SESSION_ID), 'unsent side draft');
    });
    expect(container.querySelector('[data-btw-clear]')).not.toBeNull();
    act(() => {
      store.set(btwDraftAtomFamily(SESSION_ID), '   ');
    });
    expect(container.querySelector('[data-btw-clear]')).toBeNull();
  });
});
