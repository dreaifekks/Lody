import { useAtomValue } from 'jotai';
import { useCallback } from 'react';
import type { BoardMeta, SessionId, SessionMeta } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useSessionActions } from '@/hooks/use-session-actions';
import { restoreWorkspaceBoard, writeWorkspaceBoard } from '@/lib/workspace-catalog-write';

/** Root Sessions of a Board: archive and restore carry their contained Tabs along. */
export function boardRootMemberIds(
  board: BoardMeta,
  sessions: readonly SessionMeta[]
): SessionId[] {
  return sessions
    .filter(
      (session) =>
        session.boardId === board.id &&
        !session.parentSessionId &&
        session.id !== board.coordinatorSessionId
    )
    .map((session) => session.id);
}

/**
 * Archiving a Board archives the coordinator and every root member, then marks
 * the row; restoring restores them all, then clears the mark. The row changes
 * last both ways, so a failure stops with the Board where it was and its entry
 * (settings or Archive) still offers the retry. Session restore covers only
 * direct Tabs, so every member root is restored explicitly.
 */
export function useBoardLifecycle() {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const { archiveSession, restoreSession } = useSessionActions();
  const archiveBoard = useCallback(
    async (board: BoardMeta, activeSessions: readonly SessionMeta[]) => {
      if (!runtime) throw new Error('Runtime not ready');
      for (const id of [board.coordinatorSessionId, ...boardRootMemberIds(board, activeSessions)])
        await archiveSession(id);
      await writeWorkspaceBoard(runtime, { ...board, archivedAtMs: Date.now() });
    },
    [archiveSession, runtime]
  );
  const restoreBoard = useCallback(
    async (board: BoardMeta, archivedSessions: readonly SessionMeta[]) => {
      if (!runtime) throw new Error('Runtime not ready');
      await restoreWorkspaceBoard(runtime, board, async () => {
        for (const id of [
          board.coordinatorSessionId,
          ...boardRootMemberIds(board, archivedSessions),
        ])
          await restoreSession(id);
      });
    },
    [restoreSession, runtime]
  );
  return { archiveBoard, restoreBoard };
}
