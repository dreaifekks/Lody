import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { LayoutDashboard } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import type { SessionMeta } from '@lody/shared';
import { boardEnabledAtom } from '@/atoms/settings';

export const isBoardThread = (
  session: Pick<SessionMeta, 'boardId' | 'boardRole'> | undefined | null
) => !!session?.boardId && session.boardRole !== 'coordinator';

const styles = stylex.create({
  mark: {
    width: '12px',
    height: '12px',
    display: 'inline-block',
    verticalAlign: 'middle',
    marginInlineEnd: '4px',
    flexShrink: 0,
    color: colors.secondaryLabel,
  },
});
export function BoardThreadMark() {
  const { t } = useTranslation();
  const enabled = useAtomValue(boardEnabledAtom);
  if (!enabled) return null;
  return (
    <LayoutDashboard
      {...stylex.props(styles.mark)}
      aria-label={t('boards.thread', 'Board thread')}
    />
  );
}
