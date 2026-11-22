import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { MessagesSquare } from 'lucide-react';
import { fn } from 'storybook/test';
import { Tooltip } from '@lody/ui/tooltip';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { SessionInfoBar } from '@/components/sessions/session-info-bar';
import type { SessionMachineInfo } from '@/components/sessions/session-machine-info';
import {
  BTW_SURFACE_BG_CLASS,
  BtwComposerFooter,
  BtwInfoBarClearButton,
  BtwInfoBarToggle,
  BtwPendingSelectionChip,
  BtwStreamView,
  type BtwSelectionAttachment,
  type BtwTurn,
  type MainConversationStatus,
} from '@/components/sessions/btw';
import { cn } from '@/lib/utils';
import { useTheme } from '@/theme-provider';

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
