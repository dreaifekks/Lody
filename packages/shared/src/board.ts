import { z } from 'zod';
import type { BoardId, SessionId } from './ids';
import type { SessionHistoryInput, SessionStatus } from './schema';

export const MAX_BOARDS_PER_WORKSPACE = 50;
export const DEFAULT_BOARD_RULES = {
  maxRoundsPerThread: 4,
  reportHumanTurns: false,
  executorConstraints: '',
};
const boundedText = (max: number) => z.string().refine((text) => Array.from(text).length <= max);
const BoardMetaSchema = z.object({
  version: z.literal(1),
  id: z.string().startsWith('bd_').min(4),
  name: boundedText(80).refine((text) => text.trim().length > 0),
  purpose: boundedText(4000).refine((text) => text.trim().length > 0),
  coordinatorSessionId: z.string().min(1),
  createdAtMs: z.number().finite().nonnegative(),
  createdByUserId: z.string().min(1),
  rules: z
    .object({
      maxRoundsPerThread: z.number().int().positive().default(4),
      reportHumanTurns: z.boolean().default(false),
      executorConstraints: boundedText(2000).default(''),
    })
    .default(DEFAULT_BOARD_RULES),
  digestScheduleId: z.string().min(1).optional(),
  archivedAtMs: z.number().finite().nonnegative().optional(),
});
export type BoardMeta = Omit<z.infer<typeof BoardMetaSchema>, 'id' | 'coordinatorSessionId'> & {
  id: BoardId;
  coordinatorSessionId: SessionId;
};
export function normalizeBoardMeta(value: unknown): BoardMeta | null {
  const parsed = BoardMetaSchema.safeParse(value);
  return parsed.success ? (parsed.data as BoardMeta) : null;
}

export type BoardSessionStatus =
  | 'running'
  | 'initializing'
  | 'finalizing'
  | 'waiting_user'
  | 'failed'
  | 'waiting_coordinator'
  | 'idle';
/** Presence owns activity; durable status is deliberately not an input. */
export function deriveBoardSessionStatus(input: {
  liveStatus?: SessionStatus | null;
  awaitingUserSince?: number;
  lastMessageAt?: number;
  lastUserTurn?: Pick<SessionHistoryInput, 'status' | 'author'>;
  chatFailed?: boolean;
}): BoardSessionStatus {
  if (input.liveStatus?.type === 'initializing') return 'initializing';
  if (input.liveStatus?.type === 'running')
    return input.liveStatus.phase === 'finalizing' ? 'finalizing' : 'running';
  if (input.liveStatus?.type === 'requestPermission') return 'waiting_user';
  if (input.liveStatus == null && (input.awaitingUserSince ?? 0) > (input.lastMessageAt ?? 0))
    return 'waiting_user';
  if (input.lastUserTurn?.status === 'failed' || input.chatFailed) return 'failed';
  if (input.lastUserTurn?.author?.kind === 'agent') return 'waiting_coordinator';
  return 'idle';
}
