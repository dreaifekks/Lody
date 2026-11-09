'use client';

/**
 * Fork: links to one turn of a conversation (`lody://session/<id>?turn=<turnId>`).
 *
 * A link into the conversation on screen scrolls to that turn and flashes it;
 * a link into another conversation opens it first and scrolls once it shows.
 * Before each jump inside a conversation the reading position is kept, and the
 * scroll-to-latest button unwinds those jumps, newest first, before it goes to
 * the end. Reaching the end, sending and leaving the conversation forget them.
 * `view.tsx` only wires this in.
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAtomValue, useStore } from 'jotai';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { colors } from '@lody/ui/tokens/colors.stylex';
import type { SessionId } from '@lody/shared';
import type { SessionLink } from '@lody/shared/session-link';
import { useStableCallback } from '@/hooks/use-stable-callback';
import type { ReadingPosition } from '@/lib/conversation-scroll/types';
import { pendingTurnLinkAtom, type TurnLinkTarget } from '@/lib/pending-turn-link';
import { toast } from '@/lib/toast';
import type { ConversationListHandle } from './conversation-list/types';
import { useSessionLinkNavigator } from './session-link-context';

type TurnLinkScope = { readonly sessionId: string; readonly open: (turnId: string) => void };
const TurnLinkScopeContext = createContext<TurnLinkScope | null>(null);

type TurnHighlight = {
  readonly turnId: string;
  readonly startedAt: number;
  readonly done: () => void;
};
const TurnHighlightContext = createContext<TurnHighlight | null>(null);

/**
 * What clicking a session link does, or null where it cannot act. A turn of
 * the conversation on screen needs no navigation, so it works even where
 * session navigation is unavailable.
 */
export function useSessionLinkAction(target: SessionLink): (() => void) | null {
  const navigate = useSessionLinkNavigator();
  const scope = useContext(TurnLinkScopeContext);
  const store = useStore();
  const { turnId, ...session } = target;
  const sessionId = session.tabSessionId ?? session.sessionId;
  if (turnId && scope?.sessionId === sessionId) return () => scope.open(turnId);
  if (!navigate) return null;
  return () => {
    store.set(pendingTurnLinkAtom, turnId ? { sessionId, turnId } : null);
    navigate({
      ...session,
      sessionId: session.sessionId as SessionId,
      tabSessionId: session.tabSessionId as SessionId | undefined,
    });
  };
}

const NO_RETURNS: readonly ReadingPosition[] = [];

const RECEIPT_REPLY = /^assistant:(inbox:.+)$/u;

/**
 * The row a jump puts at the top. A receipt's reply (`assistant:inbox:…`, what
 * a receipt batch links to) lands with its receipt card above it, where the
 * outline lands that round: the reply's first line clears the top fade and the
 * rail marks the round. Without the card's row, the reply itself.
 */
function landingRow(rows: readonly { readonly turnId: string }[], turnId: string, row: number) {
  const card = RECEIPT_REPLY.exec(turnId)?.[1];
  const cardRow = card ? rows.findIndex((candidate) => candidate.turnId === card) : -1;
  return cardRow === -1 ? row : cardRow;
}

type Returns = { readonly sessionId: string; readonly stack: readonly ReadingPosition[] };

/** The view's half: jumps, the flash and the way back. */
export function useTurnLinkNavigation({
  sessionId,
  listRef,
  rows,
  scrollRowToTop,
  scrollToBottom,
  revealed,
  isVisible,
  isSticky,
  latestSendId,
}: {
  sessionId: string;
  listRef: { readonly current: ConversationListHandle | null };
  /** The conversation's rows, by the turn each one draws. */
  rows: readonly { readonly turnId: string }[];
  scrollRowToTop: (rowIndex: number, smooth: boolean) => void;
  scrollToBottom: () => void;
  /** The list has restored its first position; a jump before that is overwritten. */
  revealed: boolean;
  /** Hosts keep a conversation mounted behind another tab; hidden, it is left. */
  isVisible: boolean;
  isSticky: boolean;
  /** The newest message this reader is sending. */
  latestSendId: string | undefined;
}) {
  const { t } = useTranslation();
  const store = useStore();
  // Keyed by conversation, so a switch starts with nothing to go back to.
  const [returns, setReturns] = useState<Returns>(() => ({ sessionId, stack: NO_RETURNS }));
  const [highlight, setHighlight] = useState<(TurnLinkTarget & { startedAt: number }) | null>(null);
  const stack = returns.sessionId === sessionId ? returns.stack : NO_RETURNS;

  const open = useStableCallback((turnId: string, fromHere: boolean) => {
    // A turn's first row; a turn not yet loaded is one placeholder row.
    const row = rows.findIndex((candidate) => candidate.turnId === turnId);
    if (row === -1) {
      toast(t('sessions.turnLink.missing', 'That turn is no longer in this conversation.'));
      return;
    }
    const position = listRef.current?.readingPosition();
    if (fromHere && position) setReturns({ sessionId, stack: [...stack, position] });
    scrollRowToTop(landingRow(rows, turnId, row), true);
    setHighlight({ sessionId, turnId, startedAt: performance.now() });
  });

  const forget = useStableCallback(() =>
    setReturns((current) =>
      current.stack.length === 0 ? current : { sessionId, stack: NO_RETURNS }
    )
  );
  // Following the end again (scrolled there, or a sent message took it) ends
  // the excursion, as does leaving for another tab; so does a send that
  // leaves the reader where they are.
  useEffect(() => {
    if (isSticky || !isVisible) forget();
  }, [forget, isSticky, isVisible]);
  useEffect(() => {
    if (latestSendId !== undefined) forget();
  }, [forget, latestSendId]);

  const pending = useAtomValue(pendingTurnLinkAtom);
  useEffect(() => {
    if (!revealed || !isVisible || pending?.sessionId !== sessionId) return;
    store.set(pendingTurnLinkAtom, null);
    open(pending.turnId, false);
  }, [isVisible, open, pending, revealed, sessionId, store]);

  const goBackOrToLatest = useStableCallback(() => {
    const position = stack.at(-1);
    if (!position) {
      scrollToBottom();
      return;
    }
    setReturns({ sessionId, stack: stack.slice(0, -1) });
    listRef.current?.restoreReadingPosition(position, { smooth: true });
  });

  const scope = useMemo<TurnLinkScope>(
    () => ({ sessionId, open: (turnId) => open(turnId, true) }),
    [open, sessionId]
  );
  const flash = useMemo<TurnHighlight | null>(
    () =>
      highlight?.sessionId === sessionId
        ? {
            turnId: highlight.turnId,
            startedAt: highlight.startedAt,
            done: () => setHighlight((current) => (current === highlight ? null : current)),
          }
        : null,
    [highlight, sessionId]
  );
  return { scope, flash, canGoBack: stack.length > 0, goBackOrToLatest };
}

export function TurnLinkProvider({
  value,
  children,
}: {
  value: ReturnType<typeof useTurnLinkNavigation>;
  children: ReactNode;
}) {
  return (
    <TurnLinkScopeContext.Provider value={value.scope}>
      <TurnHighlightContext.Provider value={value.flash}>{children}</TurnHighlightContext.Provider>
    </TurnLinkScopeContext.Provider>
  );
}

const HIGHLIGHT_MS = 2400;

const flashIn = stylex.keyframes({
  '0%': { opacity: 0 },
  '10%': { opacity: 1 },
  '55%': { opacity: 1 },
  '100%': { opacity: 0 },
});

const styles = stylex.create({
  flash: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    backgroundColor: `color-mix(in oklab, ${colors.accent} 14%, transparent)`,
    opacity: 0,
    animationName: flashIn,
    animationDuration: `${HIGHLIGHT_MS}ms`,
    animationTimingFunction: 'ease-out',
  },
  delay: (ms: number) => ({ animationDelay: `${ms}ms` }),
});

/** Drawn in every conversation row; only the linked turn's rows flash. */
export function TurnLinkHighlight({ turnId }: { turnId: string | undefined }) {
  const highlight = useContext(TurnHighlightContext);
  if (!highlight || highlight.turnId !== turnId) return null;
  return <TurnLinkFlash key={highlight.startedAt} highlight={highlight} />;
}

function TurnLinkFlash({ highlight }: { highlight: TurnHighlight }) {
  // A long turn's rows mount while the jump glides and placeholders hydrate;
  // each joins the one flash where it is instead of starting its own.
  const [delay] = useState(() => highlight.startedAt - performance.now());
  return (
    <div
      aria-hidden="true"
      data-turn-link-highlight=""
      onAnimationEnd={highlight.done}
      {...stylex.props(styles.flash, styles.delay(delay))}
    />
  );
}
