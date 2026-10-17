// @vitest-environment jsdom

import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LocalProjectMeta,
  MachineId,
  SessionId,
  SessionMeta,
  SessionStatus,
} from '@lody/shared';

import { LocalProjectItem } from '../src/components/loro-app-sidebar';
import { initI18n } from '../src/i18n';
import { Tooltip } from '@lody/ui/tooltip';

// A project hosted on a machine a teammate shared with the workspace. The row
// must behave exactly like one on this user's own device: clicking it steers the
// chat landing to that machine + project, and the new-chat button is offered.
const machineId = 'machine-teammate' as MachineId;
const project = {
  id: 'project-shared',
  name: 'Lody',
  rootPath: '/workspace/lody',
} as LocalProjectMeta;

const NO_LIVE_STATUSES: ReadonlyMap<string, SessionStatus> = new Map();

function localSession(id: string, fields: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: id as SessionId,
    machineId,
    createdAt: '2026-09-17T00:00:00.000Z',
    lastMessageAt: 10,
    lastReadAt: 10,
    userId: 'user-1',
    cliType: 'builtin',
    agentType: 'codex',
    title: id,
    ...fields,
  } as SessionMeta;
}

describe('sidebar local project row', () => {
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      flushSync(() => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  function render(options: {
    onNavigateProject: (machineId: MachineId, localProjectId: string) => void;
    onNewChatInProject: (machineId: MachineId, localProjectId: string) => void;
    removalState?: 'waiting_for_device' | 'removing' | null;
    sessions?: SessionMeta[];
    whetherShowFullList?: boolean;
    onToggleFullList?: (groupKey: string) => void;
    collapsed?: boolean;
    liveSessionStatuses?: ReadonlyMap<string, SessionStatus>;
    isPinned?: boolean;
    onTogglePinned?: (machineId: MachineId, localProjectId: string, nextPinned: boolean) => void;
    showMachineName?: boolean;
  }) {
    flushSync(() => {
      root?.render(
        <Tooltip.Provider>
          <LocalProjectItem
            machineId={machineId}
            machineName="Teammate's Mac"
            project={project}
            // Removal stays owner-only; navigation does not depend on it.
            canRemoveProject={false}
            removalState={options.removalState ?? null}
            collapsed={options.collapsed ?? false}
            whetherShowFullList={options.whetherShowFullList ?? false}
            isSelected={false}
            sessionsForProject={options.sessions ?? []}
            childSessionsByParent={new Map()}
            liveSessionStatuses={options.liveSessionStatuses ?? NO_LIVE_STATUSES}
            formattedPath={project.rootPath}
            defaultSessionTitle="New session"
            selectedSessionId={null}
            removeProjectLabel="Remove folder"
            newChatLabel="New chat"
            archiveTooltipLabel="Archive session"
            archiveActionLabel="Archive"
            archiveConfirmLabel="Confirm"
            isMobile={false}
            toggleLabel="Toggle"
            onNavigateProject={options.onNavigateProject}
            onNewChatInProject={options.onNewChatInProject}
            isPinned={options.isPinned}
            onTogglePinned={options.onTogglePinned}
            showMachineName={options.showMachineName}
            machineNameColor="blue"
            onNavigateSession={() => undefined}
            onArchive={() => undefined}
            collapsedOpenedBySessionIds={{}}
            onToggleOpenedBySessions={() => undefined}
            onToggleCollapsed={() => undefined}
            onToggleFullList={options.onToggleFullList ?? (() => undefined)}
            onRequestRemoval={() => undefined}
          />
        </Tooltip.Provider>
      );
    });
    return container?.querySelector<HTMLElement>(`[data-id="project:${machineId}:${project.id}"]`);
  }

  it('activates the project on the landing and offers a new chat for a shared machine', () => {
    const onNavigateProject = vi.fn();
    const onNewChatInProject = vi.fn();
    const row = render({ onNavigateProject, onNewChatInProject });

    expect(row?.getAttribute('role')).toBe('button');
    expect(row?.getAttribute('aria-disabled')).toBeNull();

    flushSync(() => row?.click());
    expect(onNavigateProject).toHaveBeenCalledWith(machineId, project.id);

    const newChatButton = row?.querySelector<HTMLButtonElement>('button[aria-label="New chat"]');
    expect(newChatButton).toBeInstanceOf(HTMLButtonElement);
    flushSync(() => newChatButton?.click());
    expect(onNewChatInProject).toHaveBeenCalledWith(machineId, project.id);
    // Starting a fresh chat must not double as a plain row activation.
    expect(onNavigateProject).toHaveBeenCalledTimes(1);
  });

  it('pins and unpins the project from its More menu', () => {
    const openMenu = (row: HTMLElement | null | undefined) => {
      const moreButton = row?.querySelector<HTMLButtonElement>('button[aria-label="More actions"]');
      expect(moreButton).toBeInstanceOf(HTMLButtonElement);
      flushSync(() => moreButton?.click());
      return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(
        (item) => ({ item, label: item.textContent?.trim() ?? '' })
      );
    };

    // Without a pin handler the row offers no pin item and no More menu of its own.
    const bare = render({ onNavigateProject: vi.fn(), onNewChatInProject: vi.fn() });
    expect(bare?.querySelector('button[aria-label="More actions"]')).toBeNull();

    const onTogglePinned = vi.fn();
    const unpinnedRow = render({
      onNavigateProject: vi.fn(),
      onNewChatInProject: vi.fn(),
      onTogglePinned,
    });
    const unpinnedItems = openMenu(unpinnedRow);
    expect(unpinnedItems.map(({ label }) => label)).toContain('Pin project');
    expect(unpinnedItems.map(({ label }) => label)).not.toContain('Unpin project');
    flushSync(() => unpinnedItems.find(({ label }) => label === 'Pin project')?.item.click());
    expect(onTogglePinned).toHaveBeenCalledWith(machineId, project.id, true);

    const pinnedRow = render({
      onNavigateProject: vi.fn(),
      onNewChatInProject: vi.fn(),
      isPinned: true,
      onTogglePinned,
    });
    const pinnedItems = openMenu(pinnedRow);
    expect(pinnedItems.map(({ label }) => label)).toContain('Unpin project');
    expect(pinnedItems.map(({ label }) => label)).not.toContain('Pin project');
    flushSync(() => pinnedItems.find(({ label }) => label === 'Unpin project')?.item.click());
    expect(onTogglePinned).toHaveBeenLastCalledWith(machineId, project.id, false);
  });

  it('names its machine only when asked to, as a pinned row away from its group', () => {
    const bare = render({ onNavigateProject: vi.fn(), onNewChatInProject: vi.fn() });
    expect(bare?.querySelector('[data-sidebar-project-machine]')).toBeNull();
    expect(bare?.textContent).toContain('Lody');
    expect(bare?.textContent).not.toContain("Teammate's Mac");

    const named = render({
      onNavigateProject: vi.fn(),
      onNewChatInProject: vi.fn(),
      isPinned: true,
      onTogglePinned: vi.fn(),
      showMachineName: true,
    });
    const suffix = named?.querySelector<HTMLElement>('[data-sidebar-project-machine]');
    expect(suffix?.textContent).toBe("Teammate's Mac");
    // Right after the name, not at the row's end beside the status mark.
    expect(suffix?.previousElementSibling?.textContent).toBe('Lody');
    expect(suffix?.style.color).toContain('--lan-machine-blue');
    // Pinned rows carry no pin glyph: the Pinned section already says so.
    expect(named?.querySelector('.lucide-pin')).toBeNull();
  });

  it('goes inert while the project is being removed', () => {
    const onNavigateProject = vi.fn();
    const onNewChatInProject = vi.fn();
    const row = render({ onNavigateProject, onNewChatInProject, removalState: 'removing' });

    expect(row?.getAttribute('role')).toBeNull();
    expect(row?.getAttribute('aria-disabled')).toBe('true');

    flushSync(() => row?.click());
    expect(onNavigateProject).not.toHaveBeenCalled();
    expect(row?.querySelector('button[aria-label="New chat"]')).toBeNull();
  });

  it('previews five sessions and can reveal the full local project history', () => {
    const sessions: SessionMeta[] = Array.from({ length: 7 }, (_, index) => ({
      id: `session-${index}` as SessionId,
      machineId,
      createdAt: '2026-09-17T00:00:00.000Z',
      lastMessageAt: 7 - index,
      userId: 'user-1',
      cliType: 'builtin',
      agentType: 'codex',
      title: `Session ${index}`,
    }));
    const onToggleFullList = vi.fn();
    const baseOptions = {
      onNavigateProject: vi.fn(),
      onNewChatInProject: vi.fn(),
      sessions,
      onToggleFullList,
    };

    render(baseOptions);
    expect(container?.querySelectorAll('[data-sidebar-session-id]')).toHaveLength(5);
    const showAll = container?.querySelector<HTMLButtonElement>(
      '[data-sidebar-show-more="local-project:machine-teammate:project-shared"]'
    );
    expect(showAll?.textContent).toBe('Show all (7)');

    flushSync(() => showAll?.click());
    expect(onToggleFullList).toHaveBeenCalledWith('local-project:machine-teammate:project-shared');

    render({ ...baseOptions, whetherShowFullList: true });
    expect(container?.querySelectorAll('[data-sidebar-session-id]')).toHaveLength(7);
    expect(container?.querySelector('[data-sidebar-show-more]')?.textContent).toBe('Show less');
  });

  it('keeps the status of the Sessions a folded project hides on its header', () => {
    const sessions = [
      localSession('waiting'),
      localSession('running'),
      localSession('finished', { lastMessageAt: 20, lastReadAt: 10 }),
      localSession('idle'),
    ];
    const liveSessionStatuses = new Map<string, SessionStatus>([
      ['waiting', { type: 'requestPermission' }],
      ['running', { type: 'running' }],
    ]);
    const base = {
      onNavigateProject: vi.fn(),
      onNewChatInProject: vi.fn(),
      sessions,
      liveSessionStatuses,
    };

    // Expanded: the rows carry their own marks; the header adds nothing.
    let row = render({ ...base, collapsed: false });
    expect(row?.querySelector('[data-sidebar-group-activity]')).toBeNull();
    expect(container?.querySelectorAll('[data-sidebar-session-id]')).toHaveLength(4);

    // Folded: one mark at the header's trailing edge, by the rows' own priority —
    // a Session waiting on the user outranks the running and unread ones.
    row = render({ ...base, collapsed: true });
    expect(container?.querySelectorAll('[data-sidebar-session-id]')).toHaveLength(0);
    const mark = row?.querySelector('[data-sidebar-group-activity]');
    expect(mark?.querySelectorAll('[data-session-row-indicator]')).toHaveLength(1);
    expect(mark?.querySelector('.lucide-hand')).not.toBeNull();
    // The counts are one hover (or one screen-reader announcement) away.
    expect(row?.getAttribute('aria-label')).toBe(
      "Lody · Teammate's Mac · /workspace/lody · 1 waiting for approval · 1 working · 1 unread"
    );

    // The permission is answered: the running Sessions now lead.
    row = render({
      ...base,
      collapsed: true,
      liveSessionStatuses: new Map<string, SessionStatus>([
        ['waiting', { type: 'running' }],
        ['running', { type: 'running' }],
      ]),
    });
    expect(row?.querySelector('[data-sidebar-group-activity] [data-working-grid]')).not.toBeNull();
    expect(row?.getAttribute('aria-label')).toContain('2 working · 1 unread');

    // Both finish with new output: the folded header rests on the unread dot
    // (jsdom has no Web Animations, so the done transition completes at once).
    row = render({
      ...base,
      sessions: [
        localSession('waiting', { lastMessageAt: 30, lastReadAt: 10 }),
        localSession('running', { lastMessageAt: 30, lastReadAt: 10 }),
        localSession('finished', { lastMessageAt: 20, lastReadAt: 10 }),
        localSession('idle'),
      ],
      collapsed: true,
      liveSessionStatuses: NO_LIVE_STATUSES,
    });
    expect(row?.querySelector('[data-sidebar-group-activity] [data-working-grid]')).toBeNull();
    expect(
      row?.querySelector('[data-sidebar-group-activity] [data-session-unread-dot]')
    ).not.toBeNull();
    expect(row?.getAttribute('aria-label')).toContain('3 unread');

    // Everything read: a folded, quiet project draws nothing.
    row = render({
      ...base,
      sessions: [localSession('idle')],
      collapsed: true,
      liveSessionStatuses: NO_LIVE_STATUSES,
    });
    expect(row?.querySelector('[data-session-row-indicator]')).toBeNull();
    expect(row?.getAttribute('aria-label')).toBe("Lody · Teammate's Mac · /workspace/lody");
  });
});
