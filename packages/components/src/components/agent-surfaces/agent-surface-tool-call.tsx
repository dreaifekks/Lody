import { matchAgentSurfaceToolCall, type MessageContent } from '@lody/shared';
import { PlanReviewCard } from './plan-review-card';

type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;

/** The surface an experimental tool call renders as; see `isSurfaceToolCall`. */
export function AgentSurfaceToolCall({ toolCall }: { toolCall: ToolCallMessage }) {
  const match = matchAgentSurfaceToolCall(toolCall);
  if (match?.kind === 'review') {
    return <PlanReviewCard toolCallId={toolCall.toolCallId} input={match.input} />;
  }
  return null;
}
