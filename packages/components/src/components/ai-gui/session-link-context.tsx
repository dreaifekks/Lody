'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'jotai';
import { currentWorkspaceIdAtom } from '@/atoms';
import { boardSessionNavigationAtom } from '../boards/board-session-navigation';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { openSessionDeepLink } from '@/lib/session-deep-link';
import { parseSessionLink, type SessionLink } from '@lody/shared/session-link';
import type { SessionId } from '@lody/shared';
import type { SessionNavigationTarget } from '@/lib/session-navigation';

/**
 * Recognize current resource links and historical session:// references.
 */
export function parseSessionLinkHref(href: string): SessionId | null {
  return (parseSessionLink(href)?.sessionId as SessionId | undefined) ?? null;
}

/**
 * Opens a Session named by a Markdown resource link. Absent outside a live
 * Session workspace (share pages, settings), where the link renders inert.
 */
const SessionLinkContext = createContext<
  ((target: SessionNavigationTarget & Pick<SessionLink, 'workspaceId'>) => void) | null
>(null);

export function SessionLinkProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const store = useStore();
  const navigate = useStableCallback(
    (target: SessionNavigationTarget & Pick<SessionLink, 'workspaceId'>) => {
      const boardNavigation = store.get(boardSessionNavigationAtom);
      if (
        boardNavigation &&
        (!target.workspaceId || target.workspaceId === store.get(currentWorkspaceIdAtom))
      ) {
        boardNavigation.open(target);
      } else openSessionDeepLink(target);
    }
  );
  return (
    <SessionLinkContext.Provider value={enabled ? navigate : null}>
      {children}
    </SessionLinkContext.Provider>
  );
}

export function useSessionLinkNavigator() {
  return useContext(SessionLinkContext);
}
