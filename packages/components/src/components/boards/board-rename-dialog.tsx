import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardMeta } from '@lody/shared';
import { RenameSessionDialogView } from '../sessions/rename-session-dialog';
import { useBoardActions } from './board-lifecycle';

/**
 * The chat rename dialog, renaming a Board: its row and its coordinator's title.
 * `board` is the row as it was when the dialog opened.
 */
export function BoardRenameDialog({
  board,
  onClose,
}: {
  board: BoardMeta | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { rename } = useBoardActions();
  const target = useMemo(
    () => (board ? { sessionId: board.coordinatorSessionId, initialTitle: board.name } : null),
    [board]
  );
  return (
    <RenameSessionDialogView
      target={target}
      onClose={onClose}
      onRename={(_coordinator, name) => (board ? rename(board, name) : undefined)}
      title={t('boards.rename', 'Rename Board')}
      description={t('boards.renameDescription', 'Enter a new name for this Board.')}
    />
  );
}
