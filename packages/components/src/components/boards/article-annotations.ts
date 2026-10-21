import { atom, useAtomValue, useSetAtom } from 'jotai';
import { useMemo } from 'react';
import type { SessionId } from '@lody/shared';
import type { SourceLineRange } from '@/lib/document-selection';

/**
 * A comment on a passage of a Board thread's Markdown article (experimental).
 * It waits beside the article until the thread's next message carries it.
 */
export interface ArticleAnnotation {
  readonly id: string;
  /** The thread whose next message carries it: the one beside the article. */
  readonly threadId: SessionId;
  /** The article: the thread whose workspace holds the file, and its path there. */
  readonly ownerThreadId: SessionId;
  readonly path: string;
  readonly quote: string;
  readonly comment: string;
  /** Source lines of the quote, when the Markdown places it unambiguously. */
  readonly lines: SourceLineRange | null;
  /** The rendered block the selection starts in: its index among blocks, and its text. */
  readonly block: { readonly index: number; readonly text: string };
}

/** Rendered Markdown blocks a comment can sit at the end of. */
export const ARTICLE_BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, dt, dd';

/** In memory only: a restart drops unsent comments. */
export const articleAnnotationsAtom = atom<readonly ArticleAnnotation[]>([]);

const EMPTY: readonly ArticleAnnotation[] = [];

/** Comments the thread's next message carries. */
export function useThreadArticleAnnotations(
  threadId: SessionId | null | undefined
): readonly ArticleAnnotation[] {
  const all = useAtomValue(articleAnnotationsAtom);
  return useMemo(
    () => (threadId ? all.filter((item) => item.threadId === threadId) : EMPTY),
    [all, threadId]
  );
}

let nextAnnotationId = 0;

export function useArticleAnnotationActions() {
  const set = useSetAtom(articleAnnotationsAtom);
  return useMemo(
    () => ({
      add: (annotation: Omit<ArticleAnnotation, 'id'>) =>
        set((items) => [...items, { ...annotation, id: `annotation-${++nextAnnotationId}` }]),
      update: (id: string, comment: string) =>
        set((items) => items.map((item) => (item.id === id ? { ...item, comment } : item))),
      remove: (ids: ReadonlySet<string>) => set((items) => items.filter((item) => !ids.has(item.id))),
    }),
    [set]
  );
}

/** The block a selection starts in, as an annotation records it. */
export function articleBlockOf(root: HTMLElement, range: Range): ArticleAnnotation['block'] {
  const node = range.startContainer;
  const element = node instanceof Element ? node : node.parentElement!;
  const block = element.closest<HTMLElement>(ARTICLE_BLOCK_SELECTOR) ?? element;
  return {
    index: Array.from(root.querySelectorAll(ARTICLE_BLOCK_SELECTOR)).indexOf(block),
    text: block.textContent ?? '',
  };
}

/**
 * The rendered block an annotation belongs to now. The agent may have
 * rewritten the article since: the recorded block, else the block with the
 * same text, else one holding the quote, else the nearest index, so a comment
 * stays reachable.
 */
export function resolveArticleBlock(
  blocks: readonly HTMLElement[],
  annotation: ArticleAnnotation
): HTMLElement | undefined {
  const { index, text } = annotation.block;
  if (blocks[index]?.textContent === text) return blocks[index];
  const quoteStart = annotation.quote.split('\n')[0].trim();
  return (
    blocks.find((block) => block.textContent === text) ??
    blocks.find((block) => block.textContent?.includes(quoteStart)) ??
    blocks[Math.min(Math.max(index, 0), blocks.length - 1)]
  );
}

const indent = (text: string, prefix: string) =>
  text
    .split('\n')
    .map((line) => (line ? `${prefix}${line}` : prefix.trimEnd()))
    .join('\n');

/**
 * The comments as the end of a message, grouped by file and in document
 * order within each file:
 *
 *     ---
 *     <heading>
 *
 *     1. `path:line`
 *        > quote
 *        comment
 */
export function formatArticleAnnotations(
  annotations: readonly ArticleAnnotation[],
  heading: string
): string {
  const files = new Map<string, ArticleAnnotation[]>();
  for (const annotation of annotations) {
    const key = `${annotation.ownerThreadId}\n${annotation.path}`;
    files.set(key, [...(files.get(key) ?? []), annotation]);
  }
  const ordered = [...files.values()].flatMap((items) =>
    items.toSorted(
      (a, b) =>
        a.block.index - b.block.index ||
        (a.lines?.startLine ?? 0) - (b.lines?.startLine ?? 0)
    )
  );
  const entries = ordered.map((annotation, index) => {
    const { lines } = annotation;
    const location = !lines
      ? ''
      : lines.startLine === lines.endLine
        ? `:${lines.startLine}`
        : `:${lines.startLine}-${lines.endLine}`;
    const comment = annotation.comment.trim();
    return [
      `${index + 1}. \`${annotation.path}${location}\``,
      indent(annotation.quote, '   > '),
      ...(comment ? [indent(comment, '   ')] : []),
    ].join('\n');
  });
  return ['---', heading, '', entries.join('\n\n')].join('\n');
}
