/**
 * The user turn the composer's Continue action sent. It carries a short
 * continuation prompt for the agent, so the conversation shows a marker in its
 * place and the outline keeps it inside the round it continues.
 */
export function isContinueDeliveryTurn(entry: { role: string; inputConfig?: unknown }): boolean {
  return (
    entry.role === 'user' &&
    (entry.inputConfig as { _lodyDeliveryKind?: unknown } | undefined)?._lodyDeliveryKind ===
      'continue'
  );
}
