import { Fragment } from 'react';
import type { ReceiptRoundSource } from '@/lib/conversation-outline-receipt';
import { useOperationTargetTitle } from './created-session-operation-card';

/**
 * Fork: the outline card's title for a round a receipt batch started — the
 * reporting sessions' live titles, as the receipt card shows them. Only the
 * hovered round mounts this, so it subscribes to a few titles at a time.
 */
export function ConversationOutlineReceiptTitle({
  sources,
}: {
  sources: readonly ReceiptRoundSource[];
}) {
  return sources.map((source, index) => (
    <Fragment key={source.sessionId}>
      {index > 0 ? ' · ' : null}
      <ReceiptSessionTitle source={source} />
    </Fragment>
  ));
}

function ReceiptSessionTitle({ source }: { source: ReceiptRoundSource }) {
  return useOperationTargetTitle(source.sessionId, source.title);
}
