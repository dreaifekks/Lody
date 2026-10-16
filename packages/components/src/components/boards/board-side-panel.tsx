import { atom, useAtomValue } from 'jotai';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  deriveBoardSessionStatus,
  getMachineFlockLocalProjects,
  getSessionRoomId,
  isBoardSessionStopped,
  type BoardMeta,
  type LocalProjectMeta,
  type MachineFlockRowMap,
  type SessionId,
  type SessionMeta,
  type SessionStatus,
} from '@lody/shared';

const localProjectsOf = (rows: MachineFlockRowMap | undefined) =>
  rows ? getMachineFlockLocalProjects(rows) : undefined;
import { currentWorkspaceIdAtom } from '@/atoms';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { sessionLiveStatusAtomFamily } from '@/atoms/presence';
import { getMachineMetaMapAtom } from '@/atoms/machines';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { useMachineFlockRowsByMachineIds } from '@/hooks/use-machine-flock-rows';
import { useStableNow } from '@/hooks/use-stable-now';
import {
  useVisibleArchivedSessionMetas,
  useVisibleSessionMetas,
} from '@/hooks/use-visible-session-metas';
import { useBoardDocument } from '@/hooks/use-board-document';
import { formatCompactRelativeTime } from '@/lib/format-relative-time';
import { toast } from '@/lib/toast';
import { BoardPanelView, BoardThreadPaneView, type BoardPanelTab } from './board-panel-view';
import { BoardThreadListView, type BoardThreadItem } from './board-thread-list';
import { BoardFileEditorView, BoardFilesView } from './board-files-view';
import { BoardNotesEditor } from './board-notes-panel';
import { BoardSettingsDialog } from './board-settings-panel';
import { CreateBoardDialog } from './create-board-dialog';
import { buildBoardRows } from './board-threads';
import { useBoardLifecycle } from './board-lifecycle';

/** Where a member runs, said once: agent · machine · project. */
function useSessionDetail() {
  const { t } = useTranslation();
  const machines = useAtomValue(getMachineMetaMapAtom);
  const agents = useAtomValue(getAllAgentConfigAtom);
  return (session: SessionMeta, localProjects?: Readonly<Record<string, LocalProjectMeta>>) => {
    const project = session.project;
    const machine = machines.get(session.machineId);
    const projects: Readonly<Record<string, LocalProjectMeta>> = {
      ...machine?.localProjects,
      ...localProjects,
    };
    const context =
      project?.kind === 'local'
        ? (projects[project.localProjectId]?.name ?? t('boards.localProject', 'Local project'))
        : project?.kind === 'github'
          ? project.repoFullName
          : t('boards.chat', 'Chat');
    return [
      session.lastModel?.name ??
        agents.find((agent) => agent.id === session.agentConfigId)?.name ??
        session.agentType,
      machine?.name ?? session.machineId,
      context,
      ...(session.isWorktree === true ? [t('boards.worktree', 'Worktree')] : []),
    ].join(' · ');
  };
}

/**
 * Thread rows from metadata and presence only: no member document is opened
 * for the list. A failure therefore shows once the thread is opened, and in the
 * coordinator's report.
 */
export function boardThreadItems(
  rows: readonly { session: SessionMeta; depth: number }[],
  live: readonly (SessionStatus | null)[],
  context: {
    lookup: (id: SessionId) => SessionMeta | undefined;
    detail: (session: SessionMeta) => string;
    now: Date;
    untitled: string;
  }
): BoardThreadItem[] {
  return rows.map(({ session, depth }, index) => ({
    id: session.id,
    title: session.title || context.untitled,
    depth,
    archived: session.isArchived === true,
    status: deriveBoardSessionStatus({
      liveStatus: live[index],
      awaitingUserSince: session.awaitingUserSince,
      lastMessageAt: session.lastMessageAt,
      collaborationStopped: isBoardSessionStopped(session, context.lookup),
    }),
    detail: context.detail(session),
    updatedLabel: formatCompactRelativeTime(
      session.lastMessageAt ?? session.createdAt,
      context.now
    ),
  }));
}

function BoardThreads({
  board,
  onOpen,
}: {
  board: BoardMeta;
  onOpen: (session: SessionMeta) => void;
}) {
  const { allActiveSessions } = useVisibleSessionMetas();
  const { archivedSessions } = useVisibleArchivedSessionMetas();
  const metas = useAtomValue(sessionMetaCacheAtom);
  const now = useStableNow();
  const detail = useSessionDetail();
  const { t } = useTranslation();
  const isMember = (session: SessionMeta) =>
    session.boardId === board.id && session.id !== board.coordinatorSessionId;
  const active = buildBoardRows(allActiveSessions.filter(isMember));
  const archived = buildBoardRows(archivedSessions.filter(isMember));
  const rows = [...active, ...archived];
  const ids = rows.map(({ session }) => session.id).join('\n');
  // One derived atom over every member's presence, never a hook per row.
  const liveAtom = useMemo(
    () =>
      atom((get) =>
        ids === ''
          ? []
          : ids.split('\n').map((id) => get(sessionLiveStatusAtomFamily(id as SessionId)))
      ),
    [ids]
  );
  const live = useAtomValue(liveAtom);
  const machineIds = [...new Set(rows.map(({ session }) => session.machineId))];
  const machineRows = useMachineFlockRowsByMachineIds(machineIds, { families: ['localProject'] });
  const threads = boardThreadItems(rows, live, {
    lookup: (id) => metas[getSessionRoomId(id)],
    detail: (session) => detail(session, localProjectsOf(machineRows.get(session.machineId))),
    now,
    untitled: t('boards.untitled', 'Untitled session'),
  });
  const byId = new Map(rows.map(({ session }) => [session.id, session]));
  return (
    <BoardThreadListView
      threads={threads}
      onOpen={(id) => {
        const session = byId.get(id as SessionId);
        if (session) onOpen(session);
      }}
    />
  );
}

function BoardFiles({ board }: { board: BoardMeta }) {
  const { t } = useTranslation();
  const [notesOpen, setNotesOpen] = useState(false);
  const { document, save, error } = useBoardDocument(board.id);
  const notesName = t('boards.notes', 'Shared notes');
  if (notesOpen)
    return (
      <BoardFileEditorView name={notesName} onBack={() => setNotesOpen(false)}>
        {document && save ? (
          <BoardNotesEditor notes={document.notes} onSave={save} />
        ) : (
          <p>
            {error
              ? t('boards.notesLoadFailed', 'Could not load notes.')
              : t('boards.loading', 'Loading…')}
          </p>
        )}
      </BoardFileEditorView>
    );
  return (
    <BoardFilesView
      files={[
        {
          id: 'notes',
          name: notesName,
          detail: t('boards.files.notesDetail', 'Every member reads and appends to it.'),
        },
      ]}
      onOpen={() => setNotesOpen(true)}
      note={t(
        'boards.files.directoryLater',
        'A shared folder for any kind of file comes in a later step. It will live on the coordinator’s machine.'
      )}
    />
  );
}

type BoardSidePanelProps = {
  board: BoardMeta;
  openThreadId: SessionId | null;
  onOpenThread: (session: SessionMeta | null) => void;
  /**
   * A direct child of the coordinator (a Tab or a Side Chat) is already mounted
   * by the coordinator's page; the page shows it there instead of a second copy.
   */
  onShowInPage: (session: SessionMeta) => void;
  onOpenThreadFull: (session: SessionMeta) => void;
  renderThread: (session: SessionMeta) => ReactNode;
  onArchived: () => void;
};

/**
 * The Board side panel on the coordinator's Session page. The open thread is
 * the page's state, so the panel can remount (compact layout) without losing it.
 * Its own state (tab, settings draft) belongs to one Board: switching Board or
 * workspace starts it afresh, so a draft can never be saved into another Board.
 */
export function BoardSidePanel(props: BoardSidePanelProps) {
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  return <BoardSidePanelContent key={`${workspaceId}:${props.board.id}`} {...props} />;
}

function BoardSidePanelContent({
  board,
  openThreadId,
  onOpenThread,
  onShowInPage,
  onOpenThreadFull,
  renderThread,
  onArchived,
}: BoardSidePanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<BoardPanelTab>('threads');
  const [dialog, setDialog] = useState<'settings' | 'thread' | null>(null);
  const { allActiveSessions } = useVisibleSessionMetas();
  const { archivedSessions } = useVisibleArchivedSessionMetas();
  const { archiveBoard } = useBoardLifecycle();
  const openThread =
    openThreadId === null
      ? null
      : (allActiveSessions.find((session) => session.id === openThreadId) ??
        archivedSessions.find((session) => session.id === openThreadId) ??
        null);
  const active = board.archivedAtMs === undefined;
  return (
    <>
      {openThread ? (
        <BoardThreadPaneView
          title={openThread.title || t('boards.untitled', 'Untitled session')}
          onBack={() => onOpenThread(null)}
          onOpenFull={() => onOpenThreadFull(openThread)}
        >
          {renderThread(openThread)}
        </BoardThreadPaneView>
      ) : (
        <BoardPanelView
          tab={tab}
          onTabChange={setTab}
          onNewThread={active ? () => setDialog('thread') : undefined}
          onOpenSettings={() => setDialog('settings')}
        >
          {tab === 'threads' ? (
            <BoardThreads
              board={board}
              onOpen={(session) =>
                session.parentSessionId === board.coordinatorSessionId
                  ? onShowInPage(session)
                  : onOpenThread(session)
              }
            />
          ) : (
            <BoardFiles board={board} />
          )}
        </BoardPanelView>
      )}
      {dialog === 'settings' ? (
        <BoardSettingsDialog
          key={board.id}
          board={board}
          onClose={() => setDialog(null)}
          onArchive={
            active
              ? () => {
                  setDialog(null);
                  void archiveBoard(board, allActiveSessions).then(onArchived, (cause: unknown) =>
                    toast.error(
                      t(
                        'boards.archiveFailed',
                        'Could not archive the Board: {{reason}}. It stays open; try again.',
                        { reason: cause instanceof Error ? cause.message : String(cause) }
                      )
                    )
                  );
                }
              : undefined
          }
        />
      ) : null}
      {dialog === 'thread' ? (
        <CreateBoardDialog
          existingBoard={board}
          onClose={() => setDialog(null)}
          onCreated={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}
