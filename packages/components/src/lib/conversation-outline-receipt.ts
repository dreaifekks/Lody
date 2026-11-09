import type { MessageContent, SessionId } from '@lody/shared';

/**
 * Receipt rounds in the conversation outline (fork).
 *
 * A coordinator is woken by its children's results without any user message:
 * the CLI writes each automatic Inbox batch as a system turn whose id is the
 * Inbox input id, `inbox:<executionId>` (`apps/cli/src/orchestration/inbox/sqlite.ts`
 * creates it, `session/session-execution-service.ts` writes the turn), and the
 * agent's reply follows it. Such a turn drives its round the way a user message
 * does. A batch delivered together with a human message is written as
 * `operation-batch:<batchId>` and stays inside that message's round.
 *
 * The id is the signal because every turn has it, hydrated or not: the round
 * count — and with it whether the rail shows at all — must not change as the
 * view hydrates and evicts turns.
 */
export const isReceiptRoundStart = (role: string, id: string): boolean =>
  role === 'system' && id.startsWith('inbox:');

/** A user message or an automatic receipt batch: the turns a round starts at. */
export const opensOutlineRound = (row: { readonly role: string; readonly id: string }): boolean =>
  row.role === 'user' || isReceiptRoundStart(row.role, row.id);

/** A session a receipt batch reports on, with the title the receipt itself carries. */
export type ReceiptRoundSource = {
  readonly sessionId: SessionId;
  readonly title?: string;
};

/**
 * The sessions a receipt batch reports on, in delivery order, once each.
 * A Board report carries its thread's title at report time; other results
 * carry only the caller's optional label, so the outline card reads the live
 * title by session id, as the receipt card does.
 */
export function receiptSourcesOf(items: readonly MessageContent[]): ReceiptRoundSource[] {
  const sources: ReceiptRoundSource[] = [];
  const seen = new Set<string>();
  const add = (sessionId: SessionId, title: string | undefined) => {
    if (seen.has(sessionId)) return;
    seen.add(sessionId);
    const trimmed = title?.trim();
    sources.push(trimmed ? { sessionId, title: trimmed } : { sessionId });
  };
  for (const item of items) {
    if (item.type !== 'operation_completion_batch') continue;
    for (const member of item.members ?? []) {
      const completion = member.completion;
      const result =
        completion.type === 'result'
          ? completion.value
          : completion.type === 'cancelled'
            ? completion.partial
            : undefined;
      for (const event of result?.boardReport?.events ?? []) add(event.sessionId, event.title);
      for (const entry of result?.items ?? []) {
        if (entry.target) add(entry.target.sessionId, entry.label);
      }
    }
  }
  return sources;
}

/** The titles a receipt carries, for places that cannot read live titles. */
export const receiptRoundTitle = (sources: readonly ReceiptRoundSource[]): string =>
  sources.flatMap((source) => (source.title ? [source.title] : [])).join(' · ');
