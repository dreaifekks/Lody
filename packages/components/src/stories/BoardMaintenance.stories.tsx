/**
 * Board coordinator maintenance: the one divider a run leaves in the
 * coordinator's conversation, in each state it can show. Real message rows with
 * synthetic history; the maintenance turns behind a divider are never drawn.
 */
import type { Meta, StoryObj } from '@storybook/react';
import type { BoardMaintenanceMeta, SessionId } from '@lody/shared';
import { MessageRowView } from '@/components/ai-gui/view';

const divider = (id: string, meta: Omit<BoardMaintenanceMeta, 'boardId'>) => (
  <MessageRowView
    key={id}
    sessionId={'coordinator' as SessionId}
    message={{
      id: `board-maintenance:${id}`,
      role: 'system',
      timestamp: '2026-10-17T00:00:00Z',
      items: [
        {
          type: 'system_notice',
          name: 'board_context_maintenance',
          meta: { boardId: 'bd_demo', ...meta },
        },
      ],
    }}
    onNavigateSession={() => {}}
  />
);

function Dividers() {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      {divider('running', { kind: 'compact', trigger: 'idle', status: 'running' })}
      {divider('done', {
        kind: 'compact',
        trigger: 'idle',
        status: 'done',
        usedBefore: 182_000,
        usedAfter: 24_000,
        renewed: true,
      })}
      {divider('fresh', { kind: 'new_conversation', trigger: 'manual', status: 'done' })}
      {divider('unsupported', { kind: 'compact', trigger: 'manual', status: 'unsupported' })}
      {divider('failed', {
        kind: 'compact',
        trigger: 'idle',
        status: 'failed',
        reason: 'compaction-unconfirmed',
      })}
      {divider('stopped', { kind: 'compact', trigger: 'manual', status: 'interrupted' })}
    </div>
  );
}

const meta = {
  title: 'Workspace/Boards/Maintenance divider',
  component: Dividers,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Dividers>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Running, tidied with its token change, new conversation, and the honest outcomes. */
export const States: Story = {};
