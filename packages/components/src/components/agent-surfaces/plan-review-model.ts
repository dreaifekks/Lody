import { atomFamily } from 'jotai/utils';
import { atom } from 'jotai';
import {
  matchAgentSurfaceToolCall,
  type LodyRequestReviewInput,
  type MessageContent,
  type SessionHistory,
} from '@lody/shared';

/**
 * Plan reviews (`lody_request_review`) of one session.
 *
 * The plan travels inside the tool call, so the transcript is the only record:
 * a review is answered once the user wrote anything after it, and a later
 * review replaces every earlier one.
 */

export type PlanReviewEntry = {
  toolCallId: string;
  turnId: string;
  input: LodyRequestReviewInput;
};

export type PlanReviewStatus = 'pending' | 'answered' | 'superseded';

/** What one turn contributes; derived once per turn object. */
export type PlanReviewTurnFact = {
  role: SessionHistory['role'];
  reviews: PlanReviewEntry[];
};

export const derivePlanReviewTurnFact = (turn: SessionHistory): PlanReviewTurnFact => {
  const items = Array.isArray(turn.items) ? (turn.items as unknown as MessageContent[]) : [];
  const reviews: PlanReviewEntry[] = [];
  if (turn.role === 'assistant') {
    for (const item of items) {
      if (item?.type !== 'tool_call') continue;
      const match = matchAgentSurfaceToolCall(item);
      if (match?.kind === 'review' && match.input) {
        reviews.push({ toolCallId: item.toolCallId, turnId: turn.id, input: match.input });
      }
    }
  }
  return { role: turn.role, reviews };
};

export type PlanReviewIndex = {
  byId: ReadonlyMap<string, PlanReviewEntry & { status: PlanReviewStatus }>;
  latestId: string | null;
};

export const EMPTY_PLAN_REVIEW_INDEX: PlanReviewIndex = { byId: new Map(), latestId: null };

/** Statuses from turn facts in conversation order. */
export const buildPlanReviewIndex = (facts: readonly PlanReviewTurnFact[]): PlanReviewIndex => {
  const ordered: PlanReviewEntry[] = [];
  let answeredThrough = -1;
  for (const fact of facts) {
    if (fact.role === 'user') answeredThrough = ordered.length;
    ordered.push(...fact.reviews);
  }
  if (ordered.length === 0) return EMPTY_PLAN_REVIEW_INDEX;
  const byId = new Map<string, PlanReviewEntry & { status: PlanReviewStatus }>();
  ordered.forEach((entry, index) => {
    const status: PlanReviewStatus =
      index < ordered.length - 1 ? 'superseded' : index < answeredThrough ? 'answered' : 'pending';
    byId.set(entry.toolCallId, { ...entry, status });
  });
  return { byId, latestId: ordered.at(-1)?.toolCallId ?? null };
};

/** Written by the conversation that owns the session; read by cards and the panel. */
export const planReviewIndexAtomFamily = atomFamily((_sessionId: string) =>
  atom<PlanReviewIndex>(EMPTY_PLAN_REVIEW_INDEX)
);

export type PlanReviewComment = {
  id: string;
  /** The passage the user selected. */
  quote: string;
  body: string;
};

export type PlanReviewDecision = 'approve' | 'request_changes';

const QUOTE_MAX_CHARS = 400;

const quoteBlock = (text: string): string => {
  const trimmed = text.trim().replace(/\n{3,}/g, '\n\n');
  const bounded =
    trimmed.length > QUOTE_MAX_CHARS ? `${trimmed.slice(0, QUOTE_MAX_CHARS - 1)}…` : trimmed;
  return bounded
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
};

/**
 * The user's next message: the decision first, then each commented passage
 * quoted with its comment, then the overall note. The lead sentences come
 * from the caller, in the user's language.
 */
export const buildPlanReviewDecisionMessage = ({
  lead,
  comments,
  note,
}: {
  lead: string;
  comments: readonly PlanReviewComment[];
  note?: string;
}): string => {
  const parts = [lead.trim()];
  for (const comment of comments) {
    const body = comment.body.trim();
    parts.push(body ? `${quoteBlock(comment.quote)}\n\n${body}` : quoteBlock(comment.quote));
  }
  const trimmedNote = note?.trim();
  if (trimmedNote) parts.push(trimmedNote);
  return parts.join('\n\n');
};
