import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { SessionId } from '@lody/shared';
import { AgentSurfaceContext } from '@/components/agent-surfaces/agent-surface-context';
import { PlanReviewCardView } from '@/components/agent-surfaces/plan-review-card';
import { PlanReviewPanelView } from '@/components/agent-surfaces/plan-review-panel';
import { WidgetFrame } from '@/components/agent-surfaces/widget-frame';

/**
 * Experimental surfaces agents open through the lody MCP server: the plan
 * review card and its side panel, and an interactive widget. Fixtures are
 * synthetic.
 */
const meta = {
  title: 'AI/AgentSurfaces',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const PLAN = `## Goal

Cache the file index on disk so a restart does not rebuild it.

## Steps

1. Write the index to \`~/.lody/index-cache\` after each full scan.
2. On start, load the cache and verify it against the folder's modification times.
3. Fall back to a full scan when verification fails.

## Risks

- A stale cache could hide new files until the next scan.
`;

export const PlanReviewCards: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 8, maxWidth: 560 }}>
      <PlanReviewCardView title="Cache the file index" status="pending" onOpen={() => {}} />
      <PlanReviewCardView title="Cache the file index" status="answered" onOpen={() => {}} />
      <PlanReviewCardView title="First draft" status="superseded" onOpen={() => {}} />
      <PlanReviewCardView title="Preparing a plan…" status={null} />
    </div>
  ),
};

function PanelHarness({ status, canAct }: { status: 'pending' | 'answered'; canAct: boolean }) {
  const [sent, setSent] = useState<string | null>(null);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '420px 1fr', gap: 16, height: 620 }}>
      <div style={{ border: '1px solid hsl(var(--border))', height: '100%' }}>
        <PlanReviewPanelView
          input={{
            title: 'Cache the file index',
            summary: 'Three steps; touches the indexer only.',
            markdown: PLAN,
          }}
          status={status}
          canAct={canAct}
          onSubmit={async (text) => {
            setSent(text);
            return true;
          }}
        />
      </div>
      <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
        {sent ?? 'Select text to comment.'}
      </pre>
    </div>
  );
}

export const PlanReviewPanel: Story = {
  render: () => <PanelHarness status="pending" canAct />,
};

export const PlanReviewPanelAnswered: Story = {
  render: () => <PanelHarness status="answered" canAct />,
};

const FLOW = `<svg width="100%" viewBox="0 0 680 220" role="img">
<title>Request flow</title><desc>Three steps from request to response</desc>
<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5"/></marker></defs>
<g class="node c-purple" onclick="sendPrompt('What does the router check first?')"><rect x="40" y="70" width="160" height="64" rx="6"/><text class="th" x="120" y="98" text-anchor="middle">Router</text><text class="ts" x="120" y="118" text-anchor="middle">matches the path</text></g>
<g class="node c-teal" onclick="sendPrompt('How does the handler load data?')"><rect x="260" y="70" width="160" height="64" rx="6"/><text class="th" x="340" y="98" text-anchor="middle">Handler</text><text class="ts" x="340" y="118" text-anchor="middle">loads the data</text></g>
<g class="node c-gray" onclick="sendPrompt('What goes into the response?')"><rect x="480" y="70" width="160" height="64" rx="6"/><text class="th" x="560" y="98" text-anchor="middle">Response</text><text class="ts" x="560" y="118" text-anchor="middle">renders JSON</text></g>
<line class="arr" x1="200" y1="102" x2="256" y2="102" marker-end="url(#arrow)"/>
<line class="arr" x1="420" y1="102" x2="476" y2="102" marker-end="url(#arrow)"/>
<text class="ts" x="340" y="180" text-anchor="middle">Click a step to ask about it</text>
</svg>`;

function WidgetHarness() {
  const [composer, setComposer] = useState('');
  return (
    <AgentSurfaceContext.Provider
      value={{
        sessionId: 'story-session' as SessionId,
        canAct: true,
        fillComposer: (text) =>
          setComposer((previous) => (previous ? `${previous}\n\n${text}` : text)),
      }}
    >
      <div style={{ maxWidth: 720, display: 'grid', gap: 12 }}>
        <WidgetFrame code={FLOW} title="Request flow" />
        <textarea
          aria-label="Composer"
          readOnly
          value={composer}
          placeholder="Composer"
          style={{ minHeight: 48, fontSize: 13 }}
        />
      </div>
    </AgentSurfaceContext.Provider>
  );
}

export const InlineWidget: Story = {
  render: () => <WidgetHarness />,
};
