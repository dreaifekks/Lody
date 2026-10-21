import { BoardThreadBreadcrumb } from './board-thread-breadcrumb';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { Tabs } from '@lody/ui/tabs';
import { ArrowLeft, Maximize2, Plus, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { SessionConversationPageHeader } from '../sessions/session-conversation-page';
import { BoardThreadMark } from './board-thread-mark';

/** The Board side panel: threads and the shared directory. A thread opens inside it. */
export type BoardPanelTab = 'threads' | 'files' | 'schedules';

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0 },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    minHeight: '44px',
    flexShrink: 0,
    paddingInline: space[2],
  },
  title: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.bodySize,
    fontWeight: 600,
  },
  crumb: { color: colors.secondaryLabel, flexShrink: 0 },
  spacer: { flex: '1 1 0' },
  location: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '40%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  body: { position: 'relative', flex: '1 1 0', minHeight: 0, overflow: 'auto' },
  fill: { position: 'relative', flex: '1 1 0', minHeight: 0 },
});

/** The resting panel: the Board's threads and files, one tab each. */
export function BoardPanelView({
  tab,
  onTabChange,
  onNewThread,
  children,
}: {
  tab: BoardPanelTab;
  onTabChange: (tab: BoardPanelTab) => void;
  /** Absent for an archived Board. */
  onNewThread?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Tabs.Root
      value={tab}
      onValueChange={(value: BoardPanelTab) => onTabChange(value)}
      {...stylex.props(styles.root)}
    >
      <header {...stylex.props(styles.header)}>
        <Tabs.List size="small">
          <Tabs.Tab value="threads">{t('boards.threads', 'Threads')}</Tabs.Tab>
          <Tabs.Tab value="schedules">{t('boards.schedules.title', 'Schedules')}</Tabs.Tab>
          <Tabs.Tab value="files">{t('boards.files.title', 'Board files')}</Tabs.Tab>
        </Tabs.List>
        <span {...stylex.props(styles.spacer)} />
        {tab === 'threads' && onNewThread ? (
          <Button
            variant="ghost"
            size="small"
            icon
            aria-label={t('boards.newThread', '+ New thread')}
            onClick={onNewThread}
          >
            <Plus size={16} />
          </Button>
        ) : null}
      </header>
      <div {...stylex.props(styles.body)}>{children}</div>
    </Tabs.Root>
  );
}

/**
 * One thread inside the panel, with its own conversation and composer, so the
 * user steers it without leaving the coordinator. Open leaves for the full
 * Session page.
 */
export function BoardThreadPaneView({
  title,
  parentThread,
  location,
  onBack,
  onOpenFull,
  menuSlot,
  onStop,
  children,
}: {
  title: string;
  parentThread?: { title: string; onOpen: () => void };
  /** "devnuc · Lody": where a project-bound thread runs. */
  location?: string;
  onBack: () => void;
  onOpenFull: () => void;
  menuSlot?: ReactNode;
  onStop?: () => void;
  children: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.root)}>
      <BoardThreadHeader
        title={title}
        parentThread={parentThread}
        location={location}
        menuSlot={menuSlot}
        onStop={onStop}
        startSlot={<BoardThreadBackButton onBack={onBack} />}
        endSlot={<BoardThreadOpenButton onOpen={onOpenFull} />}
      />
      <div {...stylex.props(styles.fill)}>{children}</div>
    </div>
  );
}

export function BoardThreadBackButton({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      variant="ghost"
      size="small"
      icon
      aria-label={t('boards.home.backToThreads', 'Back to threads')}
      onClick={onBack}
    >
      <ArrowLeft size={16} aria-hidden />
    </Button>
  );
}

export function BoardThreadOpenButton({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      variant="ghost"
      size="small"
      icon
      aria-label={t('boards.home.openThread', 'Open as a full conversation')}
      onClick={onOpen}
    >
      <Maximize2 size={14} aria-hidden />
    </Button>
  );
}

export function BoardThreadHeader({
  title,
  parentThread,
  location,
  startSlot,
  endSlot,
  menuSlot,
  desktopActionsSlot,
  onStop,
}: {
  title: string;
  parentThread?: { title: string; onOpen: () => void };
  location?: string;
  startSlot?: ReactNode;
  endSlot?: ReactNode;
  menuSlot?: ReactNode;
  desktopActionsSlot?: ReactNode;
  onStop?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <SessionConversationPageHeader
      startSlot={startSlot}
      titleSlot={
        <>
          <BoardThreadMark />
          <span {...stylex.props(styles.title)}>
            {parentThread ? (
              <BoardThreadBreadcrumb
                parentTitle={parentThread.title}
                title={title}
                onOpenParent={parentThread.onOpen}
              />
            ) : (
              title
            )}
          </span>
        </>
      }
      desktopActionsSlot={
        <>
          {desktopActionsSlot}
          {location ? (
            <span title={location} {...stylex.props(styles.location)}>
              {location}
            </span>
          ) : null}
        </>
      }
      menuSlot={
        <>
          {onStop ? (
            <Button
              variant="ghost"
              size="small"
              icon
              aria-label={t('sessions.stop', 'Stop')}
              onClick={onStop}
            >
              <Square size={14} />
            </Button>
          ) : null}
          {menuSlot}
        </>
      }
      endSlot={endSlot}
      sidePanel
    />
  );
}
