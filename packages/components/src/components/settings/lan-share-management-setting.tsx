import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import type { SessionId, WorkspaceId } from '@lody/shared';
import type {
  LanSharedConversation,
  LanShareImageKind,
  LanShareSettingsResult,
} from '@lody/shared/lan-share';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '@/atoms';
import { settingsDialogOpenAtom } from '@/atoms/settings';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { LanSessionShareDialog } from '@/components/sharing/lan-session-share-dialog';
import {
  LanShareSettingsError,
  readLanShareSettings,
  refreshLanShares,
  revokeLanShare,
  saveLanShareImage,
  saveLanSharePublicUrl,
  useLanShares,
} from '@/lib/lan-session-share';
import { openExternalUrl } from '@/lib/native-browser';
import { sessionShareErrorMessage } from '@/lib/session-share-errors';
import { AlertDialog, Dialog } from '@/ui/dialog';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Skeleton } from '@lody/ui/skeleton';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { focus, radius, space, text as uiText } from '@lody/ui/tokens/scales.stylex';
import { CompactLinkRow, SettingsEmptyList, settingsRecordsCard } from './compact-layout';
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
  imageRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[4],
    paddingBlock: space[1.5],
    fontSize: '12px',
  },
  imageLabel: { width: '64px', flexShrink: 0, color: colors.secondaryLabel },
  imageValue: { flexGrow: 1, minWidth: 0, color: colors.label },
  imageActions: { display: 'flex', gap: space[1], flexShrink: 0 },
  file: { display: 'none' },
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
      {state.status === 'ready' && <LanSharePagesSetting workspaceId={workspaceId} />}
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

/**
 * Where readers reach the shares, and the favicon and link-preview picture of
 * the pages: what every share of this LAN's hub has in common.
 */
function LanSharePagesSetting({ workspaceId }: { workspaceId: WorkspaceId }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<LanShareSettingsResult | null>(null);
  const [editing, setEditing] = useState<'address' | 'images' | null>(null);
  useEffect(() => {
    let current = true;
    readLanShareSettings(workspaceId).then(
      (next) => current && setSettings(next),
      () => undefined
    );
    return () => {
      current = false;
    };
  }, [workspaceId]);
  if (!settings) return null;

  const imagesLabel =
    settings.icon && settings.preview
      ? t('settings.shares.customIconAndPreview', 'Custom icon and preview image')
      : settings.icon
        ? t('settings.shares.customIcon', 'Custom icon')
        : settings.preview
          ? t('settings.shares.customPreview', 'Custom preview image')
          : 'Lody';
  return (
    <div {...stylex.props(settingsRecordsCard)}>
      <div {...stylex.props(surface.line)}>
        <CompactLinkRow
          to="open"
          label={t('settings.shares.address', 'Address')}
          helper={settings.publicUrl ?? settings.hubUrl ?? '—'}
          onClick={() => setEditing('address')}
        />
      </div>
      <div {...stylex.props(surface.line, surface.lineRuled)}>
        <CompactLinkRow
          to="open"
          label={t('settings.shares.images', 'Icon and preview image')}
          helper={imagesLabel}
          onClick={() => setEditing('images')}
        />
      </div>
      {editing === 'address' && (
        <LanShareAddressDialog
          workspaceId={workspaceId}
          settings={settings}
          onSaved={setSettings}
          onClose={() => setEditing(null)}
        />
      )}
      {editing === 'images' && (
        <LanShareImagesDialog
          workspaceId={workspaceId}
          settings={settings}
          onSaved={setSettings}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

type SettingsDialogProps = {
  workspaceId: WorkspaceId;
  settings: LanShareSettingsResult;
  onSaved: (settings: LanShareSettingsResult) => void;
  onClose: () => void;
};

function useSettingsAction(onSaved: (settings: LanShareSettingsResult) => void) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<LanShareSettingsResult>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await action());
      return true;
    } catch (cause) {
      const code = cause instanceof LanShareSettingsError ? cause.code : 'failed';
      setError(
        code === 'too_large'
          ? t('settings.shares.imageTooLarge', 'The image is too large.')
          : code === 'unsupported'
            ? t('settings.shares.imageUnsupported', 'Use a PNG, JPEG or WebP image.')
            : code === 'invalid_address'
              ? t('settings.shares.addressInvalid', 'Enter an http or https address.')
              : t('settings.shares.lanUnreachable', 'The host of this LAN did not answer.')
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function LanShareAddressDialog({ workspaceId, settings, onSaved, onClose }: SettingsDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(settings.publicUrl ?? '');
  const { busy, error, run } = useSettingsAction(onSaved);
  const save = async (publicUrl: string | null) => {
    if (await run(() => saveLanSharePublicUrl(workspaceId, publicUrl))) onClose();
  };
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>{t('settings.shares.address', 'Address')}</Dialog.Title>
        </Dialog.Header>
        <Input
          aria-label={t('settings.shares.address', 'Address')}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={settings.hubUrl ?? 'https://'}
          spellCheck={false}
          autoFocus
        />
        {error && (
          <p role="alert" {...stylex.props(styles.error)}>
            {error}
          </p>
        )}
        <Dialog.Footer>
          {settings.publicUrl && (
            <Button
              variant="secondary"
              size="small"
              disabled={busy}
              onClick={() => void save(null)}
            >
              {t('settings.shares.useHostAddress', 'Use host address')}
            </Button>
          )}
          <Button
            size="small"
            disabled={busy || value.trim() === (settings.publicUrl ?? '')}
            onClick={() => void save(value.trim() || null)}
          >
            {t('common.save', 'Save')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

const IMAGE_ACCEPT: Record<LanShareImageKind, string> = {
  icon: 'image/png,image/jpeg,image/webp,image/x-icon,.ico',
  preview: 'image/png,image/jpeg,image/webp',
};

function LanShareImagesDialog({ workspaceId, settings, onSaved, onClose }: SettingsDialogProps) {
  const { t } = useTranslation();
  const { busy, error, run } = useSettingsAction(onSaved);
  const inputs = useRef<Partial<Record<LanShareImageKind, HTMLInputElement | null>>>({});
  const choose = (kind: LanShareImageKind, file: File | undefined) => {
    if (!file) return;
    void run(async () =>
      saveLanShareImage(workspaceId, kind, new Uint8Array(await file.arrayBuffer()))
    );
  };
  const rows: Array<{ kind: LanShareImageKind; label: string }> = [
    { kind: 'icon', label: t('settings.shares.icon', 'Icon') },
    { kind: 'preview', label: t('settings.shares.preview', 'Preview image') },
  ];
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>{t('settings.shares.images', 'Icon and preview image')}</Dialog.Title>
        </Dialog.Header>
        <div>
          {rows.map(({ kind, label }, index) => (
            <div key={kind} {...stylex.props(styles.imageRow, index > 0 && surface.lineRuled)}>
              <span {...stylex.props(styles.imageLabel)}>{label}</span>
              <span {...stylex.props(styles.imageValue)}>
                {settings[kind] ? t('settings.shares.custom', 'Custom') : 'Lody'}
              </span>
              <span {...stylex.props(styles.imageActions)}>
                <input
                  ref={(node) => {
                    inputs.current[kind] = node;
                  }}
                  type="file"
                  accept={IMAGE_ACCEPT[kind]}
                  aria-label={label}
                  {...stylex.props(styles.file)}
                  onChange={(event) => {
                    choose(kind, event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
                <Button
                  variant="secondary"
                  size="small"
                  disabled={busy}
                  onClick={() => inputs.current[kind]?.click()}
                >
                  {t('settings.shares.chooseImage', 'Choose…')}
                </Button>
                {settings[kind] && (
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={busy}
                    onClick={() => void run(() => saveLanShareImage(workspaceId, kind, null))}
                  >
                    {t('settings.shares.useLodyImage', 'Use Lody')}
                  </Button>
                )}
              </span>
            </div>
          ))}
        </div>
        {error && (
          <p role="alert" {...stylex.props(styles.error)}>
            {error}
          </p>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}
