import { Navigate } from '@tanstack/react-router';
import { useAtomValue } from 'jotai';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { currentWorkspaceSlugAtom } from '@/atoms';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import { boardEntrySearch } from './board-threads';
import { boardStyles } from './board-view';

/** `/boards/<id>` is an address for the Board's coordinator conversation. */
export function BoardRedirect({ boardId }: { boardId: string }) {
  const { t } = useTranslation();
  const workspaceName = useAtomValue(currentWorkspaceSlugAtom);
  const { boards, synced } = useWorkspaceCatalog();
  const board = boards.find((entry) => entry.id === boardId);
  if (board && workspaceName)
    return (
      <Navigate
        to="/$workspaceName/sessions/$sessionId"
        params={{ workspaceName, sessionId: board.coordinatorSessionId }}
        search={boardEntrySearch(board.coordinatorSessionId)}
        replace
      />
    );
  return synced ? (
    <p {...stylex.props(boardStyles.page)}>{t('boards.notFound', 'Board not found.')}</p>
  ) : null;
}
