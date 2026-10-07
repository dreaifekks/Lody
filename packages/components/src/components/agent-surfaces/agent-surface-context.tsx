import { createContext, useContext } from 'react';
import { atom } from 'jotai';
import { matchAgentSurfaceToolCall, type MessageContent, type SessionId } from '@lody/shared';
import { inlineWidgetFeatureEnabledAtom, planReviewFeatureEnabledAtom } from '@/atoms/settings';

type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;

/** Which experimental surfaces this device renders; a stable string for cache keys. */
export const agentSurfaceKeyAtom = atom((get): AgentSurfaceKey => {
  const review = get(planReviewFeatureEnabledAtom);
  const widget = get(inlineWidgetFeatureEnabledAtom);
  return review && widget ? 'review+widget' : review ? 'review' : widget ? 'widget' : '';
});

export type AgentSurfaceKey = '' | 'review' | 'widget' | 'review+widget';

export const surfaceKeyIncludes = (key: AgentSurfaceKey, kind: 'review' | 'widget'): boolean =>
  key.split('+').includes(kind);

/**
 * Whether a tool call renders as its own surface (a review card, a widget)
 * rather than a step: it then stands outside activity groups and never folds.
 */
export const isSurfaceToolCall = (key: AgentSurfaceKey, toolCall: ToolCallMessage): boolean => {
  // A call the server refused delivered nothing; it stays an ordinary step.
  if (!key || toolCall.status === 'failed') return false;
  const match = matchAgentSurfaceToolCall(toolCall);
  if (match === null || match.kind === 'notify' || !surfaceKeyIncludes(key, match.kind)) {
    return false;
  }
  // A finished call whose input history never kept (older records) has nothing
  // left to draw; only a running call waits for its input.
  return match.input !== null || toolCall.status !== 'completed';
};

/**
 * What a conversation lets its surfaces do. Absent on read-only presentation
 * (shares): cards still render, nothing acts.
 */
export type AgentSurfaceActions = {
  sessionId: SessionId;
  /** The viewer may answer: their own, unarchived conversation. */
  canAct: boolean;
  openPlanReview?: (toolCallId: string) => void;
  /** Puts text into the composer and focuses it; never sends. */
  fillComposer?: (text: string) => void;
};

export const AgentSurfaceContext = createContext<AgentSurfaceActions | null>(null);

export const useAgentSurfaceActions = (): AgentSurfaceActions | null =>
  useContext(AgentSurfaceContext);
