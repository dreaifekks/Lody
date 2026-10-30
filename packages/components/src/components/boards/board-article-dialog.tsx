import * as stylex from '@stylexjs/stylex';
import { createContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@lody/ui/dialog';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { RelocatableSlot, type RelocatableHost } from './relocatable-host';

/** Files a Board thread can hand over as an article. */
export const isBoardArticlePath = (path: string): boolean =>
  /\.(?:md|markdown|html?)$/iu.test(path);

const DEFAULT_RATIO = 60;
/** A comparison of UI options wants the room more than the conversation does. */
const WIDE_RATIO = 75;
const MIN_RATIO = 30;
const MAX_RATIO = 75;

const PANEL_STYLE = {
  width: 'calc(100vw - 88px)',
  maxWidth: 'none',
  height: 'calc(100dvh - 88px)',
  maxHeight: 'none',
  padding: 0,
  gap: 0,
  overflow: 'hidden',
} as const;

const styles = stylex.create({
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  },
  dismiss: { position: 'absolute', inset: 0 },
  body: {
    display: 'grid',
    height: '100%',
    minHeight: 0,
    gridTemplateRows: 'minmax(0, 1fr)',
  },
  pane: { position: 'relative', minWidth: 0, minHeight: 0, overflow: 'hidden' },
  thread: { height: '100%', minHeight: 0 },
  divider: { position: 'relative', width: '1px', backgroundColor: colors.separator },
  handle: {
    position: 'absolute',
    insetBlock: 0,
    left: '-4px',
    width: '9px',
    zIndex: 1,
    cursor: 'col-resize',
    touchAction: 'none',
    outline: { default: 'none', ':focus-visible': '2px solid hsl(var(--ring) / 0.6)' },
  },
});

/**
 * Lets the article fold the conversation beside it away, and bring it back.
 * The conversation stays mounted, only out of sight.
 */
export const ArticleDialogThreadContext = createContext<{
  readonly hidden: boolean;
  readonly setHidden: (hidden: boolean) => void;
} | null>(null);

/**
 * A thread's article over the page, with the thread's own conversation beside
 * it (experimental). The conversation is not a second one: the page portals
 * the thread's single conversation into `threadHost`, and this dialog's right
 * pane claims it while open, so its composer text, chips and scroll stay as
 * they were on both sides. Only the backdrop dismisses by pointer: menus and
 * dialogs the conversation opens are not this dialog's descendants.
 */
export function BoardArticleDialog({
  title,
  article,
  threadHost,
  holdsThread = true,
  wide = false,
  onPanelChange,
  onClose,
}: {
  title: string;
  article: ReactNode;
  /** Starts with more room for the article. */
  wide?: boolean;
  threadHost: RelocatableHost;
  /**
   * False for the one commit before the dialog unmounts, so the conversation
   * moves back while both places are still in the document.
   */
  holdsThread?: boolean;
  /** The panel element, so the conversation's popups can mount inside it. */
  onPanelChange: (panel: HTMLElement | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [ratio, setRatio] = useState(wide ? WIDE_RATIO : DEFAULT_RATIO);
  const [threadHidden, setThreadHidden] = useState(false);
  const thread = useMemo(
    () => ({ hidden: threadHidden, setHidden: setThreadHidden }),
    [threadHidden]
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  const clamp = (value: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
  const fromPointer = (clientX: number) => {
    const body = bodyRef.current?.getBoundingClientRect();
    if (body && body.width > 0) setRatio(clamp(((clientX - body.left) / body.width) * 100));
  };
  return (
    <Dialog.Root
      open
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Content
        ref={onPanelChange}
        closeButton={false}
        style={PANEL_STYLE}
        backdropContent={
          <div {...stylex.props(styles.dismiss)} data-article-dismiss onClick={onClose} />
        }
      >
        <Dialog.Title {...stylex.props(styles.srOnly)}>{title}</Dialog.Title>
        <div
          ref={bodyRef}
          {...stylex.props(styles.body)}
          style={{
            gridTemplateColumns: threadHidden
              ? 'minmax(0, 1fr) 0 0'
              : `minmax(0, ${ratio}fr) 1px minmax(0, ${100 - ratio}fr)`,
          }}
        >
          <div {...stylex.props(styles.pane)}>
            <ArticleDialogThreadContext.Provider value={thread}>
              {article}
            </ArticleDialogThreadContext.Provider>
          </div>
          <div {...stylex.props(styles.divider)} hidden={threadHidden}>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('sessions.article.resize', 'Resize article and thread')}
              aria-valuemin={MIN_RATIO}
              aria-valuemax={MAX_RATIO}
              aria-valuenow={Math.round(ratio)}
              tabIndex={0}
              {...stylex.props(styles.handle)}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  fromPointer(event.clientX);
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onKeyDown={(event) => {
                const step = event.key === 'ArrowLeft' ? -5 : event.key === 'ArrowRight' ? 5 : 0;
                if (step === 0) return;
                event.preventDefault();
                setRatio(clamp(ratio + step));
              }}
            />
          </div>
          <div {...stylex.props(styles.pane)} inert={threadHidden}>
            {/* Held over the Board panel's slot, even one that remounts meanwhile. */}
            <RelocatableSlot
              host={threadHost}
              priority={1}
              held={holdsThread}
              className={stylex.props(styles.thread).className}
            />
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
