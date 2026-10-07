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

/** A question the user clicked in a widget. */
export type WidgetPromptRequest = {
  text: string;
  /** The widget's turn when a fork can start there, else null. */
  turnId: string | null;
  /** The same widget and question, wherever it is drawn; see `widgetPromptKey`. */
  key: string;
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
  /** Asks a widget's question; see `routeWidgetPrompt`. */
  sendWidgetPrompt?: (request: WidgetPromptRequest) => void;
};

export const AgentSurfaceContext = createContext<AgentSurfaceActions | null>(null);

/**
 * The assistant turn a surface is drawn in, when a fork can start there:
 * finished, and either the latest or carrying the agent's own turn id.
 */
export const AgentSurfaceTurnContext = createContext<string | null>(null);

export type WidgetPromptRoute =
  | { kind: 'send' }
  | { kind: 'side-chat'; turnId: string }
  | { kind: 'fill' };

/**
 * Where a widget's question goes. A side chat asks it itself; a conversation
 * that can fork asks it in a side chat forked at the widget's turn (the latest
 * finished turn when the widget's cannot be forked); anything else only puts
 * it in the composer.
 */
export const routeWidgetPrompt = (input: {
  inSideChat: boolean;
  canAskInSideChat: boolean;
  widgetTurnId: string | null;
  latestTurnId: string | null;
}): WidgetPromptRoute => {
  if (input.inSideChat) return { kind: 'send' };
  const turnId = input.widgetTurnId ?? input.latestTurnId;
  return input.canAskInSideChat && turnId ? { kind: 'side-chat', turnId } : { kind: 'fill' };
};

/** Names a widget by its code and the question asked, compactly (cyrb53). */
export const widgetPromptKey = (code: string, text: string): string => {
  const input = `${code}\u0000${text}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < input.length; index += 1) {
    const char = input.charCodeAt(index);
    h1 = Math.imul(h1 ^ char, 2654435761);
    h2 = Math.imul(h2 ^ char, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};

export const useAgentSurfaceActions = (): AgentSurfaceActions | null =>
  useContext(AgentSurfaceContext);

const SIDE_CHAT_TITLE_MAX_CHARS = 60;

/** A widget's side chat is named by its question, so its tab tells it apart. */
export const widgetSideChatTitle = (text: string): string => {
  const title = text.replace(/\s+/g, ' ').trim();
  return title.length > SIDE_CHAT_TITLE_MAX_CHARS
    ? `${title.slice(0, SIDE_CHAT_TITLE_MAX_CHARS - 1).trimEnd()}…`
    : title;
};

/**
 * Widget questions asked while a fork of the same conversation is under way:
 * a conversation forks one at a time, so each waits its turn and then gets its
 * own side chat, in the order asked. A question already waiting, or the one
 * being forked, is not held twice. Questions belong to the conversation page
 * (`scopeId`) they were asked on and are released only there: leaving that
 * page is not the end of its fork.
 */
export function createWidgetQuestionQueue<T extends { request: { key: string } }>() {
  const waiting = new Map<string, Map<string, T[]>>();
  return {
    hold: (scopeId: string, sourceId: string, item: T, forkingKey: string | undefined): void => {
      const scope = waiting.get(scopeId) ?? new Map<string, T[]>();
      const queue = scope.get(sourceId) ?? [];
      const key = item.request.key;
      if (key === forkingKey || queue.some((held) => held.request.key === key)) return;
      scope.set(sourceId, [...queue, item]);
      waiting.set(scopeId, scope);
    },
    /** On `scopeId`'s page, the next question of each conversation no longer forking. */
    release: (scopeId: string, isForking: (sourceId: string) => boolean): T[] => {
      const scope = waiting.get(scopeId);
      if (!scope) return [];
      const released: T[] = [];
      for (const [sourceId, queue] of scope) {
        if (isForking(sourceId)) continue;
        const [next, ...rest] = queue;
        if (next) released.push(next);
        if (rest.length > 0) scope.set(sourceId, rest);
        else scope.delete(sourceId);
      }
      if (scope.size === 0) waiting.delete(scopeId);
      return released;
    },
  };
}
