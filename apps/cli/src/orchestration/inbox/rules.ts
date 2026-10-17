import type {
  LodyOperationCompletion,
  LodyOperationItemTarget,
  LodyOperationOutputPreview,
} from '@lody/shared';
import type { InboxBatch, InboxInput } from './model';

export type SessionFenceState = {
  revision: number;
  paused: number;
  blocked: number;
  active_execution: string | null;
  active_input: string | null;
};
export const inputAcceptance = (
  kind: InboxInput['kind'],
  paused: boolean,
  previousCanceled?: boolean
): 'accept' | 'duplicate' | 'reject' =>
  previousCanceled !== undefined
    ? previousCanceled
      ? 'reject'
      : 'duplicate'
    : kind === 'task' && paused
      ? 'reject'
      : 'accept';

export const canFenceBatch = (
  state: SessionFenceState,
  batch: InboxBatch,
  id: string,
  currentOwner: boolean,
  inputCanceled: boolean,
  count: number
): boolean =>
  currentOwner &&
  !state.paused &&
  !state.blocked &&
  (batch.kind === 'automatic' ? state.revision === batch.revision : !inputCanceled) &&
  state.active_input === batch.inputId &&
  state.active_execution === id &&
  count > 0 &&
  count === batch.memberCount;

/** Preserve queryable cancellation, but user Stop is not an Agent continuation. */
export const operationInboxCompletion = (
  completion: LodyOperationCompletion
): LodyOperationCompletion | undefined => {
  if (completion.type !== 'result') return completion;
  const items = completion.value.items.filter(
    (item) => item.status !== 'cancelled' || item.cancellationReason !== 'user_stop'
  );
  if (items.length === completion.value.items.length) return completion;
  return items.length ? { ...completion, value: { ...completion.value, items } } : undefined;
};

/** Apply the Stop records captured inside the final completion transaction. */
export const cancelManuallyStoppedTargets = (
  completion: LodyOperationCompletion,
  stopped: readonly LodyOperationItemTarget[]
): LodyOperationCompletion => {
  if (completion.type !== 'result' || stopped.length === 0) return completion;
  return {
    ...completion,
    value: {
      ...completion.value,
      items: completion.value.items.map((item) =>
        item.target &&
        stopped.some(
          (target) =>
            target.sessionId === item.target?.sessionId &&
            target.userTurnId === item.target?.userTurnId
        )
          ? {
              status: 'cancelled',
              cancellationReason: 'user_stop',
              target: item.target,
              ...(item.label ? { label: item.label } : {}),
            }
          : item
      ),
    },
  };
};

/** Characters an output keeps in a result that waits for the next input. */
export const INBOX_DIGEST_OUTPUT_CHARS = 1000;

const digestOutput = (output: LodyOperationOutputPreview): LodyOperationOutputPreview => {
  const characters = Array.from(output.text);
  if (characters.length <= INBOX_DIGEST_OUTPUT_CHARS) return output;
  const head = characters.slice(0, Math.ceil(INBOX_DIGEST_OUTPUT_CHARS * 0.25)).join('');
  const tail = characters.slice(characters.length - Math.floor(INBOX_DIGEST_OUTPUT_CHARS * 0.75));
  const kept = `${head}${tail.join('')}`;
  return {
    text: `${head}\n…\n${tail.join('')}`,
    truncated: true,
    omittedBytes:
      (output.omittedBytes ?? 0) +
      Buffer.byteLength(output.text, 'utf8') -
      Buffer.byteLength(kept, 'utf8'),
  };
};

/**
 * A passive result is a digest: it rides along with the requester's next input,
 * possibly with many others, so each output keeps its head and tail only. The
 * Operation itself keeps the complete preview.
 */
export const digestCompletion = (completion: LodyOperationCompletion): LodyOperationCompletion => {
  const digest = (
    value: Extract<LodyOperationCompletion, { type: 'result' }>['value']
  ): Extract<LodyOperationCompletion, { type: 'result' }>['value'] => ({
    ...value,
    items: value.items.map((item) =>
      item.status === 'succeeded' && item.output
        ? { ...item, output: digestOutput(item.output) }
        : item
    ),
    ...(value.boardReport
      ? {
          boardReport: {
            ...value.boardReport,
            events: value.boardReport.events.map((event) =>
              event.output ? { ...event, output: digestOutput(event.output) } : event
            ),
          },
        }
      : {}),
  });
  if (completion.type === 'result') return { ...completion, value: digest(completion.value) };
  if (completion.type === 'cancelled' && completion.partial)
    return { ...completion, partial: digest(completion.partial) };
  return completion;
};
