import { useEffect } from 'react';
import type { SessionId } from '@lody/shared';
import { claimSideChatFirstPrompt } from '@/lib/side-chat-opening';
import { useStableCallback } from './use-stable-callback';

/**
 * Sends the question a side chat was opened to ask (`saveSideChatFirstPrompt`)
 * once its forked history has arrived. A question that cannot be sent goes
 * into the composer instead of being dropped.
 */
export function useSideChatFirstPrompt({
  sessionId,
  ready,
  send,
  fill,
  onSending,
}: {
  sessionId: SessionId;
  /** The side chat's history is loaded and it accepts messages. */
  ready: boolean;
  send: (text: string) => Promise<boolean>;
  fill: (text: string) => void;
  onSending?: (text: string) => void;
}): void {
  const deliver = useStableCallback(async () => {
    const text = await claimSideChatFirstPrompt(sessionId);
    if (text === null) return;
    onSending?.(text);
    const sent = await send(text).catch(() => false);
    if (!sent) fill(text);
  });
  useEffect(() => {
    if (ready) void deliver();
  }, [deliver, ready, sessionId]);
}
