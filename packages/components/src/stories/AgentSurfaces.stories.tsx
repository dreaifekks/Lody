import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { PlanReviewCardView } from '@/components/agent-surfaces/plan-review-card';
import { PlanReviewPanelView } from '@/components/agent-surfaces/plan-review-panel';

/**
 * Experimental surfaces agents open through the lody MCP server: the plan
 * review card and its side panel. Fixtures are
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
