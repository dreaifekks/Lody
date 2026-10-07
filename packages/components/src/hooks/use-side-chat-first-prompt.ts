import { useEffect } from 'react';
import type { SessionId } from '@lody/shared';
import { takeSideChatFirstPrompt } from '@/lib/session-draft-tabs';
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
  const deliver = useStableCallback(() => {
    const text = takeSideChatFirstPrompt(sessionId);
    if (text === null) return;
    onSending?.(text);
    void send(text).then(
      (sent) => {
        if (!sent) fill(text);
      },
      () => fill(text)
    );
  });
  useEffect(() => {
    if (ready) deliver();
  }, [deliver, ready, sessionId]);
}
