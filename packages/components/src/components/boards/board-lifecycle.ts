import { useAtomValue, useStore } from 'jotai';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeBoardMeta, type BoardMeta, type SessionId, type SessionMeta } from '@lody/shared';
import { allActiveSessionsAtom, archivedSessionListAtom } from '@/atoms/doc-meta';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useSessionActions } from '@/hooks/use-session-actions';
import { toast } from '@/lib/toast';
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

/**
 * What a Board's entries (its page's header menu, its sidebar row, settings,
 * Archive) do to the whole Board. Members are read when an action runs, so an
 * entry subscribes to no Session list. Archive and restore report a failure
 * themselves and resolve whether they succeeded; rename rejects, for its dialog.
 */
export function useBoardActions() {
  const { t } = useTranslation();
  const store = useStore();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const { updateSessionTitle } = useSessionActions();
  const { archiveBoard, restoreBoard } = useBoardLifecycle();
  const archive = useCallback(
    async (board: BoardMeta) => {
      try {
        await archiveBoard(board, store.get(allActiveSessionsAtom));
        return true;
      } catch (cause) {
        toast.error(
          t(
            'boards.archiveFailed',
            'Could not archive the Board: {{reason}}. It stays open; try again.',
            { reason: cause instanceof Error ? cause.message : String(cause) }
          )
        );
        return false;
      }
    },
    [archiveBoard, store, t]
  );
  const restore = useCallback(
    async (board: BoardMeta) => {
      try {
        await restoreBoard(board, store.get(archivedSessionListAtom));
        return true;
      } catch (cause) {
        toast.error(
          cause instanceof Error && cause.message === 'BOARD_LIMIT'
            ? t(
                'boards.restoreLimit',
                'A workspace can have up to 50 active Boards. Archive one first.'
              )
            : t(
                'boards.restoreFailed',
                'Could not restore the Board: {{reason}}. It stays archived; try again.',
                { reason: cause instanceof Error ? cause.message : String(cause) }
              )
        );
        return false;
      }
    },
    [restoreBoard, store, t]
  );
  // The coordinator carries the Board's name as its title, as settings keep it.
  const rename = useCallback(
    async (board: BoardMeta, name: string) => {
      const next = normalizeBoardMeta({ ...board, name });
      if (!next)
        throw new Error(
          t('boards.settings.invalid', 'Enter a name, and keep every field within its limit.')
        );
      if (!runtime) throw new Error('Runtime not ready');
      await writeWorkspaceBoard(runtime, next);
      await updateSessionTitle(board.coordinatorSessionId, next.name);
    },
    [runtime, t, updateSessionTitle]
  );
  return { archive, restore, rename };
}
