import { useCallback, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import type { SessionId, WorkspaceId } from '@lody/shared';
import type { LanSharedConversation } from '@lody/shared/lan-share';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '@/atoms';
import { settingsDialogOpenAtom } from '@/atoms/settings';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { LanSessionShareDialog } from '@/components/sharing/lan-session-share-dialog';
import { refreshLanShares, revokeLanShare, useLanShares } from '@/lib/lan-session-share';
import { openExternalUrl } from '@/lib/native-browser';
import { sessionShareErrorMessage } from '@/lib/session-share-errors';
import { AlertDialog, Dialog } from '@/ui/dialog';
import { Button } from '@lody/ui/button';
import { Skeleton } from '@lody/ui/skeleton';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { focus, radius, space, text as uiText } from '@lody/ui/tokens/scales.stylex';
import { SettingsEmptyList, settingsRecordsCard } from './compact-layout';
import { settingsSurface as surface } from './surface';

const styles = stylex.create({
  lead: { margin: 0, fontSize: uiText.footnoteSize, color: colors.secondaryLabel },
  notice: { margin: 0, fontSize: uiText.footnoteSize, color: colors.label },
  error: { margin: 0, fontSize: uiText.footnoteSize, color: colors.destructive },
  list: { margin: 0, padding: 0, listStyleType: 'none' },
  row: { position: 'relative', paddingInline: space[4], paddingBlock: '8px' },
  open: {
    display: 'block',
    width: '100%',
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    outline: 'none',
    borderRadius: radius.mini,
    boxShadow: { default: 'none', ':focus-visible': `0 0 0 ${focus.ringWidth} ${colors.accent}` },
    '::after': { content: '""', position: 'absolute', inset: 0 },
  },
  title: {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    overflow: 'hidden',
    fontSize: uiText.footnoteSize,
    color: colors.label,
  },
  meta: {
    margin: 0,
    marginTop: '2px',
    fontSize: uiText.footnoteSize,
    color: colors.secondaryLabel,
  },
  skeleton: { display: 'flex', flexDirection: 'column', gap: space[2], paddingBlock: '2px' },
  detailRow: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space[4],
    paddingBlock: space[1.5],
    fontSize: '12px',
  },
  detailLabel: { flexShrink: 0, color: colors.secondaryLabel },
  detailValue: { minWidth: 0, textAlign: 'end', color: colors.label },
  actions: { display: 'flex', flexWrap: 'wrap', gap: space[2] },
});

/** Settings > Share management in a LAN workspace: the shares its hub keeps. */
export function LanShareManagementSetting() {
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  if (!workspaceId) return null;
  return <LanShareList key={workspaceId} workspaceId={workspaceId} />;
}

function LanShareList({ workspaceId }: { workspaceId: WorkspaceId }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const setSettingsDialogOpen = useSetAtom(settingsDialogOpenAtom);
  const meta = useAtomValue(sessionMetaCacheAtom);
  const state = useLanShares(workspaceId);
  const [detail, setDetail] = useState<LanSharedConversation | null>(null);
  const [editor, setEditor] = useState<LanSharedConversation | null>(null);
  const [revoking, setRevoking] = useState<LanSharedConversation | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceOf = (share: LanSharedConversation | null) =>
    share ? Object.values(meta).find((session) => session.id === share.rootSourceId) : undefined;
  const source = sourceOf(editor);

  const openSession = useCallback(
    (sessionId: SessionId) => {
      if (!workspaceSlug) return;
      setSettingsDialogOpen(false);
      void navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: workspaceSlug, sessionId },
      });
    },
    [navigate, setSettingsDialogOpen, workspaceSlug]
  );

  const act = async (action: () => Promise<void>, stage: 'copy' | 'revoke') => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(sessionShareErrorMessage(cause, stage, t));
    } finally {
      setBusy(false);
    }
  };
  const copy = (share: LanSharedConversation) =>
    act(async () => {
      if (!share.url) throw new Error('Share credential unavailable');
      await navigator.clipboard.writeText(share.url);
      setNotice(t('settings.shares.copied', 'Share link copied'));
    }, 'copy');

  const body = (() => {
    if (state.status === 'loading')
      return (
        <div {...stylex.props(settingsRecordsCard)}>
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              {...stylex.props(surface.line, index > 0 && surface.lineRuled, styles.row)}
            >
              <div {...stylex.props(styles.skeleton)}>
                <Skeleton width="70%" height={14} />
                <Skeleton width={64} height={12} />
              </div>
            </div>
          ))}
        </div>
      );
    if (state.status === 'unavailable')
      return (
        <SettingsEmptyList>
          {t('settings.shares.lanUnavailable', 'Conversations are shared through a LAN.')}
        </SettingsEmptyList>
      );
    if (state.status === 'failed')
      return (
        <p role="alert" {...stylex.props(styles.error)}>
          {t('settings.shares.lanUnreachable', 'The host of this LAN did not answer.')}
        </p>
      );
    if (state.shares.length === 0)
      return (
        <SettingsEmptyList>{t('settings.shares.empty', 'No published shares.')}</SettingsEmptyList>
      );
    return (
      <ul {...stylex.props(settingsRecordsCard, styles.list)}>
        {state.shares.map((share, index) => {
          const updatedAt = new Date(share.updatedAt);
          return (
            <li
              key={share.shareId}
              {...stylex.props(
                surface.line,
                index > 0 && surface.lineRuled,
                surface.pressableLine,
                styles.row
              )}
            >
              <button type="button" onClick={() => setDetail(share)} {...stylex.props(styles.open)}>
                <span {...stylex.props(styles.title)}>
                  {share.title || t('sessions.untitled', 'Untitled session')}
                </span>
              </button>
              <p {...stylex.props(styles.meta)}>
                <time dateTime={updatedAt.toISOString()} title={updatedAt.toLocaleString()}>
                  {updatedAt.toLocaleDateString()}
                </time>
              </p>
            </li>
          );
        })}
      </ul>
    );
  })();

  const detailSource = sourceOf(detail);
  return (
    <div {...stylex.props(surface.container)}>
      <p {...stylex.props(styles.lead)}>
        {t(
          'settings.shares.lanDescription',
          'Read-only copies the host of this LAN serves. Anyone with a link can open it.'
        )}
      </p>
      {notice && (
        <p role="status" {...stylex.props(styles.notice)}>
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" {...stylex.props(styles.error)}>
          {error}
        </p>
      )}
      {body}
      {detail && (
        <Dialog.Root open onOpenChange={(open) => !open && setDetail(null)}>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>
                {detail.title || t('sessions.untitled', 'Untitled session')}
              </Dialog.Title>
            </Dialog.Header>
            <div>
              <DetailRow ruled={false} label={t('settings.shares.publishedAt', 'Published')}>
                {new Date(detail.createdAt).toLocaleString()}
              </DetailRow>
              {detail.revision > 1 && (
                <DetailRow ruled label={t('settings.shares.updatedAt', 'Last updated')}>
                  {new Date(detail.updatedAt).toLocaleString()}
                </DetailRow>
              )}
              <DetailRow ruled label={t('settings.shares.conversationsLabel', 'Conversations')}>
                {detail.conversationCount}
              </DetailRow>
            </div>
            <div {...stylex.props(styles.actions)}>
              {detail.url && (
                <Button size="small" onClick={() => void openExternalUrl(detail.url ?? '')}>
                  {t('settings.shares.openPublished', 'Open published page')}
                </Button>
              )}
              {detail.url && (
                <Button
                  variant="secondary"
                  size="small"
                  disabled={busy}
                  onClick={() => void copy(detail)}
                >
                  {t('settings.shares.copy', 'Copy link')}
                </Button>
              )}
              {detailSource && (
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => openSession(detailSource.id)}
                >
                  {t('settings.shares.openConversation', 'Open conversation')}
                </Button>
              )}
            </div>
            <div {...stylex.props(styles.actions)}>
              {detailSource && (
                <Button
                  variant="secondary"
                  size="small"
                  disabled={busy}
                  onClick={() => {
                    setEditor(detail);
                    setDetail(null);
                  }}
                >
                  {t('sharing.static.update', 'Update deployment')}
                </Button>
              )}
              <Button
                variant="secondary"
                size="small"
                tone="destructive"
                disabled={busy}
                onClick={() => {
                  setRevoking(detail);
                  setDetail(null);
                }}
              >
                {t('sharing.static.revoke', 'Revoke')}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Root>
      )}
      {editor && source && (
        <LanSessionShareDialog
          workspaceId={workspaceId}
          session={source}
          shareId={editor.shareId}
          onClose={() => {
            setEditor(null);
            void refreshLanShares(workspaceId);
          }}
        />
      )}
      <AlertDialog.Root
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('sharing.static.revoke', 'Revoke')}</AlertDialog.Title>
            <AlertDialog.Description>
              {t(
                'sharing.static.invalidateNotice',
                'The previous link will stop working. Downloaded copies cannot be recalled.'
              )}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('common.cancel', 'Cancel')}</AlertDialog.Cancel>
            <AlertDialog.Action
              disabled={busy}
              onClick={() => {
                const share = revoking;
                setRevoking(null);
                if (share) void act(() => revokeLanShare(workspaceId, share.shareId), 'revoke');
              }}
            >
              {t('common.confirm', 'Confirm')}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </div>
  );
}

function DetailRow({
  label,
  ruled,
  children,
}: {
  label: string;
  ruled: boolean;
  children: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.detailRow, ruled && surface.lineRuled)}>
      <span {...stylex.props(styles.detailLabel)}>{label}</span>
      <span {...stylex.props(styles.detailValue)}>{children}</span>
    </div>
  );
}
