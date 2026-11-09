import { SessionFileContentView } from '../sessions/session-file-content-view';
import { SessionDocumentScope, type BoardSessionFilePageProps } from './document-links';

/**
 * A session's file a Board preview's link led to, read in that session's
 * machine and workspace like its side tab, where its menu moves it
 * (`onOpenInTab`).
 */
export function BoardSessionFilePage({
  sessionId,
  target,
  onBack,
  onOpen,
  onOpenInTab,
}: BoardSessionFilePageProps & { onOpenInTab: () => void }) {
  return (
    <SessionDocumentScope
      sessionId={sessionId}
      path={target.path}
      onOpen={(_scope, next) => onOpen(next)}
    >
      {(scope) => (
        <SessionFileContentView
          key={`${scope.session.id}:${target.path}`}
          sessionId={scope.session.id}
          session={scope.session}
          filePath={target.path}
          startLine={target.startLine}
          endLine={target.endLine}
          fileProvider={scope.fileProvider}
          fileProviderPending={scope.fileProviderPending}
          fileProviderMessage={scope.fileProviderMessage}
          {...(scope.role === undefined ? {} : { fileProviderRole: scope.role })}
          active
          article={{ onOpenInTab, annotationThreadId: null, onBack }}
        />
      )}
    </SessionDocumentScope>
  );
}
