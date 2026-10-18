import {
  scheduleOwnSessionId,
  type SessionId,
  type ScheduleRegistryRow,
  type SessionMeta,
} from '@lody/shared';
export { isScheduleBoardThread } from '@lody/shared';

export const scheduleRowsForBoard = (rows: readonly ScheduleRegistryRow[], boardId?: string) =>
  rows.filter((row) => row.boardId === boardId);

export function scheduleBoundSession(
  row: Pick<ScheduleRegistryRow, 'scheduleId' | 'destination' | 'boardId'>,
  sessions: readonly SessionMeta[],
  isDeleted: (id: SessionId) => boolean
): SessionMeta | undefined {
  const destination = row.destination;
  if (destination.kind === 'existing_session')
    return sessions.find((session) => session.id === destination.sessionId);
  if (destination.kind === 'new_session') return undefined;
  const byId = new Map(sessions.map((session) => [session.id, session]));
  for (let sequence = 0; ; sequence++) {
    const id = scheduleOwnSessionId(row.scheduleId, destination.epoch, sequence);
    if (isDeleted(id)) continue;
    const session = byId.get(id);
    // The first never-created id is where the next run will create its thread.
    if (!session) return undefined;
    if (!session.isArchived && (!row.boardId || session.boardId === row.boardId)) return session;
  }
}
