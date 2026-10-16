// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { describe, it, expect, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';
import {
  getSessionRoomId,
  normalizeBoardMeta,
  readSessionOperationTargets,
  type AgentConfigMeta,
  type BoardMeta,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type SessionStatus,
  type SessionToCreate,
  type WorkspaceId,
} from '@lody/shared';
import {
  CLOUD_PLATFORM_CAPABILITIES,
  createStaticStore,
  type CloudApi,
  type PlatformProvider,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { userAtom, currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../src/atoms';
import { agentConfigMetaCacheAtom, sessionMetaCacheAtom } from '../src/atoms/doc-meta';
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from '../src/atoms/presence';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { CreateBoardDialog } from '../src/components/boards/create-board-dialog';
import { changeBoardMembership } from '../src/components/boards/board-membership-dialog';
import { BoardNotesEditor } from '../src/components/boards/board-notes-panel';
import { BoardSidePanel } from '../src/components/boards/board-side-panel';
import { BoardSettingsDialog } from '../src/components/boards/board-settings-panel';
import { useBoardLifecycle } from '../src/components/boards/board-lifecycle';
import { boardActivity } from '../src/components/boards/board-threads';
import { writeWorkspaceBoard } from '../src/lib/workspace-catalog-write';

const creation = vi.hoisted(() => ({
  machines: new Map<string, unknown>(),
  startSession: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
}));
vi.mock('@/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => ({ machines: creation.machines }),
}));
// Visibility is its own concern; the panel reads every member from the real atoms.
vi.mock('@/hooks/use-visible-session-metas', async () => {
  const { useAtomValue: read } = await import('jotai');
  const { allActiveSessionsAtom: active, archivedSessionListAtom: archived } =
    await import('../src/atoms/doc-meta');
  return {
    useVisibleSessionMetas: () => ({ allActiveSessions: read(active) }),
    useVisibleArchivedSessionMetas: () => ({ archivedSessions: read(archived) }),
  };
});
vi.mock('@/hooks/use-machine-flock-rows', () => ({
  useMachineFlockRowsByMachineIds: () => new Map(),
}));
vi.mock('@/hooks/use-board-document', () => ({
  useBoardDocument: () => ({ document: { notes: '# Shared' }, save: async () => {} }),
}));
vi.mock('@/hooks/use-machine-flock-agent-configs', () => ({
  useMachineFlockAgentConfigs: () => {},
}));
vi.mock('@/hooks/use-workspace-catalog', () => ({
  useWorkspaceCatalog: () => ({ servers: [], boards: [] }),
}));
vi.mock('@/hooks/use-workspace-agent-roles', () => ({
  useWorkspaceAgentRoles: () => ({ roles: [] }),
  useAgentRoleAvailability: () => ({ resolveInstance: () => ({ kind: 'available' }) }),
  useComposerAgentRoleNames: () => ({ machine: () => 'Desktop', unknownAgent: 'Unknown' }),
}));
// Archive, restore and rename are the real Session actions over the test runtime;
// only first-turn acceptance is held by the test.
vi.mock('@/hooks/use-session-actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hooks/use-session-actions')>();
  return {
    ...actual,
    useSessionActions: () => ({
      ...actual.useSessionActions(),
      startSession: (...args: unknown[]) => creation.startSession?.(...args),
      requestSessionDispatch: async () => {},
    }),
  };
});
vi.mock('@/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => ({ isAuthenticated: false, requestAuthRecovery: () => {} }),
}));
vi.mock('@/components/schedules/schedule-agent-controls', () => ({
  ScheduleAgentControls: () => null,
}));
vi.mock('@/components/sessions/desktop-run-config-menu', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  DesktopMachineMenu: () => null,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (_key: string, fallback: string, values?: Record<string, unknown>) =>
      typeof fallback === 'string'
        ? fallback.replace(/{{(\w+)}}/g, (_match, key) => String(values?.[key] ?? ''))
        : _key,
  }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const makeSession = (id: string, extra: Partial<SessionMeta> = {}) =>
  ({
    id: id as SessionId,
    machineId: 'machine',
    userId: 'user',
    title: id,
    boardId: 'bd_test',
    createdAt: '2026-10-15T00:00:00Z',
    status: { type: 'running' },
    ...extra,
  }) as SessionMeta;

const testBoard = (extra: Partial<BoardMeta> = {}) => {
  const board = normalizeBoardMeta({
    version: 1,
    id: 'bd_test',
    name: 'Release',
    purpose: 'Ship it',
    coordinatorSessionId: 'coordinator',
    createdAtMs: 1,
    createdByUserId: 'user',
    ...extra,
  });
  if (!board) throw new Error('Invalid fixture');
  return board;
};

/** A catalog writer over an in-memory row map, the shape `WorkspaceCatalogWriteDeps` needs. */
function catalogRuntime(rows = new Map<string, { key: readonly unknown[]; value: unknown }>()) {
  const runtime = {
    workspaceId: 'ws',
    workspaceSlug: 'ws',
    repo: {
      openFlockDoc: async () => ({
        flock: { scan: () => rows.values() },
        syncOnce: async () => {},
      }),
    },
    writer: {
      flockRowPut: async (_doc: string, key: readonly unknown[], value: unknown) => {
        rows.set(JSON.stringify(key), { key, value });
      },
      flockRowDelete: async (_doc: string, key: readonly unknown[]) => {
        rows.delete(JSON.stringify(key));
      },
    },
  } as unknown as WorkspaceRuntime;
  const board = (id: string) => rows.get(JSON.stringify(['board', id]))?.value as BoardMeta;
  return { runtime, rows, board };
}

/** Session actions read the platform seam; nothing here reaches a hosted service. */
const testPlatform: PlatformProvider = {
  kind: 'cloud',
  identity: {
    session: createStaticStore({ status: 'unauthenticated' }),
    signOut: async () => {},
  },
  workspaces: {
    state: createStaticStore({ status: 'ready', workspaces: [], activeWorkspaceId: null }),
    setActive: async () => {},
  },
  capabilities: CLOUD_PLATFORM_CAPABILITIES,
  cloudApi: {
    useQuery: () => undefined,
    useMutation: () => async () => ({}),
    useAction: () => async () => undefined,
  } as unknown as CloudApi,
  sync: { mode: 'cloud' },
};

/**
 * A workspace runtime over real Session metadata (a `LoroRepo`) and in-memory
 * catalog rows. A metadata write to a room in `failing` is refused, the way a
 * full disk or a lost lease would.
 */
async function boardRuntime(sessions: readonly SessionMeta[]) {
  const repo = await LoroRepo.create({});
  for (const session of sessions) await repo.upsertDocMeta(getSessionRoomId(session.id), session);
  const catalog = catalogRuntime();
  const failing = new Set<string>();
  const runtime = {
    ...catalog.runtime,
    repo: {
      openFlockDoc: catalog.runtime.repo.openFlockDoc,
      listDoc: (query: Parameters<typeof repo.listDoc>[0]) => repo.listDoc(query),
      getDocMeta: (id: string) => repo.getDocMeta(id),
      flush: async () => {},
    },
    writer: {
      ...catalog.runtime.writer,
      upsertDocMeta: async (id: string, patch: Partial<SessionMeta>) => {
        if (failing.has(id)) throw new Error('disk full');
        await repo.upsertDocMeta(id, patch);
      },
    },
    readSessionOperationTargets: (id: SessionId, operation: 'archive' | 'restore') =>
      readSessionOperationTargets(repo, id, operation),
  } as unknown as WorkspaceRuntime;
  return {
    runtime,
    board: catalog.board,
    failing,
    meta: async (id: string) =>
      (await repo.getDocMeta(getSessionRoomId(id as SessionId)))?.meta as SessionMeta,
    destroy: () => repo.destroy(),
  };
}

function workspaceStore(runtime: WorkspaceRuntime) {
  const store = createStore();
  store.set(runtimeAtom, runtime);
  store.set(currentWorkspaceIdAtom, 'ws' as WorkspaceId);
  store.set(currentWorkspaceSlugAtom, 'ws');
  return store;
}

async function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<PlatformContext.Provider value={testPlatform}>{node}</PlatformContext.Provider>)
  );
  return {
    host,
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

async function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submitForm() {
  await act(async () => {
    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

const live = (session: SessionMeta, status: SessionStatus) => ({
  [session.id]: {
    kind: 'session' as const,
    sessionId: session.id,
    machineId: session.machineId,
    instanceId: 'instance' as never,
    updatedAt: 1000,
    status,
  },
});

describe('Board side panel', () => {
  it('lists members from metadata and presence, groups them, and opens one in the panel', async () => {
    const store = createStore();
    const coordinator = makeSession('coordinator', { boardRole: 'coordinator' });
    const root = makeSession('root', { lastMessageAt: 50 });
    const tab = makeSession('review', { parentSessionId: root.id });
    const waiting = makeSession('waiting', { awaitingUserSince: 20, lastMessageAt: 10 });
    const answered = makeSession('answered', { awaitingUserSince: 10, lastMessageAt: 20 });
    const stopped = makeSession('stopped-child', { openedBySessionId: 'halted' as SessionId });
    const halted = makeSession('halted', { boardId: undefined, collaborationStopped: true });
    const other = makeSession('other', { boardId: 'bd_other' as never });
    const sessions = [coordinator, root, tab, waiting, answered, stopped, halted, other];
    store.set(
      sessionMetaCacheAtom,
      Object.fromEntries(sessions.map((entry) => [getSessionRoomId(entry.id), entry]))
    );
    store.set(lodyPresenceNowMsAtom, 1000);
    store.set(lodyPresenceStatesAtom, live(root, { type: 'running' } as SessionStatus));
    const opened: (string | null)[] = [];
    function Panel() {
      const [openThreadId, setOpenThreadId] = useState<SessionId | null>(null);
      return (
        <BoardSidePanel
          board={testBoard()}
          openThreadId={openThreadId}
          onOpenThread={(thread) => {
            opened.push(thread?.id ?? null);
            setOpenThreadId(thread?.id ?? null);
          }}
          onShowInPage={() => {}}
          onOpenThreadFull={() => {}}
          renderThread={(thread) => <p data-thread-surface={thread.id}>{thread.title}</p>}
          onArchived={() => {}}
        />
      );
    }
    const view = await mount(
      <Provider store={store}>
        <Panel />
      </Provider>
    );
    try {
      const ids = () =>
        [...view.host.querySelectorAll('[data-scope-item="row"]')].map((row) =>
          row.getAttribute('data-id')
        );
      const groups = () =>
        [...view.host.querySelectorAll('button[aria-expanded]')].map(
          (button) => button.textContent
        );
      // The coordinator is the Board itself; a stopped opener stops its member;
      // stale durable status never reads as work.
      expect(ids()).toEqual(['stopped-child', 'waiting', 'root', 'review', 'answered']);
      expect(groups()).toEqual(['Needs you2', 'Working1', 'Idle2']);
      await act(async () => store.set(lodyPresenceStatesAtom, {}));
      expect(groups()).toEqual(['Needs you2', 'Idle3']);
      await act(async () =>
        view.host.querySelector<HTMLButtonElement>('[data-id="review"]')?.click()
      );
      expect(opened).toEqual(['review']);
      expect(view.host.querySelector('[data-thread-surface="review"]')).not.toBeNull();
      await act(async () =>
        view.host.querySelector<HTMLButtonElement>('button[aria-label="Back to threads"]')?.click()
      );
      expect(view.host.querySelector('[data-thread-surface]')).toBeNull();
      const filesTab = [...view.host.querySelectorAll('[role="tab"]')].find(
        (node) => node.textContent === 'Board files'
      ) as HTMLElement;
      await act(async () => filesTab.click());
      await act(async () =>
        view.host.querySelector<HTMLButtonElement>('[data-id="notes"]')?.click()
      );
      expect(view.host.querySelector('textarea')?.value).toBe('# Shared');
    } finally {
      await view.unmount();
    }
  });

  it('shows a coordinator Tab in the page instead of a second conversation in the panel', async () => {
    const store = createStore();
    const coordinator = makeSession('coordinator', { boardRole: 'coordinator' });
    // Contained Tabs inherit the Board, so the coordinator's own Tabs are threads too.
    const coordinatorTab = makeSession('coordinator-tab', { parentSessionId: coordinator.id });
    const sideChat = makeSession('side-chat', {
      parentSessionId: coordinator.id,
      childSessionPlacement: 'side-panel',
    });
    const thread = makeSession('thread');
    store.set(
      sessionMetaCacheAtom,
      Object.fromEntries(
        [coordinator, coordinatorTab, sideChat, thread].map((entry) => [
          getSessionRoomId(entry.id),
          entry,
        ])
      )
    );
    /**
     * The coordinator's page as far as conversation surfaces go: it mounts the
     * coordinator, its Tabs and Side Chats, and shows the one selected; the
     * Board panel renders only what it opens itself.
     */
    function CoordinatorPage() {
      const [selected, setSelected] = useState<string>(coordinator.id);
      const [panelThreadId, setPanelThreadId] = useState<SessionId | null>(null);
      return (
        <>
          {[coordinator, coordinatorTab, sideChat].map((session) => (
            <section
              key={session.id}
              data-chat-surface={session.id}
              hidden={session.id !== selected}
            />
          ))}
          <BoardSidePanel
            board={testBoard()}
            openThreadId={panelThreadId}
            onOpenThread={(session) => setPanelThreadId(session?.id ?? null)}
            onShowInPage={(session) => setSelected(session.id)}
            onOpenThreadFull={() => {}}
            renderThread={(session) => <section data-chat-surface={session.id} />}
            onArchived={() => {}}
          />
        </>
      );
    }
    const view = await mount(
      <Provider store={store}>
        <CoordinatorPage />
      </Provider>
    );
    const surfaces = (id: string) =>
      view.host.querySelectorAll(`[data-chat-surface="${id}"]`).length;
    const visible = () =>
      [...view.host.querySelectorAll('[data-chat-surface]:not([hidden])')].map((node) =>
        node.getAttribute('data-chat-surface')
      );
    const open = (id: string) =>
      act(async () => view.host.querySelector<HTMLButtonElement>(`[data-id="${id}"]`)?.click());
    try {
      await open(coordinatorTab.id);
      expect(surfaces(coordinatorTab.id)).toBe(1);
      expect(visible()).toEqual([coordinatorTab.id]);
      await open(sideChat.id);
      expect(surfaces(sideChat.id)).toBe(1);
      expect(visible()).toEqual([sideChat.id]);
      await open(thread.id);
      expect(surfaces(thread.id)).toBe(1);
      expect(visible()).toEqual([sideChat.id, thread.id]);
    } finally {
      await view.unmount();
    }
  });

  it('marks a Board by its strongest member state', () => {
    const board = testBoard();
    const working = makeSession('working');
    const waiting = makeSession('waiting', { awaitingUserSince: 20, lastMessageAt: 10 });
    const answered = makeSession('answered', { awaitingUserSince: 10, lastMessageAt: 20 });
    const elsewhere = makeSession('elsewhere', { boardId: 'bd_other' as never });
    const running = new Map<string, SessionStatus>([
      [working.id, { type: 'running' } as SessionStatus],
      [elsewhere.id, { type: 'requestPermission' } as SessionStatus],
    ]);
    expect(boardActivity(board, [answered], new Map())).toBeNull();
    expect(boardActivity(board, [answered, working, elsewhere], running)).toBe('working');
    expect(boardActivity(board, [working, waiting], running)).toBe('waiting');
    expect(
      boardActivity(
        board,
        [working],
        new Map([[working.id, { type: 'requestPermission' } as SessionStatus]])
      )
    ).toBe('waiting');
  });
});

it('saves Board settings to the catalog row and renames the coordinator with the Board', async () => {
  const env = await boardRuntime([makeSession('coordinator', { boardRole: 'coordinator' })]);
  const store = workspaceStore(env.runtime);
  let closed = false;
  const view = await mount(
    <Provider store={store}>
      <BoardSettingsDialog board={testBoard()} onClose={() => (closed = true)} />
    </Provider>
  );
  try {
    await typeInto(
      document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!,
      ' Launch '
    );
    expect(document.body.textContent).not.toContain('Archive Board');
    await submitForm();
    expect(closed).toBe(true);
    expect(env.board('bd_test')).toMatchObject({ name: 'Launch', purpose: 'Ship it' });
    expect((await env.meta('coordinator')).title).toBe('Launch');
  } finally {
    await view.unmount();
    await env.destroy();
  }
});

it('starts the Board panel afresh on another Board, so a settings draft never saves into it', async () => {
  const boardA = testBoard();
  const boardB = testBoard({ id: 'bd_b' as never, name: 'Docs', coordinatorSessionId: 'coord-b' });
  const env = await boardRuntime([
    makeSession('coordinator', { boardRole: 'coordinator', title: 'Release' }),
    makeSession('coord-b', { boardId: 'bd_b' as never, boardRole: 'coordinator', title: 'Docs' }),
  ]);
  await writeWorkspaceBoard(env.runtime, boardA);
  await writeWorkspaceBoard(env.runtime, boardB);
  const store = workspaceStore(env.runtime);
  let showBoard!: (board: BoardMeta) => void;
  function Page() {
    const [board, setBoard] = useState(boardA);
    showBoard = setBoard;
    return (
      <BoardSidePanel
        board={board}
        openThreadId={null}
        onOpenThread={() => {}}
        onShowInPage={() => {}}
        onOpenThreadFull={() => {}}
        renderThread={() => null}
        onArchived={() => {}}
      />
    );
  }
  const view = await mount(
    <Provider store={store}>
      <Page />
    </Provider>
  );
  const nameInput = () => document.querySelector<HTMLInputElement>('input[aria-label="Name"]');
  const openSettings = () =>
    act(async () =>
      view.host.querySelector<HTMLButtonElement>('button[aria-label="Board settings"]')!.click()
    );
  try {
    await openSettings();
    await typeInto(nameInput()!, 'Draft for Release');
    // Browser history moves the page to Board B while A's dialog is open.
    await act(async () => showBoard(boardB));
    expect(nameInput()).toBeNull();
    await openSettings();
    expect(nameInput()?.value).toBe('Docs');
    await submitForm();
    expect(env.board('bd_b')).toMatchObject({ name: 'Docs' });
    expect(env.board('bd_test')).toMatchObject({ name: 'Release' });
    expect((await env.meta('coord-b')).title).toBe('Docs');
  } finally {
    await view.unmount();
    await env.destroy();
  }
});

it('archives and restores a Board with its members, and keeps it where it was when a member fails', async () => {
  const sessions = [
    makeSession('coordinator', { boardRole: 'coordinator' }),
    makeSession('root'),
    makeSession('review', { parentSessionId: 'root' as SessionId }),
    makeSession('second'),
    makeSession('other', { boardId: 'bd_other' as never }),
  ];
  const env = await boardRuntime(sessions);
  await writeWorkspaceBoard(env.runtime, testBoard());
  const store = workspaceStore(env.runtime);
  let lifecycle!: ReturnType<typeof useBoardLifecycle>;
  function Probe() {
    lifecycle = useBoardLifecycle();
    return null;
  }
  const view = await mount(
    <Provider store={store}>
      <Probe />
    </Provider>
  );
  const archived = async () => {
    const metas = await Promise.all(sessions.map((session) => env.meta(session.id)));
    return metas.filter((meta) => meta.isArchived === true);
  };
  const archivedIds = async () => (await archived()).map((meta) => meta.id);
  try {
    // A member refuses: the Board stays active, so its settings still offer Archive.
    env.failing.add(getSessionRoomId('second' as SessionId));
    await act(async () => {
      await expect(lifecycle.archiveBoard(testBoard(), sessions)).rejects.toThrow('disk full');
    });
    expect(env.board('bd_test')).not.toHaveProperty('archivedAtMs');
    env.failing.clear();
    await act(async () => lifecycle.archiveBoard(testBoard(), sessions));
    expect(env.board('bd_test').archivedAtMs).toEqual(expect.any(Number));
    expect(await archivedIds()).toEqual(['coordinator', 'root', 'review', 'second']);

    // Restore stops at the refusing member: the Board stays in Archive with its Restore.
    env.failing.add(getSessionRoomId('second' as SessionId));
    const toRestore = await archived();
    await act(async () => {
      await expect(lifecycle.restoreBoard(env.board('bd_test'), toRestore)).rejects.toThrow(
        'disk full'
      );
    });
    expect(env.board('bd_test').archivedAtMs).toEqual(expect.any(Number));
    expect(await archivedIds()).toEqual(['second']);
    env.failing.clear();
    await act(async () => lifecycle.restoreBoard(env.board('bd_test'), await archived()));
    expect(env.board('bd_test')).not.toHaveProperty('archivedAtMs');
    expect(await archivedIds()).toEqual([]);
  } finally {
    await view.unmount();
    await env.destroy();
  }
});

it('creates a Board from its goal, naming it after the first line with default rules', async () => {
  const store = createStore();
  const { runtime, board } = catalogRuntime();
  store.set(userAtom, { id: 'user', name: 'User', email: 'user@example.com' });
  store.set(currentWorkspaceIdAtom, 'ws' as WorkspaceId);
  store.set(currentWorkspaceSlugAtom, 'ws');
  store.set(runtimeAtom, runtime);
  store.set(agentConfigMetaCacheAtom, {
    config: {
      id: 'config',
      machineId: 'machine',
      cliType: 'builtin',
      agentType: 'claude',
      name: 'Agent',
      prompt: '',
    } as AgentConfigMeta,
  });
  creation.machines = new Map([
    ['machine', { id: 'machine', name: 'Desktop', ownerUserId: 'user' }],
  ]);
  const accepted: SessionToCreate[] = [];
  creation.startSession = async (...args: unknown[]) => {
    const [payload, history] = args as [SessionToCreate, Omit<SessionHistoryInput, 'id'>];
    accepted.push(payload);
    return { sessionId: payload.sessionId, historyEntry: { ...history, id: 'first-turn' } };
  };
  const created: BoardMeta[] = [];
  const view = await mount(
    <Provider store={store}>
      <CreateBoardDialog onClose={() => {}} onCreated={(entry) => created.push(entry)} />
    </Provider>
  );
  try {
    expect(document.querySelectorAll('input[type="number"]')).toHaveLength(0);
    const goal = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        goal,
        'Ship the Board home\nKeep it small.'
      );
      goal.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      document
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(created).toHaveLength(1);
    expect(board(created[0]!.id)).toMatchObject({
      name: 'Ship the Board home',
      purpose: 'Ship the Board home\nKeep it small.',
      rules: { maxRoundsPerThread: 4, reportHumanTurns: false, executorConstraints: '' },
    });
    expect(accepted[0]).toMatchObject({
      boardId: created[0]!.id,
      boardRole: 'coordinator',
      title: 'Ship the Board home',
    });
  } finally {
    await view.unmount();
    creation.startSession = undefined;
    creation.machines.clear();
  }
});

it('joins and removes a session through real metadata without altering its ordinary fields', async () => {
  const repo = await LoroRepo.create({});
  const session = makeSession('membership', { boardId: undefined });
  const board = normalizeBoardMeta({
    version: 1,
    id: 'bd_join',
    name: 'Join',
    purpose: 'Ship',
    coordinatorSessionId: 'coordinator',
    createdAtMs: 1,
    createdByUserId: 'user',
  });
  if (!board) throw new Error('Invalid fixture');
  const runtime = {
    repo,
    writer: {
      upsertDocMeta: (id: string, patch: Record<string, unknown>) => repo.upsertDocMeta(id, patch),
    },
  } as Parameters<typeof changeBoardMembership>[0];
  try {
    await repo.upsertDocMeta(getSessionRoomId(session.id), session);
    await changeBoardMembership(runtime, session, board, 100);
    expect((await repo.getDocMeta(getSessionRoomId(session.id)))?.meta).toMatchObject({
      title: session.title,
      boardId: board.id,
      boardJoinedAtMs: 100,
    });
    await changeBoardMembership(runtime, session);
    const meta = (await repo.getDocMeta(getSessionRoomId(session.id)))?.meta;
    expect(meta?.title).toBe(session.title);
    expect(meta).not.toHaveProperty('boardId');
    expect(meta).not.toHaveProperty('boardJoinedAtMs');
    await repo.upsertDocMeta(getSessionRoomId(session.id), {
      boardId: board.id,
      boardRole: 'coordinator',
    });
    await expect(changeBoardMembership(runtime, session)).rejects.toThrow(
      'BOARD_COORDINATOR_FIXED'
    );
    expect((await repo.getDocMeta(getSessionRoomId(session.id)))?.meta?.boardId).toBe(board.id);
  } finally {
    await repo.destroy();
  }
});

it('edits and previews shared notes and retains an unsaved draft on write failure', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let saved = '';
  const onSave = async (text: string) => {
    saved = text;
    throw new Error('disk full');
  };
  try {
    await act(async () => root.render(<BoardNotesEditor notes="# Original" onSave={onSave} />));
    const input = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        '# Updated'
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const button = (label: string) =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;
    await act(async () => button('Preview').click());
    expect(container.querySelector('h1')?.textContent).toBe('Updated');
    await act(async () => button('Save notes').click());
    expect(saved).toBe('# Updated');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('draft is retained');
    await act(async () => button('Edit').click());
    expect(container.querySelector('textarea')?.value).toBe('# Updated');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('submits a new Board thread as chat without the coordinator role', async () => {
  const store = createStore();
  const board = normalizeBoardMeta({
    version: 1,
    id: 'bd_new_thread',
    name: 'Release',
    purpose: 'Ship',
    coordinatorSessionId: 'coordinator',
    createdAtMs: 1,
    createdByUserId: 'user',
  });
  if (!board) throw new Error('Invalid fixture');
  store.set(userAtom, { id: 'user', name: 'User', email: 'user@example.com' });
  store.set(currentWorkspaceIdAtom, 'ws' as WorkspaceId);
  store.set(currentWorkspaceSlugAtom, 'ws');
  store.set(runtimeAtom, { workspaceId: 'ws', workspaceSlug: 'ws' } as WorkspaceRuntime);
  const config = {
    id: 'config',
    machineId: 'machine',
    cliType: 'builtin',
    agentType: 'claude',
    name: 'Agent',
    prompt: 'Agent instructions',
  } as AgentConfigMeta;
  store.set(agentConfigMetaCacheAtom, { config });
  creation.machines = new Map([
    ['machine', { id: 'machine', name: 'Desktop', ownerUserId: 'user' }],
  ]);
  const accepted: { payload: SessionToCreate; history: Omit<SessionHistoryInput, 'id'> }[] = [];
  creation.startSession = async (...args: unknown[]) => {
    const [payload, history] = args as [SessionToCreate, Omit<SessionHistoryInput, 'id'>];
    accepted.push({ payload, history });
    return { sessionId: payload.sessionId, historyEntry: { ...history, id: 'first-turn' } };
  };
  function NewThread() {
    const [created, setCreated] = useState(false);
    return created ? (
      <p>Thread accepted</p>
    ) : (
      <CreateBoardDialog
        existingBoard={board!}
        onClose={() => {}}
        onCreated={() => setCreated(true)}
      />
    );
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <PlatformContext.Provider value={testPlatform}>
          <Provider store={store}>
            <NewThread />
          </Provider>
        </PlatformContext.Provider>
      )
    );
    await act(async () => {
      const name = document.querySelector('input')!;
      const task = document.querySelector('textarea')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        name,
        'Implement notes'
      );
      name.dispatchEvent(new Event('input', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        task,
        'Build shared notes'
      );
      task.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      document
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(container.textContent).toBe('Thread accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.payload).toMatchObject({
      boardId: board.id,
      title: 'Implement notes',
      machineId: 'machine',
    });
    expect(accepted[0]?.payload).not.toHaveProperty('boardRole');
    expect(accepted[0]?.payload).not.toHaveProperty('project');
    expect(accepted[0]?.payload.sessionId).not.toBe(board.coordinatorSessionId);
    expect(accepted[0]?.history.inputConfig?.prompt).toContain('Build shared notes');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    creation.startSession = undefined;
    creation.machines.clear();
  }
});
