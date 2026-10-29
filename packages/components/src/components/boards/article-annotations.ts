import { atom, useAtomValue, useSetAtom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { useMemo } from 'react';
import type { SessionId } from '@lody/shared';

/**
 * A comment on a passage of a Board thread's article (experimental). It waits
 * beside the article until the thread's next message carries it, then stays
 * there, numbered as that message numbered it, until the reader resolves it or
 * asks again: so the reader can see which passages the agent has changed since.
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
  /**
   * The rendered block the selection starts in: its index among blocks, and its
   * text. An HTML page's error has no block: index -1.
   */
  readonly block: { readonly index: number; readonly text: string };
  /** What an earlier, sent comment on this passage said; this one asks again. */
  readonly previous?: string;
  /** Set once a message carried it: its number there, and when. */
  readonly sent?: { readonly number: number; readonly atMs: number };
}

/**
 * Rendered Markdown blocks a comment can sit at the end of; not a paragraph
 * that only shows deleted text (`article-diff.ts`).
 */
export const ARTICLE_BLOCK_SELECTOR =
  'p:not([data-lody-diff]), li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, dt, dd';

/** A block's text as the article has it now: without words marked deleted or change hints. */
export function articleBlockText(block: Element): string {
  let text = '';
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (!node.parentElement?.closest('[data-lody-diff="del"], [data-lody-diff="hint"]'))
      text += node.textContent ?? '';
  return text;
}

/** Sent comments nobody resolved leave after this long. */
const SENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Kept on this device across restarts; each device keeps its own. */
export const articleAnnotationsAtom = atomWithStorage<readonly ArticleAnnotation[]>(
  'lody-board-article-annotations',
  [],
  undefined,
  { getOnInit: true }
);

const EMPTY: readonly ArticleAnnotation[] = [];

/** Comments the thread's next message carries: those not sent yet. */
export function useThreadArticleAnnotations(
  threadId: SessionId | null | undefined
): readonly ArticleAnnotation[] {
  const all = useAtomValue(articleAnnotationsAtom);
  return useMemo(
    () =>
      threadId
        ? all.filter((item) => item.threadId === threadId && item.sent === undefined)
        : EMPTY,
    [all, threadId]
  );
}

/** Every comment on one article, sent or not. */
export function useArticleFileAnnotations(
  threadId: SessionId | null | undefined,
  ownerThreadId: SessionId,
  path: string
): readonly ArticleAnnotation[] {
  const all = useAtomValue(articleAnnotationsAtom);
  return useMemo(
    () =>
      threadId
        ? all.filter(
            (item) =>
              item.threadId === threadId &&
              item.ownerThreadId === ownerThreadId &&
              item.path === path
          )
        : EMPTY,
    [all, ownerThreadId, path, threadId]
  );
}

/**
 * Asks the composer of `threadId` to send now, carrying its comments with
 * whatever is typed there. `seq` tells two requests for the same thread apart.
 */
export const articleAnnotationSendRequestAtom = atom<{
  readonly threadId: SessionId;
  readonly seq: number;
} | null>(null);

/** What a message carried of each comment, by id: its number there and its words. */
export type CarriedArticleAnnotations = ReadonlyMap<
  string,
  { readonly number: number; readonly comment: string }
>;

/**
 * Marks the comments a message carried as sent, with their numbers there. A
 * comment is matched by id and by the words it carried, never by object: a
 * window that reread the list from storage meanwhile holds equal copies, while
 * a comment edited during the send stays unsent for the next message. A page
 * error has no passage to come back to, so sending it is the end of it; sent
 * comments older than a month go.
 */
export const markArticleAnnotationsSent = (
  items: readonly ArticleAnnotation[],
  carried: CarriedArticleAnnotations,
  atMs: number
): readonly ArticleAnnotation[] =>
  items.flatMap((item) => {
    const sent = carried.get(item.id);
    if (sent && sent.comment === item.comment)
      return item.block.index < 0 ? [] : [{ ...item, sent: { number: sent.number, atMs } }];
    return item.sent && atMs - item.sent.atMs > SENT_RETENTION_MS ? [] : [item];
  });

/** Asks again about a sent comment's passage: a new, unsent comment replaces it. */
export const followUpArticleAnnotation = (
  items: readonly ArticleAnnotation[],
  id: string,
  comment: string
): readonly ArticleAnnotation[] =>
  items.map((item) => {
    if (item.id !== id) return item;
    const { sent: _sent, ...rest } = item;
    return { ...rest, id: crypto.randomUUID(), comment, previous: item.comment };
  });

export function useArticleAnnotationActions() {
  const set = useSetAtom(articleAnnotationsAtom);
  const setSendRequest = useSetAtom(articleAnnotationSendRequestAtom);
  return useMemo(
    () => ({
      add: (annotation: Omit<ArticleAnnotation, 'id'>) =>
        set((items) => [...items, { ...annotation, id: crypto.randomUUID() }]),
      update: (id: string, comment: string) =>
        set((items) => items.map((item) => (item.id === id ? { ...item, comment } : item))),
      remove: (id: string) => set((items) => items.filter((item) => item.id !== id)),
      markSent: (carried: CarriedArticleAnnotations, atMs: number) =>
        set((items) => markArticleAnnotationsSent(items, carried, atMs)),
      followUp: (id: string, comment: string) =>
        set((items) => followUpArticleAnnotation(items, id, comment)),
      requestSend: (threadId: SessionId) =>
        setSendRequest((current) => ({ threadId, seq: (current?.seq ?? 0) + 1 })),
    }),
    [set, setSendRequest]
  );
}

/** The block a selection starts in, as an annotation records it. */
export function articleBlockOf(root: HTMLElement, range: Range): ArticleAnnotation['block'] {
  const node = range.startContainer;
  const element = node instanceof Element ? node : node.parentElement!;
  const block = element.closest<HTMLElement>(ARTICLE_BLOCK_SELECTOR) ?? element;
  return {
    index: Array.from(root.querySelectorAll(ARTICLE_BLOCK_SELECTOR)).indexOf(block),
    text: articleBlockText(block),
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
  if (blocks[index] && articleBlockText(blocks[index]) === text) return blocks[index];
  const quoteStart = annotation.quote.split('\n')[0].trim();
  return (
    blocks.find((block) => articleBlockText(block) === text) ??
    blocks.find((block) => articleBlockText(block).includes(quoteStart)) ??
    blocks[Math.min(Math.max(index, 0), blocks.length - 1)]
  );
}

/**
 * Whether the agent has rewritten a comment's passage since: no rendered block
 * holds the text the comment was written against any more.
 */
export const articleBlockChanged = (
  blocks: readonly HTMLElement[],
  annotation: ArticleAnnotation
): boolean => !blocks.some((block) => articleBlockText(block) === annotation.block.text);

const indent = (text: string, prefix: string) =>
  text
    .split('\n')
    .map((line) => (line ? `${prefix}${line}` : prefix.trimEnd()))
    .join('\n');

/**
 * The comments as the end of a message, grouped by file and in document
 * order within each file, with what it carried of each (its number and words). No line numbers: the
 * file may have changed since, and the quote finds the passage anyway.
 *
 *     ---
 *     <heading>
 *     <hint>
 *
 *     1. `path`
 *        > quote
 *        (<earlier> previous)
 *        comment
 */
export function formatArticleAnnotations(
  annotations: readonly ArticleAnnotation[],
  labels: { readonly heading: string; readonly hint: string; readonly earlier: string }
): { readonly text: string; readonly carried: CarriedArticleAnnotations } {
  const files = new Map<string, ArticleAnnotation[]>();
  for (const annotation of annotations) {
    const key = `${annotation.ownerThreadId}\n${annotation.path}`;
    files.set(key, [...(files.get(key) ?? []), annotation]);
  }
  const ordered = [...files.values()].flatMap((items) =>
    items.toSorted((a, b) => a.block.index - b.block.index)
  );
  const entries = ordered.map((annotation, index) => {
    const comment = annotation.comment.trim();
    return [
      `${index + 1}. \`${annotation.path}\``,
      indent(annotation.quote, '   > '),
      ...(annotation.previous ? [indent(`(${labels.earlier} ${annotation.previous})`, '   ')] : []),
      ...(comment ? [indent(comment, '   ')] : []),
    ].join('\n');
  });
  return {
    text: ['---', labels.heading, labels.hint, '', entries.join('\n\n')].join('\n'),
    carried: new Map(
      ordered.map((annotation, index) => [
        annotation.id,
        { number: index + 1, comment: annotation.comment },
      ])
    ),
  };
}
