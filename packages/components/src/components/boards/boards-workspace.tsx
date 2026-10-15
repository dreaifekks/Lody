import { useId, useState } from 'react';
import { FocusScope, useListKeyboardNavigation } from '@/ui/focus-scope';
import { useAtomValue } from 'jotai';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import type { BoardMeta, SessionMeta } from '@lody/shared';
import { boardEnabledAtom } from '@/atoms/settings';
import { currentWorkspaceSlugAtom } from '@/atoms';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import {
  useVisibleSessionMetas,
  useVisibleArchivedSessionMetas,
} from '@/hooks/use-visible-session-metas';
import { buildOpenedBySessionTree } from '@/lib/session-opened-by-tree';
import { BoardListView, boardStyles } from './board-view';
import { BoardSessionRow } from './board-session-row';
import { CreateBoardDialog } from './create-board-dialog';

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

export function BoardsWorkspace({ boardId }: { boardId?: string }) {
  const enabled = useAtomValue(boardEnabledAtom);
  const { t } = useTranslation();
  return enabled ? (
    <BoardsContent boardId={boardId} />
  ) : (
    <div {...stylex.props(boardStyles.page)}>
      {t('boards.disabled', 'Enable Boards in Settings → Experimental features.')}
    </div>
  );
}

function BoardsContent({ boardId }: { boardId?: string }) {
  const scopeId = useId();
  useListKeyboardNavigation({ scopeId });
  const { t } = useTranslation();
  const navigate = useNavigate();
  const workspaceName = useAtomValue(currentWorkspaceSlugAtom);
  const { boards } = useWorkspaceCatalog();
  const { allActiveSessions } = useVisibleSessionMetas();
  const { archivedSessions } = useVisibleArchivedSessionMetas();
  const [creating, setCreating] = useState(false);
  const board = boards.find((entry) => entry.id === boardId);
  const openBoard = (entry: BoardMeta) => {
    if (workspaceName)
      void navigate({
        to: '/$workspaceName/boards/$boardId',
        params: { workspaceName, boardId: entry.id },
      });
  };
  const openSession = (session: SessionMeta) => {
    if (workspaceName)
      void navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName, sessionId: session.parentSessionId ?? session.id },
        search: session.parentSessionId ? { tab: session.id } : {},
      });
  };
  const members = board ? allActiveSessions.filter((session) => session.boardId === board.id) : [];
  const coordinator = members.find((session) => session.id === board?.coordinatorSessionId);
  const threads = members.filter((session) => session.id !== board?.coordinatorSessionId);
  const archived = board ? archivedSessions.filter((session) => session.boardId === board.id) : [];
  return (
    <FocusScope id={scopeId} {...stylex.props(boardStyles.page)}>
      {boardId ? (
        <>
          <Button
            variant="ghost"
            onClick={() => {
              if (workspaceName)
                void navigate({ to: '/$workspaceName/boards', params: { workspaceName } });
            }}
          >
            {t('boards.back', 'All boards')}
          </Button>
          {board ? (
            <>
              <h1 {...stylex.props(boardStyles.title)}>{board.name}</h1>
              <p>{board.purpose}</p>
              <h2>{t('boards.coordinator', 'Coordinator')}</h2>
              <div {...stylex.props(boardStyles.card)}>
                {coordinator ? (
                  <BoardSessionRow
                    session={coordinator}
                    depth={0}
                    onOpen={() => openSession(coordinator)}
                  />
                ) : (
                  <p {...stylex.props(boardStyles.preview)}>
                    {t('boards.coordinatorUnavailable', 'Coordinator unavailable or archived.')}
                  </p>
                )}
              </div>
              <h2>{t('boards.threads', 'Threads')}</h2>
              {threads.length === 0 ? (
                <p {...stylex.props(boardStyles.muted)}>
                  {t('boards.noThreads', 'Sessions created by the coordinator will appear here.')}
                </p>
              ) : null}
              <div {...stylex.props(boardStyles.card)}>
                {buildBoardRows(threads).map(({ session, depth }) => (
                  <BoardSessionRow
                    key={session.id}
                    session={session}
                    depth={depth}
                    onOpen={() => openSession(session)}
                  />
                ))}
              </div>
              {archived.length ? (
                <details>
                  <summary>
                    {t('boards.archived', 'Archived ({{count}})', { count: archived.length })}
                  </summary>
                  <div {...stylex.props(boardStyles.card)}>
                    {buildBoardRows(archived).map(({ session, depth }) => (
                      <BoardSessionRow
                        key={session.id}
                        session={session}
                        depth={depth}
                        onOpen={() => openSession(session)}
                      />
                    ))}
                  </div>
                </details>
              ) : null}
            </>
          ) : (
            <p>{t('boards.notFound', 'Board not found.')}</p>
          )}
        </>
      ) : (
        <BoardListView
          boards={boards.filter((entry) => entry.archivedAtMs === undefined)}
          onCreate={() => setCreating(true)}
          onOpen={openBoard}
        />
      )}
      {creating ? (
        <CreateBoardDialog
          onClose={() => setCreating(false)}
          onCreated={(entry) => {
            setCreating(false);
            openBoard(entry);
          }}
        />
      ) : null}
    </FocusScope>
  );
}
