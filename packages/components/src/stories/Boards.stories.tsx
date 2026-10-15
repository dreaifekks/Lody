import { useState } from 'react';
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
