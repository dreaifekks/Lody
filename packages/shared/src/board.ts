import { z } from 'zod';
import type { BoardId, MachineId, SessionId } from './ids';
export type { BoardId } from './ids';
import type { LocalProjectId } from './project';
import type { SessionHistoryInput, SessionStatus, SessionMeta } from './schema';
import type { BoardReportEvent, LodyOperationOutputPreview } from './session-orchestration';
import { sha256Hex } from './sha256';
import { BoardContinuitySettingsSchema, DEFAULT_BOARD_CONTINUITY } from './board-continuity';

export const MAX_BOARDS_PER_WORKSPACE = 50;
/** The user's standing instructions for every member of a Board, in code points. */
export const MAX_BOARD_INSTRUCTIONS = 16_000;
export const DEFAULT_BOARD_RULES = {
  maxRoundsPerThread: 4,
  reportHumanTurns: false,
  executorConstraints: '',
};
const boundedText = (max: number) => z.string().refine((text) => Array.from(text).length <= max);
/** A local project is one path on one machine, so the scope names both. */
const BoardProjectRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local'),
    machineId: z.string().min(1),
    localProjectId: z.string().min(1),
    name: boundedText(200),
  }),
  z.object({ kind: z.literal('github'), repoFullName: z.string().min(1).max(200) }),
]);
export type BoardProjectRef =
  | { kind: 'local'; machineId: MachineId; localProjectId: LocalProjectId; name: string }
  | { kind: 'github'; repoFullName: string };
const BoardMetaSchema = z.object({
  version: z.literal(1),
  id: z.string().startsWith('bd_').min(4),
  name: boundedText(80).refine((text) => text.trim().length > 0),
  // Optional: a Board can start with only a name; the user speaks first.
  purpose: boundedText(4000).default(''),
  instructions: boundedText(MAX_BOARD_INSTRUCTIONS).default(''),
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
  /** The machine that keeps the Board's shared directory: the coordinator's at creation. */
  files: z
    .object({ machineId: z.string().min(1) })
    .strict()
    .optional(),
  /** The projects members may open sessions in; absent or empty means every project. */
  context: z.object({ projects: z.array(BoardProjectRefSchema).max(200).optional() }).optional(),
  /** When Lody tidies the coordinator's context; see `board-continuity.ts`. */
  continuity: BoardContinuitySettingsSchema.default(DEFAULT_BOARD_CONTINUITY),
  digestScheduleId: z.string().min(1).optional(),
  archivedAtMs: z.number().finite().nonnegative().optional(),
});
export type BoardMeta = Omit<
  z.infer<typeof BoardMetaSchema>,
  'id' | 'coordinatorSessionId' | 'files' | 'context'
> & {
  id: BoardId;
  coordinatorSessionId: SessionId;
  files?: { machineId: MachineId };
  context?: { projects?: BoardProjectRef[] };
};
export function normalizeBoardMeta(value: unknown): BoardMeta | null {
  const parsed = BoardMetaSchema.safeParse(value);
  return parsed.success ? (parsed.data as BoardMeta) : null;
}

/** The projects a Board is narrowed to, or undefined when it covers every project. */
export function boardProjectScope(
  board: Pick<BoardMeta, 'context'>
): readonly BoardProjectRef[] | undefined {
  const projects = board.context?.projects;
  return projects?.length ? projects : undefined;
}

/** Whether a session's project is one the scope names: the exact machine pair, or the repository. */
export function isProjectInBoardScope(
  scope: readonly BoardProjectRef[],
  project:
    | { kind: 'local'; machineId: string; localProjectId: string }
    | { kind: 'github'; repoFullName: string }
): boolean {
  return scope.some((entry) =>
    entry.kind === 'local'
      ? project.kind === 'local' &&
        entry.machineId === project.machineId &&
        entry.localProjectId === project.localProjectId
      : project.kind === 'github' &&
        entry.repoFullName.toLowerCase() === project.repoFullName.toLowerCase()
  );
}

/**
 * The machine of a Board's shared directory. Boards created before the
 * directory existed have no `files`: their coordinator's machine keeps it.
 */
export function boardFilesMachineId(
  board: Pick<BoardMeta, 'files'>,
  coordinator: Pick<SessionMeta, 'machineId'> | undefined
): MachineId | undefined {
  return board.files?.machineId ?? (coordinator?.machineId as MachineId | undefined);
}

export type BoardSessionStatus =
  | 'running'
  | 'initializing'
  | 'finalizing'
  | 'waiting_user'
  | 'failed'
  | 'waiting_coordinator'
  | 'idle'
  | 'stopped'
  | 'cancelled';
/** Presence owns activity; durable status is deliberately not an input. */
export function deriveBoardSessionStatus(input: {
  liveStatus?: SessionStatus | null;
  awaitingUserSince?: number;
  lastMessageAt?: number;
  lastUserTurn?: Pick<SessionHistoryInput, 'status' | 'author'>;
  chatFailed?: boolean;
  collaborationStopped?: boolean;
}): BoardSessionStatus {
  if (input.liveStatus?.type === 'initializing') return 'initializing';
  if (input.liveStatus?.type === 'running')
    return input.liveStatus.phase === 'finalizing' ? 'finalizing' : 'running';
  if (input.liveStatus?.type === 'requestPermission') return 'waiting_user';
  if (input.liveStatus == null && (input.awaitingUserSince ?? 0) > (input.lastMessageAt ?? 0))
    return 'waiting_user';
  if (input.collaborationStopped) return 'stopped';
  if (input.lastUserTurn?.status === 'canceled') return 'cancelled';
  if (input.lastUserTurn?.status === 'failed' || input.chatFailed) return 'failed';
  if (input.lastUserTurn && input.lastUserTurn.author?.kind !== 'human')
    return 'waiting_coordinator';
  return 'idle';
}

/** The last user input or system input that actually drives an agent turn. */
export function readLatestDrivingTurn<T extends Pick<SessionHistoryInput, 'role' | 'inputConfig'>>(
  history: readonly T[]
): T | undefined {
  for (let index = history.length - 1; index >= 0; index--) {
    const turn = history[index];
    if (
      turn &&
      (turn.role === 'user' ||
        (turn.role === 'system' && turn.inputConfig?.chainDepth !== undefined))
    )
      return turn;
  }
  return undefined;
}

export type BoardReportCursor = {
  lastTurnId?: string;
  lastAwaitingSince?: number;
  lastAwaitingTurnId?: string;
  lastNoticeId?: string;
};

export type BoardDrivingState = {
  turn: SessionHistoryInput;
  following: readonly SessionHistoryInput[];
};

/** Preview policy shared with ordinary Operation target results. */
export const assistantOutputPreview = (
  assistant: Pick<SessionHistoryInput, 'items'>
): LodyOperationOutputPreview | undefined => {
  const text = (assistant.items ?? [])
    .flatMap((item) => (item.type === 'text' && item.text.length > 0 ? [item.text] : []))
    .join('\n\n');
  return text ? boardOutputPreview(text) : undefined;
};

export const isTerminalAssistantEntry = (
  entry: Pick<SessionHistoryInput, 'role' | 'finished' | 'endedAt'>
): boolean =>
  entry.role === 'assistant' && (entry.finished === true || typeof entry.endedAt === 'number');

export function boardOutputPreview(text: string): LodyOperationOutputPreview {
  const encoder = new TextEncoder();
  const originalBytes = encoder.encode(text).byteLength;
  const maxBytes = 32 * 1024;
  if (originalBytes <= maxBytes) return { text };
  const characters = Array.from(text);
  const parts = (count: number) => {
    const head = Math.ceil(count * 0.25);
    const tail = count - head;
    return [
      characters.slice(0, head).join(''),
      characters.slice(characters.length - tail).join(''),
    ];
  };
  let low = 0;
  let high = characters.length;
  let kept = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (encoder.encode(parts(middle).join('\n…\n')).byteLength <= maxBytes) {
      kept = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  const [head, tail] = parts(kept);
  return {
    text: `${head}\n…\n${tail}`,
    truncated: true,
    omittedBytes: originalBytes - encoder.encode(`${head}${tail}`).byteLength,
  };
}

export function boardReportOperationId(
  event: Pick<BoardReportEvent, 'sessionId' | 'turnId' | 'kind' | 'awaitingUserSince' | 'noticeId'>
): string {
  return `board-${sha256Hex(
    JSON.stringify([
      event.sessionId,
      event.turnId,
      event.kind,
      event.awaitingUserSince,
      event.noticeId,
    ])
  ).slice(0, 58)}`;
}

/**
 * A Board's coordinator only assigns work: results of what it dispatched, and
 * Board reports, wait for its next human or scheduled input instead of waking it.
 */
export function boardDeliveryConfig(requester: Pick<SessionMeta, 'boardRole'>): {
  deliverWithNextInput?: true;
} {
  return requester.boardRole === 'coordinator' ? { deliverWithNextInput: true } : {};
}

/** A child reports its own blockers; its parent carries its successful conclusion upward. */
export function isBoardGrandchild(
  meta: SessionMeta,
  board: BoardMeta,
  members: ReadonlyMap<SessionId, SessionMeta>
): boolean {
  const opener = meta.openedBySessionId ?? meta.parentSessionId;
  return (
    !!opener && opener !== board.coordinatorSessionId && members.get(opener)?.boardId === board.id
  );
}

export function deriveBoardReports(input: {
  sessionId: SessionId;
  meta: SessionMeta;
  state?: BoardDrivingState;
  cursor: BoardReportCursor;
  reportHumanTurns: boolean;
  grandchild: boolean;
}): { events: BoardReportEvent[]; cursor: BoardReportCursor } {
  const { sessionId, meta, state, reportHumanTurns, grandchild } = input;
  const cursor = { ...input.cursor };
  const events: BoardReportEvent[] = [];
  if (!state) return { events, cursor };
  const { turn, following } = state;
  const scheduled = !!turn.inputConfig?._lodyScheduleId;
  const since = meta.boardJoinedAtMs ?? 0;
  const turnAt = Date.parse(turn.timestamp);
  const assistant = following.find((entry) => entry.role === 'assistant');
  const failed = following.find((entry) =>
    entry.items?.some((item) => item.type === 'system_notice' && item.name === 'chat_failed')
  );
  const base = {
    sessionId,
    turnId: turn.id,
    title: meta.title,
    machineId: meta.machineId,
    generation: meta.boardGeneration,
    contextWindowUsage: meta.contextWindowUsage,
    origin: scheduled ? ('schedule' as const) : (turn.author?.kind ?? ('system' as const)),
  };
  if (cursor.lastTurnId !== turn.id) {
    const terminal =
      turn.status === 'canceled' ||
      turn.status === 'failed' ||
      failed ||
      (assistant && isTerminalAssistantEntry(assistant));
    if (terminal) {
      cursor.lastTurnId = turn.id;
      const at = assistant?.endedAt ?? Date.parse((failed ?? assistant ?? turn).timestamp);
      if (turn.status !== 'canceled' && turn.cancellationReason !== 'user_stop' && at >= since) {
        if (turn.status === 'failed' || failed) {
          const failure = failed?.items?.find(
            (item) => item.type === 'system_notice' && item.name === 'chat_failed'
          );
          events.push({
            ...base,
            kind: 'failed',
            at,
            output: boardOutputPreview(failure?.meta?.message ?? 'Turn failed'),
          });
        } else if (
          (!grandchild || scheduled) &&
          (reportHumanTurns || scheduled || turn.author?.kind !== 'human')
        ) {
          events.push({
            ...base,
            kind: 'finished',
            at,
            output: assistant ? assistantOutputPreview(assistant) : undefined,
          });
        }
      }
    }
  }
  const awaiting = meta.awaitingUserSince;
  if (awaiting !== undefined && awaiting > turnAt && cursor.lastAwaitingTurnId !== turn.id) {
    cursor.lastAwaitingSince = awaiting;
    cursor.lastAwaitingTurnId = turn.id;
    if (
      awaiting >= since &&
      turn.status !== 'canceled' &&
      turn.status !== 'failed' &&
      !(assistant && isTerminalAssistantEntry(assistant))
    ) {
      const request = assistant?.items?.find(
        (item) =>
          item.type === 'tool_call' && item.permissionRequest && !item.permissionRequest.outcome
      );
      events.push({
        ...base,
        kind: 'waiting_user',
        at: awaiting,
        awaitingUserSince: awaiting,
        output:
          request?.type === 'tool_call'
            ? boardOutputPreview(request.title ?? 'Permission or answer requested')
            : undefined,
      });
    }
  }
  const notice = meta.agentNotice;
  if (notice && cursor.lastNoticeId !== notice.id) {
    cursor.lastNoticeId = notice.id;
    if (notice.at >= since && notice.kind !== 'config_change')
      events.push({
        ...base,
        kind: 'notice',
        at: notice.at,
        noticeId: notice.id,
        output: boardOutputPreview(notice.body),
      });
  }
  return { events, cursor };
}

export function isBoardSessionStopped(
  meta: SessionMeta,
  lookup: (id: SessionId) => SessionMeta | undefined
): boolean {
  const visited = new Set<SessionId>();
  let current: SessionMeta | undefined = meta;
  while (current && !visited.has(current.id)) {
    if (current.collaborationStopped) return true;
    visited.add(current.id);
    const parent: SessionId | undefined = current.parentSessionId ?? current.openedBySessionId;
    current = parent ? lookup(parent) : undefined;
  }
  return false;
}

/** Schedule destinations may be any member except the Board's main session. */
export const isScheduleBoardThread = (
  session: Pick<SessionMeta, 'id' | 'boardId'>,
  board: Pick<BoardMeta, 'id' | 'coordinatorSessionId'>
): boolean => session.boardId === board.id && session.id !== board.coordinatorSessionId;
