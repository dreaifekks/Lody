import { buildSessionDoc, openReaderView } from './conversation-view-fixtures';
import type { ConversationView } from '../src/lib/conversation-view';
// @vitest-environment jsdom
import { act } from 'react';
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
vi.mock('@/components/boards/create-board-dialog', () => ({ CreateBoardDialog: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (_key: string, fallback: string) => fallback,
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
