import { getBuiltinAgentByAgentType, type BuiltinAgentType } from '@lody/shared';
import { USAGE_AGENT_CODEX_AUTO_REVIEW, USAGE_AGENT_UNKNOWN } from '@/lib/lan-usage';
import type { StackedAreaBucket } from './usage-stacked-area-chart';
import type { SettingsUsageTimelineData } from './settings-data-cache';

type Translate = (key: string) => string;

/** What the usage page calls an agent of its agent split. */
export function usageAgentLabel(agentId: string, t: Translate): string {
  if (agentId === USAGE_AGENT_UNKNOWN) return t('workspace.usage.agent.unknown');
  if (agentId === USAGE_AGENT_CODEX_AUTO_REVIEW) return t('workspace.usage.agent.codexAutoReview');
  return getBuiltinAgentByAgentType(agentId)?.displayName ?? agentId;
}

/**
 * The agent split of a timeline as the stacked chart draws it: its legend and
 * tooltip name each agent the way the rest of the page does.
 */
export function usageAgentBuckets(
  timeline: SettingsUsageTimelineData,
  bucketLabel: (bucket: SettingsUsageTimelineData['buckets'][number]) => string,
  t: Translate
): StackedAreaBucket[] {
  return timeline.buckets.map((bucket) => ({
    label: bucketLabel(bucket),
    values: (bucket.byAgent ?? []).map((item) => ({
      id: item.agentId,
      label: usageAgentLabel(item.agentId, t),
      value: item.tokens,
    })),
  }));
}

/** The builtin agent whose icon stands for a usage agent; `null` where none does. */
export function usageAgentIconType(agentId: string): BuiltinAgentType | null {
  if (agentId === USAGE_AGENT_CODEX_AUTO_REVIEW) return 'codex';
  return getBuiltinAgentByAgentType(agentId)?.agentType ?? null;
}
