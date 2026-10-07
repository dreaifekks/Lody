import { useEffect, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { planReviewFeatureEnabledAtom } from '@/atoms/settings';
import { useConversationDerivation, useConversationIndexRows } from '@/hooks/use-conversation-view';
import type { ConversationView, TurnIndexRow } from '@/lib/conversation-view';
import {
  EMPTY_PLAN_REVIEW_INDEX,
  buildPlanReviewIndex,
  derivePlanReviewTurnFact,
  planReviewIndexAtomFamily,
  type PlanReviewTurnFact,
} from './plan-review-model';

/**
 * Keeps a session's plan-review index current from its whole conversation,
 * not only the hydrated turns: a review is answered by ANY later user turn.
 * Mounted by the conversation that owns the session; idle while the
 * experiment is off.
 */
export function usePlanReviewIndexPublisher(
  sessionId: string,
  view: ConversationView | null | undefined
): void {
  const enabled = useAtomValue(planReviewFeatureEnabledAtom);
  const activeView = enabled ? view : null;
  const rows = useConversationIndexRows(activeView);
  const { facts, version } = useConversationDerivation(activeView, derivePlanReviewTurnFact);
  const setIndex = useSetAtom(planReviewIndexAtomFamily(sessionId));

  const index = useMemo(() => {
    if (!activeView || facts.size === 0) return EMPTY_PLAN_REVIEW_INDEX;
    const ordered: PlanReviewTurnFact[] = [];
    for (const row of rows as readonly TurnIndexRow[]) {
      const fact = facts.get(row.id);
      if (fact) ordered.push(fact);
    }
    return buildPlanReviewIndex(ordered);
    // `version` is the change signal for the fact table.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, facts, rows, version]);

  useEffect(() => {
    setIndex(index);
  }, [index, setIndex]);
}
