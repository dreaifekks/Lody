import { createContext } from 'react';
import type { SessionId, SessionMeta } from '@lody/shared';
import type { ArticleBeside } from '../boards/board-article-dialog';

export type WorktreeReviewOpenRequest = {
  readonly sessionId: SessionId;
  readonly beside?: ArticleBeside;
  readonly focusFilePath?: string | null;
};

export const WorktreeReviewOpenContext = createContext<
  ((request: WorktreeReviewOpenRequest) => void) | null
>(null);

/**
 * Worktree review operates on active sessions tied to a local/GitHub project
 * or worktree. Archived sessions are excluded because read-only RPC rejects them.
 */
export function sessionSupportsWorktreeReview(
  session: Pick<SessionMeta, 'project' | 'isWorktree' | 'isArchived'> | null | undefined
): boolean {
  if (!session || session.isArchived === true) return false;
  return session.project != null || session.isWorktree === true;
}

/**
 * Resolves which session the `/btw` shortcut targets when Article or Worktree
 * Review overlays may be visible.
 *
 * When a standalone Worktree Review dialog is open (`reviewShown && !articleShown`)
 * without a beside conversation (`reviewThreadId === null && reviewTabId === null`),
 * returns `null` so `/btw` never falls through to the hidden coordinator behind it.
 */
export function resolveSessionBtwCommandTarget(params: {
  readonly articleShown: boolean;
  readonly articleThreadId: SessionId | null;
  readonly articleTabId: SessionId | null;
  readonly reviewShown: boolean;
  readonly reviewThreadId: SessionId | null;
  readonly reviewTabId: SessionId | null;
  readonly hasBoardThreadTarget: boolean;
  readonly boardThreadId: SessionId | null;
  readonly activeSessionTabId: SessionId | null;
}): SessionId | null {
  if (params.articleShown && (params.articleThreadId || params.articleTabId)) {
    return params.articleThreadId ?? params.articleTabId;
  }
  if (!params.articleShown && params.reviewShown) {
    return params.reviewThreadId ?? params.reviewTabId ?? null;
  }
  return params.hasBoardThreadTarget ? params.boardThreadId : params.activeSessionTabId;
}
