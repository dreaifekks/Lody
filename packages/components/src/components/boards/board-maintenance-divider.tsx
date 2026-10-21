import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { useTranslation } from 'react-i18next';
import { isSilentBoardMaintenance, type BoardMaintenanceMeta } from '@lody/shared';
import { formatCompactNumber } from '@/lib/format-compact-number';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';

const styles = stylex.create({
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    paddingBlock: space[4],
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  rule: {
    flexGrow: 1,
    height: '1px',
    opacity: 0.6,
    backgroundImage: `repeating-linear-gradient(to right, ${colors.separator} 0 4px, transparent 4px 7px)`,
  },
  label: { flexShrink: 0, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
});

/**
 * Where Lody tidied a Board coordinator's context or started it a new agent
 * conversation. One quiet line; the turns behind it stay out of the
 * conversation, and everything above it is still the same conversation.
 */
export function BoardMaintenanceDivider({ meta }: { meta: BoardMaintenanceMeta }) {
  const { t, i18n } = useTranslation();
  if (isSilentBoardMaintenance(meta)) return null;
  const locale = toIntlLocaleOrEn(i18n.language);
  const tokens =
    meta.usedBefore !== undefined && meta.usedAfter !== undefined
      ? `${formatCompactNumber(meta.usedBefore, locale)} → ${formatCompactNumber(meta.usedAfter, locale)}`
      : undefined;
  const compact = meta.kind === 'compact';
  const labels: Record<BoardMaintenanceMeta['status'], string> = {
    requested: compact
      ? t(
          'boards.maintenance.compactRequested',
          'Tidy requested · starts when the coordinator is free'
        )
      : t(
          'boards.maintenance.startRequested',
          'New conversation requested · starts when the coordinator is free'
        ),
    running: compact
      ? t('boards.maintenance.compacting', 'Tidying context…')
      : t('boards.maintenance.starting', 'Starting a new conversation…'),
    done: compact
      ? tokens
        ? t('boards.maintenance.compactedTokens', 'Context tidied · {{tokens}}', { tokens })
        : t('boards.maintenance.compacted', 'Context tidied')
      : t('boards.maintenance.started', 'New conversation'),
    unsupported: t('boards.maintenance.unsupported', 'This agent cannot tidy its context'),
    failed: compact
      ? t('boards.maintenance.compactFailed', 'Context not tidied')
      : t('boards.maintenance.startFailed', 'New conversation not started'),
    interrupted: compact
      ? t('boards.maintenance.compactInterrupted', 'Tidying stopped')
      : t('boards.maintenance.startInterrupted', 'New conversation stopped'),
  };
  const label = labels[meta.status];
  return (
    <div role="status" {...stylex.props(styles.row)}>
      <span aria-hidden {...stylex.props(styles.rule)} />
      <span {...stylex.props(styles.label)}>{label}</span>
      <span aria-hidden {...stylex.props(styles.rule)} />
    </div>
  );
}
