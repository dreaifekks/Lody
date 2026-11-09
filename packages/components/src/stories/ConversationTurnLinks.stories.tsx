/**
 * Fork: navigating a coordinator conversation.
 *
 * A coordinator is woken by its threads' results far more often than by the
 * user. Each automatic receipt batch starts a round of the outline, titled by
 * the threads it reports on, so a conversation with a handful of user messages
 * and dozens of results still gets a rail.
 *
 * Its answers link to single turns (`lody://session/<id>?turn=<turnId>`): a
 * click scrolls to that turn and flashes it, and the scroll-to-latest button
 * first goes back to where the link was clicked.
 *
 * Built on a real Loro document and the production window hook, so the rounds
 * the view has not hydrated are placeholders exactly as in the app.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import type { Meta, StoryObj } from '@storybook/react';
import { ArrowDown, Undo2 } from 'lucide-react';
import { Toast } from '@lody/ui';
import { Button } from '@lody/ui/button';
import { sessionDocSchema, type SessionId } from '@lody/shared';
import { buildSessionLink } from '@lody/shared/session-link';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { toastManager } from '@/lib/toast';
import { createConversationSession, type ConversationView } from '@/lib/conversation-view';
import { useConversationStreamItems } from '@/hooks/use-conversation-stream-items';
import {
  MessageRowView,
  SessionChatStreamView,
  type SessionChatStreamViewProps,
} from '@/components/ai-gui/view';

const meta = {
  title: 'Sessions/Coordinator navigation',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const coordinatorSessionId = '7c1d3a52-5f0e-4f8a-9d61-0b2a4c6e8f10' as SessionId;

const THREADS = [
  { sessionId: 'b3e0c7a4-1d2f-4e5a-8b9c-0d1e2f3a4b5c', title: '低刺激模式：未读不消' },
  { sessionId: 'c4f1d8b5-2e3a-4f6b-9cad-1e2f3a4b5c6d', title: 'Codex 审查 · PR #91' },
  { sessionId: 'd5a2e9c6-3f4b-4a7c-8dbe-2f3a4b5c6d7e', title: 'visionAgent 截图核对' },
  { sessionId: 'e6b3fad7-4a5c-4b8d-9ecf-3a4b5c6d7e8f', title: 'Upstream sync 0.110.1' },
] as const;

const at = (minute: number) =>
  new Date(Date.UTC(2026, 10, 10, 1, 0, 0) + minute * 60_000).toISOString();

const boardReport = (thread: (typeof THREADS)[number], round: number) => ({
  type: 'operation_completion',
  deliveryId: `delivery-${round}-${thread.sessionId}`,
  operationId: `board-report-${round}-${thread.sessionId}`,
  operationKind: 'board_report',
  completion: {
    type: 'result',
    value: {
      items: [],
      boardReport: {
        boardId: 'board-storybook',
        events: [
          {
            kind: round % 7 === 3 ? 'waiting_user' : 'finished',
            sessionId: thread.sessionId,
            turnId: `thread-turn-${round}`,
            at: Date.parse(at(round * 3)),
            title: thread.title,
            machineId: 'machine-storybook',
            origin: 'agent',
            output: {
              text: `第 ${round} 次回报：改完了两处，测试通过；有一处需要你判断要不要保留旧行为。`,
            },
          },
        ],
      },
    },
  },
});

const USER_MESSAGES = [
  '把看板上四个线程都推进一下，结果回来先帮我筛一遍',
  '审查意见里 P2 的那条能修就修，不用问我',
  '最后汇总一下哪些需要我拍板',
];

const turnLink = (turnId: string, sessionId: string = coordinatorSessionId) =>
  buildSessionLink({ sessionId, turnId });

/** The coordinator's last answer points back at the receipts it summarises. */
const SUMMARY_WITH_TURN_LINKS = [
  '需要你拍板的有三处：',
  '',
  `1. [回执 22 · 低刺激模式的取舍](${turnLink('assistant:inbox:completion:22')})：未读要不要保留角标。`,
  `2. [回执 3 · 截图核对](${turnLink('assistant:inbox:completion:3')})：暗色下按钮对比度不够。`,
  `3. [回执 30 · 已撤回的结论](${turnLink('assistant:inbox:completion:30')})：这一轮后来被撤回了。`,
  '',
  `另外 Codex 审查线程里 [第 1 轮的结论](${turnLink('assistant:user-1', THREADS[1].sessionId)}) 也值得再看一眼。`,
].join('\n');

/** Three user rounds and 24 receipt rounds, as a busy Board coordinator has. */
function buildCoordinatorHistory(summary?: string) {
  const history: Record<string, unknown>[] = [];
  let minute = 0;
  const user = (index: number, answer?: string) => {
    const id = `user-${index}`;
    history.push({
      id,
      role: 'user',
      timestamp: at(minute++),
      status: 'handled',
      read: true,
      finished: true,
      fileDiff: [],
      items: [{ type: 'text', text: USER_MESSAGES[index] }],
    });
    history.push({
      id: `assistant:${id}`,
      role: 'assistant',
      timestamp: at(minute++),
      userTurnId: id,
      finished: true,
      fileDiff: [],
      items: [
        {
          type: 'text',
          text: answer ?? `好的，已经派出去了。\n\n${'各线程的结果回来后我会逐条筛。'.repeat(3)}`,
        },
      ],
    });
  };
  const receipt = (round: number) => {
    const id = `inbox:completion:${round}`;
    const reporting = [THREADS[round % THREADS.length]!];
    if (round % 5 === 0) reporting.push(THREADS[(round + 1) % THREADS.length]!);
    history.push({
      id,
      role: 'system',
      timestamp: at(minute++),
      finished: true,
      fileDiff: [],
      items: [
        {
          type: 'operation_completion_batch',
          batchId: `batch-${round}`,
          memberCount: reporting.length,
          members: reporting.map((thread) => boardReport(thread, round)),
          deliveryStatus: 'settled',
        },
      ],
    });
    history.push({
      id: `assistant:${id}`,
      role: 'assistant',
      timestamp: at(minute++),
      userTurnId: id,
      finished: true,
      fileDiff: [],
      items: [
        {
          type: 'text',
          text: `回执 ${round}：${reporting.map((thread) => thread.title).join('、')} 有结果了。\n\n${'我看了改动和测试，结论可以接受；剩下一处行为取舍留给你。'.repeat(4)}${
            summary && round === 22
              ? `\n\n和 [回执 3 · 截图核对](${turnLink('assistant:inbox:completion:3')}) 是同一个问题。`
              : ''
          }`,
        },
      ],
    });
  };
  user(0);
  for (let round = 1; round <= 12; round += 1) receipt(round);
  user(1);
  for (let round = 13; round <= 24; round += 1) receipt(round);
  user(2, summary);
  return history;
}

const renderMessageRow: SessionChatStreamViewProps['renderMessageRow'] = ({
  message,
  sessionId,
}) => <MessageRowView message={message} sessionId={sessionId} />;

function CoordinatorFrame({
  summary,
  showScrollToLatest = false,
  children,
}: {
  summary?: string;
  showScrollToLatest?: boolean;
  children?: ReactNode;
}) {
  const [view, setView] = useState<ConversationView | null>(null);
  useEffect(() => {
    const doc = new LoroDoc();
    const mirror = new Mirror({
      doc,
      schema: sessionDocSchema,
      initialState: { session: { id: coordinatorSessionId }, history: [] },
      ignoreUnknownProperties: true,
    });
    mirror.setState((previous) => ({
      ...previous,
      history: buildCoordinatorHistory(summary) as never,
    }));
    mirror.dispose();
    const session = createConversationSession(doc, { sessionId: coordinatorSessionId });
    setView(session.history);
    return () => {
      session.dispose();
      doc.free();
    };
  }, [summary]);
  const stream = useConversationStreamItems(view, coordinatorSessionId);
  return (
    <div className="relative h-[760px] w-full bg-background">
      <Toast.Provider manager={toastManager} />
      <SessionChatStreamView
        initialWindowReady={stream.initialWindowReady}
        items={stream.items}
        sessionId={coordinatorSessionId}
        className="h-full"
        renderMessageRow={renderMessageRow}
        showScrollToLatest={showScrollToLatest}
        lastAssistantMessageId={stream.lastAssistantMessageId}
        lastCompletedAssistantMessageId={stream.lastCompletedAssistantMessageId}
        onRetainedTurnIdsChange={stream.onRetainedTurnIdsChange}
        onVisibleTurnRangeChange={stream.onVisibleTurnRangeChange}
        onOutlinePreviewRound={stream.onOutlinePreviewRound}
      />
      {children}
    </div>
  );
}

/**
 * Three user messages, 24 receipt rounds: the rail shows 27 ticks. Hover a
 * receipt tick for the reporting threads and the opening of the reply; click
 * it to land on that receipt.
 */
export const ReceiptRoundsInOutline: Story = {
  render: () => <CoordinatorFrame />,
};

/**
 * The last answer links to three receipts: round 22 is near and loaded, round
 * 3 is far up and still a placeholder, round 30 does not exist. A link scrolls
 * to its turn and flashes it; the round button at the bottom right turns into
 * "back" and returns to the click point, one jump at a time, before it goes to
 * the latest message again. The link into another conversation is inert here:
 * Storybook has no session navigation.
 */
export const TurnLinks: Story = {
  render: () => <CoordinatorFrame summary={SUMMARY_WITH_TURN_LINKS} showScrollToLatest />,
};

/** The other looks offered for the flash and the back button. Pick one; the rest go. */
const COLUMN_INSET = 'inset-inline: max(6px, calc((100% - 48rem - 36px) / 2 + 6px));';
const HIGHLIGHT_ALTERNATIVES = {
  // B: tint only the reading column, rounded.
  column: `[data-turn-link-highlight] { ${COLUMN_INSET} border-radius: 8px; }`,
  // C: an accent bar at the column's leading edge over a fainter tint.
  bar: `[data-turn-link-highlight] { ${COLUMN_INSET} background-color: transparent !important; box-shadow: inset 3px 0 0 hsl(220 82% 65%), inset 0 0 0 100vmax hsl(220 82% 65% / 0.07); }
.dark [data-turn-link-highlight] { box-shadow: inset 3px 0 0 hsl(27 100% 80%), inset 0 0 0 100vmax hsl(27 100% 80% / 0.07); }`,
} as const;

function BackButtonAlternative({ look }: { look: 'pill' | 'pair' }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4">
      <style>{'[data-scroll-to-latest] { display: none !important; }'}</style>
      <ConversationColumn className="flex justify-end gap-2">
        <Button
          variant="secondary"
          className="pointer-events-auto rounded-full border-[0.5px] border-border bg-white text-foreground shadow-[0_0.5px_1px_1px_rgba(0,0,0,0.04)] hover:bg-white dark:bg-secondary dark:text-secondary-foreground dark:shadow-none"
        >
          <Undo2 className="size-4" aria-hidden="true" />
          {look === 'pill' ? '返回' : '回到刚才的位置'}
        </Button>
        {look === 'pair' ? (
          <Button
            variant="secondary"
            icon
            className="pointer-events-auto rounded-full border-[0.5px] border-border bg-white text-foreground shadow-[0_0.5px_1px_1px_rgba(0,0,0,0.04)] hover:bg-white dark:bg-secondary dark:text-secondary-foreground dark:shadow-none"
          >
            <ArrowDown className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
      </ConversationColumn>
    </div>
  );
}

type LookArgs = {
  highlight: 'row' | keyof typeof HIGHLIGHT_ALTERNATIVES;
  back: 'glyph' | 'pill' | 'pair';
};

/**
 * Compare only: the shipped look is `highlight: row` + `back: glyph`. The
 * others restyle the same flash and stand a static button in for the real one.
 */
export const TurnLinkLooks: StoryObj<LookArgs> = {
  args: { highlight: 'row', back: 'glyph' },
  argTypes: {
    highlight: { control: 'inline-radio', options: ['row', 'column', 'bar'] },
    back: { control: 'inline-radio', options: ['glyph', 'pill', 'pair'] },
  },
  render: ({ highlight, back }) => (
    <CoordinatorFrame summary={SUMMARY_WITH_TURN_LINKS} showScrollToLatest>
      {highlight === 'row' ? null : <style>{HIGHLIGHT_ALTERNATIVES[highlight]}</style>}
      {back === 'glyph' ? null : <BackButtonAlternative look={back} />}
    </CoordinatorFrame>
  ),
};
