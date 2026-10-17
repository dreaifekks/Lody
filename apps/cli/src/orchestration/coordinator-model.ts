import type { SessionHistoryInput, StoredLodyOperation } from '@lody/shared';
import {
  getOperationProgressTargetKey,
  type OperationProgressStatusByTarget,
} from '@lody/shared/session-data';
export { assistantOutputPreview, isTerminalAssistantEntry } from '@lody/shared';
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
