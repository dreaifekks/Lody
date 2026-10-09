import * as stylex from '@stylexjs/stylex';
import { Download } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { ElectronUpdaterState } from '@lody/shared/electron-ipc';
import { resolveLanReleaseChannel, type LanReleaseChannel } from '@lody/shared/lan-release';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { Button } from '@lody/ui/button';
import { Select } from '@lody/ui/select';
import { Spinner } from '@lody/ui/spinner';
import { CompactRow } from './compact-layout';
import { settingsCatalog as catalog } from './surface';

const styles = stylex.create({
  /** What is said about the build, one statement to a line. */
  line: { display: 'block' },
  offer: { color: colors.warning },
  failure: { color: colors.destructive },
});

export type LanAppUpdateProps = {
  /** What keeps this application current says; `null` while it has not. */
  updater: ElectronUpdaterState | null;
  /** Whether an update was started from here and has not failed yet. */
  updating: boolean;
  onCheck: () => void;
  /** Follows the other release of the fork from now on. */
  onFollow: (channel: LanReleaseChannel) => void;
  onUpdate: () => void;
  onViewChanges: () => void;
};

/**
 * The build of this application and the releases it follows, as a row of the
 * group that names this machine. It says one thing at rest: what is on offer
 * or under way, else why nothing can be, else where the build comes from.
 * A second row switches between the two releases of the fork.
 * Nothing is shown for an application that follows no repository: its
 * publisher updates it, and that is said where the publisher's updates are.
 */
export function LanAppUpdate({
  updater,
  updating,
  onCheck,
  onFollow,
  onUpdate,
  onViewChanges,
}: LanAppUpdateProps) {
  const { t } = useTranslation();
  const channelLabelId = useId();
  if (!updater?.followed) return null;

  const { phase } = updater;
  const later = updater.downloadedVersion ?? updater.availableVersion;
  const canUpdate = (phase === 'available' || phase === 'downloaded') && Boolean(later);
  const busy = phase === 'checking' || phase === 'downloading' || updating;
  const follows = t('settings.lan.app.follows', {
    repository: updater.followed.repository,
    tag: updater.followed.tag,
  });
  const standing =
    phase === 'downloading'
      ? t('settings.lan.app.downloading', {
          version: later ?? '',
          percent: Math.round(updater.percent ?? 0),
        })
      : canUpdate
        ? t('settings.lan.app.available', { version: later })
        : phase === 'disabled'
          ? t(`settings.lan.app.disabled.${updater.disabledReason ?? 'unsupported_platform'}`, {
              defaultValue: t('settings.lan.app.disabled.unsupported_platform'),
            })
          : phase === 'up_to_date'
            ? `${t('settings.lan.app.newest')}${t('settings.lan.machines.factSeparator')}${follows}`
            : follows;
  const channel = resolveLanReleaseChannel(updater.followed.tag);
  const channels = (['stable', 'dev'] as const).map((value) => ({
    value,
    label: t(`settings.lan.app.channel.${value}`),
  }));

  return (
    <>
      <CompactRow
        label={t('settings.lan.app.version', { version: updater.currentVersion })}
        helper={
          <>
            <span {...stylex.props(styles.line, canUpdate && styles.offer)}>{standing}</span>
            {updater.error && phase !== 'downloading' ? (
              <span {...stylex.props(styles.line, styles.failure)}>
                {t(canUpdate ? 'settings.lan.app.updateFailed' : 'settings.lan.app.checkFailed', {
                  message: updater.error,
                })}
              </span>
            ) : null}
          </>
        }
      >
        {canUpdate ? (
          <>
            <Button size="small" variant="ghost" onClick={onViewChanges}>
              {t('settings.lan.app.changes')}
            </Button>
            <Button size="small" disabled={busy} onClick={onUpdate}>
              {updating ? <Spinner size="small" /> : <Download {...stylex.props(catalog.icon)} />}
              {t('settings.lan.app.update')}
            </Button>
          </>
        ) : phase === 'disabled' ? null : (
          <Button size="small" variant="secondary" disabled={busy} onClick={onCheck}>
            {busy ? <Spinner size="small" /> : null}
            {t('settings.lan.app.check')}
          </Button>
        )}
      </CompactRow>
      {channel && phase !== 'disabled' ? (
        <CompactRow labelId={channelLabelId} label={t('settings.lan.app.channel.label')}>
          <Select.Root
            items={channels}
            value={channel}
            disabled={busy}
            onValueChange={(value) => {
              if (value === 'stable' || value === 'dev') onFollow(value);
            }}
          >
            <Select.Trigger size="small" aria-labelledby={channelLabelId}>
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {channels.map((option) => (
                <Select.Item key={option.value} value={option.value}>
                  {option.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </CompactRow>
      ) : null}
    </>
  );
}
