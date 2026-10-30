import * as stylex from '@stylexjs/stylex';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  MessageSquare,
  MessageSquareDot,
  MessageSquareMore,
  MessageSquareReply,
  Pencil,
  Trash2,
} from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Popover } from '@lody/ui/popover';
import { Textarea } from '@lody/ui/textarea';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import {
  ARTICLE_BLOCK_SELECTOR,
  articleBlockChanged,
  resolveArticleBlock,
  useArticleAnnotationActions,
  type ArticleAnnotation,
} from './article-annotations';

/** A mini icon button's side. */
const MARKER_SIZE = 24;

const styles = stylex.create({
  marker: { position: 'absolute', zIndex: 1, userSelect: 'none' },
  icon: { color: colors.tertiaryLabel },
  changedIcon: { color: colors.accent },
  status: { margin: 0, fontSize: '0.6875rem', color: colors.secondaryLabel },
  statusChanged: { color: colors.accent },
  badge: {
    position: 'absolute',
    insetBlockStart: '-2px',
    insetInlineEnd: '-3px',
    minWidth: '12px',
    paddingInline: '2px',
    borderRadius: '6px',
    backgroundColor: colors.hoverFill,
    color: colors.secondaryLabel,
    fontSize: '9px',
    lineHeight: '12px',
    textAlign: 'center',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    width: 'min(320px, 80vw)',
    maxHeight: '50vh',
    overflowY: 'auto',
  },
  item: { display: 'flex', flexDirection: 'column', gap: space[1], minWidth: 0 },
  quote: {
    margin: 0,
    paddingLeft: space[2],
    borderLeftWidth: 2,
    borderLeftStyle: 'solid',
    borderLeftColor: colors.separator,
    fontSize: '0.75rem',
    lineHeight: 1.5,
    color: colors.secondaryLabel,
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    overflow: 'hidden',
    overflowWrap: 'anywhere',
  },
  row: { display: 'flex', alignItems: 'flex-start', gap: space[1] },
  comment: {
    flex: '1 1 auto',
    minWidth: 0,
    margin: 0,
    paddingBlock: '3px',
    fontSize: '0.8125rem',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: space[1] },
});

/** The box of a block's last rendered line, ignoring nested blocks such as a sublist. */
function lastLineRect(block: HTMLElement): DOMRect {
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let last: Node | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (node.textContent?.trim() && node.parentElement?.closest(ARTICLE_BLOCK_SELECTOR) === block)
      last = node;
  if (!last) return block.getBoundingClientRect();
  const range = block.ownerDocument.createRange();
  range.selectNodeContents(last);
  return Array.from(range.getClientRects()).at(-1) ?? block.getBoundingClientRect();
}

/**
 * A code block scrolled sideways has its last line's end out of sight, so its
 * mark sits in the block's top-right corner instead, left of the toolbar's
 * actions (wrap, copy) on the same row.
 */
function overflowingCodeActions(block: HTMLElement): DOMRect | null {
  const codeBlock = block.closest('[data-streamdown="code-block"]');
  const scroller = block.parentElement!;
  if (!codeBlock || scroller.scrollWidth <= scroller.clientWidth) return null;
  return codeBlock.querySelector('[data-streamdown="code-block-actions"]')!.getBoundingClientRect();
}

interface MarkerGroup {
  /** The block's index among the article's blocks. */
  readonly key: number;
  readonly left: number;
  readonly top: number;
  readonly items: readonly MarkedAnnotation[];
}

interface MarkedAnnotation {
  readonly annotation: ArticleAnnotation;
  /** Sent, and its passage rewritten since. */
  readonly changed: boolean;
}

/**
 * A comment mark at the end of each commented block of a rendered Markdown
 * article, numbered when the block has more than one. It floats over the
 * article, at the end of the block's last line, so the text never reflows;
 * pressing it lists the block's comments to edit or delete.
 */
export function ArticleAnnotationMarkers({
  root,
  revision,
  annotations,
}: {
  /**
   * The rendered Markdown; positioned, so the marks scroll with it. An element
   * rather than a ref: a parent's ref is not attached yet when these marks first measure.
   */
  root: HTMLElement | null;
  /** Changes whenever the rendered document does. */
  revision: string;
  annotations: readonly ArticleAnnotation[];
}) {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<readonly MarkerGroup[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = root;
    if (!element) return undefined;
    const measure = () => {
      const blocks = Array.from(element.querySelectorAll<HTMLElement>(ARTICLE_BLOCK_SELECTOR));
      const byBlock = new Map<HTMLElement, MarkedAnnotation[]>();
      for (const annotation of annotations) {
        const block = resolveArticleBlock(blocks, annotation);
        const item = {
          annotation,
          changed: annotation.sent !== undefined && articleBlockChanged(blocks, annotation),
        };
        if (block) byBlock.set(block, [...(byBlock.get(block) ?? []), item]);
      }
      const box = element.getBoundingClientRect();
      // Into the room beside the article when there is some, never past it.
      const limit =
        (element.parentElement?.getBoundingClientRect().right ?? box.right) -
        box.left -
        MARKER_SIZE;
      setGroups(
        [...byBlock]
          .map(([block, items]) => {
            const key = blocks.indexOf(block);
            const actions = overflowingCodeActions(block);
            if (actions)
              return {
                key,
                left: actions.left - box.left - MARKER_SIZE - 2,
                top: actions.top + actions.height / 2 - box.top - MARKER_SIZE / 2,
                items,
              };
            const line = lastLineRect(block);
            const right = Math.min(line.right, block.getBoundingClientRect().right);
            return {
              key,
              left: Math.min(right - box.left + 2, limit),
              top: line.top + line.height / 2 - box.top - MARKER_SIZE / 2,
              items,
            };
          })
          .sort((a, b) => a.key - b.key)
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [annotations, revision, root]);
  return groups.map((group) => {
    const label = t('sessions.article.annotation.count', 'Comments ({{count}})', {
      count: group.items.length,
    });
    return (
      <div
        key={group.key}
        {...stylex.props(styles.marker)}
        style={{ left: group.left, top: group.top }}
        data-article-annotation-marker
      >
        <Popover.Root
          open={open === group.key}
          onOpenChange={(next) => setOpen(next ? group.key : null)}
        >
          <Popover.Trigger
            render={<Button type="button" size="mini" variant="ghost" icon aria-label={label} />}
          >
            {group.items.some((item) => item.annotation.sent === undefined) ? (
              <MessageSquare size={14} aria-hidden {...stylex.props(styles.icon)} />
            ) : group.items.some((item) => item.changed) ? (
              <MessageSquareDot size={14} aria-hidden {...stylex.props(styles.changedIcon)} />
            ) : (
              <MessageSquareMore size={14} aria-hidden {...stylex.props(styles.icon)} />
            )}
            {group.items.length > 1 ? (
              <span {...stylex.props(styles.badge)} aria-hidden>
                {group.items.length}
              </span>
            ) : null}
          </Popover.Trigger>
          <Popover.Content side="bottom" align="end">
            <div {...stylex.props(styles.list)} aria-label={label} role="list">
              {group.items.map((item) => (
                <AnnotationItem
                  key={item.annotation.id}
                  annotation={item.annotation}
                  changed={item.changed}
                />
              ))}
            </div>
          </Popover.Content>
        </Popover.Root>
      </div>
    );
  });
}

/**
 * One comment in its block's list. Unsent, it can be edited or deleted; sent,
 * it says whether the agent has rewritten its passage since, and can be
 * resolved or asked about again (the new comment replaces it, unsent).
 */
export function AnnotationItem({
  annotation,
  changed,
}: {
  annotation: ArticleAnnotation;
  changed: boolean;
}) {
  const { t } = useTranslation();
  const actions = useArticleAnnotationActions();
  const [draft, setDraft] = useState<string | null>(null);
  const editButton = useRef<HTMLElement>(null);
  const leftEdit = useRef(false);
  // Leaving an edit hands focus back to its Edit button: the textarea goes, and
  // focus left on the page would let the next Escape close the window too.
  const leaveEdit = () => {
    leftEdit.current = true;
    setDraft(null);
  };
  useEffect(() => {
    if (draft !== null || !leftEdit.current) return;
    leftEdit.current = false;
    editButton.current!.focus();
  }, [draft]);
  const save = () => {
    if (draft === null) return;
    if (annotation.sent) actions.followUp(annotation.id, draft.trim());
    else actions.update(annotation.id, draft);
    leaveEdit();
  };
  const { sent } = annotation;
  return (
    <div {...stylex.props(styles.item)} role="listitem">
      <blockquote {...stylex.props(styles.quote)} title={annotation.quote}>
        {annotation.quote}
      </blockquote>
      {sent ? (
        <p {...stylex.props(styles.status, changed && styles.statusChanged)}>
          {changed
            ? t(
                'sessions.article.annotation.changed',
                '#{{number}} · The agent changed this passage',
                {
                  number: sent.number,
                }
              )
            : t('sessions.article.annotation.sent', '#{{number}} · Sent, waiting for the agent', {
                number: sent.number,
              })}
        </p>
      ) : null}
      {draft === null && sent ? (
        <div {...stylex.props(styles.row)}>
          <p {...stylex.props(styles.comment)}>{annotation.comment}</p>
          <Button
            ref={editButton}
            type="button"
            size="mini"
            variant="ghost"
            icon
            aria-label={t('sessions.article.annotation.followUp', 'Ask again')}
            title={t('sessions.article.annotation.followUp', 'Ask again')}
            onClick={() => setDraft('')}
          >
            <MessageSquareReply size={14} aria-hidden />
          </Button>
          <Button
            type="button"
            size="mini"
            variant="ghost"
            icon
            aria-label={t('sessions.article.annotation.resolve', 'Resolve')}
            title={t('sessions.article.annotation.resolve', 'Resolve')}
            onClick={() => actions.remove(annotation.id)}
          >
            <Check size={14} aria-hidden />
          </Button>
        </div>
      ) : draft === null ? (
        <div {...stylex.props(styles.row)}>
          <p {...stylex.props(styles.comment)}>{annotation.comment}</p>
          <Button
            ref={editButton}
            type="button"
            size="mini"
            variant="ghost"
            icon
            aria-label={t('common.edit', 'Edit')}
            onClick={() => setDraft(annotation.comment)}
          >
            <Pencil size={14} aria-hidden />
          </Button>
          <Button
            type="button"
            size="mini"
            variant="ghost"
            icon
            aria-label={t('common.delete', 'Delete')}
            onClick={() => actions.remove(annotation.id)}
          >
            <Trash2 size={14} aria-hidden />
          </Button>
        </div>
      ) : (
        <>
          <Textarea
            resize="none"
            rows={3}
            autoFocus
            aria-label={t('sessions.fileViewer.selection.comment', 'Selection comment')}
            value={draft}
            maxLength={10_000}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                save();
              }
              // The first Escape leaves the edit, not the list.
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                leaveEdit();
              }
            }}
          />
          <div {...stylex.props(styles.actions)}>
            <Button type="button" size="mini" variant="ghost" onClick={leaveEdit}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button type="button" size="mini" onClick={save}>
              {t('common.save', 'Save')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
