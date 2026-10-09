// @vitest-environment jsdom

import React, { act, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, Provider } from 'jotai';
import { LOCAL_PLATFORM_CAPABILITIES, type PlatformProvider } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import type { LanGitHubState, SessionHistoryParsed, SessionId } from '@lody/shared';

import lodyLogo from '../src/assets/lody-icon.png';
import { MessageRowView } from '../src/components/ai-gui/view';
import { LoadingPlaceholder } from '../src/components/loading-placeholder';
import { LoroSidebar, type LoroSidebarProps } from '../src/components/loro-sidebar';
import { MobileHomeScreen } from '../src/components/mobile/mobile-home-screen';
import {
  gitHubAvatarUrl,
  resolveGitHubIdentityLogin,
  useGitHubAvatarUrl,
  useGitHubAvatarUser,
  useLoadedImageSrc,
  writeGitHubIdentityLogin,
} from '../src/hooks/use-github-avatar';
import { ForceDesktopLayoutProvider } from '../src/hooks/use-mobile';
import { initI18n } from '../src/i18n';
import { resolveWorkspaceIdentityLogo } from '../src/lib/workspace-identity';
import { TEST_CLOUD_PLATFORM } from './test-platform';

const sidebarProps: LoroSidebarProps = {
  workspaceName: 'Lody',
  userEmail: 'local@lody.invalid',
  workspaces: [{ id: 'local-workspace', name: 'Lody', logo: lodyLogo }],
  currentWorkspaceId: 'local-workspace',
  repoSections: [],
  chats: [],
};

describe('workspace identity capability boundary', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    if (root) {
      flushSync(() => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function render(node: ReactNode) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root?.render(node));
  }

  it('uses the Lody brand logo only for the implicit local workspace', () => {
    expect(resolveWorkspaceIdentityLogo('https://example.com/org.png', false)).toBe(lodyLogo);
    expect(resolveWorkspaceIdentityLogo('https://example.com/org.png', true)).toBe(
      'https://example.com/org.png'
    );
    expect(resolveWorkspaceIdentityLogo(null, true)).toBeNull();
  });

  it('renders the desktop local workspace as a static nameplate', () => {
    render(<LoroSidebar {...sidebarProps} workspaceSwitcherEnabled={false} />);

    const identity = container?.querySelector('[data-workspace-identity]');
    expect(identity?.tagName).toBe('DIV');
    expect(identity?.textContent).toContain('Lody');
    expect(container?.querySelector('[data-workspace-switcher-trigger]')).toBeNull();
  });

  it('opens the settings of the LANs from the nameplate of the only LAN', () => {
    let opened = 0;
    render(
      <LoroSidebar
        {...sidebarProps}
        workspaceName="Home"
        workspaceSwitcherEnabled={false}
        workspaceSwitcherKind="lan"
        onManageLansClicked={() => {
          opened += 1;
        }}
      />
    );

    const nameplate = container?.querySelector<HTMLElement>('[data-workspace-lan-settings]');
    expect(nameplate?.tagName).toBe('BUTTON');
    expect(nameplate?.textContent).toContain('Home');
    expect(container?.querySelector('[data-workspace-switcher-trigger]')).toBeNull();

    flushSync(() => nameplate?.click());
    expect(opened).toBe(1);
  });

  it('keeps the nameplate static where the LANs have no settings', () => {
    render(
      <LoroSidebar {...sidebarProps} workspaceSwitcherEnabled={false} workspaceSwitcherKind="lan" />
    );

    expect(container?.querySelector('[data-workspace-identity]')?.tagName).toBe('DIV');
    expect(container?.querySelector('[data-workspace-lan-settings]')).toBeNull();
  });

  it('keeps the desktop cloud workspace trigger enabled by default', () => {
    render(<LoroSidebar {...sidebarProps} />);

    expect(container?.querySelector('[data-workspace-switcher-trigger]')?.tagName).toBe('BUTTON');
    expect(container?.querySelector('[data-workspace-identity]')).toBeNull();
    expect(container?.querySelectorAll('[data-workspace-switcher-trigger]')).toHaveLength(1);
    expect(container?.querySelector('button button')).toBeNull();
  });

  it('highlights desktop workspace rows, anchors their hint, and selects in the dropdown', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('__LODY_ELECTRON__', true);
    let selectedWorkspace = 'alpha';
    const settle = async (run: () => void = () => {}) => {
      await act(async () => {
        run();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
    };
    try {
      render(
        <LoroSidebar
          {...sidebarProps}
          currentWorkspaceId="alpha"
          workspaces={[
            { id: 'alpha', name: 'Alpha', slug: 'alpha' },
            { id: 'beta', name: 'Beta', slug: 'beta' },
          ]}
          onWorkspaceSelected={(value) => {
            selectedWorkspace = value;
          }}
        />
      );
      const trigger = container!.querySelector<HTMLElement>('[data-workspace-switcher-trigger]')!;
      await settle(() => {
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      });
      const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
      expect(rows).toHaveLength(2);
      const [alpha, beta] = rows;
      await settle(() => {
        alpha.dispatchEvent(
          new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })
        );
        alpha.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      });
      expect(alpha.hasAttribute('data-highlighted')).toBe(true);
      const betaRestClass = beta.className;
      await settle(() => {
        beta.dispatchEvent(
          new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })
        );
        beta.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        beta.dispatchEvent(new MouseEvent('mouseenter'));
        beta.dispatchEvent(
          new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })
        );
        beta.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      });
      expect(beta.hasAttribute('data-highlighted')).toBe(true);
      expect(alpha.hasAttribute('data-highlighted')).toBe(false);
      expect(beta.className).not.toBe(betaRestClass);
      expect(beta.hasAttribute('data-popup-open')).toBe(true);
      expect(document.body.textContent).toContain('click to open in a new window');
      await settle(() => {
        beta.click();
      });
      expect(selectedWorkspace).toBe('beta');
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
    } finally {
      flushSync(() => root?.unmount());
      root = undefined;
      vi.useRealTimers();
    }
  });

  it('restores the sidebar viewport after unmount and keeps workspace positions separate', () => {
    const store = createStore();
    const sidebar = (key: string) => <LoroSidebar {...sidebarProps} scrollStateKey={key} />;
    render(<Provider store={store}>{sidebar('workspace-a')}</Provider>);

    const viewport = () =>
      container?.querySelector<HTMLDivElement>('[data-radix-scroll-area-viewport]');
    expect(viewport()).not.toBeNull();
    viewport()!.scrollTop = 180;
    flushSync(() => root?.render(<Provider store={store}>{null}</Provider>));
    flushSync(() => root?.render(<Provider store={store}>{sidebar('workspace-a')}</Provider>));
    expect(viewport()?.scrollTop).toBe(180);

    flushSync(() => root?.render(<Provider store={store}>{sidebar('workspace-b')}</Provider>));
    expect(viewport()?.scrollTop).toBe(0);
    viewport()!.scrollTop = 55;
    flushSync(() => root?.render(<Provider store={store}>{sidebar('workspace-a')}</Provider>));
    expect(viewport()?.scrollTop).toBe(180);
  });

  it('keeps scoped workspace synchronization visible after the connection is online', () => {
    render(
      <LoroSidebar
        {...sidebarProps}
        connectionUiState="online"
        workspaceSyncing
        labels={{ workspaceSyncing: 'Syncing target workspace…' }}
      />
    );

    const trigger = container?.querySelector('[data-workspace-switcher-trigger]');
    expect(trigger?.getAttribute('aria-busy')).toBe('true');
    expect(trigger?.getAttribute('data-workspace-syncing')).toBe('true');
    const status = container?.querySelector('[data-workspace-status]');
    expect(status?.getAttribute('data-workspace-status')).toBe('syncing');
    expect(status?.textContent).toBe('Syncing target workspace…');
  });

  it('keeps connection failures ahead of workspace synchronization', () => {
    render(
      <LoroSidebar
        {...sidebarProps}
        connectionUiState="offline"
        workspaceSyncing
        labels={{ connectionOffline: 'No connection' }}
      />
    );

    const status = container?.querySelector('[data-workspace-status]');
    expect(status?.getAttribute('data-workspace-status')).toBe('offline');
    expect(status?.textContent).toBe('No connection');
  });

  it('supports a content-scoped loading placeholder without taking over the viewport', () => {
    render(<LoadingPlaceholder variant="content" title="Switching workspace" />);

    const placeholder = container?.querySelector('[data-loading-placeholder-scope]');
    expect(placeholder?.getAttribute('data-loading-placeholder-scope')).toBe('content');
    expect(placeholder?.className).toContain('h-full');
    expect(placeholder?.className).not.toContain('min-h-[100dvh]');
  });

  it('renders the mobile local workspace identity without a dialog trigger', () => {
    render(
      <MobileHomeScreen
        workspace={{ id: 'local-workspace', name: 'Lody', avatarUrl: lodyLogo }}
        machines={[]}
        selectedTab="chat"
        localProjects={[]}
        githubRepositories={[]}
        chats={[]}
      />
    );

    const identity = container?.querySelector('[data-workspace-identity]');
    expect(identity?.tagName).toBe('DIV');
    expect(container?.querySelector('[aria-haspopup="dialog"]')).toBeNull();
  });
});

describe('GitHub identity of the local desktop', () => {
  const HOME = 'lw_home';
  const BROKEN = new Set<string>();
  let asked: unknown[] = [];
  let answer: LanGitHubState | null = null;
  /** Holds this machine's answer back until it settles. */
  let held: Promise<void> | null = null;
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  /** Loads every picture on the next microtask unless its address is in `BROKEN`. */
  class TestImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    complete = false;
    naturalWidth = 0;
    set src(value: string) {
      queueMicrotask(() => (BROKEN.has(value) ? this.onerror : this.onload)?.());
    }
  }

  const LOCAL_PLATFORM: PlatformProvider = {
    ...TEST_CLOUD_PLATFORM,
    kind: 'local',
    capabilities: LOCAL_PLATFORM_CAPABILITIES,
  };
  const message = {
    id: 'message-from-me',
    role: 'user',
    userId: 'local-user',
    timestamp: '2026-10-09T10:30:00.000Z',
    read: true,
    status: 'applied',
    items: [{ type: 'text', text: 'Hello' }],
  } as unknown as SessionHistoryParsed;

  function Nameplate() {
    const logo = useLoadedImageSrc(useGitHubAvatarUrl(HOME));
    return (
      <LoroSidebar
        {...sidebarProps}
        workspaceName="Home"
        workspaces={[{ id: HOME, name: 'Home', logo: lodyLogo }]}
        currentWorkspaceId={HOME}
        identityLogo={logo}
        workspaceSwitcherEnabled={false}
      />
    );
  }

  function Sender() {
    const user = useGitHubAvatarUser(HOME);
    return (
      <ForceDesktopLayoutProvider>
        <MessageRowView
          message={message}
          sessionId={'session-github-sender' as SessionId}
          user={user}
          showSenderIdentity={false}
        />
      </ForceDesktopLayoutProvider>
    );
  }

  async function render(platform: PlatformProvider) {
    const store = createStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <PlatformContext.Provider value={platform}>
          <Provider store={store}>
            <Nameplate />
            <Sender />
          </Provider>
        </PlatformContext.Provider>
      );
    });
    await settle();
    return store;
  }

  // The answer, then each picture's load, each settle on a microtask.
  const settle = () =>
    act(async () => {
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    });

  const nameplateImage = () =>
    container?.querySelector<HTMLImageElement>('[data-workspace-identity] img')?.src ?? null;
  const senderImage = () =>
    container?.querySelector<HTMLImageElement>('img[alt="User"]')?.src ?? null;

  beforeEach(async () => {
    await initI18n('en');
    asked = [];
    answer = null;
    held = null;
    BROKEN.clear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    });
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    vi.stubGlobal('Image', TestImage);
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    vi.stubGlobal('__LODY_ELECTRON__', true);
    vi.stubGlobal('ipc', {
      invoke: async (channel: string, request: { type: string }) => {
        asked.push({ channel, ...request });
        if (held) await held;
        return answer
          ? { ok: true, type: request.type, result: answer }
          : { ok: false, type: request.type, error: 'execution_failed', message: 'down' };
      },
      on: () => () => {},
      send: () => {},
    });
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    vi.unstubAllGlobals();
  });

  it('prefers the token the hub keeps, then this machine’s gh login', () => {
    const own = { login: 'own-login' };
    expect(resolveGitHubIdentityLogin({ own, lan: { login: 'hub-login' } })).toBe('hub-login');
    expect(resolveGitHubIdentityLogin({ own, lan: null })).toBe('own-login');
    expect(resolveGitHubIdentityLogin({ own, lan: { login: null } })).toBe('own-login');
    expect(resolveGitHubIdentityLogin({ own: null, lan: null })).toBeNull();
    expect(gitHubAvatarUrl('hub-login')).toBe('https://avatars.githubusercontent.com/hub-login');
  });

  it('draws the GitHub face on the nameplate and the user message', async () => {
    answer = { own: { login: 'own-login' }, lan: { login: 'hub-login' } };
    await render(LOCAL_PLATFORM);

    expect(asked).toEqual([
      { channel: 'localProjects.control', type: 'lan/github', machineId: '', workspaceId: HOME },
    ]);
    expect(nameplateImage()).toBe(gitHubAvatarUrl('hub-login'));
    expect(senderImage()).toBe(gitHubAvatarUrl('hub-login'));
    // A face only: no name beside it and no profile to open.
    expect(
      container?.querySelector('[data-testid="user-message-metadata"]')?.textContent
    ).not.toContain('hub-login');
    expect(container?.querySelector('button[aria-label^="View profile"]')).toBeNull();
  });

  it('keeps what Settings wrote over an answer asked before it', async () => {
    answer = { own: null, lan: { login: 'old-login' } };
    let release = () => {};
    held = new Promise((resolve) => {
      release = resolve;
    });
    const store = await render(LOCAL_PLATFORM);

    await act(async () => writeGitHubIdentityLogin(store, HOME, 'new-login'));
    await settle();
    expect(senderImage()).toBe(gitHubAvatarUrl('new-login'));

    release();
    await settle();
    expect(senderImage()).toBe(gitHubAvatarUrl('new-login'));
    expect(nameplateImage()).toBe(gitHubAvatarUrl('new-login'));
  });

  it('keeps the Lody logo while the GitHub face fails to load', async () => {
    answer = { own: { login: 'own-login' }, lan: null };
    BROKEN.add(gitHubAvatarUrl('own-login'));
    await render(LOCAL_PLATFORM);

    expect(nameplateImage()).toContain('lody-icon');
    expect(senderImage()).toBeNull();
  });

  it('keeps the logo and the person icon without a GitHub identity', async () => {
    answer = { own: null, lan: null };
    await render(LOCAL_PLATFORM);

    expect(nameplateImage()).toContain('lody-icon');
    expect(senderImage()).toBeNull();
  });

  it('asks nothing on a platform whose GitHub goes through the hosted service', async () => {
    answer = { own: { login: 'own-login' }, lan: null };
    await render(TEST_CLOUD_PLATFORM);

    expect(asked).toEqual([]);
    expect(nameplateImage()).toContain('lody-icon');
    expect(senderImage()).toBeNull();
  });
});
