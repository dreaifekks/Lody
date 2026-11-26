/**
 * Linear session node rollover divider across every status it can display
 * (`sealing`, `sealed`, `switching`, `done`, `failed`, `interrupted`, plus
 * light and dark surfaces). Silent auto-interrupted runs render nothing.
 */
import type { Meta, StoryObj } from '@storybook/react';
import type { SessionId, SessionRolloverNoticeMeta } from '@lody/shared';
import { MessageRowView } from '@/components/ai-gui/view';

const divider = (id: string, meta: Omit<SessionRolloverNoticeMeta, 'kind'>) => (
  <MessageRowView
    key={id}
    sessionId={'session-rollover-demo' as SessionId}
    message={{
      id: `session-rollover:${id}`,
      role: 'system',
      timestamp: '2026-11-27T04:00:00Z',
      items: [
        {
          type: 'system_notice',
          name: 'session_context_rollover',
          meta: { kind: 'linear_rollover', ...meta },
        },
      ],
    }}
    onNavigateSession={() => {}}
  />
);

function RolloverDividers() {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      {divider('sealing', {
        trigger: 'manual',
        status: 'sealing',
        generation: 2,
        nodeId: 'n_0002',
        usedBefore: 352_000,
      })}
      {divider('sealed', {
        trigger: 'manual',
        status: 'sealed',
        generation: 2,
        nodeId: 'n_0002',
        usedBefore: 352_000,
      })}
      {divider('switching', {
        trigger: 'manual',
        status: 'switching',
        generation: 2,
        nodeId: 'n_0002',
        usedBefore: 352_000,
      })}
      {divider('done-tokens', {
        trigger: 'auto',
        status: 'done',
        generation: 2,
        nodeId: 'n_0002',
        usedBefore: 352_000,
        usedAfter: 26_000,
      })}
      {divider('done-no-tokens', {
        trigger: 'manual',
        status: 'done',
        generation: 3,
        nodeId: 'n_0003',
      })}
      {divider('failed', {
        trigger: 'manual',
        status: 'failed',
        generation: 4,
        nodeId: 'n_0004',
        reason: 'renew-failed',
      })}
      {divider('interrupted-manual', {
        trigger: 'manual',
        status: 'interrupted',
        generation: 4,
        nodeId: 'n_0004',
        reason: 'cancelled',
      })}
      {divider('interrupted-auto-silent', {
        trigger: 'auto',
        status: 'interrupted',
        generation: 4,
        nodeId: 'n_0004',
        reason: 'cancelled',
      })}
    </div>
  );
}

const meta = {
  title: 'Workspace/Sessions/Session rollover divider',
  component: RolloverDividers,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof RolloverDividers>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = {};

export const Dark: Story = {
  decorators: [
    (Story) => (
      <div className="dark" data-mode="dark" style={{ background: '#111113', minHeight: '100vh' }}>
        <Story />
      </div>
    ),
  ],
};
