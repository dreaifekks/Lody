// @vitest-environment jsdom
import { act } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
} from '@tanstack/react-router';
import { createStore, Provider } from 'jotai';
import {
  getSessionRoomId,
  normalizeBoardMeta,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { PlatformContext } from '@lody/platform/react';
import {
  createStaticStore,
  CLOUD_PLATFORM_CAPABILITIES,
  type PlatformProvider,
} from '@lody/platform';
import { SessionDeepLinkRouter } from '../src/routes/__root';
import { Route as SessionRoute } from '../src/routes/$workspaceName/_auth/sessions/$sessionId';
import { useBoardSessionNavigation } from '../src/components/boards/board-session-navigation';
import { currentWorkspaceIdAtom } from '../src/atoms';
import { sessionMetaCacheAtom } from '../src/atoms/doc-meta';
import { writeStoredLastActiveTabState } from '../src/lib/session-draft-tabs';
import { getSessionNavigationLocation } from '../src/lib/session-navigation';
import { pendingSessionLinkAtom } from '../src/lib/session-deep-link';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from '../src/components/ai-gui/markdown-renderer';
import { SessionReadonlyContext } from '../src/components/ai-gui/session-readonly-context';
import { SessionLinkProvider } from '../src/components/ai-gui/session-link-context';
import { SESSION_DEEP_LINK_EVENT } from '../src/lib/session-deep-link';
import { MarkdownFileResources } from '../src/components/ai-gui/markdown-file-image';
import {
  createFakeFileWorkspaceProvider,
  type FileWorkspaceOpenResult,
} from '../src/lib/file-workspace-provider';

// The route host and its real beforeLoad run; unrelated application/editor surfaces stay unmounted.
vi.mock('@/components/AppInitializer', () => ({ default: () => null }));
vi.mock('@/components/sessions/session-detail', () => ({ default: () => null }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('anonymous Markdown resource boundary', () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = (text: string) =>
    act(async () =>
      root.render(
        <SessionReadonlyContext.Provider
          value={{ renderImage: () => null, renderFiles: () => null }}
        >
          <MarkdownRenderer text={text} />
        </SessionReadonlyContext.Provider>
      )
    );

  it('does not load raw remote image URLs or instantiate a workspace image resolver', async () => {
    await render('![Original diagram](https://source.example/signed-image?token=synthetic)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('Original diagram');
  });

  it('makes source attachment links inert while retaining ordinary explicit web navigation', async () => {
    await render(
      '[Attachment](https://api.example/api/workspaces/private/session-files/source/file)\n\n[Article](https://example.org/article)'
    );
    const links = [...container.querySelectorAll('a')];
    expect(links.some((link) => link.href.includes('/session-files/'))).toBe(false);
    expect(container.textContent).toContain('Attachment');
    expect(links.some((link) => link.href === 'https://example.org/article')).toBe(true);
  });

  it('keeps Telegram deep links clickable and still drops script URLs', async () => {
    await render(
      '[Message](tg://privatepost?channel=1001&post=42)\n\n[Script](javascript:alert(1))'
    );
    const links = [...container.querySelectorAll('a')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'tg://privatepost?channel=1001&post=42',
    ]);
    expect(container.textContent).toContain('Script');
  });
});

describe('conversation Markdown images across row remounts', () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  // Virtua unmounts a row outside its overscan and mounts it again on return.
  const remount = async (text: string) => {
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<MarkdownRenderer text={text} />));
  };

  it('reserves a loaded image size on the next mount', async () => {
    const text = '![Screenshot](https://example.org/remount-loaded.png)';
    await act(async () => root.render(<MarkdownRenderer text={text} />));
    const image = container.querySelector('img')!;
    expect(image.hasAttribute('height')).toBe(false);
    Object.defineProperty(image, 'naturalWidth', { value: 1200 });
    Object.defineProperty(image, 'naturalHeight', { value: 800 });
    await act(async () => image.dispatchEvent(new Event('load')));

    await remount(text);
    const again = container.querySelector('img')!;
    expect(again.getAttribute('width')).toBe('1200');
    expect(again.getAttribute('height')).toBe('800');
  });

  it('shows an unreachable image as its alt text, and keeps it so on the next mount', async () => {
    const text = '![Local preview](/tmp/remount-unreachable.png)';
    await act(async () => root.render(<MarkdownRenderer text={text} />));
    await act(async () => container.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[role="img"]')?.textContent).toBe('Local preview');

    await remount(text);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[role="img"]')?.textContent).toBe('Local preview');
  });
});

describe('file Markdown images', () => {
  let root: Root, container: HTMLDivElement;
  const blobs = new Map<string, Blob>();
  let sequence = 0;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL(blob: Blob) {
          const url = `blob:test-${++sequence}`;
          blobs.set(url, blob);
          return url;
        }
        static revokeObjectURL(url: string) {
          blobs.delete(url);
        }
      }
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    expect(blobs.size).toBe(0);
    vi.unstubAllGlobals();
  });
  const provider = () =>
    createFakeFileWorkspaceProvider({
      files: [{ path: 'images/plot.png', kind: 'binary', sourceState: 'live-readonly' }],
      snapshots: {
        'images/plot.png': { kind: 'binary', bytes: new Uint8Array([137, 80, 78, 71]) },
      },
    });
  const render = (
    source: Pick<ReturnType<typeof provider>, 'openFile'>,
    automatic = false,
    documentPath = 'docs/guide.md'
  ) =>
    act(async () =>
      root.render(
        <MarkdownFileResources
          provider={source}
          documentPath={documentPath}
          automatic={automatic}
          active
        >
          <MarkdownRenderer
            text={'# Complete document\n\n![Plot](../images/plot.png)\n\nText after the image.'}
          />
        </MarkdownFileResources>
      )
    );
  const click = () =>
    act(async () => container.querySelector<HTMLButtonElement>('button')!.click());

  it('renders all text first, reads only on click, and releases the resulting blob on close', async () => {
    const source = provider();
    const paths: string[] = [];
    await render({
      openFile: async (path) => {
        paths.push(path);
        return source.openFile(path);
      },
    });
    expect(container.textContent).toContain('Complete document');
    expect(container.textContent).toContain('Text after the image.');
    expect(container.textContent).toContain('Load image');
    expect(container.querySelector('img')).toBeNull();
    expect(paths).toEqual([]);
    await click();
    expect(paths).toEqual(['images/plot.png']);
    const img = container.querySelector('img')!;
    expect(blobs.get(img.src)?.type).toBe('image/png');
    expect(blobs.get(img.src)?.size).toBe(4);
    await act(async () => img.dispatchEvent(new Event('load')));
    expect(container.querySelector('button')).toBeNull();
  });

  it('loads same-machine resources automatically without creating a blob', async () => {
    const source = createFakeFileWorkspaceProvider({
      files: [{ path: 'images/plot.png', kind: 'binary', sourceState: 'live-readonly' }],
      snapshots: { 'images/plot.png': { kind: 'binary', url: 'lody-file://synthetic/image' } },
    });
    await render(source, true);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('lody-file://synthetic/image');
    expect(blobs.size).toBe(0);
  });

  it('shows a failed read and can retry it', async () => {
    const source = provider();
    let available = false;
    await render({
      openFile: (path) =>
        available
          ? source.openFile(path)
          : Promise.resolve({
              status: 'unavailable',
              reason: 'transient-io',
              message: 'Machine offline',
            }),
    });
    await click();
    expect(container.textContent).toContain('Machine offline');
    expect(container.textContent).toContain('Retry');
    available = true;
    await click();
    expect(container.querySelector('img')?.src).toMatch(/^blob:/);
  });

  it('discards a late read after switching documents and waits for another click', async () => {
    let settle!: (result: FileWorkspaceOpenResult) => void;
    const pending = new Promise<FileWorkspaceOpenResult>((resolve) => {
      settle = resolve;
    });
    const source = { openFile: () => pending };
    await render(source);
    await click();
    await render(source, false, 'other/guide.md');
    await act(async () => settle(await provider().openFile('images/plot.png')));
    expect(blobs.size).toBe(0);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('Load image');
  });

  it('does not carry a load request into a different provider', async () => {
    await render(provider());
    await click();
    expect(blobs.size).toBe(1);
    await render({
      openFile: async () => {
        throw new Error('Must not read the new machine');
      },
    });
    expect(blobs.size).toBe(0);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('Load image');
  });

  it('cannot grant filesystem access to an anonymous share', async () => {
    await act(async () =>
      root.render(
        <SessionReadonlyContext.Provider
          value={{ renderImage: () => null, renderFiles: () => null }}
        >
          <MarkdownFileResources
            provider={{
              openFile: async () => {
                throw new Error('Must not read');
              },
            }}
            documentPath="docs/a.md"
            automatic
            active
          >
            <MarkdownRenderer text="![Private image](../images/plot.png)" />
          </MarkdownFileResources>
        </SessionReadonlyContext.Provider>
      )
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe('Private image');
  });
});

describe('Markdown session links', () => {
  let root: Root, container: HTMLDivElement;
  let opened: string[], events: AbortController;
  beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    opened = [];
    events = new AbortController();
    window.addEventListener(
      SESSION_DEEP_LINK_EVENT,
      (event) => opened.push((event as CustomEvent<string>).detail),
      { signal: events.signal }
    );
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    events.abort();
    await act(async () => root.unmount());
    container.remove();
  });
  const legacyText = 'See [@Independent review](session://1ed6ba53-93bc-46d5-91e3-bb693cb0e729).';

  it.each([true, false])(
    'keeps a non-member resource link exact despite a remembered child tab (metadata: %s)',
    async (known) => {
      const store = createStore();
      store.set(currentWorkspaceIdAtom, 'ws' as WorkspaceId);
      store.set(
        sessionMetaCacheAtom,
        known
          ? {
              [getSessionRoomId('outside' as SessionId)]: {
                id: 'outside',
                machineId: 'machine',
                userId: 'user',
                createdAt: '2026-10-18T00:00:00Z',
              } as SessionMeta,
            }
          : {}
      );
      const board = normalizeBoardMeta({
        version: 1,
        id: 'bd_test',
        name: 'Board',
        coordinatorSessionId: 'coordinator',
        createdAtMs: 1,
        createdByUserId: 'user',
      })!;
      writeStoredLastActiveTabState('outside' as SessionId, {
        sessionTabId: 'old-child',
        viewerTab: null,
      });
      const platform: PlatformProvider = {
        kind: 'cloud',
        identity: {
          session: createStaticStore({ status: 'unauthenticated' }),
          signOut: async () => {},
        },
        workspaces: {
          state: createStaticStore({
            status: 'ready',
            activeWorkspaceId: 'ws',
            workspaces: [{ id: 'ws', slug: 'ws', name: 'Workspace', role: 'owner' }],
          }),
          setActive: async () => {},
        },
        capabilities: CLOUD_PLATFORM_CAPABILITIES,
        sync: { mode: 'cloud' },
      };
      function BoardPage() {
        useBoardSessionNavigation({
          board,
          narrow: false,
          openPanel: () => {},
          showInCoordinatorPage: () => {},
          openPage: (target) => {
            const location = getSessionNavigationLocation(target);
            void router.navigate({
              to: '/$workspaceName/sessions/$sessionId',
              params: { workspaceName: 'ws', sessionId: location.sessionId },
              search: { tab: location.tab },
            });
          },
        });
        return (
          <SessionLinkProvider enabled>
            <MarkdownRenderer text="[@Outside](lody://session/outside?workspace=ws)" />
          </SessionLinkProvider>
        );
      }
      const rootRoute = createRootRoute({
        component: () => (
          <>
            <SessionDeepLinkRouter />
            <Outlet />
          </>
        ),
      });
      const sessionRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/$workspaceName/sessions/$sessionId',
        validateSearch: SessionRoute.options.validateSearch,
        beforeLoad: SessionRoute.options.beforeLoad as never,
        component: () => {
          const { sessionId } = sessionRoute.useParams();
          const { tab } = sessionRoute.useSearch();
          return sessionId === 'coordinator' ? <BoardPage /> : <output>{tab}</output>;
        },
      });
      const router = createRouter({
        routeTree: rootRoute.addChildren([sessionRoute]),
        history: createMemoryHistory({ initialEntries: ['/ws/sessions/coordinator'] }),
        defaultPendingMs: Infinity,
        defaultPendingMinMs: 0,
      });
      await router.load();
      await act(async () =>
        root.render(
          <PlatformContext.Provider value={platform}>
            <Provider store={store}>
              <RouterProvider router={router} />
            </Provider>
          </PlatformContext.Provider>
        )
      );
      // Use the actual route restoration first to demonstrate the remembered child.
      await act(async () => {
        await router.navigate({
          to: '/$workspaceName/sessions/$sessionId',
          params: { workspaceName: 'ws', sessionId: 'outside' },
          search: {},
        });
      });
      expect(container.querySelector('output')?.textContent).toBe('session:old-child');
      await act(async () => {
        await router.navigate({
          to: '/$workspaceName/sessions/$sessionId',
          params: { workspaceName: 'ws', sessionId: 'coordinator' },
          search: {},
        });
      });
      let arrived!: () => void;
      const navigationDone = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const unsubscribe = router.subscribe('onResolved', ({ toLocation }) => {
        if (toLocation.pathname === '/ws/sessions/outside') arrived();
      });
      try {
        await act(async () => {
          container.querySelector<HTMLButtonElement>('button[data-session-link]')!.click();
        });
        await navigationDone;
        expect(router.state.location.search.tab).toBe('session:outside');
        expect(container.querySelector('output')?.textContent).toBe('session:outside');
        // Until the destination hydrates its conversation, the real deep-link host retains the request.
        expect(store.get(pendingSessionLinkAtom)).toMatchObject({
          sessionId: 'outside',
          workspaceId: 'ws',
        });
      } finally {
        unsubscribe();
        writeStoredLastActiveTabState('outside' as SessionId, {
          sessionTabId: 'outside',
          viewerTab: null,
        });
      }
    }
  );

  it.each([
    [legacyText, 'lody://session/1ed6ba53-93bc-46d5-91e3-bb693cb0e729'],
    ...['ws_1', 'ws_2'].map((workspace) => {
      const url = `lody://session/1ed6ba53-93bc-46d5-91e3-bb693cb0e729?workspace=${workspace}`;
      return [`See [@Independent review](${url}).`, url];
    }),
    [
      'See [@Independent review](lody://session/root?workspace=ws_1&tab=child).',
      'lody://session/child?workspace=ws_1',
    ],
  ])('dispatches the exact target to the deep-link router: %s', async (text, url) => {
    await act(async () =>
      root.render(
        <SessionLinkProvider enabled>
          <MarkdownRenderer text={text} />
        </SessionLinkProvider>
      )
    );
    const chip = container.querySelector<HTMLButtonElement>('button[data-session-link]')!;
    expect(chip.textContent).toBe('Independent review');
    expect(container.querySelector('a')).toBeNull();
    await act(async () => chip.click());
    expect(opened).toEqual([url]);
  });

  it.each([
    [
      'session://1ed6ba53-93bc-46d5-91e3-bb693cb0e729',
      'lody://session/1ed6ba53-93bc-46d5-91e3-bb693cb0e729',
    ],
    [
      'lody://session/1ed6ba53-93bc-46d5-91e3-bb693cb0e729?workspace=ws_1',
      'lody://session/1ed6ba53-93bc-46d5-91e3-bb693cb0e729?workspace=ws_1',
    ],
  ])(
    'turns a bare %s in prose into the same chip, keeping the punctuation around it',
    async (uri, url) => {
      await act(async () =>
        root.render(
          <SessionLinkProvider enabled>
            <MarkdownRenderer text={`详见${uri}，以及 ${uri}. 完`} />
          </SessionLinkProvider>
        )
      );
      const chips = [...container.querySelectorAll<HTMLButtonElement>('button[data-session-link]')];
      expect(chips.map((chip) => chip.textContent)).toEqual(['1ed6ba53', '1ed6ba53']);
      expect(container.querySelector('a')).toBeNull();
      expect(container.textContent).toBe('详见1ed6ba53，以及 1ed6ba53. 完');
      await act(async () => chips[0]!.click());
      expect(opened).toEqual([url]);
    }
  );

  it.each([
    '`session://1ed6ba53-93bc-46d5-91e3-bb693cb0e729`',
    '```\nlody://session/1ed6ba53-93bc-46d5-91e3-bb693cb0e729\n```',
    'lody://session/1ed6ba53-93bc-46d5-91e3-bb693cb0e729?next=1',
    'lody://session/../1ed6ba53-93bc-46d5-91e3-bb693cb0e729',
    'session://bad.id',
  ])(
    'leaves %s as it is: code is shown, and only parseSessionLink says what a link is',
    async (text) => {
      await act(async () =>
        root.render(
          <SessionLinkProvider enabled>
            <MarkdownRenderer text={text} />
          </SessionLinkProvider>
        )
      );
      expect(container.querySelector('[data-session-link]')).toBeNull();
      expect(container.querySelector('a')).toBeNull();
      const uri = text.replace(/^```\n|\n```$|`/gu, '');
      expect((container.querySelector('code') ?? container).textContent).toContain(uri);
    }
  );

  it('stays inert without live navigation capability', async () => {
    await act(async () =>
      root.render(
        <SessionLinkProvider enabled={false}>
          <MarkdownRenderer text={legacyText} />
        </SessionLinkProvider>
      )
    );
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('[data-session-link]')?.textContent).toBe('Independent review');
    expect(opened).toEqual([]);
  });

  it.each([
    legacyText,
    'See [@Independent review](lody://session/1ed6ba53-93bc-46d5-91e3-bb693cb0e729?workspace=ws_1).',
  ])('stays an inert chip on a read-only share: %s', async (text) => {
    await act(async () =>
      root.render(
        <SessionReadonlyContext.Provider
          value={{ renderImage: () => null, renderFiles: () => null }}
        >
          <SessionLinkProvider enabled>
            <MarkdownRenderer text={text} />
          </SessionLinkProvider>
        </SessionReadonlyContext.Provider>
      )
    );
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('[data-session-link]')?.textContent).toBe('Independent review');
  });
});
