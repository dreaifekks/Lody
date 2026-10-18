import type { BoardMeta, ScheduleRegistryRow, SessionMeta } from '@lody/shared';

export const scheduleRowsForBoard = (rows: readonly ScheduleRegistryRow[], boardId?: string) =>
  rows.filter((row) => row.boardId === boardId);

export const isScheduleBoardThread = (session: SessionMeta, board: BoardMeta) =>
  session.boardId === board.id && session.id !== board.coordinatorSessionId;

export function scheduleBoundSession(
  row: Pick<ScheduleRegistryRow, 'scheduleId' | 'destination'>,
  sessions: readonly SessionMeta[]
): SessionMeta | undefined {
  const destination = row.destination;
  if (destination.kind === 'existing_session')
    return sessions.find((session) => session.id === destination.sessionId);
  if (destination.kind === 'new_session') return undefined;
  return sessions
    .filter((session) => session.scheduleId === row.scheduleId && !session.isArchived)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))[0];
}
