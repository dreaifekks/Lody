import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { Badge } from '@lody/ui/badge';
import { Tabs } from '@lody/ui/tabs';
import {
  ArrowLeft,
  Hand,
  LayoutDashboard,
  Maximize2,
  PanelRight,
  Plus,
  Settings2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { CONVERSATION_CONTENT_WIDTH_CLASS } from '@/lib/conversation-layout';

/** A Board is a conversation with the coordinator plus one side panel. */
export type BoardPanelTab = 'threads' | 'files';

const PANEL_WIDTH = '420px';

const styles = stylex.create({
  root: {
    position: 'relative',
    display: 'flex',
    height: '100%',
    minHeight: 0,
    minWidth: 0,
    backgroundColor: colors.background,
    color: colors.label,
  },
  main: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minWidth: 0, minHeight: 0 },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    height: '44px',
    flexShrink: 0,
    paddingInline: space[3],
  },
  name: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.bodySize,
    fontWeight: 600,
  },
  glyph: { flexShrink: 0, color: colors.secondaryLabel },
  spacer: { flex: '1 1 0' },
  conversation: { flex: '1 1 0', minHeight: 0, overflow: 'auto' },
  composer: { flexShrink: 0, paddingInline: space[4], paddingBottom: space[3] },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    width: PANEL_WIDTH,
    flexShrink: 0,
    minHeight: 0,
    boxShadow: `inset 1px 0 0 ${colors.separator}`,
    backgroundColor: colors.background,
  },
  /** Narrow windows: the panel covers the conversation instead of sitting beside it. */
  panelNarrow: { position: 'absolute', inset: 0, width: '100%', boxShadow: 'none', zIndex: 20 },
  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    height: '44px',
    flexShrink: 0,
    paddingInline: space[2],
  },
  panelTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.bodySize,
    fontWeight: 600,
  },
  crumb: { color: colors.secondaryLabel, flexShrink: 0 },
  panelBody: { flex: '1 1 0', minHeight: 0, overflow: 'auto' },
  waiting: { display: 'inline-flex', alignItems: 'center', gap: space[1] },
  waitingMark: { color: colors.warning },
});

export interface BoardHomeViewProps {
  name: string;
  /** Only when the Board is narrowed to chosen projects; "all projects" draws nothing. */
  scopeLabel?: string;
  /** Members waiting for the user. Shown on the panel toggle only while the panel is closed. */
  waitingCount: number;
  panelOpen: boolean;
  narrow?: boolean;
  onTogglePanel: () => void;
  onOpenSettings: () => void;
  conversation: ReactNode;
  composer: ReactNode;
  panel: ReactNode;
}

/**
 * The Board's main surface. The centre is the coordinator conversation — the
 * Board is opened like a chat — and every other Board surface (threads, files,
 * a thread, settings) takes turns in the one panel on the right.
 */
export function BoardHomeView({
  name,
  scopeLabel,
  waitingCount,
  panelOpen,
  narrow = false,
  onTogglePanel,
  onOpenSettings,
  conversation,
  composer,
  panel,
}: BoardHomeViewProps) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.root)} data-board-home="">
      <section {...stylex.props(styles.main)} aria-label={name}>
        <header {...stylex.props(styles.header)}>
          <LayoutDashboard size={16} aria-hidden {...stylex.props(styles.glyph)} />
          <h1 {...stylex.props(styles.name)}>{name}</h1>
          {scopeLabel !== undefined ? <Badge>{scopeLabel}</Badge> : null}
          <span {...stylex.props(styles.spacer)} />
          <Button
            variant="ghost"
            size="small"
            aria-pressed={panelOpen}
            aria-label={t('boards.home.togglePanel', 'Threads and files')}
            onClick={onTogglePanel}
          >
            {!panelOpen && waitingCount > 0 ? (
              <span {...stylex.props(styles.waiting)}>
                <Hand size={14} aria-hidden {...stylex.props(styles.waitingMark)} />
                {t('boards.home.waitingCount', '{{count}} waiting for you', {
                  count: waitingCount,
                })}
              </span>
            ) : (
              <PanelRight size={16} aria-hidden />
            )}
          </Button>
          <Button
            variant="ghost"
            size="small"
            icon
            aria-label={t('boards.settings.title', 'Board settings')}
            onClick={onOpenSettings}
          >
            <Settings2 size={16} />
          </Button>
        </header>
        <div {...stylex.props(styles.conversation)}>{conversation}</div>
        <div {...stylex.props(styles.composer)}>
          <div className={CONVERSATION_CONTENT_WIDTH_CLASS}>{composer}</div>
        </div>
      </section>
      {panelOpen ? (
        <aside {...stylex.props(styles.panel, narrow && styles.panelNarrow)}>{panel}</aside>
      ) : null}
    </div>
  );
}

/** The resting panel: the Board's threads and files, one tab each. */
export function BoardPanelView({
  tab,
  onTabChange,
  onNewThread,
  onClose,
  children,
}: {
  tab: BoardPanelTab;
  onTabChange: (tab: BoardPanelTab) => void;
  onNewThread: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Tabs.Root
      value={tab}
      onValueChange={(value: BoardPanelTab) => onTabChange(value)}
      {...stylex.props(styles.main)}
    >
      <header {...stylex.props(styles.panelHeader)}>
        <Tabs.List size="small">
          <Tabs.Tab value="threads">{t('boards.threads', 'Threads')}</Tabs.Tab>
          <Tabs.Tab value="files">{t('boards.files.title', 'Files')}</Tabs.Tab>
        </Tabs.List>
        <span {...stylex.props(styles.spacer)} />
        {tab === 'threads' ? (
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
        <Button
          variant="ghost"
          size="small"
          icon
          aria-label={t('boards.home.closePanel', 'Close panel')}
          onClick={onClose}
        >
          <X size={16} />
        </Button>
      </header>
      <div {...stylex.props(styles.panelBody)}>{children}</div>
    </Tabs.Root>
  );
}

/**
 * One thread inside the panel: its own conversation and composer, so the user
 * steers it without leaving the coordinator. "Open" leaves for the full Session.
 */
export function BoardThreadPaneView({
  title,
  status,
  onBack,
  onOpenFull,
  onClose,
  conversation,
  composer,
}: {
  title: string;
  status?: ReactNode;
  onBack: () => void;
  onOpenFull: () => void;
  onClose: () => void;
  conversation: ReactNode;
  composer: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.main)}>
      <header {...stylex.props(styles.panelHeader)}>
        <Button
          variant="ghost"
          size="small"
          aria-label={t('boards.home.backToThreads', 'Back to threads')}
          onClick={onBack}
        >
          <ArrowLeft size={16} aria-hidden />
          <span {...stylex.props(styles.crumb)}>{t('boards.threads', 'Threads')}</span>
        </Button>
        <span {...stylex.props(styles.panelTitle)}>{title}</span>
        {status}
        <span {...stylex.props(styles.spacer)} />
        <Button
          variant="ghost"
          size="small"
          icon
          aria-label={t('boards.home.openThread', 'Open as a full conversation')}
          onClick={onOpenFull}
        >
          <Maximize2 size={14} />
        </Button>
        <Button
          variant="ghost"
          size="small"
          icon
          aria-label={t('boards.home.closePanel', 'Close panel')}
          onClick={onClose}
        >
          <X size={16} />
        </Button>
      </header>
      <div {...stylex.props(styles.panelBody)}>{conversation}</div>
      <div {...stylex.props(styles.composer)}>{composer}</div>
    </div>
  );
}

/** Settings take the same panel, with their own title and a way back. */
export function BoardSettingsPaneView({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.main)}>
      <header {...stylex.props(styles.panelHeader)}>
        <span {...stylex.props(styles.panelTitle)}>
          {t('boards.settings.title', 'Board settings')}
        </span>
        <span {...stylex.props(styles.spacer)} />
        <Button
          variant="ghost"
          size="small"
          icon
          aria-label={t('boards.home.closePanel', 'Close panel')}
          onClick={onClose}
        >
          <X size={16} />
        </Button>
      </header>
      <div {...stylex.props(styles.panelBody)}>{children}</div>
    </div>
  );
}
