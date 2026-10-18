import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { selectAtom } from 'jotai/utils';
import { getSessionRoomId, type SessionId, type SessionMeta } from '@lody/shared';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { boardEnabledAtom } from '@/atoms/settings';
import {
  BOARD_SESSION_TITLE_SEPARATOR,
  formatBoardSessionTitle,
  resolveBoardThreadParent,
} from './board-threads';

const styles = stylex.create({
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    minWidth: 0,
    maxWidth: '100%',
    whiteSpace: 'nowrap',
    verticalAlign: 'middle',
  },
  withTitle: { display: 'flex', flex: '1 1 0', width: '100%', overflow: 'hidden' },
  parentWithTitle: { maxWidth: 'min(30%, 7em)' },
  parent: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    minWidth: 0,
    maxWidth: '45%',
    flex: '0 1 auto',
  },
  prefix: { maxWidth: '12em' },
  parentText: {
    paddingInline: `calc(${space[1]} / 2)`,
    paddingBlock: `calc(${space[1]} / 2)`,
    color: colors.secondaryLabel,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  separator: { flexShrink: 0, color: colors.secondaryLabel },
  title: {
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

/** Without `title`, the actual Session tab to its right supplies the child title. */
export function BoardThreadBreadcrumb({
  parentTitle,
  title,
  onOpenParent,
}: {
  parentTitle: string;
  title?: string;
  onOpenParent: () => void;
}) {
  const { t } = useTranslation();
  return (
    <span
      {...stylex.props(styles.root, title !== undefined && styles.withTitle)}
      title={title === undefined ? parentTitle : formatBoardSessionTitle(parentTitle, title)}
    >
      <span
        {...stylex.props(
          styles.parent,
          title === undefined ? styles.prefix : styles.parentWithTitle
        )}
      >
        <Button
          variant="link"
          focusRing="inset"
          size="mini"
          title={parentTitle}
          aria-label={t('boards.openParentThread', 'Open parent thread: {{title}}', {
            title: parentTitle,
          })}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onOpenParent();
          }}
        >
          <span {...stylex.props(styles.parentText)}>{parentTitle}</span>
        </Button>
      </span>
      <span {...stylex.props(styles.separator)} aria-hidden>
        {BOARD_SESSION_TITLE_SEPARATOR}
      </span>
      {title !== undefined ? <span {...stylex.props(styles.title)}>{title}</span> : null}
    </span>
  );
}

/** A page-level breadcrumb subscribes only to its parent's title/membership, never its activity. */
export function BoardThreadParentBreadcrumb({
  session,
  onOpenParent,
}: {
  session: SessionMeta;
  onOpenParent: (id: SessionId) => void;
}) {
  const { t } = useTranslation();
  const enabled = useAtomValue(boardEnabledAtom);
  const boardId = session.boardId;
  const parentId = session.parentSessionId ?? session.openedBySessionId;
  const parentAtom = useMemo(
    () =>
      selectAtom(
        sessionMetaAtomFamily(getSessionRoomId(parentId ?? ('' as SessionId))),
        (meta) => {
          const parent = resolveBoardThreadParent(
            { boardId, parentSessionId: parentId },
            () => meta
          );
          return parent ? { id: parent.id, title: parent.title } : null;
        },
        (a, b) => a?.id === b?.id && a?.title === b?.title
      ),
    [boardId, parentId]
  );
  const parent = useAtomValue(parentAtom);
  return enabled && parent ? (
    <BoardThreadBreadcrumb
      parentTitle={parent.title || t('boards.untitled', 'Untitled session')}
      onOpenParent={() => onOpenParent(parent.id)}
    />
  ) : null;
}
