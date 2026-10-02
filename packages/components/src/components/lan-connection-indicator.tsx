import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { useLanHubLatency, useLanOfWorkspace } from '@/hooks/use-lan-hub-latency';

const styles = stylex.create({
  root: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: '4px',
    fontSize: '0.75em',
    fontVariantNumeric: 'tabular-nums',
    color: colors.tertiaryLabel,
  },
  dot: { width: '6px', height: '6px', borderRadius: '50%', backgroundColor: colors.success },
  silent: { backgroundColor: colors.destructive },
  silentText: { color: colors.destructive },
});

/**
 * How the hub of the workspace's LAN answers, after the LAN's name while the
 * workspace is connected: a dot and the hub's round trip, or that it does not
 * answer. Nothing for a workspace no LAN carries. A leaf, so each measurement
 * re-renders only this.
 */
export function LanConnectionIndicator({ workspaceId }: { workspaceId: string | null }) {
  const { t } = useTranslation();
  const lan = useLanOfWorkspace(workspaceId);
  const latency = useLanHubLatency(lan?.id);
  if (!lan || latency === undefined) return null;

  const address = lan.url.replace(/^https?:\/\//, '');
  const label =
    latency === null
      ? t('sidebar.lanStatus.noAnswer', 'The hub at {{address}} does not answer', { address })
      : t('sidebar.lanStatus.latency', 'Hub {{address}} answers in {{ms}} ms', {
          address,
          ms: latency,
        });
  return (
    <span {...stylex.props(styles.root)} title={label} aria-label={label} data-lan-latency>
      <span aria-hidden="true" {...stylex.props(styles.dot, latency === null && styles.silent)} />
      <span aria-hidden="true" {...stylex.props(latency === null && styles.silentText)}>
        {latency === null
          ? t('sidebar.lanStatus.noAnswerShort', 'No answer')
          : t('sidebar.lanStatus.ms', '{{ms}} ms', { ms: latency })}
      </span>
    </span>
  );
}
