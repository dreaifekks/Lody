import * as stylex from '@stylexjs/stylex';
import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Maximize2, Minimize2 } from 'lucide-react';
import { Button } from '@lody/ui/button';

/**
 * The Board side panel's article layout (experimental): the open file tab and
 * the Board panel's thread side by side over the whole session area.
 *
 * Expanding must never change the React tree, or the thread's conversation
 * remounts and loses its composer text and selection chips. Everything here is
 * therefore a class or a style applied to elements that are always rendered:
 * the panel shell turns `fixed`, its body turns into a grid, and the divider is
 * always mounted and only hidden while collapsed.
 */

/** Files a thread can hand over as an article. */
export const isBoardArticlePath = (path: string): boolean =>
  /\.(?:md|markdown|html?)$/iu.test(path);

export const ARTICLE_FOCUS_DEFAULT_RATIO = 60;
const MIN_RATIO = 30;
const MAX_RATIO = 75;

export const articleFocusStyles = stylex.create({
  shell: { position: 'fixed', zIndex: 30, borderLeftWidth: 0 },
  body: { display: 'grid', gridTemplateRows: 'minmax(0, 1fr)' },
  article: { gridColumn: 1, gridRow: 1, minWidth: 0, minHeight: 0 },
  thread: { gridColumn: 3, gridRow: 1, minWidth: 0, minHeight: 0 },
});

const styles = stylex.create({
  divider: {
    position: 'relative',
    gridColumn: 2,
    gridRow: 1,
    width: '1px',
    backgroundColor: 'hsl(var(--border) / 0.7)',
  },
  dividerHidden: { display: 'none' },
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

/** Grid columns for the body: article, divider, thread. */
export const articleFocusColumns = (ratio: number): CSSProperties => ({
  gridTemplateColumns: `minmax(0, ${ratio}fr) 1px minmax(0, ${100 - ratio}fr)`,
});

/**
 * Where the expanded panel sits: over the session area (`root`), measured
 * while expanded so it follows window and navigation-sidebar resizes.
 */
export function useArticleFocusFrame(
  root: RefObject<HTMLElement | null>,
  active: boolean
): CSSProperties | undefined {
  const [frame, setFrame] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    const element = root.current;
    if (!active || !element) {
      setFrame(undefined);
      return undefined;
    }
    const measure = () => {
      const box = element.getBoundingClientRect();
      setFrame({ top: box.top, left: box.left, width: box.width, height: box.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [active, root]);
  return frame;
}

/** The tab row's expand/collapse control for the open article. */
export function ArticleFocusButton({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const label = active
    ? t('sessions.article.collapse', 'Collapse')
    : t('sessions.article.expand', 'Open beside the thread');
  return (
    <Button
      type="button"
      variant="ghost"
      size="small"
      icon
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onToggle}
    >
      {active ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
    </Button>
  );
}

/** Always mounted in the panel body; drawn and draggable only while expanded. */
export function ArticleFocusDivider({
  active,
  ratio,
  onRatioChange,
}: {
  active: boolean;
  ratio: number;
  onRatioChange: (ratio: number) => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const clamp = (value: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
  const fromPointer = (clientX: number) => {
    const body = ref.current?.parentElement?.getBoundingClientRect();
    if (body && body.width > 0) onRatioChange(clamp(((clientX - body.left) / body.width) * 100));
  };
  return (
    <div ref={ref} {...stylex.props(styles.divider, !active && styles.dividerHidden)}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('sessions.article.resize', 'Resize article and thread')}
        aria-valuemin={MIN_RATIO}
        aria-valuemax={MAX_RATIO}
        aria-valuenow={Math.round(ratio)}
        tabIndex={active ? 0 : -1}
        {...stylex.props(styles.handle)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) fromPointer(event.clientX);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onKeyDown={(event) => {
          const step = event.key === 'ArrowLeft' ? -5 : event.key === 'ArrowRight' ? 5 : 0;
          if (step === 0) return;
          event.preventDefault();
          onRatioChange(clamp(ratio + step));
        }}
      />
    </div>
  );
}
