/**
 * How the latest round ended when it can simply be picked up again:
 * - `stopped`: the user pressed Stop;
 * - `restart`: the daemon shut down mid-turn (restart or self-update);
 * - `disconnected`: the agent process went away mid-turn.
 */
export type ContinuableInterruption = 'stopped' | 'restart' | 'disconnected';

export const CONTINUE_PROMPT = 'Continue.';

export const INTERRUPTED_CONTINUE_PROMPT =
  'Continue from where you left off. The previous turn was cut off before it finished; check the current state before repeating anything that may already have been done.';

type ContinueHistoryEntry = {
  id: string;
  role: string;
  status?: string;
  items?: readonly ({ type: string; name?: string; meta?: unknown } | null | undefined)[];
};

/**
 * Reads the round after the latest user turn. Any other failure, or a round
 * that finished, is not an interruption: continuing there would only repeat it.
 */
export function findContinuableInterruption(
  history: readonly ContinueHistoryEntry[] | null | undefined
): ContinuableInterruption | null {
  if (!history) return null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (!entry) continue;
    if (entry.role === 'user') return entry.status === 'canceled' ? 'stopped' : null;
    for (const item of entry.items ?? []) {
      if (item?.type !== 'system_notice' || item.name !== 'chat_failed') continue;
      const reason = (item.meta as { reason?: unknown } | undefined)?.reason;
      if (reason === 'daemon_restart') return 'restart';
      if (reason === 'agent_disconnected') return 'disconnected';
      if (reason === 'acp_request_cancelled') return 'stopped';
      return null;
    }
  }
  return null;
}
