import type { BoardMeta, SessionMeta } from '@lody/shared';
import { SchedulesWorkspace } from '../schedules/schedules-workspace';

/** Board navigation supplies selection; all writes and editor controls stay in Schedules. */
export function BoardSchedules({
  board,
  scheduleId,
  onSelect,
  onOpenThread,
}: {
  board: BoardMeta;
  scheduleId?: string;
  onSelect: (id?: string) => void;
  onOpenThread: (session: SessionMeta) => void;
}) {
  return (
    <SchedulesWorkspace
      board={board}
      scheduleId={scheduleId}
      onSelectSchedule={onSelect}
      onOpenBoardThread={onOpenThread}
    />
  );
}
