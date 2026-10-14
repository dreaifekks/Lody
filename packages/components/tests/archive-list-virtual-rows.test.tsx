// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider, createStore } from 'jotai';
import { archiveMachineIdAtom, archiveScopeAtom } from '../src/atoms/sidebar-state';
import { ArchiveView, groupSessionsForArchive } from '../src/components/archive/archive-view';
import type { SessionId, SessionMeta } from '@lody/shared';
import { ArchiveListWindow } from '../src/components/archive/archive-list-window';
import {
  ARCHIVE_DESKTOP_SESSION_ROW_ESTIMATE_PX,
  ARCHIVE_LIST_OVERSCAN,
  archiveRowDataId,
  estimateArchiveRowSize,
  flattenVisibleArchiveRows,
  type ArchiveListGroupInput,
  type ArchiveVirtualRow,
} from '../src/lib/archive-list-virtualization';

const fixture = vi.hoisted(() => ({
  sessions: [] as SessionMeta[],
  teamSharing: false,
  mobile: false,
}));
vi.mock('@lody/platform/react', () => ({ usePlatformCapability: () => fixture.teamSharing }));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ navigate: () => {} }) }));
vi.mock('@/hooks/use-visible-session-metas', () => ({
  useVisibleArchivedSessionMetas: () => ({ archivedSessions: fixture.sessions }),
}));
vi.mock('@/hooks/use-session-actions', () => ({
  useSessionActions: () => ({
    restoreSession: async () => {},
    deleteArchivedSession: async () => {},
  }),
  isArchivedLocalProjectRestoreUnavailableError: () => false,
}));
vi.mock('@/hooks/useOrganization', () => ({
  useOrganization: () => ({ activeOrganization: null }),
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => fixture.mobile }));
vi.mock('@/hooks/use-machine-flock-rows', () => ({
  useMachineFlockRowsByMachineIds: () => new Map(),
}));
vi.mock('@/atoms', async () => {
  const { atom } = await import('jotai');
  return {
    userAtom: atom({ id: 'owner' }),
    currentWorkspaceSlugAtom: atom('test'),
    setMobileDrawerOpenAtom: atom(false),
  };
});
vi.mock('@/atoms/agents', async () => {
  const { atom } = await import('jotai');
  const empty = atom(null);
  return { getAgentMetaByIdAtomFamily: () => empty };
});
vi.mock('@/atoms/machines', async () => {
  const { atom } = await import('jotai');
  return {
    getMachineMetaMapAtom: atom(
      new Map([
        [
          'machine-a',
          { name: 'Laptop', localProjects: { project: { name: 'App', rootPath: '/work/app' } } },
        ],
        [
          'machine-b',
          { name: 'Server', localProjects: { project: { name: 'App', rootPath: '/work/app' } } },
        ],
      ])
    ),
  };
});
vi.mock('@/atoms/local-probe', async () => {
  const { atom } = await import('jotai');
  return { localMachineIdAtom: atom('machine-a') };
});
vi.mock('@/components/icons/agent-icon', () => ({ AgentIcon: () => null }));
vi.mock('@/components/user-avatar', () => ({ UserAvatar: () => null }));
vi.mock('@/components/mobile/mobile-archive-screen', () => ({
  MobileArchiveScreen: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, values?: { count?: number }) =>
      fallback.replace('{{count}}', String(values?.count)),
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWPORT_HEIGHT_PX = 400;
const GROUP_COUNT = 4;
const SESSIONS_PER_GROUP = 50;
const SESSION_COUNT = GROUP_COUNT * SESSIONS_PER_GROUP;

let viewportHeightPx = VIEWPORT_HEIGHT_PX;
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

function installLayoutStubs(): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: function (this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = options.top ?? 0;
      this.dispatchEvent(new Event('scroll'));
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
    configurable: true,
    value: () => true,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-archive-list-scroll') ? viewportHeightPx : 0;
    },
  });
}

function session(id: string): SessionMeta {
  return { id: id as SessionId, title: id } as SessionMeta;
}

function makeGroups(): ArchiveListGroupInput[] {
  return Array.from({ length: GROUP_COUNT }, (_, groupIndex) => ({
    key: `acme/repo-${groupIndex}`,
    kind: 'repo' as const,
    collapsed: false,
    sessions: Array.from({ length: SESSIONS_PER_GROUP }, (_session, sessionIndex) =>
      session(`s-${groupIndex}-${sessionIndex}`)
    ),
  }));
}

function renderRow(row: ArchiveVirtualRow): ReactNode {
  return (
    <div data-id={archiveRowDataId(row)} data-scope-item="row">
      {row.key}
    </div>
  );
}

function countSessions(host: HTMLElement): number {
  return host.querySelectorAll('[data-id^="archive-session:"]').length;
}

function countHeaders(host: HTMLElement): number {
  return host.querySelectorAll('[data-id^="archive-group:"]').length;
}

describe('ArchiveListWindow virtualization', () => {
  const roots: Root[] = [];
  const hosts: HTMLDivElement[] = [];

  beforeEach(() => {
    viewportHeightPx = VIEWPORT_HEIGHT_PX;
    installLayoutStubs();
    vi.stubGlobal('CSS', { escape: (value: string) => value.replaceAll(':', '\\:') });
    localStorage.clear();
    fixture.teamSharing = false;
    fixture.mobile = false;
  });

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    for (const host of hosts.splice(0)) host.remove();
    vi.unstubAllGlobals();
    if (originalOffsetHeight) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
    }
  });

  async function renderWindow(node: ReactNode): Promise<HTMLDivElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    hosts.push(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(node);
    });
    return host;
  }

  function archived(
    id: string,
    machineId: string,
    kind: 'local' | 'repo' | 'chat' = 'chat'
  ): SessionMeta {
    return {
      ...session(id),
      machineId,
      userId: 'owner',
      lastMessageAt: 100,
      project: kind === 'local' ? { kind: 'local', localProjectId: 'project' } : undefined,
      repoFullName: kind === 'repo' ? 'acme/app' : undefined,
    } as SessionMeta;
  }

  function sessionIds(host: HTMLElement) {
    return Array.from(host.querySelectorAll('[data-id^="archive-session:"]')).map((node) =>
      node.getAttribute('data-id')!.slice('archive-session:'.length)
    );
  }

  it.each([false, true])(
    'filters every session kind by machine and labels all-machine project headers (mobile: %s)',
    async (mobile) => {
      fixture.mobile = mobile;
      fixture.sessions = ['a', 'b'].flatMap((machine) =>
        (['local', 'repo', 'chat'] as const).map((kind) =>
          archived(`${machine}-${kind}`, `machine-${machine}`, kind)
        )
      );
      const store = createStore();
      store.set(archiveScopeAtom, 'my');
      const host = await renderWindow(
        <Provider store={store}>
          <ArchiveView />
        </Provider>
      );
      expect(sessionIds(host)).toHaveLength(6);
      const headers = () =>
        Array.from(host.querySelectorAll('[data-id^="archive-group:local:"]')).map(
          (node) => node.textContent
        );
      expect(headers()).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Laptop'),
          expect.stringContaining('Server'),
        ])
      );
      expect(host.textContent).toContain('All machines');
      expect(host.textContent).not.toContain('My Tasks');
      await act(async () => store.set(archiveMachineIdAtom, 'machine-b'));
      expect(sessionIds(host)).toEqual(['b-local', 'b-repo', 'b-chat']);
      expect(headers().join('')).not.toContain('Server');
      await act(async () => store.set(archiveMachineIdAtom, 'removed-machine'));
      expect(sessionIds(host)).toHaveLength(6);
      expect(host.textContent).toContain('All machines');
    }
  );

  it('hides a single-machine selector and preserves hosted My/All filtering', async () => {
    fixture.sessions = [
      archived('mine', 'machine-a'),
      { ...archived('theirs', 'machine-a'), userId: 'teammate' },
    ];
    const local = await renderWindow(
      <Provider>
        <ArchiveView />
      </Provider>
    );
    expect(local.textContent).not.toContain('All machines');
    expect(sessionIds(local)).toEqual(['mine', 'theirs']);
    fixture.teamSharing = true;
    const store = createStore();
    store.set(archiveScopeAtom, 'my');
    const cloud = await renderWindow(
      <Provider store={store}>
        <ArchiveView />
      </Provider>
    );
    expect(cloud.textContent).toContain('My Tasks');
    expect(sessionIds(cloud)).toEqual(['mine']);
    await act(async () => store.set(archiveScopeAtom, 'team'));
    expect(sessionIds(cloud)).toEqual(['mine', 'theirs']);
    expect(cloud.textContent).toContain('All Tasks');
  });

  it('expands the project preview while group selection includes hidden sessions', async () => {
    fixture.sessions = Array.from({ length: 12 }, (_, i) => archived(`chat-${i}`, 'machine-a'));
    const host = await renderWindow(
      <Provider>
        <ArchiveView />
      </Provider>
    );
    expect(sessionIds(host)).toHaveLength(10);
    const more = host.querySelector<HTMLButtonElement>('[data-id="archive-more:__chats__"]')!;
    expect(more.textContent).toBe('… 2 more');
    const checkbox = host.querySelector<HTMLElement>('[aria-label="Select chat-0"]')!;
    await act(async () => checkbox.click());
    const groupCheckbox = host.querySelector<HTMLElement>('[aria-label="Select all in Chats"]')!;
    await act(async () => groupCheckbox.click());
    expect(host.textContent).toContain('12 selected');
    await act(async () => {
      more.focus();
      more.click();
    });
    expect(document.activeElement?.getAttribute('data-id')).toBe('archive-session:chat-10');
    expect(sessionIds(host)).toHaveLength(12);
    expect(host.querySelector('[data-id="archive-more:__chats__"]')).toBeNull();
  });

  async function chooseMenu(host: HTMLElement, label: string, choice: string) {
    const trigger = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === label
    )!;
    await act(async () => trigger.click());
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
    ).find((item) => item.textContent === choice)!;
    await act(async () => option.click());
  }

  it('changes the machine through the menu and persists the choice', async () => {
    fixture.sessions = [archived('a', 'machine-a'), archived('b', 'machine-b')];
    const store = createStore();
    const host = await renderWindow(
      <Provider store={store}>
        <ArchiveView />
      </Provider>
    );
    await chooseMenu(host, 'All machines', 'Server');
    expect(sessionIds(host)).toEqual(['b']);
    expect(JSON.parse(localStorage.getItem('lody-archive-machine-id')!)).toBe('machine-b');
    await chooseMenu(host, 'Server', 'All machines');
    expect(sessionIds(host)).toEqual(['a', 'b']);
  });

  it('keeps search results limited, follows the current sort and leaves the flat list complete', async () => {
    fixture.sessions = Array.from({ length: 12 }, (_, i) => ({
      ...archived(`match-${i}`, 'machine-a'),
      lastMessageAt: i,
    }));
    const host = await renderWindow(
      <Provider>
        <ArchiveView />
      </Provider>
    );
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        search,
        'match'
      );
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(sessionIds(host)).toEqual(Array.from({ length: 10 }, (_, i) => `match-${11 - i}`));
    await chooseMenu(host, 'Newest first', 'Oldest first');
    expect(sessionIds(host)).toEqual(Array.from({ length: 10 }, (_, i) => `match-${i}`));
    await chooseMenu(host, 'By project', 'One list');
    expect(sessionIds(host)).toHaveLength(12);
    expect(host.querySelector('[data-id^="archive-more:"]')).toBeNull();
  });

  it.each([1, 5])(
    'keeps keyboard focus through expansion with %s project groups',
    async (groupCount) => {
      fixture.sessions = Array.from({ length: groupCount }, (_group, groupIndex) =>
        Array.from({ length: 70 }, (_, i) => ({
          ...archived(`chat-${groupIndex}-${i}`, 'machine-a'),
          repoFullName: `acme/repo-${groupIndex}`,
        }))
      ).flat();
      const host = await renderWindow(
        <Provider>
          <ArchiveView />
        </Provider>
      );
      expect(
        host.querySelector(`[data-archive-list="${groupCount === 1 ? 'static' : 'virtualized'}"]`)
      ).not.toBeNull();
      const last = host.querySelector<HTMLElement>('[data-id="archive-session:chat-0-9"]')!;
      await act(async () => {
        last.focus();
        last.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
        );
      });
      expect(document.activeElement?.getAttribute('data-id')).toBe('archive-more:acme/repo-0');
      await act(async () => (document.activeElement as HTMLElement).click());
      expect(host.querySelector('[data-archive-list="virtualized"]')).not.toBeNull();
      expect(document.activeElement?.getAttribute('data-id')).toBe('archive-session:chat-0-10');
      await act(async () =>
        document.activeElement!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
        )
      );
      expect(document.activeElement?.getAttribute('data-id')).toBe('archive-session:chat-0-11');
    }
  );

  it('sorts local groups by displayed paths instead of machine ids', () => {
    const groups = groupSessionsForArchive({
      sessions: [archived('z', 'machine-a', 'local'), archived('a', 'machine-b', 'local')],
      localProjectLabelByKey: new Map([
        ['local:machine-a:project', { name: 'Z', path: '/z', available: true }],
        ['local:machine-b:project', { name: 'A', path: '/a', available: true }],
      ]),
      groupMode: 'project',
      sortMode: 'newest',
      flatLabel: 'All',
    });
    expect(groups.map((group) => group.label)).toEqual(['/a', '/z']);
  });

  it('compares static vs virtualized initialization on a long grouped list', async () => {
    const groups = makeGroups();
    const rows = flattenVisibleArchiveRows(groups, {
      hideGroupHeader: false,
      expandedGroupKeys: new Set(makeGroups().map((group) => group.key)),
    });
    const expectedSpacerPx = rows.reduce(
      (sum, row) => sum + estimateArchiveRowSize(row, { isMobile: false }),
      0
    );
    const windowCeiling =
      Math.ceil(VIEWPORT_HEIGHT_PX / ARCHIVE_DESKTOP_SESSION_ROW_ESTIMATE_PX) +
      2 * ARCHIVE_LIST_OVERSCAN;

    const staticHost = await renderWindow(
      <ArchiveListWindow
        rows={rows}
        isMobile={false}
        listScopeId="archive-static"
        renderRow={renderRow}
        virtualizeThreshold={Number.POSITIVE_INFINITY}
      />
    );
    const virtualHost = await renderWindow(
      <ArchiveListWindow
        rows={rows}
        isMobile={false}
        listScopeId="archive-virtualized"
        renderRow={renderRow}
      />
    );

    const staticSessions = countSessions(staticHost);
    const virtualSessions = countSessions(virtualHost);
    const staticNodes = staticHost.querySelectorAll('*').length;
    const virtualNodes = virtualHost.querySelectorAll('*').length;

    expect(staticHost.querySelector('[data-archive-list="static"]')).not.toBeNull();
    expect(virtualHost.querySelector('[data-archive-list="virtualized"]')).not.toBeNull();
    expect(staticSessions).toBe(SESSION_COUNT);
    expect(countHeaders(staticHost)).toBe(GROUP_COUNT);
    expect(virtualSessions + countHeaders(virtualHost)).toBeLessThanOrEqual(windowCeiling);
    expect(virtualNodes).toBeLessThan(staticNodes / 2);
    expect(virtualHost.querySelector('[data-id="archive-group:acme/repo-0"]')).not.toBeNull();
    expect(virtualHost.querySelector('[data-id="archive-session:s-0-0"]')).not.toBeNull();
    expect(
      (virtualHost.querySelector('[data-archive-list="virtualized"]') as HTMLElement | null)?.style
        .height
    ).toBe(`${expectedSpacerPx}px`);
  });

  it('mounts no rows rather than the whole list while the scrollport measures 0', async () => {
    viewportHeightPx = 0;
    const rows = flattenVisibleArchiveRows(makeGroups(), {
      hideGroupHeader: false,
      expandedGroupKeys: new Set(makeGroups().map((group) => group.key)),
    });
    const host = await renderWindow(
      <ArchiveListWindow
        rows={rows}
        isMobile={false}
        listScopeId="archive-empty-range"
        renderRow={renderRow}
      />
    );
    expect(countSessions(host)).toBe(0);
    expect(countHeaders(host)).toBe(0);
    expect(host.querySelector('[data-archive-list="virtualized"]')).not.toBeNull();
  });

  it('renders every row without a spacer for a small grouped list', async () => {
    const rows = flattenVisibleArchiveRows(
      [
        {
          key: 'acme/small',
          kind: 'repo',
          collapsed: false,
          sessions: [session('a'), session('b')],
        },
      ],
      { hideGroupHeader: false }
    );
    const host = await renderWindow(
      <ArchiveListWindow
        rows={rows}
        isMobile={false}
        listScopeId="archive-small"
        renderRow={renderRow}
      />
    );
    expect(host.querySelector('[data-archive-list="static"]')).not.toBeNull();
    expect(countSessions(host)).toBe(2);
    expect(countHeaders(host)).toBe(1);
  });
});
