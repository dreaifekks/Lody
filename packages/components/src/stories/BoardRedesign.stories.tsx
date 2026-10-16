/**
 * Board redesign prototype (synthetic data, no runtime). A Board opens like a
 * chat: the centre is the coordinator conversation, and threads, files, one
 * thread or the settings take turns in the panel on the right.
 * Design: specs/project-coordinator/design.md, "Board home".
 */
import type { Meta, StoryObj } from '@storybook/react';
import { useState, type ReactNode } from 'react';
import { ArrowUp, Bot, ChevronDown, FolderOpen, Monitor } from 'lucide-react';
import { Button } from '@lody/ui/button';
import type {
  BoardId,
  MachineId,
  SessionHistoryParsed,
  SessionId,
  BoardReportEvent,
} from '@lody/shared';
import { ChatComposer } from '@/components/chat/chat-composer';
import {
  MessageRowView,
  SessionChatStreamView,
  type ChatStreamItem,
} from '@/components/ai-gui/view';
import { LoroSidebar } from '@/components/loro-sidebar';
import type { SessionListRow } from '@/components/session-list';
import {
  BoardHomeView,
  BoardPanelView,
  BoardSettingsPaneView,
  BoardThreadPaneView,
  type BoardPanelTab,
} from '@/components/boards/board-home-view';
import { BoardThreadListView, type BoardThreadItem } from '@/components/boards/board-thread-list';
import {
  BoardFileEditorView,
  BoardFilesView,
  type BoardFileItem,
} from '@/components/boards/board-files-view';
import {
  BoardSettingsPanelView,
  type BoardProjectOption,
  type BoardSettingsDraft,
} from '@/components/boards/board-settings-panel';
import {
  BoardSidebarSection,
  type BoardSidebarItem,
} from '@/components/boards/board-sidebar-section';
import { BoardCreateDialogView } from '@/components/boards/board-create-dialog-view';
import { BoardNotesEditor } from '@/components/boards/board-notes-panel';
import { SettingsStoryProviders } from './settings-story-shell';

const COORDINATOR = 'board-coordinator' as SessionId;
const THREAD = 'thread-sidebar' as SessionId;
const BOARD = 'bd_story' as BoardId;
const NOW = Date.now();

const boards: BoardSidebarItem[] = [
  { id: BOARD, name: 'Lody 协调者模式', activity: 'waiting' },
  { id: 'bd_release', name: '0.106 同步与发布', activity: 'working' },
  { id: 'bd_hebi', name: 'hebi8XC 会话网络', activity: null },
];

const threads: BoardThreadItem[] = [
  {
    id: THREAD,
    title: '侧边栏里的看板入口',
    status: 'waiting_user',
    summary: '两种新建入口只留一种：侧边栏「+」，还是落地页再加一个「看板」？',
    detail: 'Claude Opus · devnuc · Lody/worktree',
    updatedLabel: '3 分钟',
  },
  {
    id: 'thread-ios',
    title: 'iOS 推送分组回归',
    status: 'failed',
    summary: '构建缺少 Xcode 26 的签名配置',
    detail: 'Codex Sol · MacBook Air · Lody/worktree',
    updatedLabel: '40 分钟',
  },
  {
    id: 'thread-rounds',
    title: 'PR4 轮数与交接',
    status: 'running',
    summary: '正在改 lody_session_chat 的轮数检查',
    detail: 'Codex Sol · devnuc · Lody/worktree',
    updatedLabel: '刚刚',
  },
  {
    id: 'thread-review',
    title: '评审：PR4 轮数检查',
    status: 'running',
    detail: 'Gemini · devnuc · 评审',
    updatedLabel: '刚刚',
    depth: 1,
  },
  {
    id: 'thread-memory',
    title: '调研 Claude Projects 的记忆',
    status: 'idle',
    summary: '项目记忆是自动摘要，每个新对话开头读一次',
    detail: 'Claude Opus · n100 · 对话',
    updatedLabel: '1 小时',
  },
  {
    id: 'thread-files',
    title: '共享文件的同步方式',
    status: 'waiting_coordinator',
    summary: '建议先只做文本文件，二进制以后用附件通道',
    detail: 'DeepSeek · devnuc · 对话',
    updatedLabel: '2 小时',
  },
  {
    id: 'thread-old-1',
    title: '早期 UI 草图',
    status: 'idle',
    detail: 'Gemini · MacBook Air · 对话',
    updatedLabel: '昨天',
    archived: true,
  },
  {
    id: 'thread-old-2',
    title: 'Overview 只读页',
    status: 'idle',
    detail: 'Codex Sol · devnuc · Lody/worktree',
    updatedLabel: '昨天',
    archived: true,
  },
];

const files: BoardFileItem[] = [
  { id: 'notes', name: '笔记.md', detail: '协调者 · 2 小时前' },
  { id: 'decisions', name: '决定记录.md', detail: '你 · 昨天' },
  { id: 'release', name: '发布清单.md', detail: 'PR4 轮数与交接 · 10 分钟前' },
];

const projects: BoardProjectOption[] = [
  { key: 'devnuc:lody', name: 'Lody', source: 'devnuc' },
  { key: 'mba:lody', name: 'Lody', source: 'MacBook Air' },
  { key: 'devnuc:hebi8xc', name: 'hebi8xc', source: 'devnuc' },
  { key: 'n100:mizuki', name: 'Mizuki', source: 'n100' },
  { key: 'github:dreaifekks/Lody', name: 'dreaifekks/Lody', source: 'GitHub' },
];

const initialSettings: BoardSettingsDraft = {
  name: 'Lody 协调者模式',
  purpose:
    '把 Claude Projects 的协调者模式搬进 Lody：协调者拆任务、开线程，人随时进任一线程插话。先做完 PR4 轮数与交接，再做看板主界面。',
  projectKeys: null,
  memoryEnabled: true,
  memoryText:
    '- 汇报结论先行、用中文，代码和提交用英文。\n- 容器叫「看板 / Board」，不叫 Project。\n- 协调者用 Claude Opus；Codex 派完不停，不当协调者。\n- 只在用户说「发布」时打 tag。',
  memorySpaceEnabled: false,
  memorySpaceLabel: 'Nowledge Mem · 空间「Lody 协调者模式」',
  maxRoundsPerThread: 4,
  reportHumanTurns: false,
  executorConstraints: '改代码用 worktree；提交前跑受影响包的 typecheck 和 lint；不要 push。',
  digestEnabled: true,
  digestTime: '04:00',
};

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

const coordinatorMessages: SessionHistoryParsed[] = [
  {
    id: 'c-user-1',
    role: 'user',
    timestamp: '2026-10-16T01:00:00.000Z',
    read: true,
    items: [{ type: 'text', text: initialSettings.purpose }],
  },
  {
    id: 'c-assistant-1',
    role: 'assistant',
    timestamp: '2026-10-16T01:00:05.000Z',
    read: true,
    finished: true,
    modelInfo: { modelId: 'claude-opus-5-5', name: 'Opus 5.5' },
    items: [
      {
        type: 'tool_call',
        toolCallId: 'c-create',
        kind: 'other',
        title: 'lody_session_create_many · 3 个线程',
        status: 'completed',
      },
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
    modelInfo: { modelId: 'claude-opus-5-5', name: 'Opus 5.5' },
    items: [
      {
        type: 'text',
        text: '两条回报：\n\n- **侧边栏里的看板入口** 在等你选新建入口。我倾向只留侧边栏的「+」，落地页保持「本地 / GitHub / 对话」不变。你可以直接点进那个线程回答。\n- **iOS 推送分组回归** 构建失败，是 Mac 上缺签名配置，不是代码问题。我先不重试，等你有空在 Mac 上处理证书。',
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
      {
        type: 'text',
        text: '给看板在侧边栏设计一个入口，和对话同一级。出两种方案，让用户选。',
      },
    ],
  },
  {
    id: 't-assistant-1',
    role: 'assistant',
    timestamp: '2026-10-16T01:20:00.000Z',
    read: true,
    finished: true,
    modelInfo: { modelId: 'claude-opus-5-5', name: 'Opus 5.5' },
    items: [
      {
        type: 'tool_call',
        toolCallId: 't-read',
        kind: 'read',
        title: 'Read loro-sidebar.tsx',
        status: 'completed',
      },
      {
        type: 'text',
        text: '看板在侧边栏顶部单独一组，和机器、对话分组同级。新建入口有两种做法：\n\n**A. 只在「看板」组标题上放「+」**：和每个项目组的「+」一样，落地页不动。\n\n**B. 落地页的「本地 / GitHub / 对话」再加「看板」**：新建看板和开对话在同一个输入框。\n\n我建议 A。你选哪个？',
      },
    ],
  },
];

function toItems(sessionId: SessionId, messages: SessionHistoryParsed[]): ChatStreamItem[] {
  return messages.map((message, turnIndex) => ({ type: 'message', sessionId, message, turnIndex }));
}

function Conversation({
  sessionId,
  messages,
}: {
  sessionId: SessionId;
  messages: SessionHistoryParsed[];
}) {
  return (
    <SessionChatStreamView
      sessionId={sessionId}
      items={toItems(sessionId, messages)}
      renderMessageRow={({ message, sessionId: id }) => (
        <MessageRowView message={message} sessionId={id} onNavigateSession={() => {}} />
      )}
    />
  );
}

function Composer({ placeholder }: { placeholder: string }) {
  const [prompt, setPrompt] = useState('');
  return (
    <ChatComposer
      tone="dark"
      variant="session"
      promptValue={prompt}
      onPromptChange={setPrompt}
      promptPlaceholder={placeholder}
      promptRows={1}
      selector={
        <Button variant="ghost" size="small">
          <Bot size={14} aria-hidden />
          Opus 5.5
          <ChevronDown size={14} aria-hidden />
        </Button>
      }
      primaryAction={
        <Button type="button" variant="primary" aria-label="Send" shape="pill" icon>
          <ArrowUp size={16} />
        </Button>
      }
    />
  );
}

function AgentPill() {
  return (
    <Button variant="secondary" size="small">
      <Monitor size={14} aria-hidden />
      devnuc · Claude · Opus 5.5
      <ChevronDown size={14} aria-hidden />
    </Button>
  );
}

type PanelState =
  | { kind: 'closed' }
  | { kind: 'tabs'; tab: BoardPanelTab; fileId?: string }
  | { kind: 'thread'; id: string }
  | { kind: 'settings' };

function BoardHomePrototype({
  initialPanel,
  narrow = false,
  scoped = false,
}: {
  initialPanel: PanelState;
  narrow?: boolean;
  /** Narrowed to two projects: the header shows the scope, settings list the choice. */
  scoped?: boolean;
}) {
  const [panel, setPanel] = useState<PanelState>(initialPanel);
  const [settings, setSettings] = useState<BoardSettingsDraft>(
    scoped
      ? { ...initialSettings, projectKeys: ['devnuc:lody', 'github:dreaifekks/Lody'] }
      : initialSettings
  );
  const [notes, setNotes] = useState(
    '# 2026-10-16\n\n- PR4：轮数检查放在 lody_session_chat，followUp 不计轮。\n- 侧边栏入口待用户选择。'
  );
  const close = () => setPanel({ kind: 'closed' });
  const waiting = threads.filter(
    (thread) => !thread.archived && ['waiting_user', 'failed'].includes(thread.status)
  ).length;
  let panelNode: ReactNode = null;
  if (panel.kind === 'tabs') {
    const file = files.find((entry) => entry.id === panel.fileId);
    panelNode = (
      <BoardPanelView
        tab={panel.tab}
        onTabChange={(tab) => setPanel({ kind: 'tabs', tab })}
        onNewThread={() => {}}
        onClose={close}
      >
        {panel.tab === 'threads' ? (
          <BoardThreadListView
            threads={threads}
            onOpen={(id) => setPanel({ kind: 'thread', id })}
          />
        ) : file ? (
          <BoardFileEditorView
            name={file.name}
            onBack={() => setPanel({ kind: 'tabs', tab: 'files' })}
          >
            <BoardNotesEditor notes={notes} onSave={async (text) => setNotes(text)} />
          </BoardFileEditorView>
        ) : (
          <BoardFilesView
            files={files}
            onOpen={(fileId) => setPanel({ kind: 'tabs', tab: 'files', fileId })}
            onCreate={() => {}}
          />
        )}
      </BoardPanelView>
    );
  } else if (panel.kind === 'thread') {
    const thread = threads.find((entry) => entry.id === panel.id) ?? threads[0]!;
    panelNode = (
      <BoardThreadPaneView
        title={thread.title}
        onBack={() => setPanel({ kind: 'tabs', tab: 'threads' })}
        onOpenFull={() => {}}
        onClose={close}
        conversation={<Conversation sessionId={THREAD} messages={threadMessages} />}
        composer={<Composer placeholder="回复这个线程…" />}
      />
    );
  } else if (panel.kind === 'settings') {
    panelNode = (
      <BoardSettingsPaneView onClose={close}>
        <BoardSettingsPanelView
          value={settings}
          onChange={(patch) => setSettings({ ...settings, ...patch })}
          projects={projects}
          coordinator={<AgentPill />}
          onEditMemory={() => {}}
          onArchive={() => {}}
        />
      </BoardSettingsPaneView>
    );
  }
  return (
    <BoardHomeView
      name={settings.name}
      scopeLabel={
        settings.projectKeys === null ? undefined : `${settings.projectKeys.length} 个项目`
      }
      waitingCount={waiting}
      panelOpen={panel.kind !== 'closed'}
      narrow={narrow}
      onTogglePanel={() =>
        setPanel(panel.kind === 'closed' ? { kind: 'tabs', tab: 'threads' } : { kind: 'closed' })
      }
      onOpenSettings={() => setPanel({ kind: 'settings' })}
      conversation={<Conversation sessionId={COORDINATOR} messages={coordinatorMessages} />}
      composer={<Composer placeholder="告诉协调者…" />}
      panel={panelNode}
    />
  );
}

const chatRows: SessionListRow[] = [
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

function DesktopFrame({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <SettingsStoryProviders>
      <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
        <LoroSidebar
          workspaceName="dreaife"
          userEmail="dreaife@example.com"
          workspaces={[{ id: 'ws', name: 'dreaife' }]}
          currentWorkspaceId="ws"
          activeNav={null}
          labels={{ home: '新对话', schedules: '定时任务' }}
          topContent={
            <BoardSidebarSection
              boards={boards}
              selectedId={BOARD}
              collapsed={collapsed}
              onToggleCollapsed={() => setCollapsed(!collapsed)}
              onOpen={() => {}}
              onCreate={() => {}}
            />
          }
          sessionListProps={{ sessions: chatRows, repos: [], selectedSessionId: null }}
          onHomeClicked={() => {}}
          onArchiveClicked={() => {}}
          onSchedulesClicked={() => {}}
        />
        <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
      </div>
    </SettingsStoryProviders>
  );
}

function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <SettingsStoryProviders>
      <div className="h-dvh w-full overflow-hidden bg-background text-foreground">{children}</div>
    </SettingsStoryProviders>
  );
}

function CreateBoardPrototype() {
  const [goal, setGoal] = useState('');
  const [name, setName] = useState('');
  return (
    <SettingsStoryProviders>
      <BoardCreateDialogView
        goal={goal}
        name={name}
        onGoalChange={setGoal}
        onNameChange={setName}
        coordinator={<AgentPill />}
        projectScope={
          <Button variant="secondary" size="small">
            <FolderOpen size={14} aria-hidden />
            全部项目
            <ChevronDown size={14} aria-hidden />
          </Button>
        }
        onSubmit={() => {}}
        onClose={() => {}}
      />
    </SettingsStoryProviders>
  );
}

const meta = {
  title: 'Workspace/Boards/Redesign',
  component: BoardHomePrototype,
  parameters: { layout: 'fullscreen' },
  args: { initialPanel: { kind: 'tabs', tab: 'threads' } },
} satisfies Meta<typeof BoardHomePrototype>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Entering a Board: the coordinator conversation, threads beside it. */
export const Home: Story = {
  render: (args) => (
    <DesktopFrame>
      <BoardHomePrototype {...args} />
    </DesktopFrame>
  ),
};

/** A thread open in the panel, steered without leaving the coordinator. */
export const ThreadOpen: Story = {
  args: { initialPanel: { kind: 'thread', id: THREAD } },
  render: Home.render,
};

/** Shared files: the notes plus any other text the Board keeps. */
export const Files: Story = {
  args: { initialPanel: { kind: 'tabs', tab: 'files' } },
  render: Home.render,
};

/** Everything set once and rarely revisited, behind the gear. */
export const Settings: Story = {
  args: { initialPanel: { kind: 'settings' } },
  render: Home.render,
};

/** Narrowed to chosen projects; the header names the scope, nothing else changes. */
export const SettingsScopedProjects: Story = {
  args: { initialPanel: { kind: 'settings' }, scoped: true },
  render: Home.render,
};

/** Panel closed: the waiting count moves onto the toggle. */
export const PanelClosed: Story = {
  args: { initialPanel: { kind: 'closed' } },
  render: Home.render,
};

/** Goal first, coordinator second; everything else has a default. */
export const CreateBoard: Story = {
  render: () => <CreateBoardPrototype />,
};

/** 390 px: the coordinator conversation fills the screen. */
export const Narrow: Story = {
  args: { initialPanel: { kind: 'closed' }, narrow: true },
  render: (args) => (
    <PhoneFrame>
      <BoardHomePrototype {...args} />
    </PhoneFrame>
  ),
};

/** 390 px: the panel covers the conversation. */
export const NarrowThreads: Story = {
  args: { initialPanel: { kind: 'tabs', tab: 'threads' }, narrow: true },
  render: Narrow.render,
};
