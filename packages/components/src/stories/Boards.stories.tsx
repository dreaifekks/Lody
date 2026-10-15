import { MessageRowView } from '../components/ai-gui/view';
import type { SessionId, BoardId, MachineId } from '@lody/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BoardNotesEditor } from '../components/boards/board-notes-panel';
import type { Meta, StoryObj } from '@storybook/react';
import { BoardListView, BoardSessionRowView } from '../components/boards/board-view';
import { normalizeBoardMeta, type SessionMeta } from '@lody/shared';

const meta = {
  title: 'Workspace/Boards',
  component: BoardListView,
  args: { onCreate: () => {}, onOpen: () => {} },
} satisfies Meta<typeof BoardListView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = { args: { boards: [] } };
const board = normalizeBoardMeta({
  version: 1,
  id: 'bd_demo',
  name: 'Ship a desktop feature',
  purpose: 'Implement, review and verify the next release.',
  coordinatorSessionId: 'coordinator',
  createdAtMs: 1,
  createdByUserId: 'owner',
});
export const List: Story = { args: { boards: board ? [board] : [] } };
export const OverviewRows: Story = {
  args: { boards: [] },
  render: () => (
    <>
      {(['running', 'waiting_user', 'failed', 'idle'] as const).map((status, index) => (
        <BoardSessionRowView
          key={status}
          session={
            {
              id: status,
              title: ['Data model', 'UI review', 'Research', 'Follow-up'][index],
              createdAt: '2026-10-15T00:00:00Z',
            } as SessionMeta
          }
          detail="Agent · Laptop · feature-worktree"
          status={status}
          depth={index === 1 ? 1 : 0}
          expanded={status === 'failed'}
          onExpand={() => {}}
          onOpen={() => {}}
        >
          {status === 'failed' ? (
            <p>The build could not start; waiting for the missing dependency.</p>
          ) : null}
        </BoardSessionRowView>
      ))}
    </>
  ),
};

export const Notes: Story = {
  args: { boards: [] },
  render: function NotesStory() {
    const [notes, setNotes] = useState(
      '# Release decisions\n\n- Keep the implementation small.\n- Verify the desktop and mobile layouts.'
    );
    return (
      <BoardNotesEditor
        notes={notes}
        onSave={async (text) => {
          setNotes(text);
        }}
      />
    );
  },
};

export const InboxReports: Story = {
  args: { boards: [] },
  render: function InboxReportsStory() {
    const { t } = useTranslation();
    return (
      <>
        <BoardSessionRowView
          session={
            {
              id: 'coordinator',
              title: t('boards.coordinator'),
              createdAt: '2026-10-16T00:00:00Z',
              boardRole: 'coordinator',
            } as SessionMeta
          }
          detail={`${t('boards.coordinator')} · ${t('boards.chat')}`}
          status="stopped"
          expanded
          onExpand={() => {}}
          onOpen={() => {}}
        >
          <p>{t('boards.chain', { depth: 15, limit: 16 })}</p>
        </BoardSessionRowView>
        <MessageRowView
          sessionId={'coordinator' as SessionId}
          message={{
            id: 'board-reports',
            role: 'system',
            timestamp: '2026-10-16T00:00:00Z',
            items: [
              {
                type: 'operation_completion_batch',
                batchId: 'demo-board-batch',
                memberCount: 4,
                members: (['finished', 'failed', 'waiting_user', 'notice'] as const).map(
                  (kind, index) => ({
                    type: 'operation_completion',
                    deliveryId: `report-${kind}`,
                    operationId: `report-${kind}`,
                    operationKind: 'board_report',
                    completion: {
                      type: 'result',
                      value: {
                        items: [],
                        boardReport: {
                          boardId: 'bd_demo' as BoardId,
                          events: [
                            {
                              kind,
                              sessionId: `member-${index}` as SessionId,
                              machineId: 'laptop' as MachineId,
                              turnId: 'work',
                              at: 1,
                              origin: 'system',
                              title: [
                                t('boards.story.reportsTask'),
                                t('boards.story.buildTask'),
                                t('boards.story.reviewTask'),
                                t('boards.story.researchTask'),
                              ][index],
                              output: {
                                text:
                                  [
                                    t('boards.story.reportsOutput'),
                                    t('boards.story.buildOutput'),
                                    t('boards.story.reviewOutput'),
                                    t('boards.story.researchOutput'),
                                  ][index] ?? '',
                              },
                            },
                          ],
                        },
                      },
                    },
                  })
                ),
              },
              {
                type: 'system_notice',
                name: 'board_chain_limit',
                meta: { boardId: 'bd_demo', drivingTurnId: 'last-input' },
              },
            ],
          }}
          onNavigateSession={() => {}}
        />
      </>
    );
  },
};
