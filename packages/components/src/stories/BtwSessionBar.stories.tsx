import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { SessionId } from '@lody/shared';
import { Provider, useAtom, useSetAtom } from 'jotai';
import { ArrowUp, Files, MessagesSquare, PanelRight } from 'lucide-react';
import { fn } from 'storybook/test';
import { Button } from '@lody/ui/button';
import { Tooltip } from '@lody/ui/tooltip';
import { ChatComposer } from '@/components/chat/chat-composer';
import { getSessionChatInputAreaShellClassName } from '@/components/chat/composer-surface';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { SessionInfoBar } from '@/components/sessions/session-info-bar';
import type { SessionMachineInfo } from '@/components/sessions/session-machine-info';
import {
  BTW_SURFACE_BG_CLASS,
  BtwComposerFooter,
  BtwInfoBarClearButton,
  BtwInfoBarToggle,
  BtwPendingSelectionChip,
  BtwSidePanel,
  BtwStreamView,
  btwDraftAtomFamily,
  resolveBtwPresentationMode,
  useBtwContainerWidth,
  type BtwSelectionAttachment,
  type BtwTurn,
  type MainConversationStatus,
} from '@/components/sessions/btw';
import { cn } from '@/lib/utils';
import { useResolvedTheme, useTheme } from '@/theme-provider';
import { SettingsStoryProviders } from './settings-story-shell';

const DEMO_MACHINE: SessionMachineInfo = {
  machineId: 'machine-story-dev' as SessionMachineInfo['machineId'],
  name: 'devNuc',
  isOwn: true,
  isCurrent: true,
  onlineStatus: 'online',
};

const DEMO_TURNS: readonly BtwTurn[] = [
  {
    id: 'turn-u-1',
    role: 'user',
    text: '80–120ms 合帧会不会一卡一卡的？',
    selection: {
      path: 'files/btw-drawer/design.md',
      text: 'Loro Streams RPC 原生已有基于 SSE 的实时 onProgress 帧推送，按 80–120ms 节流合帧即可兼顾打字感与低写入。',
      location: 'Lines 38–40',
    },
  },
  {
    id: 'turn-a-1',
    role: 'assistant',
    text: '不会明显卡顿。80–100ms 约每秒 10–12 次刷新，贴合肉眼扫读节奏，同时大幅减少 SQLite 写入。\n\n首帧立即冲刷不等待节流窗口即可保证首字延迟。',
  },
];

const DEMO_SELECTION: BtwSelectionAttachment = {
  path: 'files/btw-drawer/design.md',
  text: 'Loro Streams RPC 原生已有基于 SSE 的实时 onProgress 帧推送',
  location: 'Line 39',
};

function RelationsStub({ count = 9 }: { readonly count?: number }) {
  return (
    <button
      type="button"
      className="flex h-6 shrink-0 select-none items-center gap-1 rounded-md px-1 text-xs text-muted-foreground transition-colors hover:bg-muted-foreground/10"
      aria-label={`Related sessions (${count})`}
    >
      <MessagesSquare className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="tabular-nums">{count}</span>
    </button>
  );
}

function SharedComposerPreview({
  isBtw,
  modelLabel,
  articleFileName,
  pendingSelection,
  onClearSelection,
}: {
  readonly isBtw: boolean;
  readonly modelLabel: string;
  readonly articleFileName?: string | null;
  readonly pendingSelection?: BtwSelectionAttachment | null;
  readonly onClearSelection?: () => void;
}) {
  return (
    <div className={cn('pb-3', isBtw ? BTW_SURFACE_BG_CLASS : 'bg-background')}>
      <ConversationColumn>
        <div
          className={cn(
            'flex flex-col gap-2 rounded-2xl border bg-[hsl(var(--composer))] px-3 py-2.5 shadow-xs dark:bg-input/90',
            isBtw
              ? 'border-primary/40 dark:border-primary/40'
              : 'border-foreground/[0.10] dark:border-input-border/70'
          )}
        >
          {isBtw && pendingSelection ? (
            <BtwPendingSelectionChip selection={pendingSelection} onRemove={onClearSelection} />
          ) : null}
          <div className="min-h-[38px] text-sm text-foreground/70 dark:text-muted-foreground">
            {isBtw ? '顺便问一句…' : '输入消息，或 /btw …'}
          </div>
          <div className="flex items-center justify-between gap-2">
            {isBtw ? (
              <BtwComposerFooter modelLabel={modelLabel} articleFileName={articleFileName} />
            ) : (
              <span className="inline-flex items-center rounded-md bg-foreground/[0.06] px-2 py-0.5 text-[11px] text-foreground/75 dark:bg-white/[0.07] dark:text-muted-foreground">
                Neon · High
              </span>
            )}
            <span
              className={cn(
                'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                isBtw ? 'bg-primary text-primary-foreground' : 'bg-foreground text-background'
              )}
            >
              ↑
            </span>
          </div>
        </div>
      </ConversationColumn>
    </div>
  );
}

type BtwBarScenarioProps = {
  readonly isOpen: boolean;
  readonly isBtwStreaming?: boolean;
  readonly hasBtwUnread?: boolean;
  readonly btwTurnCount?: number;
  readonly mainStatus: MainConversationStatus;
  readonly readOnlyTools?: boolean;
  readonly showStream?: boolean;
  readonly showPendingSelection?: boolean;
  readonly width?: number;
  readonly articleFileName?: string | null;
};

function BtwPanelScenario({
  isOpen,
  isBtwStreaming = false,
  hasBtwUnread = false,
  btwTurnCount = 1,
  mainStatus,
  readOnlyTools = false,
  showStream = true,
  showPendingSelection = false,
  width = 440,
  articleFileName = 'design.md',
}: BtwBarScenarioProps) {
  const [readOnly, setReadOnly] = useState(readOnlyTools);
  const [selection, setSelection] = useState<BtwSelectionAttachment | null>(
    showPendingSelection ? DEMO_SELECTION : null
  );
  const modelLabel = readOnly ? 'Hydrogen · Low · 只读' : 'Hydrogen · Low';

  return (
    <Tooltip.Provider>
      <div
        className="w-full max-w-[440px] overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-sm"
        style={{ width: `min(${width}px, calc(100vw - 32px))`, maxWidth: `${width}px` }}
      >
        {showStream ? (
          <div className="relative h-[320px] w-full overflow-hidden">
            {isOpen ? (
              <BtwStreamView
                turns={DEMO_TURNS}
                streamingText={
                  isBtwStreaming ? '正在对照 `machine-rpc-server.ts` 核对合帧计时器…' : ''
                }
                isStreaming={isBtwStreaming}
                readOnlyTools={readOnly}
                error={null}
                onToggleReadOnlyTools={() => setReadOnly((v) => !v)}
              />
            ) : (
              <div className="flex h-full flex-col gap-3 p-4 text-[13px]">
                <div className="self-end rounded-xl rounded-br-sm bg-foreground/[0.06] px-3 py-2 dark:bg-white/[0.07]">
                  帮我核查一下 lan-rpc-channel 和 Streams RPC 的流式推送差异。
                </div>
                <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  Running read_file · 3 tools · 14s
                </div>
              </div>
            )}
          </div>
        ) : null}

        <SessionInfoBar
          status={null}
          machine={DEMO_MACHINE}
          projectName="example/lody"
          branch="design/btw-drawer"
          relations={<RelationsStub count={9} />}
          surfaceTone={isOpen ? 'btw' : 'default'}
          btwToggle={
            <BtwInfoBarToggle
              isOpen={isOpen}
              isBtwStreaming={isBtwStreaming}
              hasBtwUnread={hasBtwUnread}
              btwTurnCount={btwTurnCount}
              mainStatus={mainStatus}
              onToggle={fn()}
            />
          }
          btwClearAction={
            isOpen && btwTurnCount > 0 ? <BtwInfoBarClearButton onClear={fn()} /> : undefined
          }
        />

        <SharedComposerPreview
          isBtw={isOpen}
          modelLabel={modelLabel}
          articleFileName={articleFileName}
          pendingSelection={selection}
          onClearSelection={() => setSelection(null)}
        />
      </div>
    </Tooltip.Provider>
  );
}

const meta = {
  title: 'Sessions/BtwSessionBar',
  component: BtwPanelScenario,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof BtwPanelScenario>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Main conversation view: `/btw` idle, streaming in background, and unread dot states. */
export const MainViewInfoBarStates: Story = {
  args: {
    isOpen: false,
    mainStatus: { kind: 'idle', tooltip: '返回主对话' },
  },
  render: () => (
    <Tooltip.Provider>
      <div className="flex w-[min(560px,calc(100vw-32px))] max-w-full flex-col gap-4">
        {(
          [
            { label: '/btw 空闲', isBtwStreaming: false, hasBtwUnread: false, btwTurnCount: 0 },
            {
              label: '/btw 后台回复中',
              isBtwStreaming: true,
              hasBtwUnread: false,
              btwTurnCount: 1,
            },
            {
              label: '/btw 有未读回复',
              isBtwStreaming: false,
              hasBtwUnread: true,
              btwTurnCount: 1,
            },
            { label: '/btw 已有历史', isBtwStreaming: false, hasBtwUnread: false, btwTurnCount: 2 },
          ] as const
        ).map((item) => (
          <div key={item.label} className="flex flex-col gap-1">
            <span className="px-1 text-[11px] text-muted-foreground">{item.label}</span>
            <SessionInfoBar
              status={null}
              machine={DEMO_MACHINE}
              projectName="example/lody"
              branch="design/btw-drawer"
              relations={<RelationsStub count={9} />}
              btwToggle={
                <BtwInfoBarToggle
                  isOpen={false}
                  isBtwStreaming={item.isBtwStreaming}
                  hasBtwUnread={item.hasBtwUnread}
                  btwTurnCount={item.btwTurnCount}
                  mainStatus={{ kind: 'idle', tooltip: '返回主对话' }}
                  onToggle={fn()}
                />
              }
            />
          </div>
        ))}
      </div>
    </Tooltip.Provider>
  ),
};

/** `/btw` expanded: all 5 main-conversation icon/color states (running, waiting Hand, done, error, idle). */
export const ExpandedMainStatusMatrix: Story = {
  args: {
    isOpen: true,
    mainStatus: { kind: 'working', tooltip: '返回主对话 · Running read_file (3)' },
  },
  render: () => (
    <Tooltip.Provider>
      <div className="flex w-[min(560px,calc(100vw-32px))] max-w-full flex-col gap-4">
        {(
          [
            {
              kind: 'working',
              tooltip: '返回主对话 · Running read_file (3)',
              caption: '主对话运行中',
            },
            { kind: 'waiting', tooltip: '返回主对话 · 等待审批', caption: '主对话等待审批 (Hand)' },
            { kind: 'done', tooltip: '返回主对话 · 已完成', caption: '主对话已完成' },
            { kind: 'error', tooltip: '返回主对话 · 连接中断', caption: '主对话出错 / 中断' },
            { kind: 'idle', tooltip: '返回主对话', caption: '主对话空闲' },
          ] as const
        ).map((status) => (
          <div key={status.kind} className="flex flex-col gap-1">
            <span className="px-1 text-[11px] text-muted-foreground">{status.caption}</span>
            <SessionInfoBar
              status={null}
              machine={DEMO_MACHINE}
              projectName="example/lody"
              branch="design/btw-drawer"
              relations={<RelationsStub count={9} />}
              surfaceTone="btw"
              btwToggle={
                <BtwInfoBarToggle
                  isOpen
                  isBtwStreaming={false}
                  hasBtwUnread={false}
                  btwTurnCount={1}
                  mainStatus={status}
                  onToggle={fn()}
                />
              }
              btwClearAction={<BtwInfoBarClearButton onClear={fn()} />}
            />
          </div>
        ))}
      </div>
    </Tooltip.Provider>
  ),
};

/** 440px narrow Article right column — light theme, main running + pending selection chip. */
export const ArticleNarrowLight: Story = {
  globals: { theme: 'light' },
  args: {
    isOpen: true,
    width: 440,
    showPendingSelection: true,
    mainStatus: { kind: 'working', tooltip: '返回主对话 · Running read_file (3)' },
  },
};

/** 440px narrow Article right column — dark theme, main waiting approval (`Hand`) + read-only enabled. */
export const ArticleNarrowDarkWaitingApproval: Story = {
  globals: { theme: 'dark' },
  args: {
    isOpen: true,
    width: 440,
    readOnlyTools: true,
    showPendingSelection: true,
    mainStatus: { kind: 'waiting', tooltip: '返回主对话 · 等待审批' },
  },
};

/** Interactive toggle between Main and `/btw` across all 5 main statuses at 440px width. */
function InteractiveBtwHarness() {
  const { previewTheme } = useTheme();
  const [isOpen, setIsOpen] = useState(true);
  const [statusKind, setStatusKind] = useState<MainConversationStatus['kind']>('working');
  const [dark, setDark] = useState(false);

  useEffect(() => {
    previewTheme(dark ? 'dark' : 'light');
  }, [dark, previewTheme]);

  const statusMap: Record<MainConversationStatus['kind'], MainConversationStatus> = {
    working: { kind: 'working', tooltip: '返回主对话 · Running read_file (3)' },
    waiting: { kind: 'waiting', tooltip: '返回主对话 · 等待审批' },
    done: { kind: 'done', tooltip: '返回主对话 · 已完成' },
    error: { kind: 'error', tooltip: '返回主对话 · 连接中断' },
    idle: { kind: 'idle', tooltip: '返回主对话' },
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1"
          onClick={() => setIsOpen((v) => !v)}
        >
          {isOpen ? '切回主对话' : '切入 /btw'}
        </button>
        {(['working', 'waiting', 'done', 'error', 'idle'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            className={cn(
              'rounded-md border px-2 py-1',
              statusKind === kind ? 'border-primary bg-primary/12 text-primary' : 'border-border'
            )}
            onClick={() => setStatusKind(kind)}
          >
            {kind}
          </button>
        ))}
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1"
          onClick={() => setDark((v) => !v)}
        >
          {dark ? '亮色' : '暗色'}
        </button>
      </div>
      <BtwPanelScenario
        isOpen={isOpen}
        mainStatus={statusMap[statusKind]}
        showPendingSelection
        width={440}
      />
    </div>
  );
}

export const InteractivePlayground: Story = {
  args: {
    isOpen: true,
    mainStatus: { kind: 'working', tooltip: '返回主对话 · Running read_file (3)' },
  },
  render: () => <InteractiveBtwHarness />,
};

const DESKTOP_STORY_SESSION_ID = 'session-story-btw-desktop' as SessionId;

function MainComposerReal({
  sessionId,
  isBtwOverlay,
  isBtwStreaming,
  isDark,
  modelLabel,
  articleFileName,
  pendingSelection,
  onClearSelection,
  onSendBtw,
  onCancelBtw,
}: {
  readonly sessionId: SessionId;
  readonly isBtwOverlay: boolean;
  readonly isBtwStreaming: boolean;
  readonly isDark: boolean;
  readonly modelLabel: string;
  readonly articleFileName?: string | null;
  readonly pendingSelection?: BtwSelectionAttachment | null;
  readonly onClearSelection?: () => void;
  readonly onSendBtw: (question: string) => void;
  readonly onCancelBtw: () => void;
}) {
  const [mainDraft, setMainDraft] = useState('');
  const [btwDraft, setBtwDraft] = useAtom(btwDraftAtomFamily(sessionId));
  const value = isBtwOverlay ? btwDraft : mainDraft;

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (isBtwOverlay) {
      setBtwDraft('');
      onSendBtw(trimmed);
    } else {
      setMainDraft('');
    }
  };

  return (
    <div
      data-btw-composer-active={isBtwOverlay ? 'true' : undefined}
      className={cn(
        getSessionChatInputAreaShellClassName(),
        isBtwOverlay &&
          '!bg-[color-mix(in_srgb,hsl(var(--primary))_3.5%,hsl(var(--background)))] dark:!bg-[color-mix(in_srgb,hsl(var(--primary))_5%,hsl(var(--background)))]'
      )}
    >
      <ConversationColumn>
        <ChatComposer
          tone={isDark ? 'dark' : 'light'}
          variant="session"
          currentSessionId={sessionId}
          draftKey={isBtwOverlay ? `${sessionId}:btw` : sessionId}
          promptValue={value}
          onPromptChange={isBtwOverlay ? setBtwDraft : setMainDraft}
          promptPlaceholder={isBtwOverlay ? '顺便问一句…' : '输入消息，或 /btw …'}
          promptRows={2}
          imageDropDisabled
          hideFocusHint
          boxClassName={isBtwOverlay ? 'border-primary/40 dark:border-primary/40' : undefined}
          boxHeader={
            isBtwOverlay && pendingSelection ? (
              <BtwPendingSelectionChip selection={pendingSelection} onRemove={onClearSelection} />
            ) : undefined
          }
          footerSelector={
            isBtwOverlay ? (
              <BtwComposerFooter modelLabel={modelLabel} articleFileName={articleFileName} />
            ) : (
              <span className="inline-flex items-center rounded-md bg-foreground/[0.06] px-2 py-0.5 text-[11px] text-foreground/75 dark:bg-white/[0.07] dark:text-muted-foreground">
                Neon · High
              </span>
            )
          }
          primaryAction={
            isBtwOverlay && isBtwStreaming ? (
              <Button
                type="button"
                onClick={onCancelBtw}
                variant="ghost"
                size="small"
                shape="pill"
                icon
                aria-label="停止 /btw"
                className="bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 hover:text-primary-foreground"
              >
                <span className="h-2.5 w-2.5 rounded-[2px] bg-current" aria-hidden="true" />
              </Button>
            ) : (
              <Button
                type="button"
                onClick={handleSend}
                disabled={value.trim().length === 0}
                variant="ghost"
                size="small"
                shape="pill"
                icon
                aria-label="发送"
                className={cn(
                  'shadow-xs',
                  isBtwOverlay
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground'
                    : 'bg-foreground text-background hover:bg-foreground/90 hover:text-background'
                )}
              >
                <ArrowUp className="h-4 w-4" aria-hidden="true" />
              </Button>
            )
          }
          autoResize
          maxRows={6}
          focusOnContainerClick
        />
      </ConversationColumn>
    </div>
  );
}

type DesktopAdaptiveScenarioProps = {
  readonly initialBtwOpen?: boolean;
  readonly initialRightSidebarOpen?: boolean;
  readonly initialReadOnlyTools?: boolean;
  readonly initialStreaming?: boolean;
  readonly showPendingSelection?: boolean;
  readonly frameWidth?: number | 'full';
  readonly frameHeight?: number;
  readonly showControls?: boolean;
};

function DesktopAdaptiveScenarioInner({
  initialBtwOpen = true,
  initialRightSidebarOpen = false,
  initialReadOnlyTools = false,
  initialStreaming = false,
  showPendingSelection = false,
  frameWidth = 'full',
  frameHeight = 680,
  showControls = false,
}: DesktopAdaptiveScenarioProps) {
  const resolvedTheme = useResolvedTheme();
  const { previewTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const [isBtwOpen, setIsBtwOpen] = useState(initialBtwOpen);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(initialRightSidebarOpen);
  const [readOnlyTools, setReadOnlyTools] = useState(initialReadOnlyTools);
  const [isStreaming, setIsStreaming] = useState(initialStreaming);
  const [narrowPreview, setNarrowPreview] = useState(false);
  const [turns, setTurns] = useState<readonly BtwTurn[]>(DEMO_TURNS);
  const [selection, setSelection] = useState<BtwSelectionAttachment | null>(
    showPendingSelection ? DEMO_SELECTION : null
  );
  const [layoutRoot, setLayoutRoot] = useState<HTMLDivElement | null>(null);

  const allowBtwSidePanel = !rightSidebarOpen;
  const containerWidth = useBtwContainerWidth(layoutRoot, allowBtwSidePanel);
  const presentationMode = resolveBtwPresentationMode({
    allowSidePanel: allowBtwSidePanel,
    isMobile: false,
    containerWidth,
  });
  const isBtwSidePanel = isBtwOpen && presentationMode === 'side-panel';
  const isBtwOverlay = isBtwOpen && presentationMode === 'overlay';
  const modelLabel = readOnlyTools ? 'Hydrogen · Low · 只读' : 'Hydrogen · Low';
  const canClear = isBtwOpen && (turns.length > 0 || isStreaming);
  const completedTurnCount = turns.filter((turn) => turn.role === 'user').length;

  useEffect(() => {
    if (!isBtwOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229
      ) {
        return;
      }
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"]:not([hidden]), [role="listbox"]:not([hidden])'
        )
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setIsBtwOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isBtwOpen]);

  const handleSendBtw = (question: string) => {
    setTurns((prev) => [
      ...prev,
      {
        id: `turn-u-${prev.length + 1}`,
        role: 'user',
        text: question,
        ...(selection ? { selection } : {}),
      },
      {
        id: `turn-a-${prev.length + 2}`,
        role: 'assistant',
        text: `已收到：「${question}」。当前模式为 **${presentationMode}**。`,
      },
    ]);
    setSelection(null);
  };

  const setBtwDraft = useSetAtom(btwDraftAtomFamily(DESKTOP_STORY_SESSION_ID));
  const handleClear = () => {
    setTurns([]);
    setSelection(null);
    setBtwDraft('');
    setIsStreaming(false);
    setIsBtwOpen(false);
  };

  const effectiveWidth =
    showControls && narrowPreview
      ? 780
      : frameWidth === 'full'
        ? '100%'
        : `min(${frameWidth}px, 100vw)`;

  return (
    <Tooltip.Provider>
      <div className="flex h-full min-h-screen w-full flex-col items-center bg-muted/20 p-4 text-foreground">
        {showControls ? (
          <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
            <button
              type="button"
              className="rounded-md border border-border bg-background px-2.5 py-1"
              onClick={() => setIsBtwOpen((v) => !v)}
            >
              {isBtwOpen ? '关闭 /btw' : '打开 /btw'}
            </button>
            <button
              type="button"
              className={cn(
                'rounded-md border px-2.5 py-1',
                rightSidebarOpen
                  ? 'border-primary bg-primary/12 text-primary'
                  : 'border-border bg-background'
              )}
              onClick={() => setRightSidebarOpen((v) => !v)}
            >
              {rightSidebarOpen ? '关闭右侧工作区栏' : '打开右侧工作区栏'}
            </button>
            <button
              type="button"
              className={cn(
                'rounded-md border px-2.5 py-1',
                narrowPreview
                  ? 'border-primary bg-primary/12 text-primary'
                  : 'border-border bg-background'
              )}
              onClick={() => setNarrowPreview((v) => !v)}
            >
              {narrowPreview ? '切回宽屏' : '模拟窄窗 (780px)'}
            </button>
            <button
              type="button"
              className="rounded-md border border-border bg-background px-2.5 py-1"
              onClick={() => previewTheme(isDark ? 'light' : 'dark')}
            >
              {isDark ? '亮色' : '暗色'}
            </button>
            <span className="px-1.5 font-mono text-[11px] text-muted-foreground">
              mode={presentationMode} ({containerWidth ?? '—'}px)
            </span>
          </div>
        ) : null}

        <div
          className="flex overflow-hidden rounded-xl border border-border bg-background shadow-sm"
          style={{ width: effectiveWidth, height: `${frameHeight}px`, maxWidth: '100%' }}
        >
          {/* Main desktop session column (top tab bar + conversation surface) */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3 text-xs">
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-foreground/[0.06] px-2.5 py-1 font-medium text-foreground dark:bg-white/[0.08]">
                  优化 /btw 侧栏与默认主对话
                </span>
                <span className="text-muted-foreground">Lody</span>
              </div>
              <button
                type="button"
                aria-label="Toggle right workspace panel"
                onClick={() => setRightSidebarOpen((v) => !v)}
                className={cn(
                  'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors',
                  rightSidebarOpen
                    ? 'bg-foreground/10 text-foreground'
                    : 'text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground'
                )}
              >
                <PanelRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div
              ref={setLayoutRoot}
              data-btw-layout-mode={presentationMode}
              className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
            >
              {/* Main conversation column */}
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="relative flex-1 min-h-0 overflow-hidden">
                  <div className="input-scrollbar h-full overflow-y-auto py-5">
                    <ConversationColumn className="flex flex-col gap-4 text-[13.5px] leading-relaxed">
                      <div className="self-end max-w-[82%] rounded-2xl rounded-br-sm bg-foreground/[0.06] px-3.5 py-2.5 dark:bg-white/[0.07]">
                        帮我核查一下 lan-rpc-channel 和 Streams RPC
                        的流式推送差异，顺便确认一下重连退避逻辑。
                      </div>
                      <div className="flex flex-col gap-2 text-foreground/90">
                        <p>
                          已完成排查：`lan-rpc-channel` 通过单向控制帧做请求-响应，而 Loro Streams
                          RPC 支持 SSE 增量帧推送，可以在 80–120ms
                          窗口内合帧以兼顾首字响应与写入开销。
                        </p>
                        <div className="rounded-lg border border-border/80 bg-muted/35 px-3 py-2 font-mono text-xs text-muted-foreground">
                          Read packages/components/src/components/sessions/btw/use-btw-controller.ts
                        </div>
                        <p>
                          主对话在宽屏下始终保留在左侧完整可见，你可以随时继续滚动阅读或直接向主对话发送新指令。
                        </p>
                      </div>
                    </ConversationColumn>
                  </div>

                  {isBtwOverlay ? (
                    <BtwStreamView
                      turns={turns}
                      streamingText={
                        isStreaming ? '正在对照 `machine-rpc-server.ts` 核对合帧计时器…' : ''
                      }
                      isStreaming={isStreaming}
                      readOnlyTools={readOnlyTools}
                      error={null}
                      onToggleReadOnlyTools={() => setReadOnlyTools((v) => !v)}
                    />
                  ) : null}
                </div>

                <SessionInfoBar
                  status={null}
                  machine={DEMO_MACHINE}
                  projectName="example/lody"
                  branch="feat/btw-default-main-and-side-panel"
                  relations={<RelationsStub count={4} />}
                  surfaceTone={isBtwOverlay ? 'btw' : 'default'}
                  btwToggle={
                    <BtwInfoBarToggle
                      isOpen={isBtwOpen}
                      isBtwStreaming={isStreaming}
                      hasBtwUnread={false}
                      btwTurnCount={completedTurnCount}
                      mainStatus={{
                        kind: 'working',
                        tooltip: '返回主对话 · Running read_file (3)',
                      }}
                      presentationMode={presentationMode}
                      onToggle={() => setIsBtwOpen((v) => !v)}
                    />
                  }
                  btwClearAction={
                    isBtwOverlay && canClear ? (
                      <BtwInfoBarClearButton onClear={handleClear} />
                    ) : undefined
                  }
                />

                <MainComposerReal
                  sessionId={DESKTOP_STORY_SESSION_ID}
                  isBtwOverlay={isBtwOverlay}
                  isBtwStreaming={isStreaming}
                  isDark={isDark}
                  modelLabel={modelLabel}
                  articleFileName="design.md"
                  pendingSelection={selection}
                  onClearSelection={() => setSelection(null)}
                  onSendBtw={handleSendBtw}
                  onCancelBtw={() => setIsStreaming(false)}
                />
              </div>

              {isBtwSidePanel ? (
                <BtwSidePanel
                  sessionId={DESKTOP_STORY_SESSION_ID}
                  containerWidth={containerWidth}
                  isDark={isDark}
                  isVisible
                  turns={turns}
                  streamingText={
                    isStreaming ? '正在对照 `machine-rpc-server.ts` 核对合帧计时器…' : ''
                  }
                  isStreaming={isStreaming}
                  readOnlyTools={readOnlyTools}
                  error={null}
                  modelLabel={modelLabel}
                  articleFileName="design.md"
                  pendingSelection={selection}
                  canClear={canClear}
                  onToggleReadOnlyTools={() => setReadOnlyTools((v) => !v)}
                  onClearPendingSelection={() => setSelection(null)}
                  onSend={handleSendBtw}
                  onCancel={() => setIsStreaming(false)}
                  onClear={handleClear}
                  onClose={() => setIsBtwOpen(false)}
                />
              ) : null}
            </div>
          </div>

          {rightSidebarOpen ? (
            <aside
              data-story-workspace-sidebar=""
              className="flex w-[340px] shrink-0 flex-col border-l border-border bg-background"
            >
              <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border px-3 text-xs font-medium">
                <Files className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                <span>Files</span>
              </div>
              <div className="flex flex-1 flex-col gap-1.5 p-3 font-mono text-xs text-muted-foreground">
                <div className="rounded-md bg-foreground/[0.05] px-2 py-1 text-foreground dark:bg-white/[0.06]">
                  btw-side-panel.tsx
                </div>
                <div className="px-2 py-1">btw-layout.ts</div>
                <div className="px-2 py-1">use-btw-controller.ts</div>
                <div className="px-2 py-1">session-chat-interface.tsx</div>
              </div>
            </aside>
          ) : null}
        </div>
      </div>
    </Tooltip.Provider>
  );
}

function DesktopAdaptiveScenario(props: DesktopAdaptiveScenarioProps) {
  return (
    <SettingsStoryProviders>
      <Provider>
        <DesktopAdaptiveScenarioInner {...props} />
      </Provider>
    </SettingsStoryProviders>
  );
}

/** Wide full-page desktop conversation (light theme): `/btw` opens as a right side panel beside the main chat. */
export const DesktopWideSidePanelLight: Story = {
  globals: { theme: 'light' },
  parameters: { layout: 'fullscreen' },
  args: {
    isOpen: true,
    mainStatus: { kind: 'idle', tooltip: '返回主对话' },
  },
  render: () => (
    <DesktopAdaptiveScenario
      initialBtwOpen
      initialRightSidebarOpen={false}
      showPendingSelection
      frameWidth={1240}
      frameHeight={700}
    />
  ),
};

/** Wide full-page desktop conversation (dark theme): `/btw` right side panel with read-only tools enabled and streaming reply. */
export const DesktopWideSidePanelDark: Story = {
  globals: { theme: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: {
    isOpen: true,
    mainStatus: { kind: 'idle', tooltip: '返回主对话' },
  },
  render: () => (
    <DesktopAdaptiveScenario
      initialBtwOpen
      initialRightSidebarOpen={false}
      initialReadOnlyTools
      initialStreaming
      showPendingSelection
      frameWidth={1240}
      frameHeight={700}
    />
  ),
};

/** Desktop conversation with an existing right workspace sidebar open: `/btw` cleanly degrades to overlay mode (no double right sidebars). */
export const DesktopWithRightSidebarOverlayFallback: Story = {
  globals: { theme: 'light' },
  parameters: { layout: 'fullscreen' },
  args: {
    isOpen: true,
    mainStatus: { kind: 'working', tooltip: '返回主对话 · Running read_file (3)' },
  },
  render: () => (
    <DesktopAdaptiveScenario
      initialBtwOpen
      initialRightSidebarOpen
      showPendingSelection
      frameWidth={1240}
      frameHeight={700}
    />
  ),
};

/** Narrow desktop window (< 900px, no right sidebar, dark theme): `/btw` degrades to overlay mode. */
export const DesktopNarrowOverlayFallbackDark: Story = {
  globals: { theme: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: {
    isOpen: true,
    mainStatus: { kind: 'working', tooltip: '返回主对话 · Running read_file (3)' },
  },
  render: () => (
    <DesktopAdaptiveScenario
      initialBtwOpen
      initialRightSidebarOpen={false}
      frameWidth={780}
      frameHeight={680}
    />
  ),
};

/** Interactive adaptive playground: toggle `/btw`, right sidebar, narrow width, and theme live while preserving typed `/btw` draft. */
export const AdaptiveLayoutPlayground: Story = {
  parameters: { layout: 'fullscreen' },
  args: {
    isOpen: true,
    mainStatus: { kind: 'working', tooltip: '返回主对话 · Running read_file (3)' },
  },
  render: () => (
    <DesktopAdaptiveScenario
      initialBtwOpen
      initialRightSidebarOpen={false}
      showPendingSelection
      frameWidth={1240}
      frameHeight={660}
      showControls
    />
  ),
};
