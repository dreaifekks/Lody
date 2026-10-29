import * as stylex from '@stylexjs/stylex';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Send, X } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import type { SessionId } from '@lody/shared';
import {
  ARTICLE_BLOCK_SELECTOR,
  useArticleAnnotationActions,
  useThreadArticleAnnotations,
} from './article-annotations';

const styles = stylex.create({
  bar: {
    position: 'absolute',
    width: '3px',
    borderRadius: '2px',
    backgroundColor: colors.accent,
    opacity: 0.55,
    pointerEvents: 'none',
  },
  current: { opacity: 1 },
  group: { display: 'flex', alignItems: 'center', gap: '2px' },
  count: {
    paddingInline: '4px',
    fontSize: '0.75rem',
    color: colors.secondaryLabel,
    whiteSpace: 'nowrap',
  },
});

/** How many times each text occurs among blocks. */
const countTexts = (texts: readonly string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
  return counts;
};

export interface ArticleChanges {
  /**
   * Blocks the reader has not seen yet, in document order: their text was in
   * none of the revisions shown before, since the reader last cleared the marks.
   */
  readonly changed: readonly HTMLElement[];
  /** The one the reader last moved to, or -1. */
  readonly current: number;
  readonly move: (step: 1 | -1) => void;
  readonly clear: () => void;
}

/** A nested block (a list item's paragraph) counts once, as its outermost block. */
const outermost = (blocks: readonly HTMLElement[]): HTMLElement[] =>
  blocks.filter((block) => !blocks.some((other) => other !== block && other.contains(block)));

/**
 * What changed in a rendered Markdown article while the reader had it open:
 * blocks whose text the revision shown before did not hold. The first
 * revision shown is the baseline; marks add up over later revisions (an agent
 * writes in bursts) until the reader clears them, and a mark goes when its
 * text leaves the article.
 */
export function useArticleChanges(
  root: HTMLElement | null,
  revision: string,
  enabled: boolean
): ArticleChanges {
  const seen = useRef<Map<string, number> | null>(null);
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
  const [changed, setChanged] = useState<readonly HTMLElement[]>([]);
  const [current, setCurrent] = useState(-1);
  useLayoutEffect(() => {
    if (!enabled || !root) return;
    const blocks = Array.from(root.querySelectorAll<HTMLElement>(ARTICLE_BLOCK_SELECTOR));
    if (blocks.length === 0) return;
    const texts = blocks.map((block) => block.textContent ?? '');
    const before = seen.current;
    seen.current = countTexts(texts);
    if (!before) return;
    const remaining = new Map(before);
    const fresh = texts.filter((text) => {
      const left = remaining.get(text) ?? 0;
      if (left > 0) {
        remaining.set(text, left - 1);
        return false;
      }
      return text.trim().length > 0;
    });
    const present = new Set(texts);
    setMarked((shown) => {
      const next = new Set([...shown].filter((text) => present.has(text)));
      for (const text of fresh) next.add(text);
      return next.size === shown.size && [...next].every((text) => shown.has(text)) ? shown : next;
    });
  }, [enabled, revision, root]);
  // The marked texts as the blocks now on screen, after every revision.
  useLayoutEffect(() => {
    if (!root) return;
    const blocks = Array.from(root.querySelectorAll<HTMLElement>(ARTICLE_BLOCK_SELECTOR));
    setChanged(outermost(blocks.filter((block) => marked.has(block.textContent ?? ''))));
    setCurrent(-1);
  }, [marked, revision, root]);
  const move = useCallback(
    (step: 1 | -1) => {
      if (changed.length === 0) return;
      const next = (current + step + changed.length) % changed.length;
      setCurrent(next);
      changed[next].scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
    [changed, current]
  );
  const clear = useCallback(() => {
    setMarked(new Set());
    setCurrent(-1);
  }, []);
  return { changed, current, move, clear };
}

interface BarBox {
  readonly top: number;
  readonly height: number;
}

/** A bar in the article's left margin beside each changed block. */
export function ArticleChangeBars({
  root,
  revision,
  changes,
}: {
  /** The rendered Markdown; positioned, so the bars scroll with it. */
  root: HTMLElement | null;
  revision: string;
  changes: ArticleChanges;
}) {
  const [boxes, setBoxes] = useState<readonly BarBox[]>([]);
  useLayoutEffect(() => {
    const element = root;
    if (!element) return undefined;
    const measure = () => {
      const origin = element.getBoundingClientRect();
      setBoxes(
        changes.changed
          .filter((block) => element.contains(block))
          .map((block) => {
            const box = block.getBoundingClientRect();
            return { top: box.top - origin.top, height: box.height };
          })
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [changes.changed, revision, root]);
  return boxes.map((box, index) => (
    <span
      key={index}
      aria-hidden
      data-article-change-bar
      {...stylex.props(styles.bar, index === changes.current && styles.current)}
      style={{ left: 2, top: box.top, height: box.height }}
    />
  ));
}

/**
 * The article header's review controls: the changes since the reader last
 * looked, to step through or dismiss, and the comments waiting for the
 * thread, to send now.
 */
export function ArticleReviewControls({
  threadId,
  changes,
}: {
  /** The thread beside the article, whose next message carries the comments. */
  threadId: SessionId | null;
  changes: ArticleChanges | null;
}) {
  const { t } = useTranslation();
  const waiting = useThreadArticleAnnotations(threadId);
  const { requestSend } = useArticleAnnotationActions();
  const count = changes?.changed.length ?? 0;
  return (
    <>
      {changes && count > 0 ? (
        <div
          {...stylex.props(styles.group)}
          role="group"
          aria-label={t('sessions.article.changes.label', 'Changes since you last looked')}
        >
          <span
            {...stylex.props(styles.count)}
            title={t('sessions.article.changes.count', '{{count}} changed', { count })}
          >
            {changes.current >= 0 ? `${changes.current + 1}/${count}` : count}
          </span>
          <Button
            size="mini"
            variant="ghost"
            icon
            aria-label={t('sessions.article.changes.previous', 'Previous change')}
            onClick={() => changes.move(-1)}
          >
            <ChevronUp size={14} aria-hidden />
          </Button>
          <Button
            size="mini"
            variant="ghost"
            icon
            aria-label={t('sessions.article.changes.next', 'Next change')}
            onClick={() => changes.move(1)}
          >
            <ChevronDown size={14} aria-hidden />
          </Button>
          <Button
            size="mini"
            variant="ghost"
            icon
            aria-label={t('sessions.article.changes.clear', 'Clear change marks')}
            onClick={changes.clear}
          >
            <X size={14} aria-hidden />
          </Button>
        </div>
      ) : null}
      {threadId && waiting.length > 0 ? (
        <Button
          size="mini"
          variant="ghost"
          title={t(
            'sessions.article.annotation.sendHint',
            'Sends with whatever is typed in the thread'
          )}
          onClick={() => requestSend(threadId)}
        >
          <Send size={12} aria-hidden />
          {t('sessions.article.annotation.send', 'Send {{count}} comments', {
            count: waiting.length,
          })}
        </Button>
      ) : null}
    </>
  );
}
