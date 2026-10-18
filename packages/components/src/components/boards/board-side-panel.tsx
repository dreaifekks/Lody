import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { Download } from 'lucide-react';
import { atom, useAtomValue } from 'jotai';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  deriveBoardSessionStatus,
  getMachineFlockLocalProjects,
  getSessionRoomId,
  isBoardSessionStopped,
  type BoardFileEntry,
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
import { sessionHasUnreadMessages } from '@/lib/session-read-receipt';
import { BoardSchedules } from './board-schedules';
import { BoardPanelView, BoardThreadPaneView, type BoardPanelTab } from './board-panel-view';
import { BoardThreadListView, type BoardThreadItem } from './board-thread-list';
import { BoardDirectoryTreeView, BoardFileEditorView } from './board-files-view';
import {
  BoardFilePreview,
  useBoardDirectoryFileProvider,
  useBoardFileDownload,
} from './board-directory';
import { BoardNotesEditor } from './board-notes-panel';
import { CreateBoardDialog } from './create-board-dialog';
import { buildBoardRows, opensInCoordinatorPage } from './board-threads';

const panelStyles = stylex.create({
  padded: { display: 'flex', flexDirection: 'column', gap: space[1], padding: space[2] },
});

/** Where a member runs, said once: agent · machine · project. */
export function useSessionDetail() {
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
    unread: sessionHasUnreadMessages(session),
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
  const [open, setOpen] = useState<'notes' | BoardFileEntry | null>(null);
  const { document, save, error } = useBoardDocument(board.id);
  const { provider, truncated } = useBoardDirectoryFileProvider(board);
  const download = useBoardFileDownload(board, 'files');
  const downloadLabel = t('boards.files.download', 'Download');
  const menuItems = useMemo(
    () =>
      download
        ? [{ id: 'download' as const, label: downloadLabel, icon: Download, run: download }]
        : undefined,
    [download, downloadLabel]
  );
  const notesName = t('boards.notes', 'Shared notes');
  const back = t('boards.files.back', 'Back to files');
  if (open === 'notes')
    return (
      <BoardFileEditorView name={notesName} onBack={() => setOpen(null)}>
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
  if (open)
    return (
      <div {...stylex.props(panelStyles.padded)}>
        <BoardFilePreview
          board={board}
          area="files"
          entry={open}
          backLabel={back}
          onBack={() => setOpen(null)}
        />
      </div>
    );
  return (
    <BoardDirectoryTreeView
      notesName={notesName}
      onOpenNotes={() => setOpen('notes')}
      provider={provider}
      truncated={truncated}
      onOpenFile={(filePath) => setOpen(provider?.entry(filePath) ?? null)}
      viewStateKey={`board-files:${board.id}`}
      {...(menuItems ? { menuItems } : {})}
    />
  );
}

/** "devnuc · Lody": where a thread bound to a project runs. Chats have no such place. */
export function useThreadLocation(session: SessionMeta | null): string | undefined {
  const machines = useAtomValue(getMachineMetaMapAtom);
  const rows = useMachineFlockRowsByMachineIds(session ? [session.machineId] : [], {
    families: ['localProject'],
  });
  const project = session?.project;
  if (!session || !project) return undefined;
  const machine = machines.get(session.machineId);
  const name =
    project.kind === 'local'
      ? ({ ...machine?.localProjects, ...localProjectsOf(rows.get(session.machineId)) }[
          project.localProjectId
        ]?.name ?? undefined)
      : project.repoFullName.split('/').pop();
  return [machine?.name ?? session.machineId, name].filter(Boolean).join(' · ');
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
  /** A member to open once (`?boardThread`), the way its row opens it; then `onThreadRequestDone`. */
  requestedScheduleId?: string | null;
  onScheduleRequestDone?: () => void;
  requestedThreadId: SessionId | null;
  onThreadRequestDone: () => void;
};

/**
 * The Board side panel on the coordinator's Session page. The open thread is
 * the page's state, so the panel can remount (compact layout) without losing it.
 * Its own state (tab, open file, new-thread draft) belongs to one Board:
 * switching Board or workspace starts it afresh.
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
  requestedThreadId,
  onThreadRequestDone,
  requestedScheduleId,
  onScheduleRequestDone,
}: BoardSidePanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<BoardPanelTab>('threads');
  const [scheduleId, setScheduleId] = useState<string>();
  useEffect(() => {
    if (!requestedScheduleId) return;
    setTab('schedules');
    setScheduleId(requestedScheduleId);
    onOpenThread(null);
    onScheduleRequestDone?.();
  }, [requestedScheduleId, onScheduleRequestDone, onOpenThread]);
  const [creatingThread, setCreatingThread] = useState(false);
  const { allActiveSessions } = useVisibleSessionMetas();
  const { archivedSessions } = useVisibleArchivedSessionMetas();
  const openThread =
    openThreadId === null
      ? null
      : (allActiveSessions.find((session) => session.id === openThreadId) ??
        archivedSessions.find((session) => session.id === openThreadId) ??
        null);
  const active = board.archivedAtMs === undefined;
  const location = useThreadLocation(openThread);
  const openMember = useCallback(
    (session: SessionMeta) =>
      opensInCoordinatorPage(board, session) ? onShowInPage(session) : onOpenThread(session),
    [board, onOpenThread, onShowInPage]
  );
  // A requested member opens as soon as its metadata is here.
  const requested =
    requestedThreadId === null
      ? undefined
      : (allActiveSessions.find((session) => session.id === requestedThreadId) ??
        archivedSessions.find((session) => session.id === requestedThreadId));
  useEffect(() => {
    if (!requested) return;
    onThreadRequestDone();
    openMember(requested);
  }, [onThreadRequestDone, openMember, requested]);
  return (
    <>
      {openThread ? (
        <BoardThreadPaneView
          title={openThread.title || t('boards.untitled', 'Untitled session')}
          location={location}
          onBack={() => onOpenThread(null)}
          onOpenFull={() => onOpenThreadFull(openThread)}
        >
          {renderThread(openThread)}
        </BoardThreadPaneView>
      ) : (
        <BoardPanelView
          tab={tab}
          onTabChange={setTab}
          onNewThread={active ? () => setCreatingThread(true) : undefined}
        >
          {tab === 'threads' ? (
            <BoardThreads board={board} onOpen={openMember} />
          ) : tab === 'schedules' ? (
            <BoardSchedules
              board={board}
              scheduleId={scheduleId}
              onSelect={setScheduleId}
              onOpenThread={openMember}
            />
          ) : (
            <BoardFiles board={board} />
          )}
        </BoardPanelView>
      )}
      {creatingThread ? (
        <CreateBoardDialog
          existingBoard={board}
          onClose={() => setCreatingThread(false)}
          onCreated={() => setCreatingThread(false)}
        />
      ) : null}
    </>
  );
}
