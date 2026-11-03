import type { SessionHistoryInput, SessionMeta, StoredLodyOperation } from '@lody/shared';
import { readChatFailureNotice } from '@lody/shared';
import {
  getOperationProgressTargetKey,
  type OperationProgressStatusByTarget,
} from '@lody/shared/session-data';
export { assistantOutputPreview, isTerminalAssistantEntry } from '@lody/shared';
const MAX_FAILURE_DETAIL_CHARS = 500;

/**
 * Explains a failed target from the durable `chat_failed` notice recorded after
 * its user turn. The reason and original message travel in the error message so
 * older readers of the strict Operation result schema keep working. Without a
 * notice the generic text stands; a cause is never guessed.
 */
export const targetFailureMessage = (output: readonly SessionHistoryInput[]): string => {
  const notice = readChatFailureNotice(output);
  if (!notice) return 'Target Turn failed.';
  const detail = notice.message
    ? `: ${Array.from(notice.message).slice(0, MAX_FAILURE_DETAIL_CHARS).join('')}`
    : '';
  return `Target Turn failed (${notice.reason ?? 'unknown'})${detail}`;
};

/** Bounds a handoff walk so a malformed steer ledger cannot loop reconciliation. */
export const MAX_STEER_HANDOFF_HOPS = 16;

/**
 * The steered input that took over an assistant turn's work. An applied steer
 * seals the running assistant turn and continues the same work under the steered
 * input, so a delegated target completes with that successor's final reply.
 */
export const findSteerSuccessor = (
  meta: Pick<SessionMeta, 'steerOperationLedger'>,
  assistantTurnId: string
): string | undefined =>
  Object.values(meta.steerOperationLedger ?? {}).find(
    (record) => record.expectedTurnId === assistantTurnId && record.delivery === 'applied'
  )?.userTurnId;

export function progressIsSettled(
  operation: StoredLodyOperation,
  row: SessionHistoryInput | undefined,
  observed: OperationProgressStatusByTarget
): boolean {
  const content = row?.items?.find((item) => item.type === 'operation_progress');
  const published = new Map(
    (content?.items ?? []).map((item) => [getOperationProgressTargetKey(item.target), item.status])
  );
  const expected = new Map(observed);
  for (const item of operation.items) {
    if (!('target' in item) || !item.target) continue;
    const key = getOperationProgressTargetKey(item.target);
    if (expected.has(key)) continue;
    if (
      item.status === 'succeeded' ||
      item.status === 'cancelled' ||
      (item.status === 'failed' && item.error.code === 'TARGET_FAILED')
    ) {
      if (item.status === 'succeeded' || published.has(key)) expected.set(key, item.status);
    } else if (item.status === 'active' && item.inputDurable) expected.set(key, 'created');
  }
  // Previously published targets stay owned even when metadata is temporarily absent.
  if (published.size !== expected.size) return false;
  return [...expected].every(
    ([key, status]) => status !== 'created' && status !== 'running' && published.get(key) === status
  );
}
