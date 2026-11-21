import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { createStore, Provider } from 'jotai';
import { expect, waitFor } from 'storybook/test';
import type { MessageContent, SessionHistory, SessionId } from '@lody/shared';
import {
  experimentalFeaturesEnabledAtom,
  lowStimulusExperimentEnabledAtom,
  streamingThoughtPreviewExperimentEnabledAtom,
} from '@/atoms/settings';
import type { SessionBackgroundTaskStatus } from '@/components/ai-gui/background-task-status-row';
import { buildChatStreamItems } from '@/components/ai-gui/build-chat-stream-items';
import {
  MessageRowView,
  SessionChatStreamView,
  type SessionChatStreamViewProps,
} from '@/components/ai-gui/view';
import { SessionRowStatusIndicator } from '@/components/sidebar-row-shared';
import { createConversationViewFromHistory } from '@/lib/conversation-view';
import { BackgroundStatusMark } from '@/ui/working-status-mark';

const sessionId = 'session-streaming-thought-preview-story' as SessionId;

const renderMessageRow: SessionChatStreamViewProps['renderMessageRow'] = ({
  message,
  sessionId: storySessionId,
}) => <MessageRowView message={message} sessionId={storySessionId} />;

type PreviewHarnessProps = {
  turnId: string;
  items: MessageContent[];
  finished?: boolean;
  endedAt?: number;
  experimentalEnabled: boolean;
  thoughtPreviewEnabled: boolean;
  lowStimulusEnabled?: boolean;
  agentActivityLabel?: string | null;
  agentActivityTone?: 'primary' | 'warning';
  agentActivityShimmer?: boolean;
  backgroundTaskStatus?: SessionBackgroundTaskStatus | null;
  showStatusMarksStrip?: boolean;
};

function PreviewHarness({
  turnId,
  items,
  finished = false,
  endedAt,
  experimentalEnabled,
  thoughtPreviewEnabled,
  lowStimulusEnabled = false,
  agentActivityLabel = finished ? null : 'Working',
  agentActivityTone = 'primary',
  agentActivityShimmer = !finished,
  backgroundTaskStatus = null,
  showStatusMarksStrip = false,
}: PreviewHarnessProps) {
  const [store] = useState(() => {
    const created = createStore();
    created.set(experimentalFeaturesEnabledAtom, experimentalEnabled);
    created.set(streamingThoughtPreviewExperimentEnabledAtom, thoughtPreviewEnabled);
    created.set(lowStimulusExperimentEnabledAtom, lowStimulusEnabled);
    return created;
  });

  const [stream] = useState(() => {
    const userTimestamp = finished
      ? '2026-11-21T02:00:00.000Z'
      : new Date(Date.now() - 30_000).toISOString();
    const assistantTimestamp = finished
      ? '2026-11-21T02:00:02.000Z'
      : new Date(Date.now() - 28_000).toISOString();
    const history: SessionHistory[] = [
      {
        id: `${turnId}:user`,
        role: 'user',
        timestamp: userTimestamp,
        read: true,
        fileDiff: [],
        items: [
          {
            type: 'text',
            text: 'Confirm PR #103 keeps thought excerpts during tool loops and start watching GitHub Actions CI in the background without blocking the summary.',
          },
        ],
      },
      {
        id: turnId,
        role: 'assistant',
        timestamp: assistantTimestamp,
        read: true,
        finished,
        ...(endedAt !== undefined ? { endedAt } : {}),
        fileDiff: [],
        items,
      },
    ];

    const view = createConversationViewFromHistory({
      sessionId,
      getHistory: () => history,
      subscribe: () => () => {},
    });
    return { view, streamItems: buildChatStreamItems(view, sessionId).items };
  });

  return (
    <Provider store={store}>
      <div className="flex h-[560px] w-full flex-col bg-background text-foreground">
        {showStatusMarksStrip ? (
          <div className="flex items-center gap-6 border-b border-border/60 px-6 py-2.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <SessionRowStatusIndicator isWorking workingStill={lowStimulusEnabled} />
              <span>Sidebar active</span>
            </span>
            <span className="inline-flex items-center gap-2">
              <SessionRowStatusIndicator
                isWorking
                isBackgroundWorking
                workingStill={lowStimulusEnabled}
              />
              <span>Sidebar background</span>
            </span>
            <span className="inline-flex items-center gap-2">
              <BackgroundStatusMark still={lowStimulusEnabled} />
              <span>Tab background</span>
            </span>
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          <SessionChatStreamView
            sessionId={sessionId}
            items={stream.streamItems}
            conversationView={stream.view}
            renderMessageRow={renderMessageRow}
            lastAssistantMessageId={turnId}
            agentActivityLabel={agentActivityLabel}
            agentActivityTone={agentActivityTone}
            agentActivityShimmer={agentActivityShimmer}
            backgroundTaskStatus={backgroundTaskStatus}
          />
        </div>
      </div>
    </Provider>
  );
}

const meta = {
  title: 'Sessions/StreamingThoughtPreview',
  component: PreviewHarness,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof PreviewHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

const AGY_PLACEHOLDER = "I'm thinking through how to approach this.";

const thought1Text = [
  AGY_PLACEHOLDER,
  'Checking how adjacent thoughts and tool calls merge into one collapsed activity group in `assistant-turn-render-blocks.ts`.',
  'Verifying whether the compact single-level header keeps the latest valid thought excerpt while commands run.',
].join('\n\n\n');

const thought2Text = [
  'Initial inspection confirms `extractLatestStreamingThoughtPreview` scans entries in reverse and skips placeholder-only chunks.',
  'Next I will run the unit test suite and attach a background `gh run watch` task for CI.',
].join('\n\n\n');

const thought3Text = [
  AGY_PLACEHOLDER,
  'All unit tests passed and `gh run watch 20481937412 --exit-status` is running in the background. Writing the concise summary now.',
].join('\n\n\n');

const runningToolItems: MessageContent[] = [
  {
    type: 'thought',
    text: thought1Text,
  },
  {
    type: 'tool_call',
    toolCallId: 'read-blocks',
    kind: 'read',
    title: 'Read packages/components/src/components/ai-gui/assistant-turn-render-blocks.ts',
    locations: [
      { path: 'packages/components/src/components/ai-gui/assistant-turn-render-blocks.ts' },
    ],
    status: 'completed',
  },
  {
    type: 'tool_call',
    toolCallId: 'read-preview',
    kind: 'read',
    title: 'Read packages/components/src/components/ai-gui/streaming-thought-preview.ts',
    locations: [{ path: 'packages/components/src/components/ai-gui/streaming-thought-preview.ts' }],
    status: 'completed',
  },
  {
    type: 'tool_call',
    toolCallId: 'search-key',
    kind: 'search',
    title: 'Search resolveLiveThoughtPreviewRowKey in packages/components/src/components/ai-gui/',
    status: 'completed',
  },
  {
    type: 'tool_call',
    toolCallId: 'run-vitest',
    kind: 'execute',
    title: 'Run pnpm --filter @lody/components test tests/streaming-thought-preview.test.ts',
    status: 'in_progress',
  },
];

const fullProcessItems: MessageContent[] = [
  {
    type: 'thought',
    text: thought1Text,
  },
  {
    type: 'tool_call',
    toolCallId: 'read-blocks',
    kind: 'read',
    title: 'Read packages/components/src/components/ai-gui/assistant-turn-render-blocks.ts',
    locations: [
      { path: 'packages/components/src/components/ai-gui/assistant-turn-render-blocks.ts' },
    ],
    status: 'completed',
  },
  {
    type: 'tool_call',
    toolCallId: 'read-preview',
    kind: 'read',
    title: 'Read packages/components/src/components/ai-gui/streaming-thought-preview.ts',
    locations: [{ path: 'packages/components/src/components/ai-gui/streaming-thought-preview.ts' }],
    status: 'completed',
  },
  {
    type: 'thought',
    text: thought2Text,
  },
  {
    type: 'tool_call',
    toolCallId: 'search-key',
    kind: 'search',
    title: 'Search resolveLiveThoughtPreviewRowKey in packages/components/src/components/ai-gui/',
    status: 'completed',
  },
  {
    type: 'tool_call',
    toolCallId: 'run-vitest',
    kind: 'execute',
    title: 'Run pnpm --filter @lody/components test tests/streaming-thought-preview.test.ts',
    status: 'completed',
    content: [
      {
        type: 'terminal_output',
        output:
          '✓ tests/streaming-thought-preview.test.ts (42 tests) 1.42s\nTest Files  1 passed (1)',
        stream: 'combined',
      },
    ],
  },
  {
    type: 'tool_call',
    toolCallId: 'bg-gh-watch',
    kind: 'execute',
    title: 'Run gh run watch 20481937412 --exit-status',
    status: 'in_progress',
    backgroundTaskId: 'bg-gh-run-20481937412',
    content: [
      {
        type: 'terminal_output',
        output: 'Tool is running as a background task with task id: bg-gh-run-20481937412',
        stream: 'combined',
      },
    ],
  },
  {
    type: 'thought',
    text: thought3Text,
  },
];

const finalAnswerItem: MessageContent = {
  type: 'text',
  text: [
    'Verified PR #103 and started CI tracking in the background:',
    '',
    '1. **Thought retention during tool loops**: `extractLatestStreamingThoughtPreview` scans entries in reverse and retains the previous valid thought while tools execute.',
    '2. **Single-level directory**: clicking the header opens a flat list of collapsed thought excerpts, clustered read steps, and expandable tool outputs.',
    '3. **Background CI watch**: `gh run watch 20481937412 --exit-status` is attached as a native background task and will report back on completion.',
  ].join('\n'),
};

export const LivePlaceholderOnly: Story = {
  args: {
    turnId: 'preview-placeholder-only',
    experimentalEnabled: true,
    thoughtPreviewEnabled: true,
    items: [{ type: 'thought', text: AGY_PLACEHOLDER }],
  },
};

export const LiveCollapsedThoughtOnly: Story = {
  args: {
    turnId: 'preview-thought-only',
    experimentalEnabled: true,
    thoughtPreviewEnabled: true,
    items: [{ type: 'thought', text: thought1Text }],
  },
};

export const LiveRunningToolWithThought: Story = {
  args: {
    turnId: 'preview-running-tool',
    experimentalEnabled: true,
    thoughtPreviewEnabled: true,
    items: runningToolItems,
  },
};

export const LiveThinkingWithToolCounts: Story = {
  args: {
    turnId: 'preview-thinking-counts',
    experimentalEnabled: true,
    thoughtPreviewEnabled: true,
    items: fullProcessItems,
  },
};

export const ExpandedSingleLevelDirectory: Story = {
  args: {
    turnId: 'preview-expanded-directory',
    experimentalEnabled: true,
    thoughtPreviewEnabled: true,
    finished: true,
    endedAt: Date.parse('2026-11-21T02:02:06.000Z'),
    backgroundTaskStatus: { mode: 'waiting', taskCount: 1 },
    items: [...fullProcessItems, finalAnswerItem],
  },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(canvasElement.querySelector('[data-compact-work-header="finished"]')).not.toBeNull();
    });
    const header = canvasElement.querySelector<HTMLButtonElement>(
      '[data-compact-work-header="finished"]'
    )!;
    if (header.getAttribute('aria-expanded') === 'false') {
      header.click();
    }
    await waitFor(() => {
      expect(canvasElement.querySelector('[data-compact-read-cluster-toggle]')).not.toBeNull();
    });
    canvasElement.querySelector<HTMLButtonElement>('[data-compact-read-cluster-toggle]')?.click();
    canvasElement
      .querySelector<HTMLButtonElement>(
        '[data-compact-thought-row="0"] [data-compact-thought-toggle]'
      )
      ?.click();
    canvasElement
      .querySelector<HTMLButtonElement>(
        '[data-compact-tool-row="run-vitest"] [data-compact-tool-toggle]'
      )
      ?.click();
  },
};

export const FinishedWithBackgroundWaiting: Story = {
  args: {
    turnId: 'preview-finished-bg-waiting',
    experimentalEnabled: true,
    thoughtPreviewEnabled: true,
    finished: true,
    endedAt: Date.parse('2026-11-21T02:02:06.000Z'),
    backgroundTaskStatus: { mode: 'waiting', taskCount: 1 },
    showStatusMarksStrip: true,
    items: [...fullProcessItems, finalAnswerItem],
  },
};

export const FinishedWithBackgroundWakeup: Story = {
  args: {
    turnId: 'preview-finished-bg-wakeup',
    experimentalEnabled: true,
    thoughtPreviewEnabled: true,
    finished: true,
    endedAt: Date.parse('2026-11-21T02:02:06.000Z'),
    backgroundTaskStatus: { mode: 'wakeup', taskCount: 1 },
    items: [...fullProcessItems, finalAnswerItem],
  },
};

export const LiveLowStimulus: Story = {
  args: {
    turnId: 'preview-low-stimulus',
    experimentalEnabled: true,
    thoughtPreviewEnabled: true,
    lowStimulusEnabled: true,
    agentActivityShimmer: false,
    showStatusMarksStrip: true,
    items: runningToolItems,
  },
};

export const ExperimentDisabled: Story = {
  args: {
    turnId: 'preview-experiment-disabled',
    experimentalEnabled: true,
    thoughtPreviewEnabled: false,
    items: runningToolItems,
  },
};
