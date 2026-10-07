import { useAtomValue } from 'jotai';
import { getSessionRoomId, type SessionId } from '@lody/shared';
import { userAtom } from '@/atoms';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { PlanReviewPanel } from './plan-review-panel';
import type { PlanReviewDecision } from './plan-review-model';

/**
 * The side panel's plan review for one session. Buttons only for the
 * session's own, unarchived conversation: a teammate's session or an archived
 * one shows the plan read-only.
 */
export function SessionPlanReviewPanel({
  sessionId,
  toolCallId,
  onSubmit,
}: {
  sessionId: SessionId;
  toolCallId: string;
  onSubmit: (decision: PlanReviewDecision, text: string) => Promise<boolean>;
}) {
  const session = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(sessionId)));
  const user = useAtomValue(userAtom);
  const canAct = Boolean(user?.id) && session?.userId === user?.id && session?.isArchived !== true;
  return (
    <PlanReviewPanel
      sessionId={sessionId}
      toolCallId={toolCallId}
      canAct={canAct}
      onSubmit={onSubmit}
    />
  );
}
