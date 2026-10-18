import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useAtomValue } from 'jotai';
import { getSessionRoomId, type SessionId, type SessionMeta } from '@lody/shared';
import { userAtom } from '@/atoms';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { localHomeDirAtom, localMachineIdAtom } from '@/atoms/local-probe';
import { useResolvedMachineMeta } from '@/hooks/use-resolved-machine-meta';
import { useCodeCollabRequestedRole } from '@/hooks/use-code-collab-requested-role';
import {
  CODE_COLLAB_CHECKING_MESSAGE,
  useCodeCollabSessionFileProvider,
  type UseCodeCollabSessionFileProviderResult,
} from '@/hooks/use-code-collab-session-file-provider';
import { useSessionFileActions } from '@/hooks/use-session-file-actions';
import { resolveEffectiveCodeCollabWorkspaceId } from '@/lib/code-collab-workspace-id';
import {
  resolveSessionLocalProjectRootPath,
  resolveSessionRepoFullName,
} from '@/lib/session-local-file-source';
import {
  resolveMachineDotlodyPath,
  resolveSessionWorkspacePath,
} from '@/lib/session-workspace-path';
import type {
  SessionDetailOpenFileOptions,
  SessionFileOpenContext,
} from '@/lib/session-file-link-open';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { SessionFileErrorState } from './session-file-error-state';
import { SessionFileActionsMenu } from './session-file-actions-menu';

export type SessionFileScopeValue = SessionFileOpenContext & {
  session: SessionMeta;
  fileProviderPending: boolean;
  fileProviderMessage: string | undefined;
  role: UseCodeCollabSessionFileProviderResult['role'];
};

/** File ownership lives outside the page's active conversation, including restored tabs. */
export function SessionFileScope({
  sessionId,
  enabled = true,
  unavailable = <SessionFileErrorState message="" reason="metadata-only" />,
  children,
}: {
  sessionId: SessionId;
  enabled?: boolean;
  unavailable?: ReactNode;
  children: (scope: SessionFileScopeValue) => ReactNode;
}) {
  const session = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(sessionId)));
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom);
  const user = useAtomValue(userAtom);
  const localMachineId = useAtomValue(localMachineIdAtom);
  const localHomeDir = useAtomValue(localHomeDirAtom);
  const { machine, machineFlockRows } = useResolvedMachineMeta(session?.machineId);
  const requestedRole = useCodeCollabRequestedRole();
  const workspaceId = resolveEffectiveCodeCollabWorkspaceId({
    currentWorkspaceId,
    runtimeWorkspaceId: runtime?.workspaceId,
  });
  const files = useCodeCollabSessionFileProvider({
    workspaceId,
    sessionId,
    enabled: Boolean(enabled && session && workspaceId),
    requestedRole,
    machineId: session?.machineId,
    requestedByUserId: user?.id ?? session?.userId,
    githubRepoFullName: session ? resolveSessionRepoFullName(session) : null,
    debugLabel: 'session-detail:owned-file-provider',
  });
  if (!session) return unavailable;
  const isLocalMachine = Boolean(localMachineId) && session.machineId === localMachineId;
  const workspacePath = resolveSessionWorkspacePath({
    sessionId,
    ownerSessionId: session.parentSessionId,
    isWorktree: session.isWorktree,
    dotlodyPath: resolveMachineDotlodyPath(machineFlockRows, isLocalMachine ? localHomeDir : null),
    localProjectRootPath: resolveSessionLocalProjectRootPath(session, machine?.localProjects ?? {}),
    repoFullName: resolveSessionRepoFullName(session),
    legacyWorkspacePath: machine?.workspacePaths?.[sessionId],
  });
  return children({
    session,
    workspacePath,
    preserveWorktreePath: window.__LODY_ELECTRON__ === true && isLocalMachine,
    fileProvider: files.provider,
    fileProviderPending:
      !files.provider &&
      (!workspaceId || files.status === 'checking' || files.status === 'loading'),
    fileProviderMessage: !workspaceId ? CODE_COLLAB_CHECKING_MESSAGE : files.message,
    role: files.role,
  });
}

/** A commit-time bridge: index and machine updates never render the conversation. */
function PublishFileScope({
  scope,
  scopeRef,
}: {
  scope: SessionFileScopeValue | null;
  scopeRef: RefObject<SessionFileScopeValue | null>;
}) {
  useLayoutEffect(() => {
    scopeRef.current = scope;
    return () => {
      scopeRef.current = null;
    };
  }, [scope, scopeRef]);
  return null;
}

export function SessionFileScopeHost({
  sessionId,
  enabled,
  scopeRef,
}: {
  sessionId: SessionId;
  enabled: boolean;
  scopeRef: RefObject<SessionFileScopeValue | null>;
}) {
  return (
    <SessionFileScope
      sessionId={sessionId}
      enabled={enabled}
      unavailable={<PublishFileScope scope={null} scopeRef={scopeRef} />}
    >
      {(scope) => <PublishFileScope scope={scope} scopeRef={scopeRef} />}
    </SessionFileScope>
  );
}

export function useThreadFileLinks(
  sessionId: SessionId | null,
  onOpen: (
    scope: SessionFileScopeValue,
    path: string,
    options?: SessionDetailOpenFileOptions
  ) => void
) {
  const scopeRef = useRef<SessionFileScopeValue | null>(null);
  const [requestedSessionId, setRequestedSessionId] = useState<SessionId | null>(null);
  const onFilePathClick = useStableCallback(
    (path: string, options?: SessionDetailOpenFileOptions) => {
      const scope = scopeRef.current;
      if (!scope || scope.session.id !== sessionId) return;
      setRequestedSessionId(sessionId);
      onOpen(scope, path, options);
    }
  );
  const onOpenHtmlFile = useStableCallback((path: string) =>
    onFilePathClick(path, {
      pathKind: 'canonical',
      source: 'html_attachment',
      previewHtml: true,
    })
  );
  return { scopeRef, enabled: requestedSessionId === sessionId, onFilePathClick, onOpenHtmlFile };
}

export function SessionOwnedFileActionsMenu({
  scope,
  filePath,
}: {
  scope: SessionFileScopeValue;
  filePath: string | null;
}) {
  const actions = useSessionFileActions({
    session: scope.session,
    fileProvider: scope.fileProvider,
  });
  return <SessionFileActionsMenu filePath={filePath} items={actions.menuItems} />;
}
