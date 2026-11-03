import { beforeEach } from 'vitest';
// @vitest-environment jsdom

// @vitest-environment jsdom
import React, { act, forwardRef, useImperativeHandle, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sidebarPanelMock = vi.hoisted(() => ({
  collapse: vi.fn(),
  getSize: vi.fn(() => 25),
  resize: vi.fn(),
}));

vi.mock('../src/ui/resizable', () => ({
  ResizablePanelGroup: ({
    children,
    autoSaveId,
  }: {
    children: React.ReactNode;
    autoSaveId?: string;
  }) => <div data-auto-save-id={autoSaveId ?? 'none'}>{children}</div>,
  ResizablePanel: forwardRef<
    unknown,
    { children: React.ReactNode; id?: string; style?: React.CSSProperties }
  >(function MockResizablePanel({ children, id, style }, ref) {
    useImperativeHandle(ref, () =>
      id === 'sidebar'
        ? {
            collapse: sidebarPanelMock.collapse,
            getSize: sidebarPanelMock.getSize,
            resize: sidebarPanelMock.resize,
          }
        : {}
    );
    return (
      <div data-panel-id={id} style={style}>
        {children}
      </div>
    );
  }),
  ResizableHandle: ({ disabled }: { disabled?: boolean }) => (
    <div data-disabled={String(Boolean(disabled))} />
  ),
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({
      animate: _animate,
      initial: _initial,
      transition: _transition,
      ...props
    }: HTMLAttributes<HTMLDivElement> & {
      animate?: unknown;
      initial?: unknown;
      transition?: unknown;
    }) => <div {...props} />,
  },
  useReducedMotion: () => false,
}));

import {
  DesktopSessionDetailLayout,
  type DesktopSessionDetailLayoutProps,
} from '../src/components/sessions/desktop-session-detail-layout';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('DesktopSessionDetailLayout', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  const renderLayout = (overrides: Partial<DesktopSessionDetailLayoutProps>) => {
    if (!container) {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }
    act(() => {
      root?.render(
        <DesktopSessionDetailLayout
          defaultSizes={{ main: 70, sidebar: 30 }}
          topBar={null}
          chatSurfaces={null}
          terminalDock={null}
          secondaryPanel={null}
          sidebarOpen
          onSidebarCollapse={() => {}}
          deleteConfirmDialog={null}
          {...overrides}
        />
      );
    });
    if (!container) throw new Error('Expected a mounted container');
    return container;
  };

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it('keeps the terminal dock inside the chat panel and outside the sidebar panel', () => {
    const mounted = renderLayout({
      topBar: <div data-testid="top-bar" />,
      chatSurfaces: <div data-testid="chat-surfaces" />,
      terminalDock: <div data-testid="terminal-dock" />,
      secondaryPanel: <div data-testid="secondary-panel" />,
    });

    const terminalDock = mounted.querySelector('[data-testid="terminal-dock"]');
    const chatPanel = mounted.querySelector('[data-panel-id="chat"]');
    const sidebarPanel = mounted.querySelector('[data-panel-id="sidebar"]');

    expect(terminalDock).not.toBeNull();
    expect(chatPanel?.contains(terminalDock)).toBe(true);
    expect(sidebarPanel?.contains(terminalDock)).toBe(false);
  });

  it('keeps the secondary panel mounted while the sidebar is collapsed', () => {
    const secondaryPanel = <div data-testid="secondary-panel" />;
    const mounted = renderLayout({ secondaryPanel, sidebarOpen: true });
    const openPanel = mounted.querySelector('[data-testid="secondary-panel"]');
    expect(openPanel).not.toBeNull();

    renderLayout({ secondaryPanel, sidebarOpen: false });
    const collapsedPanel = mounted.querySelector('[data-testid="secondary-panel"]');

    // A remount would have produced a different DOM node.
    expect(collapsedPanel).toBe(openPanel);
    expect(collapsedPanel?.closest('[aria-hidden="true"]')).not.toBeNull();
  });
});

describe('DesktopSessionDetailLayout sidebarMinWidthRequest', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let rectSpy: ReturnType<typeof vi.spyOn> | undefined;

  const GROUP_WIDTH = 1200;
  // 500px of a 1200px group.
  const REQUEST_PERCENT = (500 / GROUP_WIDTH) * 100;

  const renderLayout = (overrides: Partial<DesktopSessionDetailLayoutProps>) => {
    if (!container) {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }
    act(() => {
      root?.render(
        <DesktopSessionDetailLayout
          defaultSizes={{ main: 70, sidebar: 30 }}
          topBar={null}
          chatSurfaces={null}
          terminalDock={null}
          secondaryPanel={null}
          sidebarOpen
          onSidebarCollapse={() => {}}
          deleteConfirmDialog={null}
          {...overrides}
        />
      );
    });
  };

  const stubGroupWidth = (width: number) => {
    rectSpy?.mockRestore();
    rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width } as DOMRect);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sidebarPanelMock.getSize.mockReturnValue(25);
    stubGroupWidth(GROUP_WIDTH);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    container?.remove();
    root = undefined;
    container = undefined;
    rectSpy?.mockRestore();
    rectSpy = undefined;
  });

  it("opens a Board half and half, never at a chat layout's width, and remembers no split", () => {
    // A chat's side panel was dragged to 38% and closed.
    sidebarPanelMock.getSize.mockReturnValue(38.2);
    renderLayout({ layoutStorageId: 'session-detail-panels', sidebarOpen: true });
    renderLayout({ layoutStorageId: 'session-detail-panels', sidebarOpen: false });

    // The same page becomes a Board page, whose panel opens on arrival.
    const board = { layoutStorageId: null, defaultSizes: { main: 50, sidebar: 50 } };
    renderLayout({ ...board, sidebarOpen: false });
    renderLayout({ ...board, sidebarOpen: true });

    expect(sidebarPanelMock.resize).toHaveBeenLastCalledWith(50);
    expect(container?.querySelector('[data-auto-save-id]')?.getAttribute('data-auto-save-id')).toBe(
      'none'
    );
  });

  it('puts the next Board back at half and half though Boards share one layout', () => {
    const board = (resetKey: string) => ({
      layoutStorageId: null,
      layoutResetKey: resetKey,
      defaultSizes: { main: 50, sidebar: 50 },
      sidebarOpen: true,
    });
    renderLayout(board('bd_a:1'));
    expect(sidebarPanelMock.resize).not.toHaveBeenCalled();
    // Board A dragged to 60/40, then Board B opens on the same mounted page.
    sidebarPanelMock.getSize.mockReturnValue(40);
    renderLayout(board('bd_b:2'));
    expect(sidebarPanelMock.resize).toHaveBeenLastCalledWith(50);
    // Entering B again resets it as well.
    sidebarPanelMock.resize.mockClear();
    renderLayout(board('bd_b:3'));
    expect(sidebarPanelMock.resize).toHaveBeenLastCalledWith(50);
  });

  it("reopens a chat's panel at its own width after a Board used the panel", () => {
    const chat = { layoutStorageId: 'session-detail-panels' };
    const board = {
      layoutStorageId: null,
      layoutResetKey: 'bd_a:1',
      defaultSizes: { main: 50, sidebar: 50 },
    };
    sidebarPanelMock.getSize.mockReturnValue(38);
    renderLayout({ ...chat, sidebarOpen: true });
    renderLayout({ ...chat, sidebarOpen: false });
    renderLayout({ ...board, sidebarOpen: false });
    renderLayout({ ...board, sidebarOpen: true });
    expect(sidebarPanelMock.resize).toHaveBeenLastCalledWith(50);
    sidebarPanelMock.getSize.mockReturnValue(50);
    renderLayout({ ...board, sidebarOpen: false });
    renderLayout({ ...chat, sidebarOpen: false });
    renderLayout({ ...chat, sidebarOpen: true });
    expect(sidebarPanelMock.resize).toHaveBeenLastCalledWith(38);
  });
});
