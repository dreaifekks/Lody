import { useAtomValue, useStore } from 'jotai';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  boardMaintenanceTurn,
  getServerNow,
  type BoardMaintenanceKind,
  type BoardMeta,
  type SessionHistory,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { allActiveSessionsAtom, archivedSessionListAtom } from '@/atoms/doc-meta';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useSessionActions } from '@/hooks/use-session-actions';
import { toast } from '@/lib/toast';
import {
  renameWorkspaceBoard,
  restoreWorkspaceBoard,
  writeWorkspaceBoard,
} from '@/lib/workspace-catalog-write';

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
 * Archiving a Board archives every root member, then the coordinator, then marks
 * the row; restoring restores the members, then the coordinator, then clears the
 * mark. The coordinator and the row change last both ways, so a failure stops
 * with the Board where it was and every entry (its page's menu, which follows the
 * coordinator, the sidebar row, settings, Archive) still offers the retry.
 * Session restore covers only direct Tabs, so every member root is restored
 * explicitly.
 */
export function useBoardLifecycle() {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const { archiveSession, restoreSession } = useSessionActions();
  const archiveBoard = useCallback(
    async (board: BoardMeta, activeSessions: readonly SessionMeta[]) => {
      if (!runtime) throw new Error('Runtime not ready');
      for (const id of [...boardRootMemberIds(board, activeSessions), board.coordinatorSessionId])
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
          ...boardRootMemberIds(board, archivedSessions),
          board.coordinatorSessionId,
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
      if (!runtime) throw new Error('Runtime not ready');
      const next = await renameWorkspaceBoard(runtime, board.id, name).catch((cause: unknown) => {
        throw cause instanceof Error && cause.message === 'BOARD_INVALID'
          ? new Error(
              t('boards.settings.invalid', 'Enter a name, and keep every field within its limit.')
            )
          : cause;
      });
      await updateSessionTitle(board.coordinatorSessionId, next.name);
    },
    [runtime, t, updateSessionTitle]
  );
  return { archive, restore, rename };
}

/**
 * Ask the coordinator's machine to tidy the coordinator's context now, or to
 * start it a new agent conversation. The request is the divider itself: the
 * machine picks it up once the coordinator is free and keeps it current. Needs
 * only the workspace runtime, so the conversation header can hold it.
 */
export function useBoardMaintenanceRequest() {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  return useCallback(
    async (coordinator: Pick<SessionMeta, 'id' | 'boardId'>, kind: BoardMaintenanceKind) => {
      if (!runtime || !coordinator.boardId) return;
      const turn = boardMaintenanceTurn(
        crypto.randomUUID(),
        { boardId: coordinator.boardId, kind, trigger: 'manual', status: 'requested' },
        new Date(getServerNow()).toISOString()
      );
      try {
        await runtime.writer.appendSessionHistory(coordinator.id, turn as SessionHistory);
      } catch (cause) {
        toast.error(
          t('boards.maintenance.requestFailed', 'Could not ask the coordinator: {{reason}}', {
            reason: cause instanceof Error ? cause.message : String(cause),
          })
        );
      }
    },
    [runtime, t]
  );
}
