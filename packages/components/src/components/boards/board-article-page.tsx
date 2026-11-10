import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { useAtomValue } from 'jotai';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { boardFilesMachineId, getSessionRoomId, type SessionId } from '@lody/shared';
import { currentWorkspaceIdAtom } from '@/atoms';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import { BoardMemberFileProvider } from '@/lib/board-directory-file-provider';
import {
  boardFileLinkPath,
  isBoardFileTarget,
  type BoardFileTarget,
  type FileTarget,
} from '@/lib/document-link-open';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { SessionFileContentView } from '../sessions/session-file-content-view';
import type { SessionFileScopeValue } from '../sessions/session-file-scope';
import type { ArticlePage } from './board-article-dialog';
import { SessionBoardCompareView } from './board-compare-view';
import { isCompareManifestPath } from './compare-manifest';
import { SessionDocumentScope } from './document-links';

const styles = stylex.create({
  note: {
    margin: 0,
    padding: space[4],
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
});

type ArticlePageViewProps = {
  page: ArticlePage;
  /** Whose next message carries the page's comments; null where nobody's does. */
  annotationThreadId: SessionId | null;
  /** A link on the page, read for `scope`. */
  onOpenLink: (scope: SessionFileScopeValue, target: FileTarget) => void;
  /** The page as a side tab instead. */
  onOpenInTab: (scope: SessionFileScopeValue) => void;
  onBack?: () => void;
  className: string | undefined;
};

/**
 * One page of the article window: a session's Markdown, HTML or comparison
 * read from its workspace, or a Board's read from the machine that keeps the
 * Board directory. Its links follow `DocumentLinks`.
 */
export function ArticlePageView({
  page,
  annotationThreadId,
  onOpenLink,
  onOpenInTab,
  onBack,
  className,
}: ArticlePageViewProps) {
  const { target } = page;
  const back = onBack ? { onBack } : {};
  return (
    <SessionDocumentScope readerId={page.readerId} document={target} onOpen={onOpenLink}>
      {(scope) => {
        if (isBoardFileTarget(target))
          return (
            <BoardArticleFile
              target={target}
              annotationThreadId={annotationThreadId}
              onOpenInTab={() => onOpenInTab(scope)}
              {...back}
              className={className}
            />
          );
        if (isCompareManifestPath(target.path))
          return (
            <SessionBoardCompareView
              scope={`session:${scope.session.id}`}
              key={`${scope.session.id}:${target.path}`}
              fileProvider={scope.fileProvider}
              manifestPath={target.path}
              comments={
                annotationThreadId
                  ? { threadId: annotationThreadId, ownerThreadId: scope.session.id }
                  : null
              }
              onOpenInTab={() => onOpenInTab(scope)}
              {...back}
            />
          );
        return (
          <SessionFileContentView
            key={`${scope.session.id}:${target.path}`}
            sessionId={scope.session.id}
            session={scope.session}
            filePath={target.path}
            {...(page.fileId === undefined ? {} : { fileId: page.fileId })}
            startLine={target.startLine}
            endLine={target.endLine}
            fileProvider={scope.fileProvider}
            fileProviderPending={scope.fileProviderPending}
            fileProviderMessage={scope.fileProviderMessage}
            {...(scope.role === undefined ? {} : { fileProviderRole: scope.role })}
            active
            article={{ onOpenInTab: () => onOpenInTab(scope), annotationThreadId, ...back }}
            className={className}
          />
        );
      }}
    </SessionDocumentScope>
  );
}

/**
 * A Board's file as an article. It is read through the member file channel,
 * like the Board's own preview, and named by its canonical path
 * (`boards/<ws>/<board>/…`). The Board's coordinator stands for the Board: a
 * comment is on the Board's file whoever reads it, and goes with the next
 * message of `annotationThreadId`.
 */
function BoardArticleFile({
  target,
  annotationThreadId,
  onOpenInTab,
  onBack,
  className,
}: {
  target: BoardFileTarget;
  annotationThreadId: SessionId | null;
  onOpenInTab: () => void;
  onBack?: () => void;
  className: string | undefined;
}) {
  const { t } = useTranslation();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const metas = useAtomValue(sessionMetaCacheAtom);
  const { boards } = useWorkspaceCatalog();
  const board = boards.find((entry) => entry.id === target.source.boardId);
  const coordinatorId = board?.coordinatorSessionId;
  const coordinator = coordinatorId ? metas[getSessionRoomId(coordinatorId)] : undefined;
  const host = board ? boardFilesMachineId(board, coordinator) : undefined;
  const provider = useMemo(() => {
    const ipc = getIpcServices();
    if (!ipc || !workspaceId || !coordinatorId || !host) return null;
    const boardId = target.source.boardId;
    return new BoardMemberFileProvider(workspaceId, boardId, (path) =>
      ipc.machineRpc.openMemberFile({
        workspaceId,
        machineId: host,
        sessionId: coordinatorId,
        boardId,
        path,
      })
    );
  }, [coordinatorId, host, target.source.boardId, workspaceId]);
  if (!coordinator || !provider)
    return <p {...stylex.props(styles.note)}>{t('boards.notFound', 'Board not found.')}</p>;
  const path = boardFileLinkPath(workspaceId, target);
  const back = onBack ? { onBack } : {};
  return isCompareManifestPath(path) ? (
    <SessionBoardCompareView
      scope={`board:${target.source.boardId}`}
      key={path}
      fileProvider={provider}
      manifestPath={path}
      comments={
        annotationThreadId ? { threadId: annotationThreadId, ownerThreadId: coordinator.id } : null
      }
      onOpenInTab={onOpenInTab}
      {...back}
    />
  ) : (
    <SessionFileContentView
      key={path}
      sessionId={coordinator.id}
      session={coordinator}
      filePath={path}
      fileProvider={provider}
      active
      article={{ onOpenInTab, annotationThreadId, boardFile: true, ...back }}
      className={className}
    />
  );
}
