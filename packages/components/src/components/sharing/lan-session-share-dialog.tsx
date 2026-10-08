import { useMemo } from 'react';
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
export function LanSessionShareDialog({
  workspaceId,
  session,
  onClose,
  shareId,
}: {
  workspaceId: WorkspaceId;
  session: SessionMeta;
  onClose: () => void;
  shareId?: string;
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
  return (
    <SessionShareDialogFrame title={title} onClose={onClose}>
      <SessionShareManager
        sessionId={session.id}
        candidates={candidates}
        onClose={onClose}
        {...management}
      />
    </SessionShareDialogFrame>
  );
}
