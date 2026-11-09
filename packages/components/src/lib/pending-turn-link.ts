import { atom } from 'jotai';

/** Fork: one turn of a conversation, named by a `?turn=` link (`turn-links.tsx`). */
export type TurnLinkTarget = { readonly sessionId: string; readonly turnId: string };

/**
 * A turn link that opened another conversation, from a chip or a deep link.
 * That conversation's view takes it once shown.
 */
export const pendingTurnLinkAtom = atom<TurnLinkTarget | null>(null);
