import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';

/** Styles the Board dialogs and editors share. */
export const boardStyles = stylex.create({
  page: { padding: space[6], color: colors.label },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[4],
    minHeight: 0,
    overflowY: 'auto',
    // A scroller clips at its padding box, and a field's focus ring is a shadow
    // outside the field. The inset keeps the ring inside; the bleed keeps the
    // fields aligned with the dialog's title.
    padding: space[1],
    margin: `calc(-1 * ${space[1]})`,
  },
  field: { display: 'flex', flexDirection: 'column', gap: space[2] },
  controls: { display: 'flex', flexWrap: 'wrap', gap: space[2], alignItems: 'center' },
  error: { color: colors.destructive },
});
