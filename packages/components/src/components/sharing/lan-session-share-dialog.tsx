import { useEffect, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { SessionMeta, WorkspaceId } from '@lody/shared';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { getSessionShareCandidates } from '@/lib/session-share-candidates';
import { useLanSessionShareManagement } from '@/lib/lan-session-share';
import { SessionShareDialogFrame } from './session-share-dialog';
import { SessionShareManager } from './session-share-manager';

/**
 * The upstream share dialog for a conversation of a LAN workspace, which the
 * LAN's hub publishes. Mounted only while open.
 */
function LanSessionShareEditor({
  workspaceId,
  session,
  onClose,
  shareId,
  embedded = false,
  onBusyChange,
}: {
  workspaceId: WorkspaceId;
  session: SessionMeta;
  onClose: () => void;
  shareId?: string;
  embedded?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const meta = useAtomValue(sessionMetaCacheAtom);
  const title = (session.title ?? '') || t('sessions.untitled', 'Untitled session');
  const candidates = useMemo(
    () =>
      [session, ...getSessionShareCandidates(session.id, Object.values(meta)).slice(0, 96)].map(
        (entry) => ({
          sessionId: entry.id,
          title: (entry.title ?? '') || t('sessions.untitled', 'Untitled session'),
        })
      ),
    [meta, session, t]
  );
  const management = useLanSessionShareManagement(
    workspaceId,
    session.id,
    candidates.map((entry) => entry.sessionId),
    shareId
  );
  const working = management.busy || management.phase !== 'idle';
  useEffect(() => {
    onBusyChange?.(working);
  }, [onBusyChange, working]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  const editor = (
    <SessionShareManager
      embedded={embedded}
      sessionId={session.id}
      candidates={candidates}
      onClose={onClose}
      {...management}
    />
  );
  return embedded ? (
    editor
  ) : (
    <SessionShareDialogFrame title={title} onClose={onClose}>
      {editor}
    </SessionShareDialogFrame>
  );
}

export function LanSessionShareDialog(
  props: Omit<Parameters<typeof LanSessionShareEditor>[0], 'embedded'>
) {
  return <LanSessionShareEditor {...props} />;
}
export function LanSessionShareEditorPanel(
  props: Omit<Parameters<typeof LanSessionShareEditor>[0], 'embedded'>
) {
  return <LanSessionShareEditor {...props} embedded />;
}
