import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import type { LodyShowWidgetInput } from '@lody/shared';
import { WidgetFrame } from './widget-frame';

const styles = stylex.create({
  pending: { fontSize: '12px', color: colors.secondaryLabel },
});

/** `lody_show_widget` (and Claude Desktop's `show_widget`) in the conversation. */
export function WidgetToolCall({ input }: { input: LodyShowWidgetInput | null }) {
  const { t } = useTranslation();
  if (!input) {
    return (
      <span role="status" {...stylex.props(styles.pending)}>
        {t('agentSurfaces.widget.drawing', 'Drawing a widget…')}
      </span>
    );
  }
  // A new code is a new widget: remount instead of patching a running page.
  return <WidgetFrame key={input.widget_code} code={input.widget_code} title={input.title} />;
}
