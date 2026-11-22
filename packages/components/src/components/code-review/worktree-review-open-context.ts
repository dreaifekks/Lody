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
