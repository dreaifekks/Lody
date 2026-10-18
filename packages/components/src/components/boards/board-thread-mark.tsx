import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { LayoutDashboard } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { selectAtom } from 'jotai/utils';
import { getSessionRoomId, type SessionId, type SessionMeta } from '@lody/shared';
import { boardEnabledAtom } from '@/atoms/settings';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';

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

/** Only the membership boolean is subscribed, never the full, high-frequency metadata. */
export function SessionBoardThreadMark({ sessionId }: { sessionId: string }) {
  const membership = useMemo(
    () =>
      selectAtom(sessionMetaAtomFamily(getSessionRoomId(sessionId as SessionId)), isBoardThread),
    [sessionId]
  );
  return useAtomValue(membership) ? <BoardThreadMark /> : null;
}
