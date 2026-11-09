import type {
  LodyError,
  SessionHistoryInput,
  SessionMeta,
  StoredLodyOperation,
} from '@lody/shared';
import { describeChatFailure, readChatFailureNotice } from '@lody/shared';
import {
  getOperationProgressTargetKey,
  type OperationProgressStatusByTarget,
} from '@lody/shared/session-data';
export { assistantOutputPreview, isTerminalAssistantEntry } from '@lody/shared';
const failureReferenceMs = (output: readonly SessionHistoryInput[], fallbackMs: number): number => {
  const notice = readChatFailureNotice(output);
  if (!notice) return fallbackMs;
  const parsed = notice.at ? Date.parse(notice.at) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  // The notice normally carries its own timestamp. A malformed one degrades to
  // the coordinator clock, never a clock read inside this native model.
  for (let index = output.length - 1; index >= 0; index -= 1) {
    const turnAt = Date.parse(output[index]?.timestamp ?? '');
    if (Number.isFinite(turnAt)) return turnAt;
  }
  return fallbackMs;
};

/**
 * Explains a failed target from the durable `chat_failed` notice recorded after
 * its user turn. The reason and redacted provider text remain in the message for
 * plain-text consumers; readers that validate the strict Operation schema get
 * the normalized cause and quota reset as structured fields. Without a notice
 * the generic text stands; a cause is never guessed.
 */
export const targetFailureError = (
  output: readonly SessionHistoryInput[],
  assistantTurnId?: string,
  referenceMs = 0
): LodyError => {
  const notice = readChatFailureNotice(output);
  if (!notice)
    return {
      code: 'TARGET_FAILED',
      message: 'Target Turn failed.',
      retryable: false,
      reason: 'unknown',
    };
  const failure = describeChatFailure(notice, failureReferenceMs(output, referenceMs));
  const detail = failure.detail ? `: ${failure.detail}` : '';
  return {
    code: 'TARGET_FAILED',
    message: `Target Turn failed (${notice.reason ?? 'unknown'})${detail}`,
    retryable: failure.retryable,
    reason: failure.reason,
    ...(failure.detail ? { detail: failure.detail } : {}),
    ...(failure.resetAt ? { resetAt: failure.resetAt } : {}),
    ...(assistantTurnId ? { assistantTurnId } : {}),
  };
};

export const targetFailureMessage = (
  output: readonly SessionHistoryInput[],
  referenceMs = 0
): string => targetFailureError(output, undefined, referenceMs).message;

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
