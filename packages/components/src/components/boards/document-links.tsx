import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useAtomValue, useStore } from 'jotai';
import {
  boardFilesMachineId,
  getSessionRoomId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { currentWorkspaceIdAtom } from '@/atoms';
import { sessionMetaAtomFamily, sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import { fileSourceKey, resolveDocumentLink, type FileTarget } from '@/lib/document-link-open';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { parseMarkdownAgentFileHref } from '@/lib/markdown-agent-file-link';
import { classifyFileLinkProbe, type FileLinkProbeResult } from '@/lib/session-file-link-fallback';
import type {
  SessionDetailOpenFileOptions,
  SessionFileOpenContext,
} from '@/lib/session-file-link-open';
import { AgentFileLinkOpenContext } from '../ai-gui/markdown-renderer';
import { SessionAgentFileLinkMenuProvider } from '../sessions/session-agent-file-link-menu';
import {
  SessionFileScope,
  SessionFileScopeHost,
  type SessionFileScopeValue,
} from '../sessions/session-file-scope';

/** The session a document's links fall back to: its machine, workspace and file index. */
export type DocumentLinkOwner = SessionFileOpenContext & { readonly session: SessionMeta };

const PROBE_TIMEOUT_MS = 2_500;

/**
 * Makes the file links of one rendered document open instead of copying their
 * path. Which file a link names is `resolveDocumentLink`'s answer; where it then
 * shows is the container's (`onOpen`): a tab beside a tab, the next page in the
 * article window or a Board preview.
 */
export function DocumentLinks({
  document,
  owner,
  onOpen,
  children,
}: {
  /** The document the links are written in. */
  document: FileTarget;
  owner: DocumentLinkOwner;
  onOpen: (target: FileTarget) => void;
  children: ReactNode;
}) {
  const store = useStore();
  const { boards } = useWorkspaceCatalog();
  const probe = useStableCallback(async (target: FileTarget): Promise<FileLinkProbeResult> => {
    if (target.source.kind === 'board') {
      const boardId = target.source.boardId;
      const board = boards.find((entry) => entry.id === boardId);
      const workspaceId = store.get(currentWorkspaceIdAtom);
      const host =
        board &&
        boardFilesMachineId(
          board,
          store.get(sessionMetaCacheAtom)[getSessionRoomId(board.coordinatorSessionId)]
        );
      const ipc = getIpcServices();
      if (!ipc || !workspaceId || !host) return { state: 'unknown' };
      const resource = await ipc.machineRpc.openMemberFile({
        workspaceId,
        machineId: host,
        sessionId: owner.session.id,
        boardId,
        path: target.path,
      });
      if (resource.ok) return { state: 'found' };
      return { state: /ENOENT/.test(resource.error) ? 'missing' : 'unknown' };
    }
    // An indexed path exists; only an unlisted one is asked about.
    if (await owner.fileProvider?.getFile(target.path).catch(() => null)) return { state: 'found' };
    const runtime = store.get(activeWorkspaceRuntimeAtom);
    if (!runtime) return { state: 'unknown' };
    return classifyFileLinkProbe(
      await runtime.requestFilePreview(
        owner.session.machineId,
        { sessionId: owner.session.id, path: target.path, maxBytes: 1 },
        {
          ownerSessionId: owner.session.parentSessionId ?? owner.session.id,
          timeoutMs: PROBE_TIMEOUT_MS,
          workspaceRoot: owner.workspacePath,
        }
      )
    );
  });
  // Only the latest click opens, and nothing opens once the document has
  // changed (a page stack's Back) or is gone.
  const latestClick = useRef(0);
  const documentKey = `${owner.session.id}|${fileSourceKey(document.source)}:${document.path}`;
  useEffect(
    () => () => {
      latestClick.current += 1;
    },
    [documentKey]
  );
  const follow = useStableCallback((href: string) => {
    const click = (latestClick.current += 1);
    void resolveDocumentLink({
      href,
      document,
      readerSessionId: owner.session.id,
      workspaceId: store.get(currentWorkspaceIdAtom),
      boards,
      probe,
    }).then((target) => {
      if (target && latestClick.current === click) onOpen(target);
    });
  });
  const open = useCallback(
    (href: string) => (parseMarkdownAgentFileHref(href) ? () => follow(href) : undefined),
    [follow]
  );
  return (
    <AgentFileLinkOpenContext.Provider value={open}>{children}</AgentFileLinkOpenContext.Provider>
  );
}

/**
 * The file scope of the session a document is read for, with the document's
 * links followed: `SessionFileScope` and `DocumentLinks` together, for a
 * container that renders the document from that scope (the article window).
 */
export function SessionDocumentScope({
  readerId,
  document,
  onOpen,
  children,
}: {
  /** The document's own session, or for a Board's file the member reading it. */
  readerId: SessionId;
  document: FileTarget;
  onOpen: (scope: SessionFileScopeValue, target: FileTarget) => void;
  children: (scope: SessionFileScopeValue) => ReactNode;
}) {
  return (
    <SessionFileScope sessionId={readerId}>
      {(scope) => (
        <DocumentLinks document={document} owner={scope} onOpen={(target) => onOpen(scope, target)}>
          {children(scope)}
        </DocumentLinks>
      )}
    </SessionFileScope>
  );
}

/**
 * How the session page opens a file link in the name of another session (a
 * reply card's target): the same opener as that conversation's own links.
 */
export type SessionFileLinkOpener = (
  scope: SessionFileScopeValue,
  path: string,
  options?: SessionDetailOpenFileOptions
) => void;
export const SessionFileLinkOpenContext = createContext<SessionFileLinkOpener | null>(null);

/**
 * File links in a reply another session sent: opened in that session's
 * machine and workspace, the way its own conversation opens them. Without an
 * opener from the page, the links keep copying their path.
 */
export function SessionReplyFileLinks({
  sessionId,
  text,
  onOpen,
  children,
}: {
  sessionId: SessionId;
  /** The reply, where a path the machine cannot find may be spelled out in full. */
  text: string;
  /** Before the file opens: the reply's own dialog makes way. */
  onOpen: () => void;
  children: ReactNode;
}) {
  const openFile = useContext(SessionFileLinkOpenContext);
  const session = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(sessionId)));
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const scopeRef = useRef<SessionFileScopeValue | null>(null);
  const follow = useStableCallback((href: string) => {
    const scope = scopeRef.current;
    if (!scope || !openFile) return;
    onOpen();
    openFile(scope, href, { linkContext: () => ({ mentions: [text], outputs: [] }) });
  });
  const open = useCallback(
    (href: string) => (parseMarkdownAgentFileHref(href) ? () => follow(href) : undefined),
    [follow]
  );
  if (!openFile || !session) return <>{children}</>;
  // The reply's paths are confirmed against its own session's files, like its conversation's.
  return (
    <SessionAgentFileLinkMenuProvider session={session} workspaceId={workspaceId}>
      <SessionFileScopeHost sessionId={sessionId} enabled={false} scopeRef={scopeRef} />
      <AgentFileLinkOpenContext.Provider value={open}>{children}</AgentFileLinkOpenContext.Provider>
    </SessionAgentFileLinkMenuProvider>
  );
}

/** A Board preview's page showing a session's file a link led to. */
export type BoardSessionFilePageProps = {
  readonly sessionId: SessionId;
  readonly target: FileTarget;
  readonly onBack: () => void;
  /** A link on the page: the preview's next page. */
  readonly onOpen: (target: FileTarget) => void;
};

/**
 * What a Board preview's links need from the session page: the session they
 * are read for (the coordinator in the Board panel), the page for one of
 * that session's files, and the article window where the page has one. The
 * session page renders the file's page, so the file viewer stays out of the
 * Board panel's imports.
 */
export type BoardDocumentLinksValue = {
  readonly owner: DocumentLinkOwner;
  readonly renderSessionFile: (page: BoardSessionFilePageProps) => ReactNode;
  readonly openArticle?: (target: FileTarget) => void;
};
export const BoardDocumentLinksContext = createContext<BoardDocumentLinksValue | null>(null);

/** The shared notes have no folder: their relative links start at the Board directory. */
export const BOARD_NOTES_DOCUMENT_PATH = 'notes';

/**
 * Links of a Board document previewed in the Board panel or its settings:
 * whatever file they lead to opens in place, as the preview's next page
 * (`onOpen`). Without the page's links they keep copying their path.
 */
export function BoardDocumentLinks({
  boardId,
  path,
  onOpen,
  children,
}: {
  boardId: string;
  /** `<area>/<path>`, or `BOARD_NOTES_DOCUMENT_PATH`. */
  path: string;
  onOpen: (target: FileTarget) => void;
  children: ReactNode;
}) {
  const links = useContext(BoardDocumentLinksContext);
  if (!links) return <>{children}</>;
  return (
    <DocumentLinks
      document={{ source: { kind: 'board', boardId }, path }}
      owner={links.owner}
      onOpen={onOpen}
    >
      {children}
    </DocumentLinks>
  );
}
