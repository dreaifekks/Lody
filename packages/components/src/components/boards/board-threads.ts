import type { BoardMeta, SessionId, SessionMeta, SessionStatus } from '@lody/shared';
import { buildOpenedBySessionTree } from '@/lib/session-opened-by-tree';
import { formatExplicitSessionTabSearch } from '@/lib/session-tab-url';

/**
 * Search of every Board entry (sidebar, `/boards/<id>`, command palette): the
 * coordinator's own Tab, never the last child Tab the page would restore, and
 * the Board panel opened once.
 */
export const boardEntrySearch = (coordinatorSessionId: SessionId) => ({
  board: true,
  tab: formatExplicitSessionTabSearch(coordinatorSessionId),
});

/** Use the same opener tree as the sidebar, with contained Tabs below their root. */
export function buildBoardRows(sessions: readonly SessionMeta[]) {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const roots = sessions.filter(
    (session) => !session.parentSessionId || !byId.has(session.parentSessionId)
  );
  return buildOpenedBySessionTree(roots, {
    getId: (session) => session.id,
    getOpenedBySessionId: (session) => session.openedByRootSessionId ?? session.openedBySessionId,
    rootRank: (session) => new Date(session.lastMessageAt ?? session.createdAt).getTime(),
  }).flatMap((node) => [
    { session: node.item, depth: node.depth },
    ...sessions
      .filter((session) => session.parentSessionId === node.id)
      .map((session) => ({ session, depth: node.depth + 1 })),
  ]);
}

/** A Board's coordinator is the Board itself; session lists show the Board instead. */
export function isBoardCoordinator(session: Pick<SessionMeta, 'boardRole'>): boolean {
  return session.boardRole === 'coordinator';
}

/**
 * A Board's conversations live in the Board: lists outside it (sidebar, mobile
 * home, Archive) show none of them while Boards are on. With the experiment off
 * the threads are ordinary sessions again; the coordinator stays the Board's.
 */
export function isBoardSession(
  session: Pick<SessionMeta, 'boardRole' | 'boardId'>,
  boardsEnabled: boolean
): boolean {
  return isBoardCoordinator(session) || (boardsEnabled && session.boardId !== undefined);
}

/** True when nothing live says otherwise and the waiting marker is newer than the last message. */
function awaitsUser(session: SessionMeta, live: SessionStatus | null | undefined): boolean {
  if (live) return live.type === 'requestPermission';
  return (session.awaitingUserSince ?? 0) > (session.lastMessageAt ?? 0);
}

export type BoardActivity = 'waiting' | 'working' | null;

/**
 * The one mark a Board row carries: some member waits for the user, else some
 * member works, else nothing. Members include the coordinator.
 */
export function boardActivity(
  board: Pick<BoardMeta, 'id'>,
  sessions: readonly SessionMeta[],
  liveStatuses: ReadonlyMap<string, SessionStatus>
): BoardActivity {
  let working = false;
  for (const session of sessions) {
    if (session.boardId !== board.id) continue;
    const live = liveStatuses.get(session.id);
    if (awaitsUser(session, live)) return 'waiting';
    if (live) working = true;
  }
  return working ? 'working' : null;
}
