// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { describe, it, expect, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';
import {
  getSessionRoomId,
  normalizeBoardMeta,
  type AgentConfigMeta,
  type BoardMeta,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type SessionStatus,
  type SessionToCreate,
  type WorkspaceId,
} from '@lody/shared';
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

const creation = vi.hoisted(() => ({
  machines: new Map<string, unknown>(),
  startSession: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
  /** Lifecycle requests that reached the session actions, in order. */
  actions: [] as string[],
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
vi.mock('@/hooks/use-session-actions', () => ({
  useSessionActions: () => ({
    startSession: (...args: unknown[]) => creation.startSession?.(...args),
    requestSessionDispatch: async () => {},
    archiveSession: async (id: string) => void creation.actions.push(`archive:${id}`),
    restoreSession: async (id: string) => void creation.actions.push(`restore:${id}`),
    updateSessionTitle: async (id: string, title: string) =>
      void creation.actions.push(`title:${id}:${title}`),
  }),
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

async function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    host,
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
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
        (node) => node.textContent === 'Files'
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
  const store = createStore();
  const { runtime, board } = catalogRuntime();
  store.set(runtimeAtom, runtime);
  store.set(currentWorkspaceIdAtom, 'ws' as WorkspaceId);
  creation.actions = [];
  let closed = false;
  const view = await mount(
    <Provider store={store}>
      <BoardSettingsDialog board={testBoard()} onClose={() => (closed = true)} />
    </Provider>
  );
  try {
    const name = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        name,
        ' Launch '
      );
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.body.textContent).not.toContain('Archive Board');
    await act(async () => {
      document
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(closed).toBe(true);
    expect(board('bd_test')).toMatchObject({ name: 'Launch', purpose: 'Ship it' });
    expect(creation.actions).toEqual(['title:coordinator:Launch']);
  } finally {
    await view.unmount();
  }
});

it('archives a Board with its coordinator and member roots, then restores them all', async () => {
  const store = createStore();
  const { runtime, board } = catalogRuntime();
  store.set(runtimeAtom, runtime);
  store.set(currentWorkspaceIdAtom, 'ws' as WorkspaceId);
  creation.actions = [];
  const sessions = [
    makeSession('coordinator', { boardRole: 'coordinator' }),
    makeSession('root'),
    makeSession('review', { parentSessionId: 'root' as SessionId }),
    makeSession('other', { boardId: 'bd_other' as never }),
  ];
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
  try {
    await act(async () => lifecycle.archiveBoard(testBoard(), sessions));
    expect(creation.actions).toEqual(['archive:coordinator', 'archive:root']);
    expect(board('bd_test').archivedAtMs).toEqual(expect.any(Number));
    creation.actions = [];
    await act(async () => lifecycle.restoreBoard(board('bd_test'), sessions));
    expect(board('bd_test')).not.toHaveProperty('archivedAtMs');
    expect(creation.actions).toEqual(['restore:coordinator', 'restore:root']);
  } finally {
    await view.unmount();
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
        <Provider store={store}>
          <NewThread />
        </Provider>
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
