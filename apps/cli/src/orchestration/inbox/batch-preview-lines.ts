import { buildSessionLink } from '@lody/shared/session-link';

/**
 * Fork lines of a receipt batch's header (`batchPreview`), kept out of the
 * upstream header so a sync touches one call. Every line is paid on every
 * batch, so each must earn its tokens.
 */

/** The turn a batch is delivered in: the agent's reply to it. */
export type BatchTurn = { sessionId: string; turnId: string };

export const batchPreviewForkLines = (turn: BatchTurn | undefined): string[] =>
  turn
    ? [
        // A coordinator woken by many batches refers back to earlier ones; the
        // desktop scrolls to a linked turn and highlights it.
        `To point the user back to this turn in a later reply, link it: [short label](${buildSessionLink(turn)}). Ids of other turns: lody_session_history.`,
      ]
    : [];
