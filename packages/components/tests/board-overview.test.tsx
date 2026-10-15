import { createLoroSessionData } from '@lody/shared/session-data';
import { CreateBoardDialog } from '../src/components/boards/create-board-dialog';
import { userAtom, currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../src/atoms';
import { agentConfigMetaCacheAtom } from '../src/atoms/doc-meta';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import type {
  SessionToCreate,
  SessionHistoryInput,
  AgentConfigMeta,
  WorkspaceId,
} from '@lody/shared';
import { LoroRepo } from 'loro-repo';
import { normalizeBoardMeta } from '@lody/shared';
import { changeBoardMembership } from '../src/components/boards/board-membership-dialog';
import { BoardNotesEditor } from '../src/components/boards/board-notes-panel';
import { buildSessionDoc, openReaderView } from './conversation-view-fixtures';
import type { ConversationView } from '../src/lib/conversation-view';
// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider, useAtomValue } from 'jotai';
import { describe, it, expect, vi } from 'vitest';
import {
  getSessionRoomId,
  type SessionHistory,
  type SessionMeta,
  type SessionId,
} from '@lody/shared';
import { sessionMetaCacheAtom, allActiveSessionsAtom } from '../src/atoms/doc-meta';
import { lodyPresenceStatesAtom, lodyPresenceNowMsAtom } from '../src/atoms/presence';
import { BoardSessionRow } from '../src/components/boards/board-session-row';
import { buildBoardRows } from '../src/components/boards/boards-workspace';

const docReads = vi.hoisted(() => ({
  enabled: new Set<string>(),
  histories: new Map<string, ConversationView>(),
}));
vi.mock('@/hooks/use-session-doc', () => ({
  useSessionDoc: (id: string, options: { enabled: boolean }) => {
    if (options.enabled) docReads.enabled.add(id);
    return { history: options.enabled ? (docReads.histories.get(id) ?? null) : null, ready: true };
  },
}));
const creation = vi.hoisted(() => ({
  machines: new Map<string, unknown>(),
  startSession: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
}));
vi.mock('@/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => ({ machines: creation.machines }),
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

function Rows() {
  const sessions = useAtomValue(allActiveSessionsAtom).filter(
    (entry) => entry.boardId === 'bd_test'
  );
  return (
    <>
      {buildBoardRows(sessions).map(({ session, depth }) => (
        <BoardSessionRow key={session.id} session={session} depth={depth} onOpen={() => {}} />
      ))}
    </>
  );
}

describe('board Overview', () => {
  it.each([
    {
      name: 'failed user turn',
      failed: true,
      currentFailure: false,
      oldFailure: false,
      expected: 'Failed',
    },
    {
      name: 'current chat_failed notice',
      failed: false,
      currentFailure: true,
      oldFailure: false,
      expected: 'Failed',
    },
    {
      name: 'agent turn after an old failure',
      failed: false,
      currentFailure: false,
      oldFailure: true,
      expected: 'Idle · waiting for coordinator',
    },
  ])(
    'reads a Loro-backed transcript: $name',
    async ({ failed, currentFailure, oldFailure, expected }) => {
      const id = 'transcript' as SessionId;
      const entry = (turnId: string, patch: Partial<SessionHistory>): SessionHistory => ({
        id: turnId,
        role: 'user',
        timestamp: '2026-10-15T00:00:00Z',
        finished: true,
        items: [],
        ...patch,
      });
      const failure = (turnId: string) =>
        entry(turnId, {
          role: 'system',
          items: [
            { type: 'system_notice', name: 'chat_failed', meta: { reason: 'agent_no_output' } },
          ],
        });
      const turns = [
        ...(oldFailure ? [entry('old-user', {}), failure('old-failure')] : []),
        entry('latest-user', {
          status: failed ? 'failed' : 'handled',
          author: {
            v: 1,
            kind: 'agent',
            sessionId: 'coordinator',
            turnId: 'assignment',
            name: 'Coordinator',
          },
          items: [{ type: 'text', text: 'Implement the next step.\nKeep the result small.' }],
        }),
        entry('latest-assistant', {
          role: 'assistant',
          items: [{ type: 'text', text: 'Latest conclusion from the real transcript.' }],
        }),
        ...(currentFailure ? [failure('latest-failure')] : []),
      ];
      const doc = buildSessionDoc(turns);
      const history = await openReaderView(doc, { sessionId: id });
      docReads.histories.set(id, history);
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () =>
          root.render(
            <Provider store={createStore()}>
              <BoardSessionRow
                session={makeSession(id, { awaitingUserSince: 10, lastMessageAt: 20 })}
                depth={0}
                onOpen={() => {}}
              />
            </Provider>
          )
        );
        expect(host.textContent).not.toContain('Latest conclusion');
        await act(async () =>
          host.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click()
        );
        expect(host.textContent).toContain(expected);
        expect(host.textContent).toContain('Implement the next step.');
        expect(host.textContent).not.toContain('Keep the result small.');
        expect(host.textContent).toContain('Latest conclusion from the real transcript.');
        if (oldFailure) expect(host.textContent).not.toContain('Failed');
      } finally {
        await act(async () => root.unmount());
        host.remove();
        docReads.histories.delete(id);
        history.dispose();
        doc.free();
      }
    }
  );

  it('updates membership from real metadata atoms, shows tabs/opened sessions, and uses presence rather than stale status', async () => {
    const store = createStore();
    const a = makeSession('root');
    const tab = makeSession('review', { parentSessionId: a.id });
    const child = makeSession('independent', { openedBySessionId: a.id });
    const other = makeSession('other', { boardId: 'bd_other' as never });
    const cache = Object.fromEntries(
      [a, tab, child, other].map((entry) => [getSessionRoomId(entry.id), entry])
    );
    store.set(sessionMetaCacheAtom, cache);
    store.set(lodyPresenceNowMsAtom, 1000);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    docReads.enabled.clear();
    try {
      await act(async () =>
        root.render(
          <Provider store={store}>
            <Rows />
          </Provider>
        )
      );
      expect(
        [...host.querySelectorAll('[data-board-session]')].map((node) =>
          node.getAttribute('data-board-session')
        )
      ).toEqual(['root', 'review', 'independent']);
      expect(host.textContent).not.toContain('Running');
      expect(docReads.enabled.size).toBe(0);
      await act(async () =>
        store.set(lodyPresenceStatesAtom, {
          live: {
            kind: 'session',
            sessionId: a.id,
            machineId: a.machineId,
            instanceId: 'instance' as never,
            updatedAt: 1000,
            status: { type: 'running', phase: 'finalizing' },
          },
        })
      );
      expect(host.querySelector('[data-board-session="root"]')?.textContent).toContain(
        'Finalizing'
      );
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>('[data-board-session="review"] button[aria-expanded]')
          ?.click()
      );
      expect([...docReads.enabled]).toEqual(['review']);
      await act(async () =>
        store.set(sessionMetaCacheAtom, {
          ...cache,
          [getSessionRoomId(a.id)]: { ...a, boardId: undefined },
        })
      );
      expect(host.querySelector('[data-board-session="root"]')).toBeNull();
      expect(host.querySelector('[data-board-session="review"]')).not.toBeNull();
      expect(host.querySelector('[data-board-session="independent"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
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

it('shows the system driving depth and the limit notice, then clears stopped on a fresh human turn', async () => {
  const id = 'chain-coordinator' as SessionId;
  const doc = buildSessionDoc([
    {
      id: 'human',
      role: 'user',
      timestamp: '2026-10-16T00:00:00Z',
      inputConfig: { chainDepth: 0 },
      items: [],
    },
    {
      id: 'automatic',
      role: 'system',
      timestamp: '2026-10-16T00:00:01Z',
      inputConfig: { chainDepth: 15 },
      items: [],
    },
    {
      id: 'limit',
      role: 'system',
      timestamp: '2026-10-16T00:00:02Z',
      items: [
        {
          type: 'system_notice',
          name: 'board_chain_limit',
          meta: { boardId: 'bd_test', drivingTurnId: 'automatic' },
        },
      ],
    },
  ]);
  const data = createLoroSessionData({ sessionId: id, doc });
  const history = await openReaderView(doc, { sessionId: id });
  docReads.histories.set(id, history);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <Provider>
          <BoardSessionRow
            session={makeSession(id, { boardRole: 'coordinator' })}
            depth={0}
            onOpen={() => {}}
          />
        </Provider>
      )
    );
    expect(container.textContent).toContain('Stopped');
    expect(container.textContent).toContain('15/16');
    await act(async () =>
      data.commands.appendTurn({
        id: 'fresh-human',
        role: 'user',
        timestamp: '2026-10-16T00:00:03Z',
        author: { v: 1, kind: 'human', userId: 'user' },
        inputConfig: { chainDepth: 0 },
        items: [],
        fileDiff: [],
      })
    );
    expect(container.textContent).not.toContain('Stopped');
    expect(container.textContent).toContain('0/16');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    history.dispose();
    doc.free();
    docReads.histories.delete(id);
  }
});
