import * as stylex from '@stylexjs/stylex';
import { useLayoutEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Popover } from '@lody/ui/popover';
import { Textarea } from '@lody/ui/textarea';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import {
  ARTICLE_BLOCK_SELECTOR,
  resolveArticleBlock,
  useArticleAnnotationActions,
  type ArticleAnnotation,
} from './article-annotations';

/** A mini icon button's side. */
const MARKER_SIZE = 24;

const styles = stylex.create({
  marker: { position: 'absolute', zIndex: 1, userSelect: 'none' },
  icon: { color: colors.tertiaryLabel },
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

interface MarkerGroup {
  /** The block's index among the article's blocks. */
  readonly key: number;
  readonly left: number;
  readonly top: number;
  readonly items: readonly ArticleAnnotation[];
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
      const byBlock = new Map<HTMLElement, ArticleAnnotation[]>();
      for (const annotation of annotations) {
        const block = resolveArticleBlock(blocks, annotation);
        if (block) byBlock.set(block, [...(byBlock.get(block) ?? []), annotation]);
      }
      const box = element.getBoundingClientRect();
      // Into the room beside the article when there is some, never past it.
      const limit =
        (element.parentElement?.getBoundingClientRect().right ?? box.right) - box.left - MARKER_SIZE;
      setGroups(
        [...byBlock]
          .map(([block, items]) => {
            const line = lastLineRect(block);
            const right = Math.min(line.right, block.getBoundingClientRect().right);
            return {
              key: blocks.indexOf(block),
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
            <MessageSquare size={14} aria-hidden {...stylex.props(styles.icon)} />
            {group.items.length > 1 ? (
              <span {...stylex.props(styles.badge)} aria-hidden>
                {group.items.length}
              </span>
            ) : null}
          </Popover.Trigger>
          <Popover.Content side="bottom" align="end">
            <div {...stylex.props(styles.list)} aria-label={label} role="list">
              {group.items.map((annotation) => (
                <AnnotationItem key={annotation.id} annotation={annotation} />
              ))}
            </div>
          </Popover.Content>
        </Popover.Root>
      </div>
    );
  });
}

function AnnotationItem({ annotation }: { annotation: ArticleAnnotation }) {
  const { t } = useTranslation();
  const actions = useArticleAnnotationActions();
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    if (draft === null) return;
    actions.update(annotation.id, draft);
    setDraft(null);
  };
  return (
    <div {...stylex.props(styles.item)} role="listitem">
      <blockquote {...stylex.props(styles.quote)} title={annotation.quote}>
        {annotation.quote}
      </blockquote>
      {draft === null ? (
        <div {...stylex.props(styles.row)}>
          <p {...stylex.props(styles.comment)}>{annotation.comment}</p>
          <Button
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
            onClick={() => actions.remove(new Set([annotation.id]))}
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
                setDraft(null);
              }
            }}
          />
          <div {...stylex.props(styles.actions)}>
            <Button type="button" size="mini" variant="ghost" onClick={() => setDraft(null)}>
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
