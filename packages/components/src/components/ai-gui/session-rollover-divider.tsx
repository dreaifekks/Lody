import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { useTranslation } from 'react-i18next';
import { isSilentSessionRollover, type SessionRolloverNoticeMeta } from '@lody/shared';
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
 * Quiet inline divider for linear session node rollovers (`/rollover` or
 * proactive context-threshold rollover). Reuses the exact visual language of
 * `BoardMaintenanceDivider`; underlying `:seal` and `:renew` turns stay hidden.
 */
export function SessionRolloverDivider({ meta }: { meta: SessionRolloverNoticeMeta }) {
  const { t, i18n } = useTranslation();
  if (isSilentSessionRollover(meta)) return null;
  const locale = toIntlLocaleOrEn(i18n.language);
  const gen = meta.generation;
  const tokens =
    meta.usedBefore !== undefined && meta.usedAfter !== undefined
      ? `${formatCompactNumber(meta.usedBefore, locale)} → ${formatCompactNumber(meta.usedAfter, locale)}`
      : undefined;

  const labels: Record<SessionRolloverNoticeMeta['status'], string> = {
    sealing: t('sessions.rollover.sealing', 'Preparing node handoff…'),
    sealed: t('sessions.rollover.sealed', 'Handoff ready · next message starts node #{{gen}}', {
      gen,
    }),
    switching: t('sessions.rollover.switching', 'Switching to node #{{gen}}…', { gen }),
    done: tokens
      ? t('sessions.rollover.doneTokens', 'Switched to node #{{gen}} · {{tokens}}', {
          gen,
          tokens,
        })
      : t('sessions.rollover.done', 'Switched to node #{{gen}}', { gen }),
    failed: t('sessions.rollover.failed', 'Node handoff failed'),
    interrupted: t('sessions.rollover.interrupted', 'Node handoff stopped'),
  };

  return (
    <div role="status" {...stylex.props(styles.row)}>
      <span aria-hidden {...stylex.props(styles.rule)} />
      <span {...stylex.props(styles.label)}>{labels[meta.status]}</span>
      <span aria-hidden {...stylex.props(styles.rule)} />
    </div>
  );
}
