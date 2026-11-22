import { useCallback, useState } from 'react';
import type { SessionId } from '@lody/shared';
import { PopupContainerProvider } from '@lody/ui/popup-container';
import { BoardArticleDialog } from '../boards/board-article-dialog';
import type { RelocatableHost } from '../boards/relocatable-host';
import { SessionFileScope } from '../sessions/session-file-scope';
import { WorktreeReviewWorkspace } from './worktree-review-workspace';

export interface WorktreeReviewDialogProps {
  /** Target thread/session whose worktree, machineId, and capabilities are reviewed. */
  readonly sessionId: SessionId;
  readonly focusFilePath?: string | null;
  /** Optional relocatable conversation host rendered in the collapsible right pane. */
  readonly threadHost?: RelocatableHost;
  /** False during the two-commit close handoff so the conversation returns with its scroll intact. */
  readonly holdsThread?: boolean;
  readonly onPanelChange: (panel: HTMLElement | null) => void;
  readonly onClose: () => void;
}

/**
 * Full-window read-only Worktree Review dialog reusing `BoardArticleDialog`
 * (left review workspace + right collapsible `RelocatableSlot` thread chat)
 * and `SessionFileScope` so target machineId, capabilities, and worktree root
 * stay strictly scoped to `sessionId`.
 */
export function WorktreeReviewDialog({
  sessionId,
  focusFilePath = null,
  threadHost,
  holdsThread = true,
  onPanelChange,
  onClose,
}: WorktreeReviewDialogProps) {
  const [panelElement, setPanelElement] = useState<HTMLElement | null>(null);
  const handlePanelChange = useCallback(
    (panel: HTMLElement | null) => {
      setPanelElement(panel);
      onPanelChange(panel);
    },
    [onPanelChange]
  );

  return (
    <BoardArticleDialog
      title="Worktree Review"
      wide
      {...(threadHost ? { threadHost } : {})}
      holdsThread={holdsThread}
      onPanelChange={handlePanelChange}
      onClose={onClose}
      article={
        <PopupContainerProvider container={panelElement}>
          <SessionFileScope sessionId={sessionId}>
            {(scope) => (
              <WorktreeReviewWorkspace
                sessionId={scope.session.id}
                ownerSessionId={scope.ownerSessionId}
                ownerProjectRun={scope.ownerProjectRun}
                machineId={scope.session.machineId}
                session={scope.session}
                branchName={scope.session.branchName}
                fileProvider={scope.fileProvider}
                fileProviderPending={scope.fileProviderPending}
                fileProviderMessage={scope.fileProviderMessage}
                focusFilePath={focusFilePath}
                onClose={onClose}
              />
            )}
          </SessionFileScope>
        </PopupContainerProvider>
      }
    />
  );
}
