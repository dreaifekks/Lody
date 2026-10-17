import { getBuiltinAgentByAgentType, type BuiltinAgentType } from '@lody/shared';
import { USAGE_AGENT_CODEX_AUTO_REVIEW, USAGE_AGENT_UNKNOWN } from '@/lib/lan-usage';

type Translate = (key: string) => string;

/** What the usage page calls an agent of its agent split. */
export function usageAgentLabel(agentId: string, t: Translate): string {
  if (agentId === USAGE_AGENT_UNKNOWN) return t('workspace.usage.agent.unknown');
  if (agentId === USAGE_AGENT_CODEX_AUTO_REVIEW) return t('workspace.usage.agent.codexAutoReview');
  return getBuiltinAgentByAgentType(agentId)?.displayName ?? agentId;
}

/** The builtin agent whose icon stands for a usage agent; `null` where none does. */
export function usageAgentIconType(agentId: string): BuiltinAgentType | null {
  if (agentId === USAGE_AGENT_CODEX_AUTO_REVIEW) return 'codex';
  return getBuiltinAgentByAgentType(agentId)?.agentType ?? null;
}
