import { useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import * as stylex from '@stylexjs/stylex';
import { getServerNow, getSessionRoomId, type BoardMeta, type SessionMeta } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import { Dialog } from '@/ui/dialog';
import { boardStyles } from './board-view';
import type { WorkspaceRuntime } from '@/atoms/runtime';

export async function changeBoardMembership(
  runtime: Pick<WorkspaceRuntime, 'repo' | 'writer'>,
  session: SessionMeta,
  board?: BoardMeta,
  now = getServerNow()
) {
  const roomId = getSessionRoomId(session.id);
  const current = (await runtime.repo.getDocMeta(roomId))?.meta as SessionMeta | undefined;
  if (!current || current.boardRole === 'coordinator') throw new Error('BOARD_COORDINATOR_FIXED');
  await runtime.writer.upsertDocMeta(roomId, {
    boardId: board?.id,
    boardJoinedAtMs: board ? now : undefined,
    boardRole: undefined,
    boardGeneration: undefined,
  });
  await runtime.repo.flush();
}

export function BoardMembershipDialog({
  session,
  onClose,
}: {
  session: SessionMeta;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const { boards } = useWorkspaceCatalog();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const change = async (board?: BoardMeta) => {
    if (!runtime || saving) return;
    setSaving(true);
    setError(false);
    try {
      await changeBoardMembership(runtime, session, board);
      onClose();
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>
            {session.boardId
              ? t('boards.remove', 'Remove from board')
              : t('boards.join', 'Join board')}
          </Dialog.Title>
        </Dialog.Header>
        <div {...stylex.props(boardStyles.form)}>
          {session.boardId ? (
            <Button disabled={saving} onClick={() => void change()}>
              {t('boards.remove', 'Remove from board')}
            </Button>
          ) : (
            boards
              .filter((b) => b.archivedAtMs === undefined)
              .map((b) => (
                <Button key={b.id} disabled={saving} onClick={() => void change(b)}>
                  {b.name}
                </Button>
              ))
          )}
          {!session.boardId && !boards.some((b) => b.archivedAtMs === undefined) ? (
            <p>{t('boards.noAvailable', 'Create a board first.')}</p>
          ) : null}
          {error ? (
            <p role="alert">{t('boards.membershipFailed', 'Could not change board membership.')}</p>
          ) : null}
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
