import { atom, useStore } from 'jotai';
import { useEffect } from 'react';
import { getSessionRoomId, type SessionId } from '@lody/shared';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { useStableCallback } from '@/hooks/use-stable-callback';
import type { BoardMeta, SessionMeta } from '@lody/shared';
import type { SessionNavigationTarget } from '@/lib/session-navigation';
import { opensInCoordinatorPage } from './board-threads';

/** The mounted Board page also owns navigation from the global command palette. */
export const boardSessionNavigationAtom = atom<{
  open: (target: SessionNavigationTarget) => void;
} | null>(null);

/** Expanded threads have their own page; narrow windows also use page navigation. */
export function boardSessionDestination(
  board: BoardMeta | null,
  session: SessionMeta | undefined | null,
  narrow: boolean
): 'panel' | 'coordinator' | 'page' {
  if (!board || !session || narrow) return 'page';
  if (session.id === board.coordinatorSessionId || opensInCoordinatorPage(board, session))
    return 'coordinator';
  return 'panel';
}

/** All session entries on a Board page share this one destination decision. */
export function useBoardSessionNavigation({
  board,
  narrow,
  openPanel,
  showInCoordinatorPage,
  openPage,
}: {
  board: BoardMeta | null;
  narrow: boolean;
  openPanel: (id: SessionId) => void;
  showInCoordinatorPage: (target: SessionNavigationTarget) => void;
  openPage: (target: SessionNavigationTarget) => void;
}) {
  const store = useStore();
  const open = useStableCallback((target: SessionNavigationTarget) => {
    const exactId = target.tabSessionId ?? target.sessionId;
    const session = store.get(sessionMetaAtomFamily(getSessionRoomId(exactId)));
    switch (boardSessionDestination(board, session, narrow)) {
      case 'panel':
        openPanel(exactId);
        return;
      case 'coordinator':
        showInCoordinatorPage(target);
        return;
      case 'page':
        openPage(target);
        return;
    }
  });
  useEffect(() => {
    if (!board) return undefined;
    const navigation = { open };
    store.set(boardSessionNavigationAtom, navigation);
    return () => {
      if (store.get(boardSessionNavigationAtom) === navigation)
        store.set(boardSessionNavigationAtom, null);
    };
  }, [board, open, store]);
  return open;
}
