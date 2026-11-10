import {
  getMachineRoomId,
  getSessionRoomId,
  LodyOperationCompletionSchema,
  normalizeLanMachineAlias,
  type MachineId,
  type SessionId,
} from '@lody/shared';
import { buildSessionLink } from '@lody/shared/session-link';

/**
 * Fork lines of a receipt batch's header (`batchPreview`), kept out of the
 * upstream header so a sync touches one call. Every line is paid on every
 * batch, so each must earn its tokens.
 */

/** Results of a batch whose sessions ran on another machine, where their files are. */
export type ResultsElsewhere = { machine: string; sessionIds: readonly string[] };

/** The turn a batch is delivered in: the agent's reply to it. */
export type BatchTurn = {
  sessionId: string;
  turnId: string;
  elsewhere?: readonly ResultsElsewhere[];
};

export const batchPreviewForkLines = (turn: BatchTurn | undefined): string[] =>
  turn
    ? [
        // A coordinator woken by many batches refers back to earlier ones; the
        // desktop scrolls to a linked turn and highlights it.
        `To point the user back to this turn in a later reply, link it: [short label](${buildSessionLink(turn)}). Ids of other turns: lody_session_history.`,
        // A path from such a result opens on this machine unless it names its own.
        ...(turn.elsewhere ?? []).map(
          ({ machine, sessionIds }) =>
            `Results of ${sessionIds.join(', ')} ran on ${machine}: write their files as ${machine}:<absolute path>.`
        ),
      ]
    : [];

/** The sessions a batch member's results came from. */
const resultSessionIds = (completion: unknown): string[] => {
  const parsed = LodyOperationCompletionSchema.safeParse(completion);
  if (!parsed.success) return [];
  const result =
    parsed.data.type === 'result'
      ? parsed.data.value
      : parsed.data.type === 'cancelled'
        ? parsed.data.partial
        : undefined;
  return [
    ...(result?.items ?? []).flatMap((item) => (item.target ? [item.target.sessionId] : [])),
    ...(result?.boardReport?.events ?? []).map((event) => event.sessionId),
  ];
};

/** A name a `<machine>:<path>` link can carry: the desktop reads it up to the colon. */
const LINKABLE_MACHINE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]+$/u;

/** What the workspace document says of a room, as `LoroRepo.getDocMeta` answers. */
type ReadMeta = (roomId: string) => Promise<{ readonly meta?: unknown } | null | undefined>;

const fieldOf = (meta: unknown, key: string): unknown =>
  meta && typeof meta === 'object' ? (meta as Record<string, unknown>)[key] : undefined;

/**
 * The sessions of a batch's results that ran on another machine than `here`,
 * by machine. Each machine goes by the first of its names a link can carry:
 * the name its LAN gave it, its own name, else its id.
 */
export async function findResultsElsewhere(
  members: readonly { completion: unknown }[],
  here: string,
  readMeta: ReadMeta
): Promise<ResultsElsewhere[]> {
  const byMachine = new Map<string, string[]>();
  for (const sessionId of new Set(
    members.flatMap((member) => resultSessionIds(member.completion))
  )) {
    const machineId = fieldOf(
      (await readMeta(getSessionRoomId(sessionId as SessionId)))?.meta,
      'machineId'
    );
    if (typeof machineId !== 'string' || machineId === here) continue;
    byMachine.set(machineId, [...(byMachine.get(machineId) ?? []), sessionId]);
  }
  const found: ResultsElsewhere[] = [];
  for (const [machineId, sessionIds] of byMachine) {
    const meta = (await readMeta(getMachineRoomId(machineId as MachineId)))?.meta;
    const machine =
      [normalizeLanMachineAlias(fieldOf(meta, 'lanAlias')), fieldOf(meta, 'name')].find(
        (name): name is string => typeof name === 'string' && LINKABLE_MACHINE_NAME.test(name)
      ) ?? machineId;
    found.push({ machine, sessionIds });
  }
  return found;
}
