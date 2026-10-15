import { useAtomValue } from 'jotai';
import { boardEnabledAtom } from '@/atoms/settings';
import { BoardMembershipDialog } from '../boards/board-membership-dialog';
import { useState } from 'react';
import { PanelsTopLeft, Share2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppCapability } from '@/lib/app-platform';
import type { SessionMeta, WorkspaceId } from '@lody/shared';
import {
  MobileSessionMenuSheet,
  type MobileSessionMenuSheetProps,
} from '@/components/mobile/mobile-session-menu-sheet';
import { SessionShareDialog } from './session-share-dialog';

/** Mobile hides SessionHeaderMenu, so its native menu owns a separate entry. */
export function SessionShareMobileMenu({
  workspaceId,
  session,
  ...menu
}: MobileSessionMenuSheetProps & {
  workspaceId: WorkspaceId | null;
  /** The active persisted Tab; drafts/viewers must pass null. */
  session: SessionMeta | null;
}) {
  const { t } = useTranslation();
  const available = useAppCapability('teamSharing');
  const boardsEnabled = useAtomValue(boardEnabledAtom);
  const [boardOpen, setBoardOpen] = useState(false);
  const actions = [
    ...menu.actions,
    ...(boardsEnabled && session && !session.isArchived && session.boardRole !== 'coordinator'
      ? [
          {
            id: 'board',
            icon: <PanelsTopLeft />,
            label: session.boardId
              ? t('boards.remove', 'Remove from board')
              : t('boards.join', 'Join board'),
            onClick: () => setBoardOpen(true),
          },
        ]
      : []),
  ];
  const [sharing, setSharing] = useState(false);
  const enabled = available && workspaceId !== null && session !== null;
  return (
    <>
      <MobileSessionMenuSheet
        {...menu}
        actions={
          enabled
            ? [
                ...actions,
                {
                  id: 'public-share',
                  icon: <Share2 className="h-3.5 w-3.5" />,
                  label: t('sharing.manager.title', 'Share'),
                  onClick: () => setSharing(true),
                },
              ]
            : actions
        }
      />
      {boardOpen && session ? (
        <BoardMembershipDialog session={session} onClose={() => setBoardOpen(false)} />
      ) : null}
      {enabled && sharing && (
        <SessionShareDialog
          workspaceId={workspaceId}
          session={session}
          onClose={() => setSharing(false)}
        />
      )}
    </>
  );
}
