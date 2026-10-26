import { normalizeAgentRole } from '@lody/shared';
// @vitest-environment jsdom
import {
  useBoardSessionNavigation,
  boardSessionNavigationAtom,
} from '../src/components/boards/board-session-navigation';
import {
  SessionFileScope,
  SessionFileScopeHost,
  useThreadFileLinks,
} from '../src/components/sessions/session-file-scope';
import { SessionFileContentView } from '../src/components/sessions/session-file-content-view';
import { resolveSessionFileLinkOpen } from '../src/lib/session-file-link-open';
import {
  createFakeSessionFileProvider,
  type SessionFileProvider,
} from '../src/lib/session-file-provider';
import { BoardFileLinkPreview, BoardFilePreview } from '../src/components/boards/board-directory';
import {
  boardDocumentFilePath,
  resolveBoardFileLink,
} from '../src/lib/board-directory-file-provider';
import {
  MarkdownRenderer,
  AgentFileLinkOpenContext,
} from '../src/components/ai-gui/markdown-renderer';
import { SESSION_DEEP_LINK_EVENT } from '../src/lib/session-deep-link';
import { SessionLinkProvider } from '../src/components/ai-gui/session-link-context';
import { WORKING_HAND_OVER_MS } from '../src/ui/working-status-mark';
import { BoardThreadStatusCard } from '../src/components/boards/board-thread-status-card';
import { SessionRelationCard } from '../src/components/shared/session-relation-card';
import { Toast } from '@lody/ui';
import { toastManager } from '../src/lib/toast';
import { BoardThreadMark } from '../src/components/boards/board-thread-mark';
import { BoardThreadPaneView } from '../src/components/boards/board-panel-view';
import { act, Profiler, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { describe, it, expect, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';
import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  normalizeBoardMeta,
  readSessionOperationTargets,
  type AgentConfigMeta,
  type BoardMeta,
  type LocalProjectId,
  type MachineId,
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
import {
  lodyPresenceNowMsAtom,
  lodyPresenceStatesAtom,
  lodyPresenceSyncStateAtom,
} from '../src/atoms/presence';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import {
  scheduleRowsForBoard,
  scheduleBoundSession,
  isScheduleBoardThread,
} from '../src/components/schedules/schedule-scope';
import {
  buildScheduleRegistryRow,
  ScheduleDefinitionSchema,
  scheduleOwnSessionId,
} from '@lody/shared';
import { CreateBoardDialog } from '../src/components/boards/create-board-dialog';
import { changeBoardMembership } from '../src/components/boards/board-membership-dialog';
import { BoardNotesEditor } from '../src/components/boards/board-notes-panel';
import { BoardSidePanel } from '../src/components/boards/board-side-panel';
import { BoardSettings, BoardSettingsDialog } from '../src/components/boards/board-settings-panel';
import { BoardThreadListView } from '../src/components/boards/board-thread-list';
import { localProbeResultAtom } from '../src/atoms/local-probe';
import { useBoardActions, useBoardLifecycle } from '../src/components/boards/board-lifecycle';
import { BoardRenameDialog } from '../src/components/boards/board-rename-dialog';
import {
  boardScopeNames,
  boardScopeOptionState,
  buildBoardScopeOptions,
  toggleBoardScopeOption,
  type BoardScopeLocalProject,
} from '../src/components/boards/board-project-scope';
import { BoardSidebar } from '../src/components/boards/board-sidebar-section';
import { SessionHeaderMenu } from '../src/components/sessions/session-chat-interface';
import { boardExperimentEnabledAtom, experimentalFeaturesEnabledAtom } from '../src/atoms/settings';
import {
  boardActivity,
  resolveBoardThreadPageNavigation,
  resolveBoardThreadParent,
  formatBoardSessionTitle,
  resolveSidebarBoardSelection,
  boardMemberEntrySearch,
  isBoardSession,
} from '../src/components/boards/board-threads';
import { closeSessionTab } from '../src/components/sessions/session-tab-close-target';
import { useSessionActions } from '../src/hooks/use-session-actions';
import { writeWorkspaceBoard } from '../src/lib/workspace-catalog-write';

const creation = vi.hoisted(() => ({
  machines: new Map<string, unknown>(),
  roles: [] as import('@lody/shared').AgentRole[],
  unavailableTargets: new Set<string>(),
  fileProviders: new Map<string, SessionFileProvider>(),
  fileIndexRevision: 0,
  fileIndexListeners: new Set<() => void>(),
  fileLeases: new Set<string>(),
  startSession: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
  /** The product language, as i18next names it. */
  language: 'en',
  /** The workspace catalog's Board rows. */
  boards: [] as BoardMeta[],
}));
vi.mock('@/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => ({
    machines: creation.machines,
    accessByMachineId: new Map(),
    isLoading: false,
  }),
}));
vi.mock('@/hooks/use-code-collab-requested-role', () => ({
  useCodeCollabRequestedRole: () => 'read',
}));
vi.mock('@/hooks/use-code-collab-session-file-provider', async (importOriginal) => {
  const { useEffect, useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    creation.fileIndexListeners.add(listener);
    return () => {
      creation.fileIndexListeners.delete(listener);
    };
  };
  const noSubscription = () => () => {};
  return {
    ...(await importOriginal<object>()),
    useCodeCollabSessionFileProvider: ({
      sessionId,
      machineId,
      enabled,
    }: {
      sessionId: string;
      machineId: string;
      enabled: boolean;
    }) => {
      useSyncExternalStore(enabled ? subscribe : noSubscription, () =>
        enabled ? creation.fileIndexRevision : 0
      );
      useEffect(() => {
        if (!enabled) return undefined;
        creation.fileLeases.add(sessionId);
        return () => {
          creation.fileLeases.delete(sessionId);
        };
      }, [enabled, sessionId]);
      return {
        provider: enabled
          ? (creation.fileProviders.get(`${machineId}:${sessionId}`) ?? null)
          : null,
        status: enabled ? 'ready' : 'disabled',
        role: 'read',
      };
    },
  };
});
vi.mock('@/hooks/use-resolved-machine-meta', () => ({
  useResolvedMachineMeta: (id: string) => ({
    machine: creation.machines.get(id),
    machineFlockRows: {},
  }),
}));
vi.mock('@/components/sessions/session-monaco-text-viewer', () => ({
  SessionMonacoTextViewer: ({ text }: { text: string }) => <pre>{text}</pre>,
}));
// Visibility is its own concern; the panel reads every member from the real atoms.
vi.mock('@/hooks/use-visible-session-metas', async () => {
  const { useAtomValue: read } = await import('jotai');
  const { allActiveSessionsAtom: active, archivedSessionListAtom: archived } =
    await import('../src/atoms/doc-meta');
  const visibleMachineIds = new Set(['machine', 'remote', 'devnuc', 'machine-1']);
  const visibleLocalProjectKeys = new Set<string>();
  return {
    useVisibleMachineIdSet: () => ({ visibleMachineIds, isLoading: false }),
    useVisibleLocalProjectKeySet: () => ({ visibleLocalProjectKeys, isLoading: false }),
    useVisibleSessionMetas: () => ({ allActiveSessions: read(active) }),
    useVisibleArchivedSessionMetas: () => ({ archivedSessions: read(archived) }),
  };
});
vi.mock('@/hooks/use-machine-flock-rows', () => ({
  useMachineFlockRowsByMachineIds: () => new Map(),
  useMachineFlockRows: () => ({}),
}));
vi.mock('@/hooks/use-board-document', () => ({
  useBoardDocument: () => ({ document: { notes: '# Shared' }, save: async () => {} }),
}));
vi.mock('@/hooks/use-machine-flock-agent-configs', () => ({
  useMachineFlockAgentConfigs: () => {},
}));
vi.mock('@/hooks/use-workspace-catalog', () => ({
  useWorkspaceCatalog: () => ({ servers: [], boards: creation.boards }),
}));
vi.mock('@/hooks/use-workspace-agent-roles', () => ({
  useWorkspaceAgentRoles: () => ({ roles: creation.roles }),
  useAgentRoleAvailability: () => ({
    resolveInstance: (target: { id: string }) =>
      creation.unavailableTargets.has(target.id)
        ? { kind: 'unavailable', reason: 'agent_config_missing' }
        : { kind: 'available' },
  }),
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
// The project picker is its own suite; here it only hands the dialog a repository.
vi.mock('@/components/shared/project-ref-selector', () => ({
  ProjectRefSelector: ({ onChange }: { onChange: (project: unknown) => void }) => (
    <button
      type="button"
      data-testid="pick-repository"
      onClick={() => onChange({ kind: 'github', repoFullName: 'owner/web', branch: 'main' })}
    />
  ),
}));
// GitHub answers the repository's default branch.
vi.mock('@/lib/github-token', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withGitHubTokenRetry: async (_workspaceId: string, repoFullName: string) =>
    repoFullName === 'owner/web' ? 'release' : 'main',
}));
vi.mock('@/components/sessions/desktop-run-config-menu', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  DesktopMachineMenu: () => null,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: creation.language },
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
      deleteDoc: (id: string) => repo.deleteDoc(id),
    },
    readSessionOperationTargets: (id: SessionId, operation: 'archive' | 'restore') =>
      readSessionOperationTargets(repo, id, operation),
    ensureDocStream: async () => {},
    releaseSessionStore: async () => {},
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
  store.set(localProbeResultAtom, { ok: true, machineId: 'machine' });
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

/**
 * The desktop's IPC as this machine's agent service would answer it: Board
 * directory listings by area, and member files as `data:` URLs.
 */
function installIpc(answers: Record<string, unknown>) {
  const requests: { method?: string; params?: unknown }[] = [];
  const target = window as unknown as Record<string, unknown>;
  target.__LODY_ELECTRON__ = true;
  target.ipc = {
    invoke: async (channel: string, message: Record<string, unknown>) => {
      if (channel === 'machineRpc.send') {
        requests.push(message);
        const params = message.params as { area: string };
        return { ok: true, result: answers[`${String(message.method)}:${params.area}`] };
      }
      if (channel === 'machineRpc.openMemberFile') {
        requests.push({ method: 'openMemberFile', params: message });
        const body = answers[`file:${String(message.path)}`];
        return typeof body === 'string'
          ? { ok: true, url: `data:text/plain,${encodeURIComponent(body)}`, sizeBytes: body.length }
          : {
              ok: false,
              error: `ENOENT: no such file or directory, open '/data/boards/ws/bd_test/${String(message.path)}'`,
            };
      }
      if (channel === 'machineRpc.saveMemberFile') {
        requests.push({ method: 'saveMemberFile', params: message });
        return { ok: true, saved: true, path: `/downloads/${String(message.fileName)}` };
      }
      throw new Error(`unexpected IPC ${channel}`);
    },
    on: () => () => {},
    send: () => {},
  };
  return {
    requests,
    remove() {
      delete target.__LODY_ELECTRON__;
      delete target.ipc;
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
  it('leaves the card unmarked until its metadata belongs to a Board', async () => {
    const store = createStore();
    const thread = makeSession('thread', { boardId: undefined, lastMessageAt: 20, lastReadAt: 20 });
    const child = makeSession('child', {
      boardId: undefined,
      openedBySessionId: thread.id,
      awaitingUserSince: 30,
    });
    const view = await mount(
      <Provider store={store}>
        <BoardThreadStatusCard sessionId={thread.id} />
      </Provider>
    );
    const marks = () =>
      view.host.querySelector(
        '[data-session-row-indicator], svg.lucide-check, svg.lucide-circle-slash'
      );
    try {
      expect(marks()).toBeNull();
      await act(async () => {
        store.set(sessionMetaCacheAtom, {
          [getSessionRoomId(thread.id)]: thread,
          [getSessionRoomId(child.id)]: child,
        });
        store.set(lodyPresenceNowMsAtom, 1000);
        store.set(lodyPresenceSyncStateAtom, 'synced');
        store.set(lodyPresenceStatesAtom, {
          machine: {
            kind: 'machine',
            machineId: thread.machineId,
            instanceId: 'test' as never,
            updatedAt: 1000,
          },
        });
      });
      expect(marks()).toBeNull();
      await act(async () =>
        store.set(sessionMetaCacheAtom, {
          [getSessionRoomId(thread.id)]: { ...thread, boardId: 'bd_test' as never },
          [getSessionRoomId(child.id)]: child,
        })
      );
      expect(view.host.querySelector('svg.lucide-check')).not.toBeNull();
      await act(async () =>
        store.set(sessionMetaCacheAtom, {
          [getSessionRoomId(thread.id)]: thread,
          [getSessionRoomId(child.id)]: child,
        })
      );
      expect(marks()).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('does not commit card renders for unrelated activity or unchanged family status', async () => {
    const store = createStore();
    const thread = makeSession('thread', { lastMessageAt: 20, lastReadAt: 20 });
    const child = makeSession('child', { openedBySessionId: thread.id });
    const unrelated = makeSession('unrelated');
    const outside = makeSession('outside', { boardId: undefined });
    const sessions = [thread, child, unrelated, outside];
    store.set(
      sessionMetaCacheAtom,
      Object.fromEntries(sessions.map((entry) => [getSessionRoomId(entry.id), entry]))
    );
    const online = {
      machine: {
        kind: 'machine' as const,
        machineId: thread.machineId,
        instanceId: 'test' as never,
        updatedAt: 1000,
      },
    };
    store.set(lodyPresenceNowMsAtom, 1000);
    store.set(lodyPresenceSyncStateAtom, 'synced');
    store.set(lodyPresenceStatesAtom, online);
    let commits = 0;
    const view = await mount(
      <Provider store={store}>
        <Profiler
          id="thread-card"
          onRender={() => {
            commits++;
          }}
        >
          <BoardThreadStatusCard sessionId={thread.id} />
        </Profiler>
      </Provider>
    );
    try {
      expect(view.host.querySelector('svg.lucide-check')).not.toBeNull();
      const initialCommits = commits;
      await act(async () =>
        store.set(lodyPresenceStatesAtom, {
          ...online,
          ...live(unrelated, { type: 'requestPermission' } as SessionStatus),
        })
      );
      expect(commits).toBe(initialCommits);
      for (const target of [outside, unrelated]) {
        await act(async () =>
          store.set(
            sessionMetaCacheAtom,
            Object.fromEntries(
              sessions.map((entry) => [
                getSessionRoomId(entry.id),
                entry.id === target.id ? { ...entry, title: 'New title' } : entry,
              ])
            )
          )
        );
        expect(commits).toBe(initialCommits);
      }
      expect(view.host.querySelector('svg.lucide-check')).not.toBeNull();
      await act(async () =>
        store.set(lodyPresenceStatesAtom, {
          ...online,
          ...live(child, { type: 'running' } as SessionStatus),
        })
      );
      expect(view.host.querySelector('[data-session-working-indicator]')).not.toBeNull();
      expect(view.host.querySelector('svg.lucide-check')).toBeNull();
      const workingCommits = commits;
      // A fresh presence object with the same rendered status must not commit again.
      await act(async () =>
        store.set(lodyPresenceStatesAtom, {
          ...online,
          ...live(child, { type: 'running' } as SessionStatus),
        })
      );
      expect(commits).toBe(workingCommits);
      await act(async () =>
        store.set(lodyPresenceStatesAtom, {
          ...online,
          ...live(child, { type: 'requestPermission' } as SessionStatus),
        })
      );
      expect(view.host.querySelector('[data-session-working-indicator]')).toBeNull();
      expect(view.host.querySelector('[data-session-row-indicator] svg')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('shows a card as complete only after its entire visible family settles', async () => {
    const store = createStore();
    const thread = makeSession('thread', { lastMessageAt: 20, lastReadAt: 20 });
    const child = makeSession('child', {
      openedBySessionId: thread.id,
      machineId: 'remote' as never,
    });
    const tab = makeSession('tab', { parentSessionId: child.id });
    const unrelated = makeSession('unrelated', { awaitingUserSince: 30 });
    const otherBoard = makeSession('other-board', {
      boardId: 'bd_other' as never,
      openedBySessionId: thread.id,
      awaitingUserSince: 30,
    });
    const sessions = [thread, child, tab, unrelated, otherBoard];
    const setSessions = (entries = sessions) =>
      store.set(
        sessionMetaCacheAtom,
        Object.fromEntries(entries.map((entry) => [getSessionRoomId(entry.id), entry]))
      );
    setSessions();
    const online = {
      machine: {
        kind: 'machine' as const,
        machineId: thread.machineId,
        instanceId: 'test' as never,
        updatedAt: 1000,
      },
      remote: {
        kind: 'machine' as const,
        machineId: child.machineId,
        instanceId: 'test' as never,
        updatedAt: 1000,
      },
    };
    store.set(lodyPresenceNowMsAtom, 1000);
    store.set(lodyPresenceSyncStateAtom, 'synced');
    store.set(lodyPresenceStatesAtom, online);
    vi.useFakeTimers();
    const view = await mount(
      <Provider store={store}>
        <BoardThreadStatusCard sessionId={thread.id} />
      </Provider>
    );
    const check = () => view.host.querySelector('svg.lucide-check');
    const working = () => view.host.querySelector('[data-session-working-indicator]');
    const waiting = () => view.host.querySelector('[data-session-row-indicator] svg');
    try {
      expect(check()).not.toBeNull();
      // Both opened sessions and their Tabs participate, including live phase changes.
      for (const member of [child, tab]) {
        for (const status of [
          { type: 'running' },
          { type: 'initializing' },
          { type: 'running', phase: 'finalizing' },
        ] as SessionStatus[]) {
          await act(async () =>
            store.set(lodyPresenceStatesAtom, { ...online, ...live(member, status) })
          );
          expect(check()).toBeNull();
          expect(working()).not.toBeNull();
        }
        await act(async () =>
          store.set(lodyPresenceStatesAtom, {
            ...online,
            ...live(thread, { type: 'running' } as SessionStatus),
            ...live(member, { type: 'requestPermission' } as SessionStatus),
          })
        );
        expect(check()).toBeNull();
        expect(waiting()).not.toBeNull();
        expect(working()).toBeNull();
      }
      await act(async () => {
        store.set(lodyPresenceStatesAtom, online);
        setSessions(
          sessions.map((member) =>
            member.id === child.id ? { ...member, awaitingUserSince: 30 } : member
          )
        );
      });
      expect(check()).toBeNull();
      expect(waiting()).not.toBeNull();
      await act(async () => vi.advanceTimersByTime(WORKING_HAND_OVER_MS));
      await act(async () =>
        setSessions(
          sessions.map((member) =>
            member.id === child.id ? { ...member, collaborationStopped: true } : member
          )
        )
      );
      expect(check()).toBeNull();
      expect(view.host.querySelector('svg.lucide-circle-slash')).not.toBeNull();
      await act(async () => setSessions());
      expect(check()).not.toBeNull();
      // Fresh heartbeats keep members online while the transport is not synced
      // (a local-only workspace stays idle).
      for (const state of ['idle', 'connecting', 'disconnected'] as const) {
        await act(async () => store.set(lodyPresenceSyncStateAtom, state));
        expect(check()).not.toBeNull();
      }
      await act(async () => {
        store.set(lodyPresenceSyncStateAtom, 'synced');
        store.set(lodyPresenceStatesAtom, { machine: online.machine });
      });
      expect(check()).toBeNull();
      await act(async () => store.set(lodyPresenceStatesAtom, online));
      expect(check()).not.toBeNull();
      await act(async () =>
        setSessions(
          sessions.map((member) =>
            member.id === thread.id
              ? {
                  ...member,
                  latestUserMsgId: 'later-receipt',
                  lastHandledUserMsgId: 'later-receipt',
                  lastMessageAt: 40,
                  lastReadAt: 40,
                }
              : member
          )
        )
      );
      expect(check()).not.toBeNull();
      await act(async () =>
        setSessions(
          sessions.map((member) =>
            member.id === child.id ? { ...member, lastMessageAt: 50 } : member
          )
        )
      );
      // Unopened child results do not hold the parent card's completion mark hostage.
      expect(check()).not.toBeNull();
      expect(view.host.querySelector('[data-session-unread-dot]')).toBeNull();
      await act(async () =>
        setSessions(
          sessions.map((member) =>
            member.id === thread.id ? { ...member, lastMessageAt: 50 } : member
          )
        )
      );
      expect(check()).toBeNull();
      expect(view.host.querySelector('[data-session-unread-dot]')).not.toBeNull();
    } finally {
      await view.unmount();
      vi.useRealTimers();
    }
  });

  it('lists members from metadata and presence, groups them, and opens one in the panel', async () => {
    const store = createStore();
    const coordinator = makeSession('coordinator', { boardRole: 'coordinator' });
    const root = makeSession('root', { lastMessageAt: 50 });
    const tab = makeSession('review', { parentSessionId: root.id });
    const waiting = makeSession('waiting', { awaitingUserSince: 20, lastMessageAt: 10 });
    const answered = makeSession('answered', {
      awaitingUserSince: 10,
      lastMessageAt: 20,
      lastReadAt: 10,
    });
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
          renderThread={(thread, controls) => (
            <BoardThreadPaneView title={thread.title ?? ''} {...controls}>
              <p data-thread-surface={thread.id}>{thread.title}</p>
            </BoardThreadPaneView>
          )}
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
      // stale durable status never reads as work. A thread and its Tab stay
      // together under the thread's strongest state.
      expect(ids()).toEqual(['stopped-child', 'waiting', 'root', 'review', 'answered']);
      expect(groups()).toEqual(['Needs you2', 'Working2', 'Idle1']);
      // Rows carry sidebar marks: ✋ waiting, the working grid, the unread dot.
      const mark = (id: string) => {
        const row = view.host.querySelector(`[data-id="${id}"]`);
        if (row?.querySelector('[data-session-working-indicator]')) return 'working';
        if (row?.querySelector('[data-session-unread-dot]')) return 'unread';
        if (row?.querySelector('[data-session-row-indicator] svg')) return 'waiting';
        return null;
      };
      expect(['waiting', 'root', 'answered', 'review'].map(mark)).toEqual([
        'waiting',
        'working',
        'unread',
        null,
      ]);
      const rootRow = view.host.querySelector('[data-id="root"]');
      await act(async () => store.set(lodyPresenceStatesAtom, {}));
      expect(groups()).toEqual(['Needs you2', 'Idle3']);
      // Finishing moves the row from Working to Idle without remounting it, so its
      // mark sees working end and collapses into the unread dot as a sidebar row does.
      expect(view.host.querySelector('[data-id="root"]')).toBe(rootRow);
      expect(mark('root')).toBe('unread');
      // Read: the dot goes, as a sidebar row's does.
      await act(async () =>
        store.set(sessionMetaCacheAtom, (cache) => ({
          ...cache,
          [getSessionRoomId(answered.id)]: { ...answered, lastReadAt: 20 },
        }))
      );
      expect(mark('answered')).toBeNull();
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
            requestedThreadId={null}
            onThreadRequestDone={() => {}}
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

  it('opens a palette entry where its row opens it, so a coordinator Tab is mounted once', async () => {
    const store = createStore();
    const coordinator = makeSession('coordinator', { boardRole: 'coordinator' });
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
    const board = testBoard();
    /** The coordinator's page after the palette's `?board=1&boardThread=…` left the URL. */
    function CoordinatorPage({ boardThread }: { boardThread: string }) {
      const [selected, setSelected] = useState<string>(coordinator.id);
      const [panelThreadId, setPanelThreadId] = useState<SessionId | null>(null);
      const [request, setRequest] = useState<SessionId | null>(boardThread as SessionId);
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
            board={board}
            openThreadId={panelThreadId}
            onOpenThread={(session) => setPanelThreadId(session?.id ?? null)}
            onShowInPage={(session) => setSelected(session.id)}
            onOpenThreadFull={() => {}}
            renderThread={(session) => <section data-chat-surface={session.id} />}
            requestedThreadId={request}
            onThreadRequestDone={() => setRequest(null)}
          />
        </>
      );
    }
    for (const [member, shown] of [
      [coordinatorTab, [coordinatorTab.id]],
      [sideChat, [sideChat.id]],
      [thread, [coordinator.id, thread.id]],
    ] as const) {
      const search = boardMemberEntrySearch(board, member.id);
      expect(search).toMatchObject({ board: true, boardThread: member.id });
      const view = await mount(
        <Provider store={store}>
          <CoordinatorPage boardThread={search.boardThread!} />
        </Provider>
      );
      try {
        expect(view.host.querySelectorAll(`[data-chat-surface="${member.id}"]`)).toHaveLength(1);
        expect(
          [...view.host.querySelectorAll('[data-chat-surface]:not([hidden])')].map((node) =>
            node.getAttribute('data-chat-surface')
          )
        ).toEqual(shown);
      } finally {
        await view.unmount();
      }
    }
  });

  it('shows the Board directory in the session file tree and previews a file through the local agent', async () => {
    // jsdom lays nothing out; give the tree's scroll viewport a height, as the
    // file tree's own suite does, so its virtual rows mount.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute('data-radix-scroll-area-viewport') ? 400 : 0;
      },
    });
    const store = createStore();
    store.set(currentWorkspaceIdAtom, 'ws' as WorkspaceId);
    store.set(localProbeResultAtom, { ok: true, machineId: 'laptop' });
    // No `files` row yet: the coordinator's machine keeps the directory.
    const coordinator = makeSession('coordinator', {
      boardRole: 'coordinator',
      machineId: 'devnuc',
    });
    store.set(sessionMetaCacheAtom, { [getSessionRoomId(coordinator.id)]: coordinator });
    const ipc = installIpc({
      'board/files-list:files': {
        entries: [
          { path: 'design/plan.md', sizeBytes: 22, modifiedAtMs: 1 },
          { path: 'design/mock.sketch', sizeBytes: 4096, modifiedAtMs: 1 },
        ],
        // The area holds more than the listing limit.
        truncated: true,
      },
      'file:files/design/plan.md': '# Plan\n\nShip it.',
    });
    const view = await mount(
      <Provider store={store}>
        <BoardSidePanel
          board={testBoard()}
          openThreadId={null}
          onOpenThread={() => {}}
          onShowInPage={() => {}}
          onOpenThreadFull={() => {}}
          renderThread={() => null}
          requestedThreadId={null}
          onThreadRequestDone={() => {}}
        />
      </Provider>
    );
    try {
      const filesTab = [...view.host.querySelectorAll('[role="tab"]')].find(
        (node) => node.textContent === 'Board files'
      ) as HTMLElement;
      await act(async () => filesTab.click());
      const treeRow = (name: string) =>
        [...view.host.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].find(
          (row) => row.textContent === name
        );
      // The shared notes lead; the directory follows as the session file tree,
      // its folders built from the listed paths.
      expect(view.host.querySelector('[data-id="notes"]')).not.toBeNull();
      await vi.waitFor(() => expect(treeRow('design')).toBeDefined());
      expect(view.host.textContent).toContain('Only the first 500 files are listed.');
      await act(async () => treeRow('design')?.click());
      expect(
        [...view.host.querySelectorAll('[role="treeitem"]')].map((row) => row.textContent)
      ).toEqual(['design', 'mock.sketch', 'plan.md']);
      await act(async () => treeRow('plan.md')?.click());
      await vi.waitFor(() => expect(view.host.querySelector('h1')?.textContent).toBe('Plan'));
      expect(ipc.requests).toContainEqual({
        method: 'openMemberFile',
        params: {
          workspaceId: 'ws',
          machineId: 'devnuc',
          sessionId: 'coordinator',
          boardId: 'bd_test',
          path: 'files/design/plan.md',
        },
      });

      // A file with no preview is saved to disk from the keeping machine instead.
      await act(async () =>
        view.host.querySelector<HTMLButtonElement>('button[aria-label="Back to files"]')?.click()
      );
      // The folder stays open on the way back.
      await vi.waitFor(() => expect(treeRow('mock.sketch')).toBeDefined());
      await act(async () => treeRow('mock.sketch')?.click());
      expect(view.host.textContent).toContain('No preview for this kind of file.');
      const download = [...view.host.querySelectorAll('button')].find(
        (button) => button.textContent === 'Download'
      ) as HTMLElement;
      await act(async () => download.click());
      expect(ipc.requests).toContainEqual({
        method: 'saveMemberFile',
        params: {
          workspaceId: 'ws',
          machineId: 'devnuc',
          sessionId: 'coordinator',
          boardId: 'bd_test',
          path: 'files/design/mock.sketch',
          fileName: 'mock.sketch',
        },
      });
    } finally {
      await view.unmount();
      ipc.remove();
      vi.unstubAllGlobals();
      if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight);
      else delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
    }
  });

  it('keeps the sessions a thread opened under it, lifted by the strongest state', async () => {
    const view = await mount(
      <BoardThreadListView
        now={new Date(0)}
        threads={[
          {
            id: 'idle',
            title: 'Idle thread',
            status: 'idle',
            detail: '',
            updatedLabel: '',
            updatedAt: 0,
          },
          {
            id: 'parent',
            title: 'Thread',
            status: 'idle',
            detail: '',
            updatedLabel: '',
            updatedAt: 0,
          },
          {
            id: 'reviewer',
            title: 'Reviewer',
            status: 'waiting_user',
            detail: '',
            updatedLabel: '',
            updatedAt: 0,
            depth: 1,
          },
        ]}
        onOpen={() => {}}
      />
    );
    try {
      const sections: [string | null, string[]][] = [];
      for (const node of view.host.querySelectorAll(
        'button[aria-expanded], [data-scope-item="row"]'
      )) {
        if (node.hasAttribute('aria-expanded')) sections.push([node.textContent, []]);
        else sections.at(-1)?.[1].push(node.getAttribute('data-id') ?? '');
      }
      expect(sections).toEqual([
        ['Needs you2', ['parent', 'reviewer']],
        ['Idle1', ['idle']],
      ]);
    } finally {
      await view.unmount();
    }
  });

  it('keeps Board conversations out of outside lists while Boards are on', () => {
    const coordinator = makeSession('coordinator', { boardRole: 'coordinator' });
    const thread = makeSession('thread');
    const chat = makeSession('chat', { boardId: undefined });
    expect([coordinator, thread, chat].filter((s) => !isBoardSession(s, true))).toEqual([chat]);
    // With the experiment off threads are ordinary sessions again; the coordinator stays the Board's.
    expect([coordinator, thread, chat].filter((s) => !isBoardSession(s, false))).toEqual([
      thread,
      chat,
    ]);
  });

  it('marks a Board by its strongest member state', () => {
    const board = testBoard();
    const working = makeSession('working');
    const waiting = makeSession('waiting', {
      awaitingUserSince: 20,
      lastMessageAt: 10,
      lastReadAt: 10,
    });
    const answered = makeSession('answered', {
      awaitingUserSince: 10,
      lastMessageAt: 20,
      lastReadAt: 20,
    });
    const elsewhere = makeSession('elsewhere', { boardId: 'bd_other' as never });
    const running = new Map<string, SessionStatus>([
      [working.id, { type: 'running' } as SessionStatus],
      [elsewhere.id, { type: 'requestPermission' } as SessionStatus],
    ]);
    const idle = { isWaitingPermission: false, isWorking: false, hasUnreadMessages: false };
    expect(boardActivity(board, [answered], new Map())).toEqual(idle);
    expect(boardActivity(board, [answered, working, elsewhere], running)).toEqual({
      ...idle,
      isWorking: true,
    });
    expect(boardActivity(board, [working, waiting], running)).toEqual({
      ...idle,
      isWaitingPermission: true,
      isWorking: true,
    });
    expect(
      boardActivity(
        board,
        [working],
        new Map([[working.id, { type: 'requestPermission' } as SessionStatus]])
      )
    ).toEqual({ ...idle, isWaitingPermission: true, isWorking: true });
    // Any member's unseen output lights the row, the coordinator's too; seen,
    // closed and other Boards' output does not.
    const unseen = makeSession('unseen', { lastMessageAt: 30, lastReadAt: 20 });
    const seen = makeSession('seen', { lastMessageAt: 30, lastReadAt: 30 });
    const closed = makeSession('closed', { lastMessageAt: 30, isTabClosed: true });
    const coordinator = makeSession('coordinator', {
      boardRole: 'coordinator',
      lastMessageAt: 40,
      lastReadAt: 10,
    });
    const foreign = makeSession('foreign', { boardId: 'bd_other' as never, lastMessageAt: 30 });
    expect(boardActivity(board, [seen, closed, foreign], new Map())).toEqual(idle);
    expect(boardActivity(board, [seen, unseen], new Map())).toEqual({
      ...idle,
      hasUnreadMessages: true,
    });
    expect(boardActivity(board, [seen, coordinator], new Map())).toEqual({
      ...idle,
      hasUnreadMessages: true,
    });
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

it('starts Board settings afresh on another Board, so a draft never saves into it', async () => {
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
    return <BoardSettings board={board} onClose={() => {}} onArchived={() => {}} />;
  }
  const view = await mount(
    <Provider store={store}>
      <Page />
    </Provider>
  );
  const nameInput = () => document.querySelector<HTMLInputElement>('input[aria-label="Name"]');
  try {
    await typeInto(nameInput()!, 'Draft for Release');
    // Browser history moves the page to Board B while A's settings are open.
    await act(async () => showBoard(boardB));
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

it('saves the Board instructions from the General page and lists the agents memory', async () => {
  const env = await boardRuntime([makeSession('coordinator', { boardRole: 'coordinator' })]);
  await writeWorkspaceBoard(env.runtime, testBoard());
  const store = workspaceStore(env.runtime);
  const ipc = installIpc({
    'board/files-list:memory': {
      entries: [
        { path: 'decisions.md', sizeBytes: 10, modifiedAtMs: 1 },
        { path: 'MEMORY.md', sizeBytes: 20, modifiedAtMs: 2 },
      ],
      truncated: false,
    },
  });
  // i18next names Chinese `zh_CN`, which Intl does not take as a tag.
  creation.language = 'zh_CN';
  const view = await mount(
    <Provider store={store}>
      <BoardSettings board={env.board('bd_test')} onClose={() => {}} onArchived={() => {}} />
    </Provider>
  );
  try {
    // The instructions sit on General, the page the dialog opens on.
    await typeInto(
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Instructions"]')!,
      'Check nmem first.'
    );
    expect(document.body.textContent).toContain('17 / 16,000');
    const memoryPage = [...document.querySelectorAll('nav button')].find(
      (button) => button.textContent === 'Memory'
    ) as HTMLElement;
    await act(async () => memoryPage.click());
    expect(document.querySelector('textarea[aria-label="Instructions"]')).toBeNull();
    // MEMORY.md, the index, leads the memory files.
    expect(
      [...document.querySelectorAll('[data-scope-item="row"]')].map((row) =>
        row.getAttribute('data-id')
      )
    ).toEqual(['MEMORY.md', 'decisions.md']);
    expect(ipc.requests).toContainEqual(
      expect.objectContaining({
        method: 'board/files-list',
        params: { boardId: 'bd_test', sessionId: 'coordinator', area: 'memory' },
      })
    );
    await submitForm();
    expect(env.board('bd_test')).toMatchObject({ instructions: 'Check nmem first.' });
  } finally {
    creation.language = 'en';
    await view.unmount();
    ipc.remove();
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
    // A member refuses: the Board and its coordinator stay active, so every entry
    // (the page's menu follows the coordinator) still offers Archive.
    env.failing.add(getSessionRoomId('second' as SessionId));
    await act(async () => {
      await expect(lifecycle.archiveBoard(testBoard(), sessions)).rejects.toThrow('disk full');
    });
    expect(env.board('bd_test')).not.toHaveProperty('archivedAtMs');
    expect(await archivedIds()).not.toContain('coordinator');
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
    expect(await archivedIds()).toEqual(['coordinator', 'second']);
    env.failing.clear();
    await act(async () => lifecycle.restoreBoard(env.board('bd_test'), await archived()));
    expect(env.board('bd_test')).not.toHaveProperty('archivedAtMs');
    expect(await archivedIds()).toEqual([]);
  } finally {
    await view.unmount();
    await env.destroy();
  }
});

it('creates a Board from a name alone, with a coordinator that has not been sent anything', async () => {
  const env = await boardRuntime([]);
  const store = workspaceStore(env.runtime);
  store.set(userAtom, { id: 'user', name: 'User', email: 'user@example.com' });
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
  const created: BoardMeta[] = [];
  let actions!: Pick<
    ReturnType<typeof useSessionActions>,
    'deleteSessions' | 'setSessionTabClosed'
  >;
  function Probe() {
    actions = useSessionActions();
    return null;
  }
  const view = await mount(
    <Provider store={store}>
      <Probe />
      <CreateBoardDialog onClose={() => {}} onCreated={(entry) => created.push(entry)} />
    </Provider>
  );
  try {
    expect(document.querySelectorAll('input[type="number"]')).toHaveLength(0);
    await typeInto(document.querySelector('input')!, 'Ship the Board home');
    await submitForm();
    expect(created).toHaveLength(1);
    const board = env.board(created[0]!.id);
    expect(board).toMatchObject({
      name: 'Ship the Board home',
      purpose: '',
      rules: { maxRoundsPerThread: 4, reportHumanTurns: false, executorConstraints: '' },
      files: { machineId: 'machine' },
    });
    // The coordinator exists, belongs to the Board, and has no first message:
    // the user speaks first.
    const coordinator = await env.meta(board.coordinatorSessionId);
    expect(coordinator).toMatchObject({
      boardId: board.id,
      boardRole: 'coordinator',
      title: 'Ship the Board home',
      machineId: 'machine',
    });
    expect(coordinator).not.toHaveProperty('lastMessageAt');

    // Closing its tab keeps it, and the Board with it: a coordinator is never an
    // empty tab to delete, while an ordinary empty tab still is.
    const close = (id: SessionId) =>
      closeSessionTab(id, {
        runtime: env.runtime,
        deleteSessions: actions.deleteSessions,
        setSessionTabClosed: actions.setSessionTabClosed,
      });
    expect(await close(board.coordinatorSessionId)).toBe('closed');
    expect(await env.meta(board.coordinatorSessionId)).toMatchObject({
      boardRole: 'coordinator',
      isTabClosed: true,
    });
    expect(env.board(board.id)).toMatchObject({ coordinatorSessionId: board.coordinatorSessionId });
    await env.runtime.writer.upsertDocMeta(
      getSessionRoomId('empty-tab' as SessionId),
      makeSession('empty-tab', { parentSessionId: board.coordinatorSessionId })
    );
    expect(await close('empty-tab' as SessionId)).toBe('deleted');
    expect(
      isLoroRepoDocDeleted(
        await env.runtime.repo.getDocMeta(getSessionRoomId('empty-tab' as SessionId))
      )
    ).toBe(true);
  } finally {
    await view.unmount();
    creation.machines.clear();
    await env.destroy();
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

/** Fills in and submits "+ New thread"; returns what was handed to `startSession`. */
async function submitNewBoardThread(
  options: { pickRepository?: boolean; roleState?: 'selected' | 'missing' | 'unavailable' } = {}
) {
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
  if (options.roleState) {
    localStorage.setItem(
      'lody-board-last-agent',
      JSON.stringify({
        machineId: 'machine',
        agent: { agentConfigId: 'config', modelId: 'saved-agent' },
        instanceId: 'target-second',
      })
    );
    creation.roles =
      options.roleState === 'missing'
        ? []
        : [
            normalizeAgentRole({
              v: 2,
              id: 'synthetic-role',
              name: 'Reviewer',
              ownerUserId: 'user',
              visibility: 'private',
              revision: 4,
              createdAt: 1,
              updatedAt: 1,
              targets: [
                {
                  id: 'target-first',
                  machineId: 'machine',
                  agentConfigId: 'config',
                  runConfig: {
                    modelId: 'first-model',
                    memory: { providerId: 'nowledge-mem', memoryId: 'first-memory' },
                  },
                },
                {
                  id: 'target-second',
                  alias: 'Second',
                  machineId: 'machine',
                  agentConfigId: 'config',
                  runConfig: {
                    modelId: 'second-model',
                    memory: { providerId: 'nowledge-mem', memoryId: 'second-memory' },
                  },
                },
              ],
            })!,
          ];
    if (options.roleState === 'unavailable') creation.unavailableTargets.add('target-second');
  }
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
    if (options.pickRepository)
      await act(async () => {
        document.querySelector<HTMLButtonElement>('[data-testid="pick-repository"]')!.click();
      });
    await act(async () => {
      document
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    if (options.roleState === 'missing' || options.roleState === 'unavailable') {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'The selected Role target is missing or unavailable.'
      );
      expect(accepted).toEqual([]);
    } else expect(container.textContent).toBe('Thread accepted');
    return { board, accepted };
  } finally {
    await act(async () => root.unmount());
    container.remove();
    creation.startSession = undefined;
    creation.machines.clear();
    creation.roles = [];
    creation.unavailableTargets.clear();
    localStorage.removeItem('lody-board-last-agent');
  }
}

it('submits a new Board thread as chat without the coordinator role', async () => {
  const { board, accepted } = await submitNewBoardThread();
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
});

it.each(['selected', 'missing', 'unavailable'] as const)(
  'keeps a Board thread pinned to its exact Role target (%s)',
  async (roleState) => {
    const { accepted } = await submitNewBoardThread({ roleState });
    if (roleState !== 'selected') return;
    expect(accepted[0]?.payload).toMatchObject({
      agentRoleId: 'synthetic-role',
      agentRoleInstanceId: 'target-second',
    });
    expect(accepted[0]?.history.inputConfig).toMatchObject({
      modelId: 'second-model',
      memory: { providerId: 'nowledge-mem', memoryId: 'second-memory' },
      agentRoleSnapshot: { instanceId: 'target-second', revision: 4 },
    });
  }
);

it('starts a new Board thread in a repository from its default branch', async () => {
  const { accepted } = await submitNewBoardThread({ pickRepository: true });
  expect(accepted[0]?.payload.project).toEqual({
    kind: 'github',
    repoFullName: 'owner/web',
    branch: 'release',
  });
});

/** A Board of three members, its row in the catalog and its Sessions in the metadata cache. */
async function boardWithMembers() {
  const sessions = [
    makeSession('coordinator', { boardRole: 'coordinator', title: 'Release' }),
    makeSession('root'),
    makeSession('review', { parentSessionId: 'root' as SessionId }),
  ];
  const env = await boardRuntime(sessions);
  await writeWorkspaceBoard(env.runtime, testBoard());
  const store = workspaceStore(env.runtime);
  store.set(experimentalFeaturesEnabledAtom, true);
  store.set(boardExperimentEnabledAtom, true);
  store.set(
    sessionMetaCacheAtom,
    Object.fromEntries(sessions.map((session) => [getSessionRoomId(session.id), session]))
  );
  const archivedIds = async () =>
    (await Promise.all(sessions.map((session) => env.meta(session.id))))
      .filter((meta) => meta.isArchived === true)
      .map((meta) => meta.id);
  return { env, store, archivedIds };
}

function menuItem(label: string) {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === label
  );
}

async function renameTo(name: string) {
  await typeInto(document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!, name);
  const save = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (button) => button.textContent === 'Save'
  )!;
  await act(async () => save.click());
}

it('renames and archives the whole Board from its page header menu', async () => {
  const { env, store, archivedIds } = await boardWithMembers();
  let left = false;
  // The coordinator page's wiring: the menu's rename and archive act on its Board.
  function Header() {
    const { archive } = useBoardActions();
    const [renaming, setRenaming] = useState<BoardMeta | null>(null);
    return (
      <>
        <SessionHeaderMenu
          session={makeSession('coordinator', { boardRole: 'coordinator' })}
          owner={{ members: [], ownerUserId: 'user', onChangeOwner: () => {} }}
          onCopyUrl={() => {}}
          onRename={() => setRenaming(env.board('bd_test'))}
          onArchive={async () => {
            left = await archive(env.board('bd_test'));
          }}
          t={(_key: string, fallback: string) => fallback}
        />
        <BoardRenameDialog board={renaming} onClose={() => setRenaming(null)} />
      </>
    );
  }
  const view = await mount(
    <Provider store={store}>
      <Header />
    </Provider>
  );
  const openMenu = async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'requestAnimationFrame'] });
    try {
      await act(async () => {
        document
          .querySelector('button[aria-label="More actions"]')!
          .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        await vi.advanceTimersByTimeAsync(40);
      });
    } finally {
      vi.useRealTimers();
    }
  };
  try {
    await openMenu();
    // A Board has no owner of its own, and the menu names the Board.
    expect(menuItem('Change owner')).toBeUndefined();
    expect(menuItem('Rename Chat')).toBeUndefined();
    await act(async () => menuItem('Rename Board')!.click());
    // Another window saves instructions while the rename is open; the rename keeps them.
    await writeWorkspaceBoard(env.runtime, { ...env.board('bd_test'), instructions: 'Use nmem.' });
    await renameTo('Launch');
    expect(env.board('bd_test')).toMatchObject({
      name: 'Launch',
      purpose: 'Ship it',
      instructions: 'Use nmem.',
    });
    expect((await env.meta('coordinator')).title).toBe('Launch');

    await openMenu();
    expect(menuItem('Archive session')).toBeUndefined();
    await act(async () => menuItem('Archive Board')!.click());
    expect(left).toBe(true);
    expect(env.board('bd_test').archivedAtMs).toEqual(expect.any(Number));
    expect(await archivedIds()).toEqual(['coordinator', 'root', 'review']);
  } finally {
    await view.unmount();
    await env.destroy();
  }
});

it('shares, renames and archives a Board from its sidebar row controls', async () => {
  const { env, store, archivedIds } = await boardWithMembers();
  creation.boards = [env.board('bd_test')];
  const copied: string[] = [];
  const archived: string[] = [];
  const opened: string[] = [];
  const view = await mount(
    <Provider store={store}>
      <BoardSidebar
        routeSessionId="coordinator"
        boards={[
          {
            id: 'bd_test',
            name: 'Release',
            coordinatorSessionId: 'coordinator' as SessionId,
            activity: { isWaitingPermission: false, isWorking: false, hasUnreadMessages: false },
          },
        ]}
        collapsed={false}
        onToggleCollapsed={() => {}}
        onOpen={(board) => opened.push(board.id)}
        onCreate={() => {}}
        onCopyUrl={(board) => copied.push(board.coordinatorSessionId)}
        onArchived={(board) => archived.push(board.id)}
      />
    </Provider>
  );
  const openRowMenu = async () => {
    await act(async () => {
      document
        .querySelector('[data-id="bd_test"]')!
        .dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 8, clientY: 8 })
        );
    });
  };
  const press = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
    });
  };
  try {
    // Enter on the row opens the Board; on ⋯ inside it, it stays with the button.
    await press(document.querySelector('[data-id="bd_test"] button[aria-label="More actions"]')!);
    expect(opened).toEqual([]);
    await press(document.querySelector('[data-id="bd_test"]')!);
    expect(opened).toEqual(['bd_test']);

    await openRowMenu();
    await act(async () => menuItem('Copy Board URL')!.click());
    expect(copied).toEqual(['coordinator']);

    // Sharing a Board opens the share editor on its coordinator's conversation.
    await openRowMenu();
    await act(async () => menuItem('Share')!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Release');
    await act(async () => {
      document
        .querySelector('[role="dialog"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await openRowMenu();
    await act(async () => menuItem('Rename Board')!.click());
    await renameTo('Launch');
    expect(env.board('bd_test').name).toBe('Launch');

    const archiveButton = view.host.querySelector<HTMLButtonElement>(
      '[data-id="bd_test"] button[aria-label="Archive Board"]'
    )!;
    await act(async () => archiveButton.click());
    expect(await archivedIds()).toEqual([]);
    await act(async () => archiveButton.click());
    expect(archived).toEqual(['bd_test']);
    expect(await archivedIds()).toEqual(['coordinator', 'root', 'review']);
  } finally {
    creation.boards = [];
    await view.unmount();
    await env.destroy();
  }
});

it('uses sidebar menus and the shared recursive archive action for Board threads', async () => {
  const sessions = [
    makeSession('coordinator', { boardRole: 'coordinator' }),
    makeSession('root', { openedBySessionId: 'coordinator' as SessionId }),
    makeSession('tab', { parentSessionId: 'root' as SessionId }),
    makeSession('opened', { openedBySessionId: 'root' as SessionId }),
    makeSession('other'),
  ];
  const env = await boardRuntime(sessions);
  const store = workspaceStore(env.runtime);
  store.set(experimentalFeaturesEnabledAtom, true);
  store.set(boardExperimentEnabledAtom, true);
  store.set(
    sessionMetaCacheAtom,
    Object.fromEntries(sessions.map((session) => [getSessionRoomId(session.id), session]))
  );
  let selected: string | null = null;
  let shownInPage: string | null = null;
  const view = await mount(
    <Provider store={store}>
      <BoardSidePanel
        board={testBoard()}
        openThreadId={null}
        onOpenThread={(session) => {
          selected = session?.id ?? null;
        }}
        onShowInPage={(session) => {
          shownInPage = session.id;
        }}
        onOpenThreadFull={() => {}}
        renderThread={() => null}
        requestedThreadId={null}
        onThreadRequestDone={() => {}}
      />
    </Provider>
  );
  const row = () => view.host.querySelector<HTMLElement>('[data-id="root"]')!;
  const openMenu = () =>
    act(async () =>
      row().dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 8, clientY: 8 })
      )
    );
  try {
    expect(row().querySelector('[aria-label="Board thread"]')).toBeNull();
    await act(async () =>
      row()
        .querySelector('button[aria-label="More actions"]')!
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        )
    );
    expect(selected).toBeNull();
    await openMenu();
    await act(async () => menuItem('Rename')!.click());
    await renameTo('Renamed thread');
    expect((await env.meta('root')).title).toBe('Renamed thread');
    expect((await env.meta('coordinator')).title).toBe('coordinator');
    await openMenu();
    expect(menuItem('Pin Session')).toBeUndefined();
    expect(menuItem('Unpin Session')).toBeUndefined();
    expect((await env.meta('root')).boardId).toBe('bd_test');
    await openMenu();
    await act(async () => menuItem('Go to Opener Session')!.click());
    expect(shownInPage).toBe('coordinator');
    expect(selected).toBeNull();
    await openMenu();
    await act(async () => menuItem('Archive Session')!.click());
    expect(
      (await Promise.all(sessions.map((session) => env.meta(session.id))))
        .filter((session) => session.isArchived)
        .map((session) => session.id)
    ).toEqual(['root', 'tab', 'opened']);
    expect(selected).toBeNull();
    // The shared restore action restores only the root and contained Tabs.
    await act(async () =>
      store.set(
        sessionMetaCacheAtom,
        Object.fromEntries(
          await Promise.all(
            sessions.map(async (session) => [
              getSessionRoomId(session.id),
              await env.meta(session.id),
            ])
          )
        )
      )
    );
    await act(async () =>
      [...view.host.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
        .find((button) => button.textContent?.startsWith('Archived'))!
        .click()
    );
    await openMenu();
    expect(menuItem('Archive Session')).toBeUndefined();
    await act(async () => menuItem('Restore')!.click());
    expect((await env.meta('root')).isArchived).toBe(false);
    expect((await env.meta('tab')).isArchived).toBe(false);
    expect((await env.meta('opened')).isArchived).toBe(true);
    const otherArchive = view.host.querySelector<HTMLButtonElement>(
      '[data-id="other"] button[aria-label="Archive session"]'
    )!;
    await act(async () => otherArchive.click());
    expect((await env.meta('other')).isArchived).not.toBe(true);
    expect(selected).toBeNull();
    await act(async () =>
      view.host
        .querySelector<HTMLButtonElement>(
          '[data-id="other"] button[aria-label="Confirm Archive session"]'
        )!
        .click()
    );
    expect((await env.meta('other')).isArchived).toBe(true);
    expect(selected).toBeNull();
  } finally {
    await view.unmount();
    await env.destroy();
  }
});

it('keeps the Board selected through its coordinator, threads and contained Tabs', () => {
  const boards = [
    testBoard(),
    testBoard({ id: 'bd_other' as never, coordinatorSessionId: 'other-coordinator' as SessionId }),
  ];
  const selection = (routeSessionId: string | null, routeBoardId?: string, tabBoardId?: string) =>
    resolveSidebarBoardSelection({
      boards,
      routeSessionId,
      routeBoardId,
      tabBoardId,
      tabSessionId: tabBoardId === undefined ? undefined : 'tab',
    });
  // Opening inside the panel leaves the coordinator route unchanged.
  expect(selection('coordinator')).toBe('bd_test');
  expect(selection('thread', 'bd_test')).toBe('bd_test');
  // Opened descendants and contained Tabs are members by their own boardId.
  expect(selection('grandchild', 'bd_test')).toBe('bd_test');
  expect(selection('thread', 'bd_test', 'bd_test')).toBe('bd_test');
  expect(selection('chat', undefined, 'bd_test')).toBe('bd_test');
  expect(selection('thread', 'bd_test', 'bd_other')).toBe('bd_other');
  expect(
    resolveSidebarBoardSelection({
      boards,
      routeSessionId: 'thread',
      routeBoardId: 'bd_test',
      tabSessionId: 'detached-tab',
    })
  ).toBeUndefined();
  expect(selection('chat')).toBeUndefined();
  expect(selection('thread', 'bd_missing')).toBeUndefined();
  expect(selection(null, undefined, 'bd_test')).toBeUndefined();
});

it("opens a child's same-Board parent from both its row and panel header", async () => {
  const parent = makeSession('parent', { title: 'Parent thread' });
  const child = makeSession('child', { title: 'Review', openedBySessionId: parent.id });
  const contained = makeSession('contained', {
    parentSessionId: parent.id,
    openedBySessionId: 'coordinator' as SessionId,
  });
  const coordinator = makeSession('coordinator', { boardRole: 'coordinator' });
  const byId = new Map([parent, child, contained, coordinator].map((entry) => [entry.id, entry]));
  expect(resolveBoardThreadParent(child, (id) => byId.get(id))).toBe(parent);
  expect(resolveBoardThreadParent(contained, (id) => byId.get(id))).toBe(parent);
  expect(
    resolveBoardThreadParent({ ...child, boardId: 'bd_other' as never }, (id) => byId.get(id))
  ).toBeUndefined();
  expect(
    resolveBoardThreadParent({ ...child, openedBySessionId: coordinator.id }, (id) => byId.get(id))
  ).toBeUndefined();
  expect(resolveBoardThreadParent(child, () => undefined)).toBeUndefined();
  expect(formatBoardSessionTitle(parent.title!, child.title!)).toBe('Parent thread › Review');
  const store = createStore();
  store.set(experimentalFeaturesEnabledAtom, true);
  store.set(boardExperimentEnabledAtom, true);
  store.set(
    sessionMetaCacheAtom,
    Object.fromEntries([...byId.values()].map((entry) => [getSessionRoomId(entry.id), entry]))
  );
  function Panel() {
    const [open, setOpen] = useState<SessionId | null>(child.id);
    return (
      <BoardSidePanel
        board={testBoard()}
        openThreadId={open}
        onOpenThread={(entry) => setOpen(entry?.id ?? null)}
        onShowInPage={() => {}}
        onOpenThreadFull={() => {}}
        requestedThreadId={null}
        onThreadRequestDone={() => {}}
        renderThread={(entry, controls) => (
          <BoardThreadPaneView title={entry.title!} {...controls}>
            <p data-open-thread={entry.id}>{entry.title}</p>
          </BoardThreadPaneView>
        )}
      />
    );
  }
  const view = await mount(
    <Provider store={store}>
      <Panel />
    </Provider>
  );
  try {
    expect(view.host.textContent).toContain('Parent thread›Review');
    await act(async () =>
      view.host
        .querySelector<HTMLButtonElement>('[aria-label="Open parent thread: Parent thread"]')!
        .click()
    );
    expect(view.host.querySelector('[data-open-thread="parent"]')).not.toBeNull();
    await act(async () =>
      view.host.querySelector<HTMLButtonElement>('[aria-label="Back to threads"]')!.click()
    );
    const childRow = view.host.querySelector<HTMLElement>('[data-id="child"]')!;
    expect(childRow.textContent).toContain('Parent thread›Review');
    await act(async () =>
      childRow
        .querySelector<HTMLButtonElement>('[aria-label="Open parent thread: Parent thread"]')!
        .click()
    );
    expect(view.host.querySelector('[data-open-thread="parent"]')).not.toBeNull();
    expect(view.host.querySelector('[data-open-thread="child"]')).toBeNull();
  } finally {
    await view.unmount();
  }
});

it('resolves page navigation without duplicating coordinator or parent tabs', () => {
  const board = testBoard();
  const coordinator = makeSession('coordinator', { boardRole: 'coordinator' });
  const thread = makeSession('thread', { openedBySessionId: coordinator.id });
  const tab = makeSession('tab', { parentSessionId: thread.id });
  const child = makeSession('child', { openedBySessionId: thread.id });
  const resolve = (
    pageSession: SessionMeta,
    selectedSession: SessionMeta = pageSession,
    enabled = true
  ) => resolveBoardThreadPageNavigation({ enabled, boards: [board], pageSession, selectedSession });
  const back = { sessionId: coordinator.id, search: { board: true, tab: 'session:coordinator' } };
  expect(resolve(thread)).toEqual({ back, parent: null });
  expect(resolve(thread, thread, false)).toBeNull();
  expect(resolve(makeSession('chat', { boardId: undefined }))).toBeNull();
  expect(resolve(coordinator)).toBeNull();
  expect(
    resolve(coordinator, makeSession('coordinator-tab', { parentSessionId: coordinator.id }))
  ).toBeNull();
  // The catalog id also excludes a coordinator route before its role metadata arrives.
  expect(resolve({ ...coordinator, boardRole: undefined }, tab)).toBeNull();
  expect(resolve(thread, tab)).toEqual({ back, parent: null });
  expect(resolve(child)).toEqual({
    back,
    parent: {
      sessionId: coordinator.id,
      search: { board: true, tab: 'session:coordinator', boardThread: thread.id },
    },
  });
});

it('gates the conversation-header Board mark on the experiment', async () => {
  const store = createStore();
  store.set(experimentalFeaturesEnabledAtom, true);
  store.set(boardExperimentEnabledAtom, true);
  const view = await mount(
    <Provider store={store}>
      <BoardThreadMark />
    </Provider>
  );
  try {
    expect(view.host.querySelector('[aria-label="Board thread"]')).not.toBeNull();
    await act(async () => store.set(boardExperimentEnabledAtom, false));
    expect(view.host.querySelector('[aria-label="Board thread"]')).toBeNull();
  } finally {
    await view.unmount();
  }
});

it('reports archive and removed-project restore failures without changing lifecycle state', async () => {
  const active = makeSession('active');
  const archived = makeSession('archived-local', {
    isArchived: true,
    project: { kind: 'local', localProjectId: 'removed' } as SessionMeta['project'],
  });
  const env = await boardRuntime([active, archived]);
  const store = workspaceStore(env.runtime);
  store.set(sessionMetaCacheAtom, {
    [getSessionRoomId(active.id)]: active,
    [getSessionRoomId(archived.id)]: archived,
  });
  env.failing.add(getSessionRoomId(active.id));
  const view = await mount(
    <Toast.Provider manager={toastManager} timeout={0}>
      <Provider store={store}>
        <BoardSidePanel
          board={testBoard()}
          openThreadId={null}
          onOpenThread={() => {}}
          onShowInPage={() => {}}
          onOpenThreadFull={() => {}}
          renderThread={() => null}
          requestedThreadId={null}
          onThreadRequestDone={() => {}}
        />
      </Provider>
    </Toast.Provider>
  );
  const openMenu = (id: string) =>
    act(async () =>
      view.host
        .querySelector(`[data-id="${id}"]`)!
        .dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 8, clientY: 8 })
        )
    );
  try {
    await openMenu(active.id);
    await act(async () => menuItem('Archive Session')!.click());
    expect(document.body.textContent).toContain('disk full');
    expect((await env.meta(active.id)).isArchived).not.toBe(true);
    await act(async () =>
      [...view.host.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
        .find((button) => button.textContent?.startsWith('Archived'))!
        .click()
    );
    await openMenu(archived.id);
    await act(async () => menuItem('Restore')!.click());
    expect(document.body.textContent).toContain(
      'Re-add this local project to restore its conversations.'
    );
    expect((await env.meta(archived.id)).isArchived).toBe(true);
  } finally {
    await view.unmount();
    await env.destroy();
  }
});

describe('Board schedule scope', () => {
  const definition = (scheduleId: string, boardId?: string) =>
    buildScheduleRegistryRow({
      definition: ScheduleDefinitionSchema.parse({
        scheduleId,
        boardId,
        title: scheduleId,
        ownerId: 'user',
        machineId: 'machine',
        enabled: true,
        activationId: 'activation',
        activeFrom: 0,
        trigger: { kind: 'manual' },
        misfirePolicy: { kind: 'run_once' },
        overlapPolicy: 'queue_one',
        agent: { agentConfigId: 'agent' },
        destination: { kind: 'own_session', epoch: 0 },
        retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86400000 },
        createdAt: 0,
        updatedAt: 0,
        createdBy: 'user',
      }),
      prompt: 'Synthetic schedule',
      timeline: [],
    });
  it('lists each schedule only in its owning global or Board surface', () => {
    const global = definition('global');
    const own = definition('own', 'bd_test');
    const other = definition('other', 'bd_other');
    const rows = [global, own, other];
    expect(scheduleRowsForBoard(rows)).toEqual([global]);
    expect(scheduleRowsForBoard(rows, 'bd_test')).toEqual([own]);
    expect(scheduleRowsForBoard(rows, 'bd_other')).toEqual([other]);
  });
  it('selects the first usable deterministic id in the current epoch, ignoring unrelated scheduleId matches', () => {
    const row = definition('own', 'bd_test');
    const zeroId = scheduleOwnSessionId('own', 0);
    const nextId = scheduleOwnSessionId('own', 0, 1);
    const old = makeSession(zeroId, { scheduleId: 'own', isArchived: true });
    const next = makeSession(nextId, { scheduleId: 'own', createdAt: '2026-10-16T00:00:00Z' });
    const unrelated = makeSession('unrelated', {
      scheduleId: 'own',
      createdAt: '2026-10-17T00:00:00Z',
    });
    const sessions = [old, next, unrelated];
    const deleted = new Set<SessionId>();
    const isDeleted = (id: SessionId) => deleted.has(id);
    expect(scheduleBoundSession(row, sessions, isDeleted)).toBe(next);
    expect(
      scheduleBoundSession(
        { ...row, destination: { kind: 'own_session', epoch: 1 } },
        sessions,
        isDeleted
      )
    ).toBeUndefined();
    old.isArchived = false;
    expect(scheduleBoundSession(row, sessions, isDeleted)).toBe(old);
    old.boardId = undefined;
    expect(scheduleBoundSession(row, sessions, isDeleted)).toBe(next);
    deleted.add(zeroId);
    expect(scheduleBoundSession(row, [next, unrelated], isDeleted)).toBe(next);
    expect(scheduleBoundSession(row, [unrelated], isDeleted)).toBeUndefined();
    expect(isScheduleBoardThread(makeSession('coordinator'), testBoard())).toBe(false);
    expect(
      isScheduleBoardThread(makeSession('foreign', { boardId: 'bd_other' as never }), testBoard())
    ).toBe(false);
    expect(isScheduleBoardThread(next, testBoard())).toBe(true);
  });
});

describe('Board conversation navigation', () => {
  it.each([
    { mode: 'side', narrow: false, boardPage: true, destination: 'panel' },
    { mode: 'narrow', narrow: true, boardPage: true, destination: 'page' },
    { mode: 'expanded thread page', narrow: false, boardPage: false, destination: 'page' },
  ])(
    'opens cards and nested links in the $mode destination',
    async ({ narrow, boardPage, destination }) => {
      const deepLinks: string[] = [];
      const recordDeepLink = (event: Event) =>
        deepLinks.push((event as CustomEvent<string>).detail);
      window.addEventListener(SESSION_DEEP_LINK_EVENT, recordDeepLink);
      const store = createStore();
      store.set(currentWorkspaceIdAtom, 'ws' as WorkspaceId);
      const coordinator = makeSession('coordinator', { boardRole: 'coordinator' });
      const thread = makeSession('thread');
      const external = [
        makeSession('other-coordinator', {
          boardId: 'bd_other' as never,
          boardRole: 'coordinator',
        }),
        makeSession('other-thread', { boardId: 'bd_other' as never }),
        makeSession('ordinary', { boardId: undefined }),
      ];
      const child = makeSession('child', { openedBySessionId: thread.id });
      const tab = makeSession('tab', { parentSessionId: coordinator.id });
      const side = makeSession('side', {
        parentSessionId: coordinator.id,
        childSessionPlacement: 'side-panel',
      });
      store.set(
        sessionMetaCacheAtom,
        Object.fromEntries(
          [coordinator, thread, child, tab, side, ...external].map((session) => [
            getSessionRoomId(session.id),
            session,
          ])
        )
      );
      const board = testBoard();
      function Page() {
        const [shown, setShown] = useState('coordinator');
        const open = useBoardSessionNavigation({
          board: boardPage ? board : null,
          narrow,
          openPanel: (id) => setShown(`panel:${id}`),
          showInCoordinatorPage: (target) =>
            setShown(`coordinator:${target.tabSessionId ?? target.sessionId}`),
          openPage: (target) => setShown(`page:${target.tabSessionId ?? target.sessionId}`),
        });
        return (
          <SessionLinkProvider enabled>
            <output>{shown}</output>
            <BoardThreadStatusCard sessionId={thread.id} onNavigateSession={open} />
            <SessionRelationCard
              relation="opened-by"
              label="Opener"
              sessionTitle="thread"
              actionLabel="Open parent"
              onAction={() => open({ sessionId: thread.id })}
            />
            <MarkdownRenderer text="[Nested child](lody://session/child?workspace=ws)" />
            {external.map((session) => (
              <MarkdownRenderer
                key={session.id}
                text={`[${session.title}](lody://session/${session.id}?workspace=ws)`}
              />
            ))}
            <button onClick={() => open({ sessionId: coordinator.id, tabSessionId: tab.id })}>
              Contained tab
            </button>
            <button onClick={() => open({ sessionId: side.id })}>Side chat</button>
          </SessionLinkProvider>
        );
      }
      const view = await mount(
        <Provider store={store}>
          <Page />
        </Provider>
      );
      try {
        await act(async () =>
          view.host.querySelector<HTMLButtonElement>('[data-board-thread-card] button')!.click()
        );
        expect(view.host.querySelector('output')!.textContent).toBe(`${destination}:thread`);
        await act(async () =>
          view.host.querySelector<HTMLButtonElement>('[data-session-relation-card] button')!.click()
        );
        expect(view.host.querySelector('output')!.textContent).toBe(`${destination}:thread`);
        if (boardPage) {
          await act(async () =>
            view.host.querySelector<HTMLButtonElement>('button[data-session-link]')!.click()
          );
          if (narrow) expect(deepLinks.at(-1)).toBe('lody://session/child?workspace=ws');
          else expect(view.host.querySelector('output')!.textContent).toBe('panel:child');
          // The palette uses exactly the mounted page's navigation, including nested targets.
          await act(async () =>
            store.get(boardSessionNavigationAtom)!.open({ sessionId: thread.id })
          );
          expect(view.host.querySelector('output')!.textContent).toBe(`${destination}:thread`);
          for (const session of external) {
            await act(async () =>
              view.host
                .querySelector<HTMLButtonElement>(`button[data-session-link="${session.id}"]`)!
                .click()
            );
            expect(deepLinks.at(-1)).toBe(`lody://session/${session.id}?workspace=ws`);
            await act(async () =>
              store.get(boardSessionNavigationAtom)!.open({ sessionId: session.id })
            );
            expect(view.host.querySelector('output')!.textContent).toBe(`page:${session.id}`);
          }
        }
        for (const [label, id] of [
          ['Contained tab', 'tab'],
          ['Side chat', 'side'],
        ]) {
          await act(async () =>
            [...view.host.querySelectorAll('button')]
              .find((button) => button.textContent === label)!
              .click()
          );
          expect(view.host.querySelector('output')!.textContent).toBe(
            `${boardPage && !narrow ? 'coordinator' : 'page'}:${id}`
          );
        }
      } finally {
        window.removeEventListener(SESSION_DEEP_LINK_EVENT, recordDeepLink);
        await view.unmount();
      }
      expect(store.get(boardSessionNavigationAtom)).toBeNull();
    }
  );
});

it.each(['files', 'memory'] as const)(
  'opens a linked Board %s file through member reads and exposes read failures',
  async (area) => {
    const board = testBoard();
    const store = createStore();
    store.set(currentWorkspaceIdAtom, 'ws' as WorkspaceId);
    const coordinator = makeSession('coordinator', {
      boardRole: 'coordinator',
      machineId: 'devnuc',
    });
    store.set(sessionMetaCacheAtom, { [getSessionRoomId(coordinator.id)]: coordinator });
    const href = `/data/boards/ws/bd_test/${area}/plan%20one.md:12`;
    const ipc = installIpc({ [`file:${area}/plan one.md`]: '# Shared plan\n\nAuthorized bytes.' });
    function FileTabs() {
      const [file, setFile] = useState<ReturnType<typeof resolveBoardFileLink>>(null);
      return (
        <>
          <AgentFileLinkOpenContext.Provider
            value={(link) => {
              const target = resolveBoardFileLink(link, 'ws', [board]);
              return target ? () => setFile(target) : undefined;
            }}
          >
            <MarkdownRenderer
              text={`[Plan](${href}) [Missing](/data/boards/ws/bd_test/${area}/missing.md) [Workspace](src/main.ts)`}
            />
          </AgentFileLinkOpenContext.Provider>
          {file && (
            <section aria-label="File tab">
              <BoardFileLinkPreview
                key={file.filePath}
                target={file}
                memberSessionId={'thread' as SessionId}
                onClose={() => setFile(null)}
              />
            </section>
          )}
        </>
      );
    }
    const view = await mount(
      <Provider store={store}>
        <FileTabs />
      </Provider>
    );
    try {
      const button = (text: string) =>
        [...view.host.querySelectorAll('button')].find((item) => item.textContent === text)!;
      expect(button('Workspace').getAttribute('aria-label')).toContain('Copy agent file path');
      expect(button('Plan').getAttribute('aria-label')).toContain('Open agent file');
      await act(async () => button('Plan').click());
      await vi.waitFor(() =>
        expect(view.host.querySelector('[aria-label="File tab"] h1')?.textContent).toBe(
          'Shared plan'
        )
      );
      expect(view.host.textContent).toContain('Authorized bytes.');
      expect(ipc.requests).toContainEqual({
        method: 'openMemberFile',
        params: {
          workspaceId: 'ws',
          machineId: 'devnuc',
          sessionId: 'thread',
          boardId: 'bd_test',
          path: `${area}/plan one.md`,
        },
      });
      await act(async () =>
        view.host.querySelector<HTMLButtonElement>('[aria-label="Close tab"]')!.click()
      );
      expect(view.host.querySelector('[aria-label="File tab"]')).toBeNull();
      await act(async () => button('Missing').click());
      expect(view.host.textContent).toContain('ENOENT');
    } finally {
      await view.unmount();
      ipc.remove();
    }
  }
);

it('shows a Board document\'s images from the Board directory, not the renderer origin', async () => {
  const board = testBoard();
  const store = createStore();
  store.set(currentWorkspaceIdAtom, 'ws' as WorkspaceId);
  store.set(localProbeResultAtom, { ok: true, machineId: 'devnuc' });
  const coordinator = makeSession('coordinator', { boardRole: 'coordinator', machineId: 'devnuc' });
  store.set(sessionMetaCacheAtom, { [getSessionRoomId(coordinator.id)]: coordinator });
  const ipc = installIpc({
    'file:memory/report.md': [
      'Screens are in `files/shots/`; the final one is `plot.png`.',
      '',
      '![Beside](beside.png) ![Up](../files/shots/up.png) <img src="/data/boards/ws/bd_test/files/shots/abs.png" alt="Absolute">',
      '',
      '![Elsewhere](/home/me/elsewhere.png)',
    ].join('\n'),
    'file:memory/beside.png': 'png',
    'file:files/shots/plot.png': 'png',
    'file:files/shots/up.png': 'png',
    'file:files/shots/abs.png': 'png',
  });
  const view = await mount(
    <Provider store={store}>
      <BoardFilePreview
        board={board}
        area="memory"
        entry={{ path: 'report.md' }}
        onBack={() => {}}
        backLabel="Back"
      />
    </Provider>
  );
  try {
    await vi.waitFor(() => expect(view.host.querySelectorAll('img')).toHaveLength(4));
    const reads = ipc.requests
      .filter((request) => request.method === 'openMemberFile')
      .map((request) => (request.params as { path: string }).path);
    expect(reads).toEqual(
      expect.arrayContaining([
        'memory/beside.png',
        'files/shots/up.png',
        'files/shots/abs.png',
        'memory/plot.png',
        'files/shots/plot.png',
      ])
    );
    expect(reads.some((path) => path.includes('elsewhere'))).toBe(false);
    expect(view.host.textContent).toContain('Image could not be loaded');
  } finally {
    await view.unmount();
    ipc.remove();
  }
});

it('maps a Board document\'s image paths into that Board only', () => {
  expect(boardDocumentFilePath('files/shots/a.png', 'ws', 'bd_test')).toBe('files/shots/a.png');
  expect(boardDocumentFilePath('/data/boards/ws/bd_test/memory/a.png', 'ws', 'bd_test')).toBe(
    'memory/a.png'
  );
  for (const path of [
    '../outside.png',
    'shots/a.png',
    'files/../memory/a.png',
    '/data/boards/ws/bd_other/files/a.png',
    '/data/boards/other/bd_test/files/a.png',
    '/home/me/a.png',
  ])
    expect(boardDocumentFilePath(path, 'ws', 'bd_test')).toBeNull();
});

it('anchors Board files to the current workspace while preserving canonical filenames', () => {
  const board = testBoard();
  expect(
    resolveBoardFileLink('/data/boards/ws/bd_test/memory/a%2520b.md#L2', 'ws', [board])?.path
  ).toBe('a%20b.md');
  expect(
    resolveBoardFileLink('/data/boards/ws/bd_test/memory/a%20b.md', 'ws', [board], 'canonical')
      ?.path
  ).toBe('a%20b.md');
  expect(resolveBoardFileLink('/data/boards/other/bd_test/files/a.md', 'ws', [board])).toBeNull();
  expect(resolveBoardFileLink('/data/boards/ws/bd_other/files/a.md', 'ws', [board])).toMatchObject({
    board: undefined,
  });
  expect(resolveBoardFileLink('app/boards/[id]/[tab]/files/page.tsx', 'ws', [board])).toBeNull();
  expect(resolveBoardFileLink('app/boards/[id]/[tab]/memory/page.tsx', 'ws', [board])).toBeNull();
  expect(resolveBoardFileLink('/data/boards/ws/bd_test/secrets/a.md', 'ws', [board])).toBeNull();
});

it('keeps an unavailable Board file in its preview until the catalog row arrives', async () => {
  const store = createStore();
  store.set(currentWorkspaceIdAtom, 'ws' as WorkspaceId);
  const coordinator = makeSession('coordinator', { boardRole: 'coordinator', machineId: 'devnuc' });
  store.set(sessionMetaCacheAtom, { [getSessionRoomId(coordinator.id)]: coordinator });
  const ipc = installIpc({ 'file:files/plan.md': '# Ready' });
  const host = document.createElement('div');
  // Use the same mounted preview while metadata arrives.
  const viewRoot = createRoot(host);
  const render = (boards: BoardMeta[]) =>
    act(async () =>
      viewRoot.render(
        <Provider store={store}>
          <BoardFileLinkPreview
            target={resolveBoardFileLink('/data/boards/ws/bd_test/files/plan.md', 'ws', boards)!}
            memberSessionId={'thread' as SessionId}
            onClose={() => {}}
          />
        </Provider>
      )
    );
  try {
    await render([]);
    expect(host.textContent).toBe('Board not found.');
    await render([testBoard()]);
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('Ready'));
  } finally {
    await act(async () => {
      viewRoot.unmount();
    });
    ipc.remove();
  }
});

// The shell keeps the coordinator active; only file ownership crosses to the panel thread.
it.each([
  ['polish-2/report.md', 'polish-2/report.md', undefined],
  ['/remote/chats/thread/polish-2/report.md#L12-L14', 'polish-2/report.md', 12],
  ['polish-2/report.md:7', 'polish-2/report.md', 7],
  ['polish-2/chart.png', 'polish-2/chart.png', undefined],
  ['report.md', 'polish-2/report.md', undefined],
  ['missing.md', 'missing.md', undefined],
  ['polish-2/result.html', 'polish-2/result.html', undefined],
] as const)(
  'opens the panel thread link %s using its own file provider',
  async (href, expectedPath, line) => {
    const store = createStore();
    const coordinator = makeSession('coordinator', { machineId: 'devnuc' });
    const thread = makeSession('thread', { machineId: 'remote' });
    store.set(currentWorkspaceIdAtom, 'ws' as WorkspaceId);
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(coordinator.id)]: coordinator,
      [getSessionRoomId(thread.id)]: thread,
    });
    creation.machines.set('remote', {
      id: 'remote',
      workspacePaths: { thread: '/remote/chats/thread' },
    });
    creation.fileProviders.set(
      'remote:thread',
      createFakeSessionFileProvider({
        files: [
          {
            path: 'polish-2/report.md',
            fileId: 'report',
            kind: 'text',
            sourceState: 'live-readonly',
          },
          { path: 'polish-2/chart.png', kind: 'binary', sourceState: 'live-readonly' },
          { path: 'polish-2/result.html', kind: 'text', sourceState: 'live-readonly' },
        ],
        snapshots: {
          'polish-2/report.md': {
            kind: 'text',
            text: '# Thread report\n\nRead from the thread machine.',
          },
          'polish-2/result.html': { kind: 'text', text: '<h1>Read from the thread machine.</h1>' },
          'polish-2/chart.png': {
            kind: 'binary',
            url: 'lody-resource://member/thread-chart',
            mimeType: 'image/png',
          },
        },
      })
    );
    creation.fileProviders.set(
      'devnuc:coordinator',
      createFakeSessionFileProvider({
        files: [
          {
            path: 'polish-2/report.md',
            fileId: 'report',
            kind: 'text',
            sourceState: 'live-readonly',
          },
        ],
        snapshots: { 'polish-2/report.md': { kind: 'text', text: 'Wrong coordinator file' } },
      })
    );
    const probes: unknown[] = [];
    const runtime = {
      requestFilePreview: async (
        machineId: string,
        request: { sessionId: string; path: string },
        options: unknown
      ) => {
        probes.push({ machineId, request, options });
        return request.path === 'polish-2/report.md'
          ? { status: 'error', code: 'too_large', path: request.path }
          : { status: 'error', code: 'file_not_found' };
      },
    } as unknown as WorkspaceRuntime;
    function ThreadFiles() {
      const [tab, setTab] = useState<
        | (Awaited<ReturnType<typeof resolveSessionFileLinkOpen>> & {
            ownerSessionId: SessionId;
            htmlPreviewRequestSeq?: number;
          })
        | null
      >(null);
      return (
        <>
          <SessionFileScope sessionId={thread.id}>
            {(scope) => (
              <MarkdownRenderer
                text={`[Report](${href})`}
                onAgentFileLinkClick={(path) => {
                  void resolveSessionFileLinkOpen(
                    path,
                    {
                      ...(href.endsWith('.html')
                        ? { pathKind: 'canonical' as const, previewHtml: true }
                        : {}),
                      linkContext: () => ({ mentions: ['polish-2/report.md'], outputs: [] }),
                    },
                    scope,
                    runtime
                  ).then((target) =>
                    setTab({
                      ...target,
                      ownerSessionId: scope.session.id,
                      filePath: target.filePath,
                      fileId: target.fileId,
                      startLine: target.startLine,
                      ...(href.endsWith('.html') ? { htmlPreviewRequestSeq: 1 } : {}),
                    })
                  );
                }}
              />
            )}
          </SessionFileScope>
          {tab && (
            <section aria-label="File tab" data-line={tab.startLine} data-path={tab.filePath}>
              <SessionFileScope sessionId={tab.ownerSessionId!}>
                {(scope) => (
                  <SessionFileContentView
                    sessionId={scope.session.id}
                    session={scope.session}
                    filePath={tab.filePath}
                    fileId={tab.fileId}
                    fileProvider={scope.fileProvider}
                    fileProviderPending={scope.fileProviderPending}
                    htmlPreviewRequestSeq={tab.htmlPreviewRequestSeq}
                  />
                )}
              </SessionFileScope>
            </section>
          )}
        </>
      );
    }
    const view = await mount(
      <Provider store={store}>
        <ThreadFiles />
      </Provider>
    );
    try {
      const button = (name: string) =>
        [...view.host.querySelectorAll('button')].find((b) => b.textContent === name)!;
      await act(async () => button('Report').click());
      await vi.waitFor(() =>
        expect(view.host.querySelector('[aria-label="File tab"]')).not.toBeNull()
      );
      const tab = view.host.querySelector('[aria-label="File tab"]')!;
      expect(tab.getAttribute('data-path')).toBe(expectedPath);
      expect(tab.getAttribute('data-line')).toBe(line === undefined ? null : String(line));
      if (expectedPath.endsWith('.png')) {
        await vi.waitFor(() =>
          expect(tab.querySelector('img')?.getAttribute('src')).toBe(
            'lody-resource://member/thread-chart'
          )
        );
      } else if (expectedPath.endsWith('.html')) {
        await vi.waitFor(() =>
          expect(tab.querySelector('iframe')?.getAttribute('srcdoc')).toContain(
            'Read from the thread machine.'
          )
        );
      } else if (expectedPath !== 'missing.md') {
        await vi.waitFor(() => expect(tab.textContent).toContain('Read from the thread machine.'));
      } else {
        await vi.waitFor(() => expect(tab.textContent).toMatch(/not found|not available/i));
      }
      expect(tab.textContent).not.toContain('Wrong coordinator file');
      if (href === 'report.md') {
        expect(probes).toContainEqual({
          machineId: 'remote',
          request: { sessionId: 'thread', path: 'polish-2/report.md', maxBytes: 1 },
          options: { ownerSessionId: 'thread', timeoutMs: 2500 },
        });
      }
    } finally {
      await view.unmount();
      creation.fileProviders.clear();
      creation.machines.delete('remote');
    }
  }
);

it('keeps file subscriptions in a silent leaf and enables them only after a thread file click', async () => {
  const thread = makeSession('file-thread', { machineId: 'remote' });
  const store = createStore();
  store.set(currentWorkspaceIdAtom, 'ws' as WorkspaceId);
  store.set(sessionMetaCacheAtom, { [getSessionRoomId(thread.id)]: thread });
  const firstProvider = createFakeSessionFileProvider();
  creation.fileProviders.set('remote:file-thread', firstProvider);
  const opens: {
    provider: SessionFileProvider | null;
    title: string | undefined;
    path: string;
    options: unknown;
  }[] = [];
  let chatCommits = 0;
  function ThreadSurface() {
    const links = useThreadFileLinks(thread.id, (scope, path, options) => {
      opens.push({ provider: scope.fileProvider, title: scope.session.title, path, options });
    });
    return (
      <>
        <SessionFileScopeHost
          sessionId={thread.id}
          enabled={links.enabled}
          scopeRef={links.scopeRef}
        />
        <Profiler
          id="chat"
          onRender={() => {
            chatCommits += 1;
          }}
        >
          <button onClick={() => links.onFilePathClick('report.md')}>Open report</button>
          <button onClick={() => links.onOpenHtmlFile('preview.html')}>Open HTML</button>
        </Profiler>
      </>
    );
  }
  const view = await mount(
    <Provider store={store}>
      <ThreadSurface />
    </Provider>
  );
  try {
    expect(creation.fileLeases.has(thread.id)).toBe(false);
    await act(async () => view.host.querySelector('button')!.click());
    expect(opens[0]).toMatchObject({ provider: null, path: 'report.md' });
    expect(creation.fileLeases.has(thread.id)).toBe(true);
    const beforeIndexUpdate = chatCommits;
    const nextProvider = createFakeSessionFileProvider();
    await act(async () => {
      creation.fileProviders.set('remote:file-thread', nextProvider);
      creation.fileIndexRevision += 1;
      for (const listener of creation.fileIndexListeners) listener();
      store.set(sessionMetaCacheAtom, {
        [getSessionRoomId(thread.id)]: { ...thread, title: 'Latest thread' },
      });
    });
    expect(chatCommits).toBe(beforeIndexUpdate);
    await act(async () => view.host.querySelectorAll('button')[1]!.click());
    expect(opens[1]).toEqual({
      provider: nextProvider,
      title: 'Latest thread',
      path: 'preview.html',
      options: { pathKind: 'canonical', source: 'html_attachment', previewHtml: true },
    });
  } finally {
    await view.unmount();
    creation.fileProviders.clear();
  }
  expect(creation.fileLeases.has(thread.id)).toBe(false);
});

it('shows the existing unavailable-file notice for an unhydrated or deleted viewer owner', async () => {
  const store = createStore();
  const thread = makeSession('restored-thread');
  store.set(currentWorkspaceIdAtom, 'ws' as WorkspaceId);
  const view = await mount(
    <Provider store={store}>
      <SessionFileScope sessionId={thread.id}>
        {() => <span>Owner available</span>}
      </SessionFileScope>
    </Provider>
  );
  try {
    expect(view.host.textContent).toContain('File content is not available');
    expect(creation.fileLeases.has(thread.id)).toBe(false);
    await act(async () =>
      store.set(sessionMetaCacheAtom, { [getSessionRoomId(thread.id)]: thread })
    );
    expect(view.host.textContent).toBe('Owner available');
    await act(async () => store.set(sessionMetaCacheAtom, {}));
    expect(view.host.textContent).toContain('File content is not available');
    expect(creation.fileLeases.has(thread.id)).toBe(false);
  } finally {
    await view.unmount();
  }
});

describe('Board project scope picker', () => {
  const project = (machine: string, name: string): BoardScopeLocalProject => ({
    machineId: `m-${machine}` as MachineId,
    machineName: machine,
    localProjectId: `p-${name}-${machine}` as LocalProjectId,
    name,
  });
  const localProjects = [
    project('n100', 'lody-ios'),
    project('devnuc', 'lody-ios'),
    project('mba', 'lody-ios'),
    project('devnuc', 'Lody'),
  ];

  it('merges a project of one name across machines into one row', () => {
    const options = buildBoardScopeOptions({
      localProjects,
      repositories: ['owner/web'],
      scope: [],
    });
    expect(
      options.map((option) =>
        option.kind === 'local'
          ? [option.name, option.projects.map((entry) => entry.machineName)]
          : [option.repoFullName]
      )
    ).toEqual([['Lody', ['devnuc']], ['lody-ios', ['devnuc', 'mba', 'n100']], ['owner/web']]);
  });

  it('ticks every machine of a row, reads a machine added later as partial and completes it', () => {
    const before = buildBoardScopeOptions({
      localProjects: localProjects.filter((entry) => entry.machineName !== 'mba'),
      repositories: [],
      scope: [],
    });
    const ios = before.find((option) => option.key === 'local:lody-ios');
    if (!ios) throw new Error('Expected the lody-ios row');
    const scope = toggleBoardScopeOption([], ios);
    expect(scope).toEqual([
      {
        kind: 'local',
        machineId: 'm-devnuc',
        localProjectId: 'p-lody-ios-devnuc',
        name: 'lody-ios',
      },
      { kind: 'local', machineId: 'm-n100', localProjectId: 'p-lody-ios-n100', name: 'lody-ios' },
    ]);
    expect(boardScopeNames(scope)).toEqual(['lody-ios']);
    // mba adds the same repository: it does not join the scope by itself.
    const after = buildBoardScopeOptions({ localProjects, repositories: [], scope });
    const grown = after.find((option) => option.key === 'local:lody-ios');
    if (!grown) throw new Error('Expected the lody-ios row');
    expect(boardScopeOptionState(grown, scope)).toBe('partial');
    const completed = toggleBoardScopeOption(scope, grown);
    expect(completed).toHaveLength(3);
    expect(boardScopeOptionState(grown, completed)).toBe('checked');
    expect(toggleBoardScopeOption(completed, grown)).toEqual([]);
  });

  it('keeps a row for a scoped project nobody sees any more, so it can be removed', () => {
    const gone = {
      kind: 'local' as const,
      machineId: 'm-old' as MachineId,
      localProjectId: 'p-old' as LocalProjectId,
      name: 'retired',
    };
    const options = buildBoardScopeOptions({ localProjects: [], repositories: [], scope: [gone] });
    expect(options).toMatchObject([
      { kind: 'local', name: 'retired', projects: [{ machineName: 'm-old' }] },
    ]);
    const [row] = options;
    if (!row) throw new Error('Expected the retired row');
    expect(toggleBoardScopeOption([gone], row)).toEqual([]);
  });
});
