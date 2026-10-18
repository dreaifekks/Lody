import { useNavigate } from '@tanstack/react-router';
import { useAtomValue } from 'jotai';
import { currentWorkspaceSlugAtom } from '@/atoms';
import { useSchedules } from '@/hooks/use-schedules';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import { boardEntrySearch } from '../boards/board-threads';

/** Both provenance links and proposal cards enter a Board's own management surface. */
export function useOpenSchedule() {
  const navigate = useNavigate();
  const slug = useAtomValue(currentWorkspaceSlugAtom);
  const { rows } = useSchedules();
  const { boards } = useWorkspaceCatalog();
  return (
    scheduleId: string,
    boardId = rows.find((row) => row.scheduleId === scheduleId)?.boardId
  ) => {
    if (!slug) return;
    if (boardId) {
      const board = boards.find((entry) => entry.id === boardId);
      if (!board) return;
      void navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: slug, sessionId: board.coordinatorSessionId },
        search: { ...boardEntrySearch(board.coordinatorSessionId), boardSchedule: scheduleId },
      });
    } else {
      void navigate({
        to: '/$workspaceName/schedules/$scheduleId',
        params: { workspaceName: slug, scheduleId },
      });
    }
  };
}
