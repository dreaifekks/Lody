import type { BoardMeta, SessionId, SessionMeta, SessionStatus } from '@lody/shared';
import { buildOpenedBySessionTree } from '@/lib/session-opened-by-tree';
import { sessionHasUnreadMessages } from '@/lib/session-read-receipt';
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

/** Search of a Board member's entry: the Board, with the member opened the way its row opens it. */
export const boardMemberEntrySearch = (board: BoardMeta, sessionId: SessionId) =>
  sessionId === board.coordinatorSessionId
    ? boardEntrySearch(board.coordinatorSessionId)
    : { ...boardEntrySearch(board.coordinatorSessionId), boardThread: sessionId };

/**
 * A direct child of the coordinator (a Tab or a Side Chat) is already mounted
 * by the coordinator's page, so it opens there; any other thread opens in the
 * Board panel. One conversation surface per Session.
 */
export const opensInCoordinatorPage = (
  board: BoardMeta,
  session: Pick<SessionMeta, 'parentSessionId'>
) => session.parentSessionId === board.coordinatorSessionId;

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

/** A Board row's marks, the ones a conversation row carries for its own Tabs. */
export type BoardActivity = {
  isWaitingPermission: boolean;
  isWorking: boolean;
  hasUnreadMessages: boolean;
};

/**
 * A Board row reads as one conversation row over all its members, the
 * coordinator included: someone waits for the user, someone works, someone has
 * output the user has not seen. The row draws the strongest, as a session row
 * with Tabs does.
 */
export function boardActivity(
  board: Pick<BoardMeta, 'id'>,
  sessions: readonly SessionMeta[],
  liveStatuses: ReadonlyMap<string, SessionStatus>
): BoardActivity {
  const activity = { isWaitingPermission: false, isWorking: false, hasUnreadMessages: false };
  for (const session of sessions) {
    if (session.boardId !== board.id) continue;
    const live = liveStatuses.get(session.id);
    if (awaitsUser(session, live)) activity.isWaitingPermission = true;
    if (live) activity.isWorking = true;
    if (sessionHasUnreadMessages(session)) activity.hasUnreadMessages = true;
  }
  return activity;
}

/** Selection follows membership, including a contained Tab with its own Board id. */
export function resolveSidebarBoardSelection({
  boards,
  routeSessionId,
  routeBoardId,
  tabSessionId,
  tabBoardId,
}: {
  boards: readonly { id: string; coordinatorSessionId: string }[];
  routeSessionId: string | null;
  routeBoardId?: string;
  tabSessionId?: string;
  tabBoardId?: string;
}): string | undefined {
  if (routeSessionId === null) return undefined;
  const selectedSessionId = tabSessionId ?? routeSessionId;
  const membership = tabSessionId === undefined ? routeBoardId : tabBoardId;
  return boards.find((board) =>
    membership ? board.id === membership : board.coordinatorSessionId === selectedSessionId
  )?.id;
}

/** Shared with the command palette's Board › thread labels. */
export const BOARD_SESSION_TITLE_SEPARATOR = '›';
export const formatBoardSessionTitle = (parent: string, title: string) =>
  `${parent} ${BOARD_SESSION_TITLE_SEPARATOR} ${title}`;

/** Presentation provenance never grants membership: both conversations belong to this Board. */
export function resolveBoardThreadParent(
  session: Pick<SessionMeta, 'boardId' | 'parentSessionId' | 'openedBySessionId'>,
  lookup: (id: SessionId) => SessionMeta | undefined
): SessionMeta | undefined {
  const parentId = session.parentSessionId ?? session.openedBySessionId;
  const parent = parentId ? lookup(parentId) : undefined;
  return session.boardId &&
    parent?.boardId === session.boardId &&
    parent.boardRole !== 'coordinator'
    ? parent
    : undefined;
}
