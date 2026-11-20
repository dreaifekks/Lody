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
import { buildChatStreamItems } from '@/components/ai-gui/build-chat-stream-items';
import {
  MessageRowView,
  SessionChatStreamView,
  type SessionChatStreamViewProps,
} from '@/components/ai-gui/view';
import { createConversationViewFromHistory } from '@/lib/conversation-view';

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
}: PreviewHarnessProps) {
  const [store] = useState(() => {
    const created = createStore();
    created.set(experimentalFeaturesEnabledAtom, experimentalEnabled);
    created.set(streamingThoughtPreviewExperimentEnabledAtom, thoughtPreviewEnabled);
    created.set(lowStimulusExperimentEnabledAtom, lowStimulusEnabled);
    return created;
  });

  const [stream] = useState(() => {
    const history: SessionHistory[] = [
      {
        id: `${turnId}:user`,
        role: 'user',
        timestamp: '2026-11-21T02:00:00.000Z',
        read: true,
        fileDiff: [],
        items: [
          {
            type: 'text',
            text: 'Inspect why streaming thoughts stay hidden during long tool loops and preview the latest paragraph cleanly.',
          },
        ],
      },
      {
        id: turnId,
        role: 'assistant',
        timestamp: '2026-11-21T02:00:02.000Z',
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
      <div className="h-[520px] w-full bg-background">
        <SessionChatStreamView
          sessionId={sessionId}
          items={stream.streamItems}
          conversationView={stream.view}
          renderMessageRow={renderMessageRow}
          lastAssistantMessageId={turnId}
          agentActivityLabel={agentActivityLabel}
          agentActivityTone={agentActivityTone}
          agentActivityShimmer={agentActivityShimmer}
        />
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

const agyThoughtText = [
  "I'm thinking through how to approach this.",
  'Checking how adjacent thoughts and tool calls merge into one collapsed activity group in `assistant-turn-render-blocks.ts`.',
  'Comparing the trailing collapsed activity group row in `view.tsx` so the two-line preview shares the exact left rail with the disclosure button and disappears cleanly once the group expands or the turn finishes.',
].join('\n\n\n');

const toolsWithThoughtItems: MessageContent[] = [
  {
    type: 'thought',
    text: agyThoughtText,
  },
  {
    type: 'tool_call',
    toolCallId: 'read-view',
    kind: 'read',
    title: 'Read packages/components/src/components/ai-gui/view.tsx',
    locations: [{ path: 'packages/components/src/components/ai-gui/view.tsx' }],
    status: 'completed',
  },
  {
    type: 'tool_call',
    toolCallId: 'read-surface',
    kind: 'read',
    title: 'Read packages/components/src/components/ai-gui/surface.ts',
    locations: [{ path: 'packages/components/src/components/ai-gui/surface.ts' }],
    status: 'completed',
  },
  {
    type: 'tool_call',
    toolCallId: 'run-vitest',
    kind: 'execute',
    title: 'pnpm --filter @lody/components test tests/streaming-thought-preview.test.ts',
    status: 'in_progress',
  },
];

export const LiveCollapsedThoughtOnly: Story = {
  args: {
    turnId: 'preview-thought-only',
    experimentalEnabled: true,
    thoughtPreviewEnabled: true,
    items: [{ type: 'thought', text: agyThoughtText }],
  },
};

export const LiveCollapsedToolsRetainingThought: Story = {
  args: {
    turnId: 'preview-tools-retaining-thought',
    experimentalEnabled: true,
    thoughtPreviewEnabled: true,
    items: toolsWithThoughtItems,
  },
};

export const LiveExpandedGroup: Story = {
  args: {
    turnId: 'preview-expanded-group',
    experimentalEnabled: true,
    thoughtPreviewEnabled: true,
    items: toolsWithThoughtItems,
  },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      const disclosures = canvasElement.querySelectorAll<HTMLButtonElement>(
        '[data-conversation-disclosure="group"]'
      );
      expect(disclosures.length).toBeGreaterThan(0);
    });
    const disclosures = canvasElement.querySelectorAll<HTMLButtonElement>(
      '[data-conversation-disclosure="group"]'
    );
    const groupHeader = disclosures[disclosures.length - 1]!;
    if (groupHeader.getAttribute('aria-expanded') === 'false') {
      groupHeader.click();
    }
    await waitFor(() => {
      expect(canvasElement.querySelector('[data-streaming-thought-preview]')).toBeNull();
    });
  },
};

export const LiveLowStimulus: Story = {
  args: {
    turnId: 'preview-low-stimulus',
    experimentalEnabled: true,
    thoughtPreviewEnabled: true,
    lowStimulusEnabled: true,
    agentActivityShimmer: false,
    items: toolsWithThoughtItems,
  },
};

export const FinishedTurn: Story = {
  args: {
    turnId: 'preview-finished-turn',
    experimentalEnabled: true,
    thoughtPreviewEnabled: true,
    finished: true,
    endedAt: Date.parse('2026-11-21T02:01:14.000Z'),
    items: [
      ...toolsWithThoughtItems.map((item) =>
        item.type === 'tool_call' ? { ...item, status: 'completed' as const } : item
      ),
      {
        type: 'text',
        text: 'Added the streaming thought preview behind the experimental switch. Once the turn finishes, it collapses into the standard Worked for disclosure with no residual preview.',
      },
    ],
  },
};

export const ExperimentDisabled: Story = {
  args: {
    turnId: 'preview-experiment-disabled',
    experimentalEnabled: true,
    thoughtPreviewEnabled: false,
    items: toolsWithThoughtItems,
  },
};
