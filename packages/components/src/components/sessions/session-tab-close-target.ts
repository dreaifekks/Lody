import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import { EMPTY_SESSION_TAB_ID } from '@/lib/session-tab-url';

export type SessionTabFocusRegion = 'conversation' | 'side-panel';

export type SessionTabCloseTarget =
  | { kind: 'conversation'; tabId: string }
  | { kind: 'side-panel'; tabId: string }
  | { kind: 'window' };

export function getSessionTabCloseTarget({
  focusRegion,
  sidePanelOpen,
  activeSidePanelTabId,
  activeConversationTabId,
  conversationTabCount,
}: {
  focusRegion: SessionTabFocusRegion;
  sidePanelOpen: boolean;
  activeSidePanelTabId: string | null;
  activeConversationTabId: string;
  parentConversationTabId: string;
  conversationTabCount: number;
}): SessionTabCloseTarget | null {
  if (focusRegion === 'side-panel' && sidePanelOpen) {
    if (activeSidePanelTabId) return { kind: 'side-panel', tabId: activeSidePanelTabId };
    return activeConversationTabId === EMPTY_SESSION_TAB_ID ? { kind: 'window' } : null;
  }
  if (activeConversationTabId !== EMPTY_SESSION_TAB_ID) {
    if (conversationTabCount === 1) return { kind: 'window' };
    return { kind: 'conversation', tabId: activeConversationTabId };
  }
  if (sidePanelOpen && activeSidePanelTabId) {
    return { kind: 'side-panel', tabId: activeSidePanelTabId };
  }
  return { kind: 'window' };
}

/**
 * Closes a Session tab. A tab that never had a message is exact-deleted instead
 * of marked closed — `isTabClosed` would leave an invisible durable doc — except
 * a Board coordinator, which is its Board and is created before anyone speaks.
 * Emptiness is judged from `getDocMeta` directly: the meta scan cache can still
 * be cold here, and exact deletion must bypass discovery.
 */
export async function closeSessionTab(
  tabSessionId: SessionId,
  actions: {
    runtime: Pick<WorkspaceRuntime, 'repo'> | null;
    deleteSessions: (sessionIds: SessionId[]) => Promise<void>;
    setSessionTabClosed: (sessionId: SessionId, closed: boolean) => Promise<void>;
  }
): Promise<'deleted' | 'closed'> {
  const entry = actions.runtime
    ? await actions.runtime.repo.getDocMeta(getSessionRoomId(tabSessionId))
    : undefined;
  if (isLoroRepoDocDeleted(entry)) throw new Error('Session was deleted');
  const meta = entry?.meta as SessionMeta | undefined;
  if (meta && !meta.lastMessageAt && meta.boardRole !== 'coordinator') {
    await actions.deleteSessions([tabSessionId]);
    return 'deleted';
  }
  await actions.setSessionTabClosed(tabSessionId, true);
  return 'closed';
}
