import { useAtomValue } from 'jotai';
import { ClipboardCheck, PanelRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LodyRequestReviewInput } from '@lody/shared';
import { SessionRelationCard } from '@/components/shared/session-relation-card';
import { useAgentSurfaceActions } from './agent-surface-context';
import { planReviewIndexAtomFamily, type PlanReviewStatus } from './plan-review-model';

/** One line in the conversation; the plan itself opens in the side panel. */
export function PlanReviewCard({
  toolCallId,
  input,
}: {
  toolCallId: string;
  /** `null` while the agent is still writing the call. */
  input: LodyRequestReviewInput | null;
}) {
  const { t } = useTranslation();
  const actions = useAgentSurfaceActions();
  const index = useAtomValue(planReviewIndexAtomFamily(actions?.sessionId ?? ''));
  const status = index.byId.get(toolCallId)?.status ?? null;
  const openPlanReview = actions?.openPlanReview;

  return (
    <PlanReviewCardView
      title={input?.title ?? t('agentSurfaces.planReview.preparing', 'Preparing a plan…')}
      status={status}
      onOpen={input && openPlanReview ? () => openPlanReview(toolCallId) : undefined}
    />
  );
}

/** Presentational card, for the conversation and stories. */
export function PlanReviewCardView({
  title,
  status,
  onOpen,
}: {
  title: string;
  status: PlanReviewStatus | null;
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  const statusLabel = status ? planReviewStatusLabel(t, status) : null;
  return (
    <SessionRelationCard
      relation="plan-review"
      icon={ClipboardCheck}
      actionIcon={PanelRight}
      label={t('agentSurfaces.planReview.label', 'Plan')}
      sessionTitle={title}
      actionLabel={t('agentSurfaces.planReview.open', 'Open plan')}
      onAction={onOpen}
      status={
        statusLabel ? (
          <span role="status" data-plan-review-status={status} className="text-xs">
            {statusLabel}
          </span>
        ) : undefined
      }
    />
  );
}

export const planReviewStatusLabel = (
  t: ReturnType<typeof useTranslation>['t'],
  status: PlanReviewStatus
): string =>
  status === 'pending'
    ? t('agentSurfaces.planReview.status.pending', 'Awaiting review')
    : status === 'answered'
      ? t('agentSurfaces.planReview.status.answered', 'Answered')
      : t('agentSurfaces.planReview.status.superseded', 'Replaced by a newer plan');
