import { BoardThreadStatusCard } from '@/components/boards/board-thread-status-card';
import { useBoardSessionNavigation } from '@/components/boards/board-session-navigation';
import type { SessionNavigationTarget } from '@/lib/session-navigation';
import * as stylex from '@stylexjs/stylex';
import { BoardThreadParentBreadcrumb } from '@/components/boards/board-thread-breadcrumb';
/**
 * Boards: the coordinator page with its Board side panel, the sidebar Boards
 * section, the settings dialog and the create dialog. Real components with
 * synthetic data; the side panel rows come from the same `boardThreadItems`
 * the container uses.
 */
import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import i18next from 'i18next';
import { Fragment, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { createStore, Provider } from 'jotai';
import { parseLodyPresenceStates } from '@lody/shared';
import { useTranslation } from 'react-i18next';
import { ArrowUp, ChevronDown, Download, Monitor, Settings2 } from 'lucide-react';
import { Button } from '@lody/ui/button';
import {
  normalizeBoardMeta,
  type BoardFileEntry,
  type BoardId,
  type BoardProjectRef,
  type BoardReportEvent,
  type LocalProjectId,
  type MachineId,
  type SessionHistoryParsed,
  type SessionId,
  type SessionMeta,
  type SessionStatus,
  type WorkspaceId,
  getSessionRoomId,
} from '@lody/shared';
import { currentWorkspaceIdAtom, userAtom } from '@/atoms';
import {
  boardArticleExperimentEnabledAtom,
  boardExperimentEnabledAtom,
  experimentalFeaturesEnabledAtom,
} from '@/atoms/settings';
import { createPortal } from 'react-dom';
import { PopupContainerProvider } from '@lody/ui/popup-container';
import { X } from 'lucide-react';
import { BoardArticleDialog } from '@/components/boards/board-article-dialog';
import {
  createRelocatableHost,
  RelocatableSlot,
  type RelocatableHost,
} from '@/components/boards/relocatable-host';
import { SessionFileContentView } from '@/components/sessions/session-file-content-view';
import {
  createFakeSessionFileProvider,
  type SessionFileProvider,
} from '@/lib/session-file-provider';
import {
  ARTICLE_BROKEN_HTML,
  ARTICLE_DEMO_HTML,
  ARTICLE_REPORT_MD,
  ARTICLE_REPORT_MD_REVISED,
} from './board-article-demo';
import {
  COMPARE_BEFORE_SVG,
  COMPARE_MANIFEST_MD,
  COMPARE_NAV_A_HTML,
  COMPARE_NAV_B_HTML,
  COMPARE_NAV_C_HTML,
  COMPARE_NAV_PHONE_HTML,
} from './board-compare-demo';
import { SessionBoardCompareView } from '@/components/boards/board-compare-view';
import { isCompareManifestPath } from '@/components/boards/compare-manifest';
import {
  articleAnnotationsAtom,
  useThreadArticleAnnotations,
  type ArticleAnnotation,
} from '@/components/boards/article-annotations';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import {
  lodyPresenceNowMsAtom,
  lodyPresenceStatesAtom,
  lodyPresenceSyncStateAtom,
} from '@/atoms/presence';
import {
  DesktopRunConfigMenu,
  DesktopPermissionModeButton,
} from '@/components/sessions/desktop-run-config-menu';
import {
  RenameSessionDialogView,
  type RenameSessionDialogTarget,
} from '@/components/sessions/rename-session-dialog';
import { ChatComposer } from '@/components/chat/chat-composer';
import {
  MessageRowView,
  SessionChatStreamView,
  type ChatStreamItem,
} from '@/components/ai-gui/view';
import { SidebarUpdatedSessionList } from '@/components/sidebar-updated-session-list';
import { LoroSidebar } from '@/components/loro-sidebar';
import { SessionAccessControl, SessionArchivedBadge } from '@/components/session-sharing';
import { SessionHeaderMenu } from '@/components/sessions/session-chat-interface';
import { SESSION_PAGE_HEADER_PILLS_CLASS } from '@/components/sessions/session-conversation-page';
import { DesktopSessionDetailLayout } from '@/components/sessions/desktop-session-detail-layout';
import { SessionSidePanelTabBar } from '@/components/sessions/session-side-panel-tab-bar';
import { SessionTabBar } from '@/components/sessions/session-tab-bar';
import { ForceMobileLayoutProvider } from '@/hooks/use-mobile';
import {
  BoardPanelView,
  BoardThreadPaneView,
  BoardThreadBackButton,
  BoardThreadHeader,
  BoardThreadOpenButton,
  type BoardPanelTab,
} from '@/components/boards/board-panel-view';
import { BoardThreadListView } from '@/components/boards/board-thread-list';
import { BoardDirectoryTreeView, BoardFileEditorView } from '@/components/boards/board-files-view';
import { BoardNotesEditor } from '@/components/boards/board-notes-panel';
import {
  BoardSettingsDialogView,
  boardSettingsDraft,
  type BoardSettingsPage,
} from '@/components/boards/board-settings-panel';
import { BoardFilePreview, BoardFileRowsView } from '@/components/boards/board-directory';
import { BoardSidebarSection } from '@/components/boards/board-sidebar-section';
import { BoardCreateDialogView } from '@/components/boards/board-create-dialog-view';
import { BoardProjectScopePickerView } from '@/components/boards/board-project-scope-picker';
import {
  buildBoardScopeOptions,
  type BoardScopeLocalProject,
} from '@/components/boards/board-project-scope';
import { ArchivedBoardsView } from '@/components/boards/archived-boards-section';
import { boardThreadItems } from '@/components/boards/board-side-panel';
import {
  buildBoardRows,
  isBoardSession,
  resolveSidebarBoardSelection,
  resolveBoardThreadPageNavigation,
  resolveBoardThreadParent,
} from '@/components/boards/board-threads';
import { BoardDirectoryFileProvider } from '@/lib/board-directory-file-provider';
import { cn } from '@/lib/utils';
import { SettingsStoryProviders } from './settings-story-shell';

const NOW = Date.parse('2026-10-16T09:00:00.000Z');
const BOARD = 'bd_story' as BoardId;
const COORDINATOR = 'board-coordinator' as SessionId;
const THREAD = 'thread-sidebar' as SessionId;

const board = normalizeBoardMeta({
  version: 1,
  id: BOARD,
  name: 'Lody 协调者模式',
  purpose:
    '把 Claude Projects 的协调者模式搬进 Lody：协调者拆任务、开线程，人随时进任一线程插话。先做完 PR4 轮数与交接，再做看板主界面。',
  coordinatorSessionId: COORDINATOR,
  createdAtMs: NOW - 86_400_000,
  createdByUserId: 'user',
  rules: {
    maxRoundsPerThread: 4,
    reportHumanTurns: false,
    executorConstraints: '改代码用 worktree；提交前跑受影响包的 typecheck 和 lint；不要 push。',
  },
})!;

const member = (
  id: string,
  title: string,
  minutesAgo: number,
  extra: Partial<SessionMeta> = {}
): SessionMeta =>
  ({
    id: id as SessionId,
    title,
    machineId: 'devnuc' as MachineId,
    userId: 'user',
    cliType: 'builtin',
    agentType: 'claude',
    boardId: BOARD,
    openedBySessionId: COORDINATOR,
    createdAt: new Date(NOW - 86_400_000).toISOString(),
    lastMessageAt: NOW - minutesAgo * 60_000,
    // Seen unless a member says otherwise.
    lastReadAt: extra.lastMessageAt ?? NOW - minutesAgo * 60_000,
    ...extra,
  }) as SessionMeta;

const members: SessionMeta[] = [
  member(THREAD, '侧边栏里的看板入口', 3, {
    lastModel: { name: 'Opus 5.5' },
    lastMessageAt: NOW - 3 * 60_000,
    project: { kind: 'local', localProjectId: 'lp-lody' } as SessionMeta['project'],
  }),
  // Opened by the thread above: it stays under it, and its question lifts the thread.
  member('thread-entry-review', '评审：两种入口方案', 2, {
    lastModel: { name: 'Gemini' },
    openedBySessionId: THREAD,
    awaitingUserSince: NOW - 60_000,
    lastMessageAt: NOW - 2 * 60_000,
  }),
  member('thread-rounds', 'PR4 轮数与交接', 1, {
    lastModel: { name: 'Codex Sol' },
    isWorktree: true,
  }),
  member('thread-review', '评审：PR4 轮数检查', 1, {
    lastModel: { name: 'Gemini' },
    parentSessionId: 'thread-rounds' as SessionId,
  }),
  // Finished an hour ago and not opened since: the unread dot.
  member('thread-memory', '调研 Claude Projects 的记忆', 60, {
    lastModel: { name: 'Opus 5.5' },
    machineId: 'n100' as MachineId,
    lastReadAt: NOW - 90 * 60_000,
  }),
  member('thread-ios', 'iOS 推送分组回归', 40, {
    lastModel: { name: 'Codex Sol' },
    machineId: 'mba' as MachineId,
    collaborationStopped: true,
  }),
  member('thread-old', 'Overview 只读页', 1440, {
    lastModel: { name: 'Codex Sol' },
    isArchived: true,
  }),
];
const live: Record<string, SessionStatus> = {
  'thread-rounds': { type: 'running' } as SessionStatus,
  'thread-review': { type: 'running' } as SessionStatus,
};
const MACHINES: Record<string, string> = { devnuc: 'devnuc', n100: 'n100', mba: 'MacBook Air' };
const rows = [
  ...buildBoardRows(members.filter((session) => !session.isArchived)),
  ...buildBoardRows(members.filter((session) => session.isArchived)),
];
const threads = boardThreadItems(
  rows,
  rows.map(({ session }) => live[session.id] ?? null),
  {
    lookup: (id) => members.find((session) => session.id === id),
    detail: (session) =>
      [
        session.lastModel?.name,
        MACHINES[session.machineId],
        session.project?.kind === 'local' ? 'Lody' : '对话',
      ]
        .filter(Boolean)
        .join(' · '),
    now: new Date(NOW),
    untitled: '未命名会话',
  }
);

function reportEvent(
  kind: BoardReportEvent['kind'],
  sessionId: string,
  title: string,
  text: string
): BoardReportEvent {
  return {
    kind,
    sessionId: sessionId as SessionId,
    machineId: 'devnuc' as MachineId,
    turnId: `${sessionId}-turn`,
    at: NOW,
    origin: 'system',
    title,
    output: { text },
  } as BoardReportEvent;
}

const opus = { modelId: 'claude-opus-5-5', name: 'Opus 5.5' };
const coordinatorMessages: SessionHistoryParsed[] = [
  {
    id: 'c-user-1',
    role: 'user',
    timestamp: '2026-10-16T01:00:00.000Z',
    read: true,
    items: [{ type: 'text', text: board.purpose }],
  },
  {
    id: 'c-assistant-1',
    role: 'assistant',
    timestamp: '2026-10-16T01:00:05.000Z',
    read: true,
    finished: true,
    modelInfo: opus,
    items: [
      {
        type: 'text',
        text: '拆成三条线程，已经开好：\n\n1. **PR4 轮数与交接**：devnuc 的 worktree，Codex Sol。\n2. **侧边栏里的看板入口**：devnuc，Claude Opus，先出两种方案让你选。\n3. **iOS 推送分组回归**：MacBook Air 上跑真机构建。\n\n有结果我会在这里汇总，需要你决定的会单独列出来。',
      },
    ],
  },
  {
    id: 'c-batch',
    role: 'system',
    timestamp: '2026-10-16T02:10:00.000Z',
    read: true,
    items: [
      {
        type: 'operation_completion_batch',
        batchId: 'story-batch',
        memberCount: 2,
        members: [
          reportEvent(
            'waiting_user',
            THREAD,
            '侧边栏里的看板入口',
            '两种新建入口只留一种，需要你选。'
          ),
          reportEvent('failed', 'thread-ios', 'iOS 推送分组回归', '构建缺少 Xcode 26 的签名配置。'),
        ].map((event, index) => ({
          type: 'operation_completion' as const,
          deliveryId: `report-${index}`,
          operationId: `report-${index}`,
          operationKind: 'board_report' as const,
          completion: {
            type: 'result' as const,
            value: { items: [], boardReport: { boardId: BOARD, events: [event] } },
          },
        })),
      },
    ],
  },
  {
    id: 'c-assistant-2',
    role: 'assistant',
    timestamp: '2026-10-16T02:10:06.000Z',
    read: true,
    finished: true,
    modelInfo: opus,
    items: [
      {
        type: 'text',
        text: '两条回报：\n\n- **侧边栏里的看板入口** 在等你选新建入口，可以直接点进那个线程回答。\n- **iOS 推送分组回归** 构建失败，是 Mac 上缺签名配置，不是代码问题。我先停下这条线程，等你在 Mac 上处理证书。',
      },
    ],
  },
];
const threadMessages: SessionHistoryParsed[] = [
  {
    id: 't-user-1',
    role: 'user',
    timestamp: '2026-10-16T01:00:10.000Z',
    read: true,
    items: [
      { type: 'text', text: '给看板在侧边栏设计一个入口，和对话同一级。出两种方案，让用户选。' },
    ],
  },
  {
    id: 't-assistant-1',
    role: 'assistant',
    timestamp: '2026-10-16T01:20:00.000Z',
    read: true,
    finished: true,
    modelInfo: opus,
    items: [
      {
        type: 'text',
        text: '看板在侧边栏单独一组，和对话分组同级。新建入口有两种做法：\n\n**A. 只在「看板」组标题上放「+」**，落地页不动。\n\n**B. 落地页再加「看板」**，新建看板和开对话在同一个输入框。\n\n我建议 A。你选哪个？',
      },
    ],
  },
];

function Conversation({
  sessionId,
  messages,
}: {
  sessionId: SessionId;
  messages: SessionHistoryParsed[];
}) {
  const items: ChatStreamItem[] = messages.map((message, turnIndex) => ({
    type: 'message',
    sessionId,
    message,
    turnIndex,
  }));
  return (
    <SessionChatStreamView
      sessionId={sessionId}
      items={items}
      renderMessageRow={({ message, sessionId: id }) => (
        <MessageRowView message={message} sessionId={id} onNavigateSession={() => {}} />
      )}
    />
  );
}

function Composer({ sessionId, placeholder }: { sessionId: SessionId; placeholder: string }) {
  const [prompt, setPrompt] = useState('');
  const { t } = useTranslation();
  // Stands in for the session composer's hint about a Board article's comments.
  const annotations = useThreadArticleAnnotations(sessionId);
  const [model, setModel] = useState<string | null>('opus');
  const [mode, setMode] = useState<string | null>('auto');
  const [config, setConfig] = useState<Record<string, string | boolean>>({ plan_mode: false });
  const modes = [
    { value: 'auto', label: 'Auto' },
    { value: 'default', label: 'Default' },
  ];
  const selectors = [
    {
      type: 'boolean' as const,
      configId: 'plan_mode',
      label: 'Plan',
      options: [] as [],
      currentValue: false,
    },
  ];
  return (
    <ChatComposer
      tone="dark"
      variant="session"
      promptValue={prompt}
      onPromptChange={setPrompt}
      promptPlaceholder={placeholder}
      promptRows={1}
      statusMessage={
        annotations.length > 0
          ? t('sessions.article.annotation.pending', 'Includes {{count}} comments', {
              count: annotations.length,
            })
          : undefined
      }
      selector={
        <>
          <DesktopRunConfigMenu
            agentSelection={null}
            fallbackAgent={{ cliType: 'builtin', agentType: 'claude' }}
            agentLocked
            modelOptions={[
              { value: 'opus', label: 'Opus 5.5' },
              { value: 'sonnet', label: 'Sonnet' },
            ]}
            selectedModelId={model}
            onModelChange={setModel}
            modeOptions={modes}
            selectedModeId={mode}
            configOptionSelectors={selectors}
            configOptionValues={config}
            onConfigOptionChange={(id, value) => setConfig({ ...config, [id]: value })}
          />
          <DesktopPermissionModeButton
            modeOptions={modes}
            selectedModeId={mode}
            onModeChange={setMode}
          />
        </>
      }
      primaryAction={
        <Button
          type="button"
          variant="primary"
          aria-label={t('chat.send', 'Send')}
          shape="pill"
          icon
        >
          <ArrowUp size={16} />
        </Button>
      }
    />
  );
}

/** The conversation surface: stream above, composer below, as on a Session page. */
function ChatSurface({
  sessionId,
  messages,
  placeholder,
}: {
  sessionId: SessionId;
  messages: SessionHistoryParsed[];
  placeholder: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <Conversation sessionId={sessionId} messages={messages} />
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pb-3">
        <Composer sessionId={sessionId} placeholder={placeholder} />
      </div>
    </div>
  );
}

const coordinatorSession = member(COORDINATOR, board.name, 2, {
  boardRole: 'coordinator',
  openedBySessionId: undefined,
});

type PanelState =
  | {
      kind: 'tabs';
      tab: BoardPanelTab;
      notes?: boolean;
      file?: BoardFileEntry;
      /** The listing stopped at its 500-file limit. */
      truncated?: boolean;
    }
  | { kind: 'thread'; id?: SessionId; running?: boolean };

const sharedFiles: BoardFileEntry[] = [
  { path: 'design/board-home.md', sizeBytes: 8_200, modifiedAtMs: NOW - 2 * 3_600_000 },
  { path: 'screens/sidebar-entry-a.png', sizeBytes: 182_000, modifiedAtMs: NOW - 20 * 60_000 },
  { path: 'release-checklist.md', sizeBytes: 1_400, modifiedAtMs: NOW - 26 * 3_600_000 },
  { path: 'screens/board-home.sketch', sizeBytes: 2_400_000, modifiedAtMs: NOW - 3 * 3_600_000 },
];

/** The Board directory's `files/` as the agent service lists it. */
const sharedFilesProvider = new BoardDirectoryFileProvider(async () => ({
  entries: sharedFiles,
  truncated: false,
}));

/**
 * The workspace the file preview asks through. The desktop's IPC is the
 * stand-in a screenshot script installs; without it the preview names the
 * file only.
 */
const previewStore = createStore();
previewStore.set(currentWorkspaceIdAtom, 'ws' as WorkspaceId);
previewStore.set(sessionMetaCacheAtom, {
  [getSessionRoomId(COORDINATOR)]: { ...coordinatorSession, machineId: 'devnuc' as MachineId },
});
const memoryFiles: BoardFileEntry[] = [
  { path: 'MEMORY.md', sizeBytes: 640, modifiedAtMs: NOW - 24 * 3_600_000 },
  { path: 'decisions-board-home.md', sizeBytes: 2_100, modifiedAtMs: NOW - 48 * 3_600_000 },
  { path: 'devnuc-test-environment.md', sizeBytes: 1_700, modifiedAtMs: NOW - 48 * 3_600_000 },
  { path: 'user-prefers-chinese-replies.md', sizeBytes: 300, modifiedAtMs: NOW - 48 * 3_600_000 },
];

function BoardPanel({ initial, narrow = false }: { initial: PanelState; narrow?: boolean }) {
  const [panel, setPanel] = useState<PanelState>(initial);
  const [notes, setNotes] = useState(
    '# 2026-10-16\n\n- PR4：轮数检查放在 lody_session_chat，followUp 不计轮。\n- 侧边栏入口待用户选择。'
  );
  const { t } = useTranslation();
  const [listItems, setItems] = useState(threads);
  const [renameTarget, setRenameTarget] = useState<RenameSessionDialogTarget | null>(null);
  const rename = (id: string, title: string) =>
    setItems((items) => items.map((item) => (item.id === id ? { ...item, title } : item)));
  const actions = {
    onArchive: (id: string) =>
      setItems((items) =>
        items.map((item) => (item.id === id ? { ...item, archived: true } : item))
      ),
    onRestore: (id: string) =>
      setItems((items) =>
        items.map((item) => (item.id === id ? { ...item, archived: false } : item))
      ),
    onMarkUnread: (id: string) =>
      setItems((items) => items.map((item) => (item.id === id ? { ...item, unread: true } : item))),
    onCopyUrl: () => {},
    onRename: rename,
    onBeginRename: (sessionId: string, initialTitle: string) =>
      setRenameTarget({ sessionId: sessionId as SessionId, initialTitle }),
  };
  const thread = members.find(
    (session) => session.id === (panel.kind === 'thread' ? (panel.id ?? THREAD) : THREAD)
  )!;
  const parent = resolveBoardThreadParent(thread, (id) => members.find((entry) => entry.id === id));
  return panel.kind === 'thread' ? (
    <BoardThreadPaneView
      title={thread.title ?? ''}
      location="devnuc · Lody"
      parentThread={
        parent
          ? { title: parent.title!, onOpen: () => setPanel({ kind: 'thread', id: parent.id }) }
          : undefined
      }
      onBack={() => setPanel({ kind: 'tabs', tab: 'threads' })}
      onOpenFull={() => {}}
      onStop={panel.running ? () => setPanel({ kind: 'thread', id: thread.id }) : undefined}
      menuSlot={
        <SessionHeaderMenu
          session={thread}
          machineName="devnuc"
          onCopyUrl={noop}
          onCopyConversationHistory={noop}
          onOpenSearch={noop}
          onRename={noop}
          onArchive={() => {
            actions.onArchive(thread.id);
            setPanel({ kind: 'tabs', tab: 'threads' });
          }}
          t={t}
        />
      }
    >
      <ChatSurface sessionId={thread.id} messages={threadMessages} placeholder="回复这个线程…" />
    </BoardThreadPaneView>
  ) : (
    <BoardPanelView
      tab={panel.tab}
      onTabChange={(tab) => setPanel({ kind: 'tabs', tab })}
      onNewThread={() => {}}
    >
      {panel.tab === 'threads' ? (
        <>
          <RenameSessionDialogView
            target={renameTarget}
            onClose={() => setRenameTarget(null)}
            onRename={rename}
          />
          <BoardThreadListView
            now={new Date(NOW)}
            threads={listItems}
            actions={actions}
            onOpen={(id) => {
              if (!narrow) setPanel({ kind: 'thread', id: id as SessionId });
            }}
          />
        </>
      ) : panel.notes === true ? (
        <BoardFileEditorView
          name={t('boards.notes')}
          onBack={() => setPanel({ kind: 'tabs', tab: 'files' })}
        >
          <BoardNotesEditor notes={notes} onSave={async (text) => setNotes(text)} />
        </BoardFileEditorView>
      ) : panel.file ? (
        <div className="p-2">
          <Provider store={previewStore}>
            <BoardFilePreview
              board={board}
              area="files"
              entry={panel.file}
              backLabel={t('boards.files.back')}
              onBack={() => setPanel({ kind: 'tabs', tab: 'files' })}
            />
          </Provider>
        </div>
      ) : (
        <BoardDirectoryTreeView
          notesName={t('boards.notes')}
          onOpenNotes={() => setPanel({ kind: 'tabs', tab: 'files', notes: true })}
          provider={sharedFilesProvider}
          truncated={panel.truncated === true}
          onOpenFile={(path) => {
            const file = sharedFilesProvider.entry(path);
            if (file) setPanel({ kind: 'tabs', tab: 'files', file });
          }}
          viewStateKey="board-files:story"
          menuItems={[
            { id: 'download', label: t('boards.files.download'), icon: Download, run: () => {} },
          ]}
        />
      )}
    </BoardPanelView>
  );
}

/** Synthetic projects: one repository on three machines, one on two, one on one. */
const scopeProjects: BoardScopeLocalProject[] = [
  ['devnuc', 'Lody'],
  ['n100', 'Lody'],
  ['mba', 'Lody'],
  ['devnuc', 'lody-ios'],
  ['mba', 'lody-ios'],
  ['devnuc', 'hebi8xc'],
].map(([machine, name]) => ({
  machineId: `machine-${machine}` as MachineId,
  machineName: machine!,
  localProjectId: `local-project-${name}-${machine}` as LocalProjectId,
  name: name!,
}));
const scopeRefs = (...names: string[]): BoardProjectRef[] =>
  scopeProjects
    .filter((project) => names.includes(project.name))
    .map(({ machineId, localProjectId, name }) => ({
      kind: 'local',
      machineId,
      localProjectId,
      name,
    }));

function ScopePicker({ initial, labelled }: { initial: BoardProjectRef[]; labelled?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <BoardProjectScopePickerView
      options={buildBoardScopeOptions({
        localProjects: scopeProjects,
        repositories: ['example/web-app'],
        scope: value,
      })}
      value={value}
      onChange={setValue}
      labelled={labelled}
    />
  );
}

/** The settings dialog over synthetic data: the real view, memory rows included. */
function SettingsDialogStory({ initialPage }: { initialPage: BoardSettingsPage }) {
  const [page, setPage] = useState(initialPage);
  const [draft, setDraft] = useState(() => ({
    ...boardSettingsDraft(board),
    instructions: '开始先查 nmem。\n改代码用 worktree，不要 push。',
  }));
  return (
    <SettingsStoryProviders>
      <BoardSettingsDialogView
        page={page}
        onPageChange={setPage}
        draft={draft}
        onDraftChange={(patch) => setDraft({ ...draft, ...patch })}
        onArchive={() => {}}
        autoMemory={<BoardFileRowsView entries={memoryFiles} onOpen={() => {}} />}
        projectScope={<ScopePicker labelled initial={scopeRefs('Lody', 'lody-ios')} />}
        onSave={() => {}}
        onClose={() => {}}
      />
    </SettingsStoryProviders>
  );
}

const chatRows = [
  ['chat-1', '查 RC 自动启动和多目录方案'],
  ['chat-2', '拆解 TradingView 对数坐标'],
  ['chat-3', 'Desktop 环境 MCP 支持'],
].map(([sessionId, title], index) => ({
  sessionId: sessionId!,
  title: title!,
  repoFullName: null,
  branchName: '',
  latestMessageAt: NOW - (index + 1) * 3_600_000,
  addedLines: 0,
  deletedLines: 0,
  isWorking: false,
  hasUnreadMessages: false,
  isOffline: false,
  isWaitingPermission: false,
}));

const noop = () => {};
const IDLE = { isWaitingPermission: false, isWorking: false, hasUnreadMessages: false };

/** A Board's row offers what a conversation row offers, on hover and right click. */
const boardRowActions = { onRename: noop, onCopyUrl: noop, onShare: noop, onArchive: noop };

function Sidebar({ selectedId, onOpen }: { selectedId: string; onOpen: (id: string) => void }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <LoroSidebar
      workspaceName="dreaife"
      userEmail="dreaife@example.com"
      workspaces={[{ id: 'ws', name: 'dreaife' }]}
      currentWorkspaceId="ws"
      activeNav={null}
      labels={{ home: '新对话', schedules: '定时任务' }}
      boardsContent={
        <BoardSidebarSection
          boards={[
            {
              id: BOARD,
              name: board.name,
              coordinatorSessionId: COORDINATOR,
              activity: { ...IDLE, isWaitingPermission: true, hasUnreadMessages: true },
            },
            {
              id: 'bd_release',
              name: '0.106 同步与发布',
              coordinatorSessionId: 'c2' as SessionId,
              activity: { ...IDLE, isWorking: true },
            },
            {
              id: 'bd_hebi',
              name: 'hebi8XC 会话网络',
              coordinatorSessionId: 'c3' as SessionId,
              activity: { ...IDLE, hasUnreadMessages: true },
            },
            {
              id: 'bd_quiet',
              name: 'Mizuki 周报',
              coordinatorSessionId: 'c4' as SessionId,
              activity: IDLE,
            },
          ]}
          selectedId={selectedId}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed(!collapsed)}
          onOpen={(entry) => onOpen(entry.id)}
          onCreate={() => {}}
          actions={boardRowActions}
        />
      }
      afterSessionListContent={null}
      sessionListProps={{ sessions: chatRows, repos: [], selectedSessionId: null }}
      onHomeClicked={() => {}}
      onArchiveClicked={() => {}}
      onSchedulesClicked={() => {}}
    />
  );
}

/** Boards are an experiment: the page's menu names Board actions only while it is on. */
function BoardStoryProvider({
  children,
  enabled = true,
  articles = false,
  annotations = [],
}: {
  children: ReactNode;
  enabled?: boolean;
  articles?: boolean;
  annotations?: readonly ArticleAnnotation[];
}) {
  const [store] = useState(() => {
    const fixtureStore = createStore();
    fixtureStore.set(
      sessionMetaCacheAtom,
      Object.fromEntries(members.map((session) => [getSessionRoomId(session.id), session]))
    );
    fixtureStore.set(experimentalFeaturesEnabledAtom, true);
    fixtureStore.set(boardExperimentEnabledAtom, enabled);
    fixtureStore.set(boardArticleExperimentEnabledAtom, articles);
    fixtureStore.set(articleAnnotationsAtom, annotations);
    return fixtureStore;
  });
  return <Provider store={store}>{children}</Provider>;
}

/**
 * The conversation header's controls as the coordinator's page draws them: the
 * share control, the "…" menu with the Board's rename/archive, then the gear.
 */
function BoardHeaderToolbar() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full shrink-0 items-center gap-1 pl-1 pr-2">
      <div className={cn(SESSION_PAGE_HEADER_PILLS_CLASS, 'items-center')}>
        <SessionAccessControl publicShare={{ status: 'none', onOpen: noop }} />
      </div>
      <SessionHeaderMenu
        session={coordinatorSession}
        machineName="devnuc"
        workspacePath="/home/dreaife/out/Lody"
        onCopyConversationHistory={noop}
        onCopyUrl={noop}
        onOpenPublicShare={noop}
        onShareAsImage={noop}
        onOpenSearch={noop}
        onFork={noop}
        onRename={noop}
        onArchive={noop}
        t={t}
      />
      <Button variant="ghost" size="small" icon aria-label="看板设置">
        <Settings2 size={16} />
      </Button>
    </div>
  );
}

/**
 * Mirrors the coordinator's Session page with the Board tab selected. Opening
 * a Board from the sidebar keeps the page mounted, as a cached page does.
 */
function CoordinatorPage({ initial }: { initial: PanelState }) {
  const [entry, setEntry] = useState({ board: BOARD as string, seq: 1 });
  const sidePanelTabs = [
    { id: 'board', label: '看板', kind: 'board' as const, closeable: true },
    { id: 'files', label: '工作区文件', kind: 'files' as const, closeable: true },
  ];
  return (
    <SettingsStoryProviders>
      <BoardStoryProvider>
        <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
          <Sidebar
            selectedId={entry.board}
            onOpen={(id) => setEntry({ board: id, seq: entry.seq + 1 })}
          />
          <main className="min-w-0 flex-1 overflow-hidden">
            <DesktopSessionDetailLayout
              defaultSizes={{ main: 50, sidebar: 50 }}
              layoutStorageId={null}
              layoutResetKey={`${entry.board}:${entry.seq}`}
              topBar={
                <SessionTabBar
                  variant="session"
                  parentSession={coordinatorSession}
                  childSessions={[]}
                  draftTabs={[]}
                  archivedChildSessions={[]}
                  activeTabSessionId={COORDINATOR}
                  onTabSelect={() => {}}
                  onNewTab={() => {}}
                  rightSlot={<BoardHeaderToolbar />}
                />
              }
              chatSurfaces={
                <ChatSurface
                  sessionId={COORDINATOR}
                  messages={coordinatorMessages}
                  placeholder="告诉协调者…"
                />
              }
              terminalDock={null}
              secondaryPanel={
                <div className="flex h-full min-h-0 flex-col">
                  <SessionSidePanelTabBar
                    tabs={sidePanelTabs}
                    activeTabId="board"
                    onTabSelect={() => {}}
                    onTabClose={() => {}}
                    closeTabLabel={(label) => `关闭 ${label}`}
                  />
                  <div className="min-h-0 flex-1">
                    <BoardPanel initial={initial} />
                  </div>
                </div>
              }
              sidebarOpen
              onSidebarCollapse={() => {}}
              deleteConfirmDialog={null}
            />
          </main>
        </div>
      </BoardStoryProvider>
    </SettingsStoryProviders>
  );
}

/** The mobile Board drawer: the same panel, full screen; a thread opens its page. */
function PhoneBoard({ initial = { kind: 'tabs', tab: 'threads' } }: { initial?: PanelState }) {
  return (
    <SettingsStoryProviders>
      <ForceMobileLayoutProvider force>
        <div className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
          <div className="flex h-12 shrink-0 items-center px-4 font-semibold">{board.name}</div>
          <div className="min-h-0 flex-1">
            <BoardPanel initial={initial} narrow />
          </div>
        </div>
      </ForceMobileLayoutProvider>
    </SettingsStoryProviders>
  );
}

const meta = {
  title: 'Workspace/Boards',
  component: CoordinatorPage,
  parameters: { layout: 'fullscreen' },
  args: { initial: { kind: 'tabs', tab: 'threads' } },
} satisfies Meta<typeof CoordinatorPage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Opening a Board: the coordinator conversation with the Board panel beside it. */
export const Home: Story = {};

/** A thread open inside the panel. */
export const ThreadOpen: Story = { args: { initial: { kind: 'thread' } } };

const articleProvider = createFakeSessionFileProvider({
  sourceState: 'live-collaborative',
  files: [
    {
      fileId: 'articles/report.md',
      path: 'articles/report.md',
      kind: 'text',
      sourceState: 'live-readonly',
    },
    {
      fileId: 'articles/demo.html',
      path: 'articles/demo.html',
      kind: 'text',
      sourceState: 'live-readonly',
    },
  ],
  snapshots: {
    'articles/report.md': { kind: 'text', text: ARTICLE_REPORT_MD },
    'articles/demo.html': { kind: 'text', text: ARTICLE_DEMO_HTML },
  },
});

const ARTICLE_FILES = [
  { fileId: 'articles/report.md', path: 'articles/report.md' },
  { fileId: 'articles/demo.html', path: 'articles/demo.html' },
  { fileId: 'articles/bench.html', path: 'articles/bench.html' },
].map((file) => ({ ...file, kind: 'text' as const, sourceState: 'live-readonly' as const }));

/**
 * The thread rewrites the report while the reader has it open: the article's
 * first read gets the report as written, every later check the revision.
 */
const revisingArticleProvider = (): SessionFileProvider => {
  const before = createFakeSessionFileProvider({
    sourceState: 'live-collaborative',
    files: ARTICLE_FILES,
    snapshots: {
      'articles/report.md': { kind: 'text', text: ARTICLE_REPORT_MD },
      'articles/bench.html': { kind: 'text', text: ARTICLE_BROKEN_HTML },
    },
  });
  const after = createFakeSessionFileProvider({
    sourceState: 'live-collaborative',
    files: ARTICLE_FILES,
    snapshots: {
      'articles/report.md': { kind: 'text', text: ARTICLE_REPORT_MD_REVISED },
      'articles/bench.html': { kind: 'text', text: ARTICLE_BROKEN_HTML },
    },
  });
  let reads = 0;
  return new Proxy(before, {
    get(target, key) {
      if (key === 'openFile') return (id: string) => (reads++ === 0 ? before : after).openFile(id);
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};

/**
 * A thread's article over the coordinator page, as the page opens it from a
 * link in the thread: each thread's one conversation is portalled into a
 * relocatable host that sits in the Board panel, or in the dialog while open.
 * The dialog follows the panel to another member; the article stays.
 */
function ArticleDialogPage({
  path,
  initialThread = THREAD,
  annotations,
  archived = false,
  provider = articleProvider,
}: {
  path: string | null;
  initialThread?: SessionId;
  annotations?: readonly ArticleAnnotation[];
  archived?: boolean;
  provider?: SessionFileProvider;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(path);
  const [closing, setClosing] = useState(false);
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const [threadId, setThreadId] = useState(initialThread);
  const [hosts] = useState(() => new Map<SessionId, RelocatableHost>());
  if (!hosts.has(threadId)) hosts.set(threadId, createRelocatableHost());
  const host = hosts.get(threadId)!;
  const owner = members.find((session) => session.id === THREAD)!;
  const thread = members.find((session) => session.id === threadId)!;
  const parent = resolveBoardThreadParent(thread, (id) => members.find((entry) => entry.id === id));
  const inArticle = open !== null && !closing;
  // The page closes in two commits: the dialog lets go, then unmounts.
  useLayoutEffect(() => {
    if (!closing) return;
    setOpen(null);
    setClosing(false);
  }, [closing]);
  const close = () => setClosing(true);
  return (
    <SettingsStoryProviders>
      <BoardStoryProvider articles annotations={annotations}>
        <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
          <Sidebar selectedId={BOARD} onOpen={() => {}} />
          <main className="min-w-0 flex-1 overflow-hidden">
            <DesktopSessionDetailLayout
              defaultSizes={{ main: 50, sidebar: 50 }}
              layoutStorageId={null}
              topBar={
                <SessionTabBar
                  variant="session"
                  parentSession={coordinatorSession}
                  childSessions={[]}
                  draftTabs={[]}
                  archivedChildSessions={[]}
                  activeTabSessionId={COORDINATOR}
                  onTabSelect={() => {}}
                  onNewTab={() => {}}
                  rightSlot={<BoardHeaderToolbar />}
                />
              }
              chatSurfaces={
                <ChatSurface
                  sessionId={COORDINATOR}
                  messages={coordinatorMessages}
                  placeholder="告诉协调者…"
                />
              }
              terminalDock={null}
              secondaryPanel={
                <div className="flex h-full min-h-0 flex-col">
                  <SessionSidePanelTabBar
                    tabs={[{ id: 'board', label: '看板', kind: 'board', closeable: true }]}
                    activeTabId="board"
                    onTabSelect={() => {}}
                    onTabClose={() => {}}
                    closeTabLabel={(label) => `关闭 ${label}`}
                  />
                  <div className="min-h-0 flex-1">
                    <RelocatableSlot key={threadId} host={host} className="h-full" />
                  </div>
                </div>
              }
              sidebarOpen
              onSidebarCollapse={() => {}}
              deleteConfirmDialog={null}
            />
          </main>
        </div>
        <Fragment key={threadId}>
          {createPortal(
            <PopupContainerProvider container={inArticle ? panel : undefined}>
              <div className="flex h-full min-h-0 flex-col">
                <BoardThreadHeader
                  title={thread.title ?? ''}
                  location={archived ? 'homeN100 · algorithm-practice' : 'devnuc · Lody'}
                  {...(archived
                    ? {
                        desktopActionsSlot: <SessionArchivedBadge iconOnlyWhenNarrow />,
                        menuSlot: (
                          <SessionHeaderMenu
                            session={thread}
                            machineName="homeN100"
                            onCopyUrl={noop}
                            onCopyConversationHistory={noop}
                            onOpenSearch={noop}
                            onRename={noop}
                            onArchive={noop}
                            t={t}
                          />
                        ),
                      }
                    : {})}
                  {...(parent
                    ? {
                        parentThread: {
                          title: parent.title!,
                          onOpen: () => setThreadId(parent.id),
                        },
                      }
                    : {})}
                  startSlot={inArticle ? undefined : <BoardThreadBackButton onBack={() => {}} />}
                  endSlot={
                    inArticle ? (
                      <Button variant="ghost" size="small" icon aria-label="关闭" onClick={close}>
                        <X size={16} />
                      </Button>
                    ) : (
                      <BoardThreadOpenButton onOpen={() => {}} />
                    )
                  }
                />
                <div className="min-h-0 flex-1">
                  <ChatSurface
                    sessionId={thread.id}
                    messages={threadMessages}
                    placeholder="回复这个线程…"
                  />
                </div>
                {open ? null : (
                  <div className="flex gap-2 border-t border-border p-2 text-sm">
                    <Button
                      size="small"
                      variant="secondary"
                      onClick={() => setOpen('articles/report.md')}
                    >
                      report.md
                    </Button>
                    <Button
                      size="small"
                      variant="secondary"
                      onClick={() => setOpen('articles/demo.html')}
                    >
                      demo.html
                    </Button>
                  </div>
                )}
              </div>
            </PopupContainerProvider>,
            host.node
          )}
        </Fragment>
        {open ? (
          <BoardArticleDialog
            title={open.split('/').at(-1)!}
            threadHost={host}
            holdsThread={!closing}
            wide={isCompareManifestPath(open)}
            onPanelChange={setPanel}
            onClose={close}
            article={
              isCompareManifestPath(open) ? (
                <SessionBoardCompareView
                  scope={`session:${owner.id}`}
                  fileProvider={provider}
                  manifestPath={open}
                  comments={inArticle ? { threadId, ownerThreadId: owner.id } : null}
                  onOpenInTab={close}
                />
              ) : (
                <SessionFileContentView
                  key={open}
                  sessionId={owner.id}
                  session={owner}
                  filePath={open}
                  fileId={open}
                  fileProvider={provider}
                  fileProviderRole="read"
                  article={{ onOpenInTab: close, annotationThreadId: inArticle ? threadId : null }}
                  className="h-full"
                />
              )
            }
          />
        ) : null}
      </BoardStoryProvider>
    </SettingsStoryProviders>
  );
}

/** A thread's Markdown report over the page, its thread beside it; select text to comment. */
export const ArticleReport: Story = {
  render: () => <ArticleDialogPage path="articles/report.md" />,
};

/** A report comment waiting at its passage; the block's last line ends in a mark. */
const reportComment = (
  id: string,
  quote: string,
  comment: string,
  blockText = quote,
  index = -1
): ArticleAnnotation => ({
  id,
  threadId: THREAD,
  ownerThreadId: THREAD,
  path: 'articles/report.md',
  quote,
  comment,
  block: { index, text: blockText },
});

/** Unsent comments on the report: two on one list item, one each on a quote and code. */
export const ArticleAnnotated: Story = {
  render: () => (
    <ArticleDialogPage
      path="articles/report.md"
      annotations={[
        reportComment(
          'cdn',
          '只能从几个 CDN 加载脚本和样式',
          '列出是哪几个 CDN。',
          'HTML 在 widget 页面里运行，只能从几个 CDN 加载脚本和样式。'
        ),
        reportComment(
          'widget',
          'HTML 在 widget 页面里运行',
          '和普通文件 tab 的 HTML 预览是同一个页面吗？',
          'HTML 在 widget 页面里运行，只能从几个 CDN 加载脚本和样式。'
        ),
        reportComment('code', 'useSessionFileDigestWatch', '这个 hook 在哪个文件？'),
        reportComment(
          'stale',
          '上游 0.107.0 还没打 tag',
          '打了 tag 之后更新这句。',
          '这份数据可能过时了：上游 0.107.0 还没打 tag。'
        ),
      ]}
    />
  ),
};

/**
 * The review loop: two comments went with the thread's last message (#1 on a
 * passage the thread has since rewritten, #2 still waiting) and one is ready
 * to send. The thread's rewrite lands at the article's next check (15 s): the
 * rewritten passages get a bar in the margin and the header counts them.
 */
export const ArticleReviewed: Story = {
  render: () => {
    const sent = (annotation: ArticleAnnotation, number: number): ArticleAnnotation => ({
      ...annotation,
      sent: { number, atMs: Date.now() - 60_000 },
    });
    return (
      <ArticleDialogPage
        path="articles/report.md"
        provider={revisingArticleProvider()}
        annotations={[
          // Block indices as the report renders: the list item 4, the code 27, the header cell 9.
          sent(
            reportComment(
              'cdn',
              '只能从几个 CDN 加载脚本和样式',
              '列出是哪几个 CDN。',
              'HTML 在 widget 页面里运行，只能从几个 CDN 加载脚本和样式。',
              4
            ),
            1
          ),
          sent(
            reportComment(
              'code',
              'useSessionFileDigestWatch',
              '这个 hook 在哪个文件？',
              'useSessionFileDigestWatch({ enabled, busy, check });',
              27
            ),
            2
          ),
          reportComment('table', '需要发 dev 包', '聚焦布局这行为什么不用发？', '需要发 dev 包', 9),
        ]}
      />
    );
  },
};

/**
 * A test bench whose script throws and whose CDN file is missing: the errors
 * show under the page, ready to go with the thread's next message.
 */
export const ArticleHtmlErrors: Story = {
  render: () => (
    <ArticleDialogPage path="articles/bench.html" provider={revisingArticleProvider()} />
  ),
};

/** An interactive HTML article that loads Chart.js from a CDN inside the widget page. */
export const ArticleHtml: Story = {
  render: () => <ArticleDialogPage path="articles/demo.html" />,
};

const COMPARE_FILES: Record<string, string> = {
  'designs/nav/nav.compare.md': COMPARE_MANIFEST_MD,
  'designs/nav/nav-a.html': COMPARE_NAV_A_HTML,
  'designs/nav/nav-b.html': COMPARE_NAV_B_HTML,
  'designs/nav/nav-c.html': COMPARE_NAV_C_HTML,
  'designs/nav/nav-phone.html': COMPARE_NAV_PHONE_HTML,
  'designs/nav/before.svg': COMPARE_BEFORE_SVG,
};

const compareProvider = createFakeSessionFileProvider({
  sourceState: 'live-collaborative',
  files: Object.keys(COMPARE_FILES).map((path) => ({
    fileId: path,
    path,
    kind: 'text' as const,
    sourceState: 'live-readonly' as const,
  })),
  snapshots: Object.fromEntries(
    Object.entries(COMPARE_FILES).map(([path, text]) => [path, { kind: 'text' as const, text }])
  ),
});

/** A comparison's option comment, as the view writes it. */
const compareComment = (
  letter: string,
  file: string,
  quote: string,
  comment: string,
  extra: Partial<ArticleAnnotation> & { spot?: { x: number; y: number }; pick?: true } = {}
): ArticleAnnotation => {
  const { spot, pick, ...rest } = extra;
  return {
    id: `compare-${letter}-${comment}`,
    threadId: THREAD,
    ownerThreadId: THREAD,
    path: `designs/nav/${file}`,
    quote,
    comment,
    block: { index: spot ? 1 + spot.y : 0, text: 'old' },
    compare: {
      manifest: 'designs/nav/nav.compare.md',
      letter,
      ...(pick ? { pick } : {}),
      ...(spot ? { spot } : {}),
    },
    ...rest,
  };
};

/**
 * Five options of one settings page, side by side at one shared scale: three
 * desktop navigations, a phone take at its own size, and the current page as
 * a picture. The conversation stays beside them.
 */
export const ArticleCompare: Story = {
  render: () => <ArticleDialogPage path="designs/nav/nav.compare.md" provider={compareProvider} />,
};

/**
 * The same comparison mid-review: B picked to build on, a comment on A, two
 * spots pointed at in C (one sent earlier, before C was rewritten).
 */
export const ArticleCompareAnnotated: Story = {
  render: () => (
    <ArticleDialogPage
      path="designs/nav/nav.compare.md"
      provider={compareProvider}
      annotations={[
        compareComment('B', 'nav-b.html', 'B · 顶部标签', '选这个方案作为基础', { pick: true }),
        compareComment('A', 'nav-a.html', 'A · 侧栏导航', '侧栏的分组标题用 A 的写法'),
        compareComment('C', 'nav-c.html', 'C · 图标栏 · a.on “通”', '选中态的配色用这个', {
          spot: { x: 28, y: 36 },
        }),
        compareComment('C', 'nav-c.html', 'C · 图标栏 · section.card “外观”', '卡片间距再大一点', {
          spot: { x: 320, y: 120 },
          sent: { number: 2, atMs: Date.now() - 3_600_000 },
        }),
      ]}
    />
  ),
};

/** The report's dialog after its breadcrumb moved to a member the thread opened. */
export const ArticleOtherThread: Story = {
  render: () => (
    <ArticleDialogPage
      path="articles/report.md"
      initialThread={'thread-entry-review' as SessionId}
    />
  ),
};

/** The page before an article opens and after it closes: the thread back in its panel. */
export const ArticleClosed: Story = {
  render: () => <ArticleDialogPage path={null} />,
};

/** An archived thread in the panel: its header with the badge, menu and a long location. */
export const ArchivedThreadPanel: Story = {
  render: () => <ArticleDialogPage path={null} archived />,
};

/** The shared notes and the Board directory's `files/`. */
export const Files: Story = { args: { initial: { kind: 'tabs', tab: 'files' } } };

/** A directory past the 500-file listing limit. */
export const FilesTruncated: Story = {
  args: { initial: { kind: 'tabs', tab: 'files', truncated: true } },
};

/** Settings open from the gear in the conversation's header: General, with the instructions. */
export const Settings: Story = { render: () => <SettingsDialogStory initialPage="general" /> };

/** Settings › Memory: the agents' memory files. */
export const SettingsMemory: Story = {
  render: () => <SettingsDialogStory initialPage="memory" />,
};

/** A name and a coordinator; the goal is optional and nothing is sent. */
export const CreateBoard: Story = {
  render: function CreateBoardStory() {
    const [goal, setGoal] = useState('');
    const [name, setName] = useState('');
    return (
      <SettingsStoryProviders>
        <BoardCreateDialogView
          goal={goal}
          name={name}
          onGoalChange={setGoal}
          onNameChange={setName}
          coordinator={
            <Button variant="secondary" size="small">
              <Monitor size={14} aria-hidden />
              devnuc · Claude · Opus 5.5
              <ChevronDown size={14} aria-hidden />
            </Button>
          }
          projectScope={<ScopePicker initial={[]} />}
          onSubmit={() => {}}
          onClose={() => {}}
        />
      </SettingsStoryProviders>
    );
  },
};

const openScopeMenu: NonNullable<Story['play']> = async ({ canvasElement }) => {
  await userEvent.click(within(canvasElement).getByRole('button', { name: /project scope/i }));
};

/** Project scope left at every project: the trigger says so, "All projects" is ticked. */
export const ProjectScopeAll: Story = {
  render: () => (
    <SettingsStoryProviders>
      <ScopePicker initial={[]} />
    </SettingsStoryProviders>
  ),
  play: openScopeMenu,
};

/** Narrowed to two projects: the trigger names them. */
export const ProjectScopeNarrowed: Story = {
  render: () => (
    <SettingsStoryProviders>
      <ScopePicker initial={scopeRefs('Lody', 'hebi8xc')} />
    </SettingsStoryProviders>
  ),
  play: openScopeMenu,
};

/**
 * One row per project name across machines. lody-ios is ticked on devnuc only,
 * so after mba added it the row reads as partial; ticking it adds mba.
 */
export const ProjectScopeMerged: Story = {
  render: () => (
    <SettingsStoryProviders>
      <ScopePicker
        initial={[
          ...scopeRefs('Lody'),
          ...scopeRefs('lody-ios').filter(
            (ref) => ref.kind === 'local' && ref.machineId === 'machine-devnuc'
          ),
        ]}
      />
    </SettingsStoryProviders>
  ),
  play: openScopeMenu,
};

/** 390 px: the Board drawer. */
export const Narrow: Story = { render: () => <PhoneBoard /> };

/** The Board directory in the mobile drawer. */
export const NarrowFiles: Story = {
  render: () => <PhoneBoard initial={{ kind: 'tabs', tab: 'files' }} />,
};

/** 390 px: the mobile sidebar with its Boards section. */
export const NarrowSidebar: Story = {
  render: () => (
    <SettingsStoryProviders>
      <ForceMobileLayoutProvider force>
        <div className="h-dvh w-full bg-background text-foreground">
          <Sidebar selectedId={BOARD} onOpen={() => {}} />
        </div>
      </ForceMobileLayoutProvider>
    </SettingsStoryProviders>
  ),
};

/** Archived Boards on the Archive page. */
export const Archived: Story = {
  render: () => (
    <div className="p-6">
      <ArchivedBoardsView boards={[{ ...board, archivedAtMs: NOW }]} onRestore={() => {}} />
    </div>
  ),
};

export const Notes: Story = {
  render: function NotesStory() {
    const [notes, setNotes] = useState(
      '# Release decisions\n\n- Keep the implementation small.\n- Verify the desktop and mobile layouts.'
    );
    return <BoardNotesEditor notes={notes} onSave={async (text) => setNotes(text)} />;
  },
};

export const InboxReports: Story = {
  render: function InboxReportsStory() {
    const { t } = useTranslation();
    return (
      <>
        <MessageRowView
          sessionId={'coordinator' as SessionId}
          message={{
            id: 'board-reports',
            role: 'system',
            timestamp: '2026-10-16T00:00:00Z',
            items: [
              {
                type: 'operation_completion_batch',
                batchId: 'demo-board-batch',
                memberCount: 4,
                members: (['finished', 'failed', 'waiting_user', 'notice'] as const).map(
                  (kind, index) => ({
                    type: 'operation_completion',
                    deliveryId: `report-${kind}`,
                    operationId: `report-${kind}`,
                    operationKind: 'board_report',
                    completion: {
                      type: 'result',
                      value: {
                        items: [],
                        boardReport: {
                          boardId: 'bd_demo' as BoardId,
                          events: [
                            {
                              kind,
                              sessionId: `member-${index}` as SessionId,
                              machineId: 'laptop' as MachineId,
                              turnId: 'work',
                              at: 1,
                              origin: 'system',
                              title: [
                                t('boards.story.reportsTask'),
                                t('boards.story.buildTask'),
                                t('boards.story.reviewTask'),
                                t('boards.story.researchTask'),
                              ][index],
                              output: {
                                text:
                                  [
                                    t('boards.story.reportsOutput'),
                                    t('boards.story.buildOutput'),
                                    t('boards.story.reviewOutput'),
                                    t('boards.story.researchOutput'),
                                  ][index] ?? '',
                              },
                            },
                          ],
                        },
                      },
                    },
                  })
                ),
              },
              {
                type: 'system_notice',
                name: 'board_chain_limit',
                meta: { boardId: 'bd_demo', drivingTurnId: 'last-input' },
              },
            ],
          }}
          onNavigateSession={() => {}}
        />
      </>
    );
  },
};

/**
 * The main session's own conversation: each assigned thread is one live card
 * (the Board panel row's mark, then where it runs), and results that went along
 * with a message are one line.
 */
const assignedStore = createStore();
assignedStore.set(userAtom, { id: 'user', name: 'Board demo', email: 'board@example.com' });
assignedStore.set(experimentalFeaturesEnabledAtom, true);
assignedStore.set(boardExperimentEnabledAtom, true);
assignedStore.set(sessionMetaCacheAtom, {
  [getSessionRoomId(COORDINATOR)]: coordinatorSession,
  ...Object.fromEntries(members.map((session) => [getSessionRoomId(session.id), session])),
});
assignedStore.set(lodyPresenceNowMsAtom, NOW);
assignedStore.set(lodyPresenceSyncStateAtom, 'synced');
assignedStore.set(
  lodyPresenceStatesAtom,
  parseLodyPresenceStates({
    machine: { kind: 'machine', machineId: 'devnuc', instanceId: 'story', updatedAt: NOW },
    ...Object.fromEntries(
      Object.entries(live).map(([id, status]) => [
        id,
        {
          kind: 'session' as const,
          sessionId: id as SessionId,
          machineId: 'devnuc' as MachineId,
          instanceId: 'story' as never,
          updatedAt: NOW,
          status,
        },
      ])
    ),
  })
);
const assigned = [THREAD, 'thread-rounds', 'thread-memory', 'thread-ios', 'thread-entry-review'];
function AssignedThreadCards({
  onNavigateSession,
}: {
  onNavigateSession: (target: SessionNavigationTarget) => void;
}) {
  return (
    <>
      <MessageRowView
        sessionId={COORDINATOR}
        message={{
          id: 'assigned',
          role: 'system',
          timestamp: new Date(NOW).toISOString(),
          items: [
            {
              type: 'operation_progress',
              operationId: 'assign',
              operationKind: 'session_create_many',
              items: assigned.map((id) => ({
                status: 'succeeded' as const,
                target: { sessionId: id as SessionId, userTurnId: `${id}-turn` },
              })),
            },
          ],
        }}
        onNavigateSession={onNavigateSession}
      />
      <MessageRowView
        sessionId={COORDINATOR}
        message={{
          id: 'attached',
          role: 'system',
          timestamp: new Date(NOW).toISOString(),
          items: [
            {
              type: 'operation_completion_batch',
              batchId: 'attached-batch',
              memberCount: 3,
              members: [],
            },
          ],
        }}
        onNavigateSession={onNavigateSession}
      />
    </>
  );
}
export const AssignedThreads: Story = {
  render: () => (
    <SettingsStoryProviders>
      <Provider store={assignedStore}>
        <AssignedThreadCards onNavigateSession={() => {}} />
      </Provider>
    </SettingsStoryProviders>
  ),
};
const completedStore = createStore();
completedStore.set(userAtom, assignedStore.get(userAtom));
completedStore.set(sessionMetaCacheAtom, {
  ...assignedStore.get(sessionMetaCacheAtom),
  [getSessionRoomId('thread-entry-review' as SessionId)]: {
    ...members[1]!,
    awaitingUserSince: undefined,
  },
});
completedStore.set(lodyPresenceNowMsAtom, NOW);
completedStore.set(lodyPresenceSyncStateAtom, 'synced');
completedStore.set(lodyPresenceStatesAtom, assignedStore.get(lodyPresenceStatesAtom));
export const CompletedThreadCard: Story = {
  render: () => (
    <SettingsStoryProviders>
      <Provider store={completedStore}>
        <BoardThreadStatusCard sessionId={THREAD} onNavigateSession={() => {}} />
      </Provider>
    </SettingsStoryProviders>
  ),
};
const navigationStoryStyles = stylex.create({
  split: { display: 'grid', gridTemplateColumns: '1fr 1fr', height: '600px' },
  column: { minWidth: 0, overflow: 'auto' },
});
function AssignedThreadsNavigation() {
  const [openId, setOpenId] = useState<SessionId | null>(null);
  const open = useBoardSessionNavigation({
    board,
    narrow: false,
    openPanel: setOpenId,
    showInCoordinatorPage: () => setOpenId(null),
    openPage: (target) => setOpenId(target.tabSessionId ?? target.sessionId),
  });
  const thread = members.find((item) => item.id === openId);
  return (
    <div {...stylex.props(navigationStoryStyles.split)}>
      <div {...stylex.props(navigationStoryStyles.column)}>
        <AssignedThreadCards onNavigateSession={open} />
      </div>
      <div {...stylex.props(navigationStoryStyles.column)}>
        {thread ? (
          <BoardThreadPaneView
            title={thread.title!}
            location="devnuc · Lody"
            onBack={() => setOpenId(null)}
            onOpenFull={() => {}}
          >
            <ChatSurface
              sessionId={thread.id}
              messages={threadMessages}
              placeholder="回复这个线程…"
            />
          </BoardThreadPaneView>
        ) : (
          <BoardThreadListView
            threads={threads}
            now={new Date(NOW)}
            onOpen={(id) => open({ sessionId: id as SessionId })}
          />
        )}
      </div>
    </div>
  );
}
/** Cards and rows use the product navigation hook; only session data is synthetic. */
export const AssignedThreadsSidePanel: Story = {
  render: () => (
    <SettingsStoryProviders>
      <Provider store={assignedStore}>
        <AssignedThreadsNavigation />
      </Provider>
    </SettingsStoryProviders>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = canvasElement.querySelector<HTMLButtonElement>('[data-board-thread-card] button')!;
    const backLabel = i18next.t('boards.home.backToThreads', 'Back to threads');
    await userEvent.click(card);
    const back = await canvas.findByRole('button', { name: backLabel });
    await expect(back.parentElement).toHaveTextContent(members[0]!.title!);
    await userEvent.click(back);
    await expect(canvas.queryByRole('button', { name: backLabel })).not.toBeInTheDocument();
    card.focus();
    await userEvent.keyboard('{Enter}');
    const keyboardBack = await canvas.findByRole('button', { name: backLabel });
    await expect(keyboardBack.parentElement).toHaveTextContent(members[0]!.title!);
    await userEvent.click(keyboardBack);
  },
};

/** Real tab bar and Board return control, with fixture-only navigation. */
export const ThreadFullPage: Story = {
  render: function FullThreadStory({ initial }) {
    const [back, setBack] = useState<PanelState | null>(null);
    const thread = members.find(
      (session) => session.id === (initial.kind === 'thread' ? (initial.id ?? THREAD) : THREAD)
    )!;
    const navigation = resolveBoardThreadPageNavigation({
      enabled: true,
      boards: [board],
      pageSession: thread,
      selectedSession: thread,
    });
    return back ? (
      <CoordinatorPage initial={back} />
    ) : (
      <SettingsStoryProviders>
        <BoardStoryProvider>
          <DesktopSessionDetailLayout
            defaultSizes={{ main: 50, sidebar: 50 }}
            topBar={
              <SessionTabBar
                variant="session"
                parentSession={thread}
                childSessions={[]}
                draftTabs={[]}
                archivedChildSessions={[]}
                activeTabSessionId={thread.id}
                onTabSelect={noop}
                onNewTab={noop}
                leftSlot={
                  <>
                    {navigation ? (
                      <BoardThreadBackButton
                        onBack={() => setBack({ kind: 'tabs', tab: 'threads' })}
                      />
                    ) : null}
                    {navigation?.parent ? (
                      <BoardThreadParentBreadcrumb
                        session={thread}
                        onOpenParent={(id) => setBack({ kind: 'thread', id })}
                      />
                    ) : null}
                  </>
                }
              />
            }
            chatSurfaces={
              <ChatSurface
                sessionId={thread.id}
                messages={threadMessages}
                placeholder="回复这个线程…"
              />
            }
            terminalDock={null}
            secondaryPanel={null}
            sidebarOpen={false}
            onSidebarCollapse={noop}
            deleteConfirmDialog={null}
          />
        </BoardStoryProvider>
      </SettingsStoryProviders>
    );
  },
};
export const ThreadControls: Story = { args: { initial: { kind: 'thread', running: true } } };
export const ThreadRowActions: Story = {};

/** Sidebar rows have no Board glyph or per-row membership subscription. */
export const ThreadSidebar: Story = {
  render: () => (
    <SettingsStoryProviders>
      <BoardStoryProvider enabled={false}>
        <SidebarUpdatedSessionList
          now={new Date(NOW)}
          onSelectItem={noop}
          onArchiveItem={noop}
          items={members
            .filter((session) => !isBoardSession(session, false))
            .map((session) => ({
              id: session.id,
              kind: 'chat',
              title: session.title ?? '',
              sectionLabel: '',
              latestMessageAt: session.lastMessageAt ?? NOW,
            }))}
        />
      </BoardStoryProvider>
    </SettingsStoryProviders>
  ),
};

/** Selection derives from the opened thread's metadata, exactly as the sidebar does. */
export const ViewingThread: Story = {
  render: function ViewingThreadStory() {
    const [current, setCurrent] = useState(THREAD);
    const session = members.find((entry) => entry.id === current);
    const selectedId = resolveSidebarBoardSelection({
      boards: [board],
      routeSessionId: current,
      routeBoardId: session?.boardId,
    });
    return (
      <SettingsStoryProviders>
        <BoardStoryProvider>
          <BoardSidebarSection
            boards={[
              { id: BOARD, name: board.name, coordinatorSessionId: COORDINATOR, activity: IDLE },
            ]}
            selectedId={selectedId}
            collapsed={false}
            onToggleCollapsed={noop}
            onOpen={() => setCurrent(COORDINATOR)}
            onCreate={noop}
            actions={boardRowActions}
          />
          <SessionTabBar
            variant="session"
            parentSession={session ?? coordinatorSession}
            childSessions={[]}
            draftTabs={[]}
            archivedChildSessions={[]}
            activeTabSessionId={current}
            onTabSelect={noop}
            onNewTab={noop}
          />
        </BoardStoryProvider>
      </SettingsStoryProviders>
    );
  },
};

export const ChildThreadOpen: Story = {
  args: { initial: { kind: 'thread', id: 'thread-entry-review' as SessionId } },
};
export const ChildThreadRows: Story = {};
export const ChildThreadFullPage: Story = {
  render: ThreadFullPage.render,
  args: { initial: { kind: 'thread', id: 'thread-entry-review' as SessionId } },
};

/** Constrain the preview viewport, not the product components, to the reported 310px panel. */
function NarrowBoardViewport({ children }: { children: ReactNode }) {
  useEffect(() => {
    const frame = window.frameElement as HTMLElement | null;
    if (!frame) return undefined;
    const previous = frame.style.cssText;
    frame.style.setProperty('width', '900px', 'important');
    frame.style.setProperty('min-width', '900px', 'important');
    frame.style.setProperty('max-width', '900px', 'important');
    return () => {
      frame.style.cssText = previous;
    };
  }, []);
  return children;
}

/** Open directly at 900px, or use the manager's fixed 900px preview. */
export const ChildThreadRowsNarrow: Story = {
  decorators: [
    (Story) => (
      <NarrowBoardViewport>
        <Story />
      </NarrowBoardViewport>
    ),
  ],
};
