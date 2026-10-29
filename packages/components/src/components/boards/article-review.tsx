import * as stylex from '@stylexjs/stylex';
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Send, X } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import type { SessionId } from '@lody/shared';
import type { MarkdownRenderer } from '../ai-gui/markdown-renderer';
import { useArticleAnnotationActions, useThreadArticleAnnotations } from './article-annotations';
import {
  DIFF_ID_ATTRIBUTE,
  markArticleChanges,
  markArticleChangesSeen,
  type ArticleContainer,
  type ArticleDiff,
  type DiffRoot,
} from './article-diff';

const styles = stylex.create({
  group: { display: 'flex', alignItems: 'center', gap: '2px' },
  count: {
    paddingInline: '4px',
    fontSize: '0.75rem',
    color: colors.secondaryLabel,
    whiteSpace: 'nowrap',
  },
});

type Rendered = { readonly containers: ArticleContainer[]; readonly diff: ArticleDiff | null };

/** The rehype step that marks an article's changes and reports what it rendered. */
const rehypeArticleChanges =
  (options: {
    base: readonly ArticleContainer[] | null;
    hiddenChangesLabel: string;
    report: (rendered: Rendered) => void;
  }) =>
  (tree: DiffRoot) => {
    options.report(
      markArticleChanges(tree, options.base, { hiddenChangesLabel: options.hiddenChangesLabel })
    );
  };

export interface ArticleChanges {
  /** Changes not seen yet; each may mark several places (deleted and inserted words). */
  readonly count: number;
  /** The one the reader last moved to, or -1. */
  readonly current: number;
  readonly move: (step: 1 | -1) => void;
  /** Everything shown counts as seen. */
  readonly clear: () => void;
  /** For the article's Markdown renderer: marks the changes in place. */
  readonly rehypePlugins: NonNullable<
    ComponentProps<typeof MarkdownRenderer>['extraRehypePlugins']
  >;
  /** The reader clicked the article: the changes on screen count as seen. */
  readonly seeInView: (viewport: Element) => void;
}

/** Whether a closed `<details>` hides this element (anything but its summary). */
const insideFoldedDetails = (element: Element): boolean => {
  for (
    let details = element.closest('details');
    details;
    details = details.parentElement?.closest('details') ?? null
  )
    if (!details.open && !details.querySelector(':scope > summary')?.contains(element)) return true;
  return false;
};

/** The first element of each change still marked, in document order. */
const changeElements = (root: HTMLElement): HTMLElement[] => {
  const first = new Map<string, HTMLElement>();
  for (const element of root.querySelectorAll<HTMLElement>(`[${DIFF_ID_ATTRIBUTE}]`)) {
    const id = element.getAttribute(DIFF_ID_ATTRIBUTE)!;
    if (!first.has(id)) first.set(id, element);
  }
  return [...first.values()];
};

/**
 * What changed in a Markdown article since the reader last looked, marked in
 * the text itself (`article-diff.ts`). The first revision shown is what the
 * reader has seen; later revisions are compared with it. A click in the
 * article counts the changes on screen as seen, folding them into it; the
 * header can step through the rest or clear them all. Nothing is remembered
 * once the article closes.
 */
export function useArticleChanges(
  root: HTMLElement | null,
  revision: string,
  enabled: boolean
): ArticleChanges {
  const { t } = useTranslation();
  const hiddenChangesLabel = t('sessions.article.changes.hidden', 'Changed inside');
  const [base, setBase] = useState<readonly ArticleContainer[] | null>(null);
  const rendered = useRef<Rendered | null>(null);
  const [count, setCount] = useState(0);
  const [current, setCurrent] = useState(-1);
  const rehypePlugins = useMemo((): ArticleChanges['rehypePlugins'] => {
    if (!enabled) return [];
    const report = (next: Rendered) => {
      rendered.current = next;
    };
    return [[rehypeArticleChanges, { base, hiddenChangesLabel, report }]];
  }, [base, enabled, hiddenChangesLabel]);
  useLayoutEffect(() => {
    if (!enabled || !root || !rendered.current) return;
    // The first revision rendered is what the reader has seen.
    if (!base) {
      setBase(rendered.current.containers);
      return;
    }
    setCount(changeElements(root).length);
    setCurrent(-1);
  }, [base, enabled, revision, root]);
  const move = useCallback(
    (step: 1 | -1) => {
      const elements = root ? changeElements(root) : [];
      if (elements.length === 0) return;
      const next = (current + step + elements.length) % elements.length;
      setCurrent(next);
      // A change inside folded details: unfold them to show it.
      for (
        let details = elements[next].closest('details');
        details;
        details = details.parentElement!.closest('details')
      )
        details.open = true;
      elements[next].scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
    [current, root]
  );
  const clear = useCallback(() => {
    if (rendered.current) setBase(rendered.current.containers);
  }, []);
  const seeInView = useCallback(
    (viewport: Element) => {
      const shown = rendered.current;
      if (!root || !base || !shown?.diff) return;
      const view = viewport.getBoundingClientRect();
      const seen = new Set<number>();
      for (const element of root.querySelectorAll<HTMLElement>(`[${DIFF_ID_ATTRIBUTE}]`)) {
        // Folded away: a closed details still lays its content out on screen.
        if (insideFoldedDetails(element)) continue;
        const box = element.getBoundingClientRect();
        if (box.bottom > view.top && box.top < view.bottom)
          seen.add(Number(element.getAttribute(DIFF_ID_ATTRIBUTE)));
      }
      if (seen.size > 0) setBase(markArticleChangesSeen(base, shown.containers, shown.diff, seen));
    },
    [base, root]
  );
  return { count, current, move, clear, rehypePlugins, seeInView };
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
  const count = changes?.count ?? 0;
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
