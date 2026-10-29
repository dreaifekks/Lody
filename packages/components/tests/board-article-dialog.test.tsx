// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { JSDOM } from 'jsdom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardArticleDialog } from '../src/components/boards/board-article-dialog';
import { getDefaultStore } from 'jotai';
import { ArticleAnnotationMarkers } from '../src/components/boards/article-annotation-markers';
import {
  articleAnnotationsAtom,
  articleBlockText,
  type ArticleAnnotation,
} from '../src/components/boards/article-annotations';
import { ArticleReviewControls, useArticleChanges } from '../src/components/boards/article-review';
import { MarkdownRenderer } from '../src/components/ai-gui/markdown-renderer';
import { ArticleHtmlFrame } from '../src/components/sessions/article-html-frame';
import {
  createRelocatableHost,
  RelocatableSlot,
  type RelocatableHost,
} from '../src/components/boards/relocatable-host';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, values?: Record<string, unknown>) =>
      fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name])),
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounts = 0;
const threadNames = new WeakMap<RelocatableHost, string>();
const threadName = (host: RelocatableHost) => threadNames.get(host) ?? 'other';

/** Stands in for the thread's conversation: a composer whose draft lives in the DOM. */
function Conversation({ thread }: { thread: string }) {
  useEffect(() => {
    mounts += 1;
  }, []);
  return createElement('textarea', { 'aria-label': 'composer', 'data-thread': thread });
}

const ARTICLE = createElement('article', null, 'Report');

const COMMENT: ArticleAnnotation = {
  id: 'comment-1',
  threadId: 'thread' as never,
  ownerThreadId: 'thread' as never,
  path: 'report.md',
  quote: 'Revenue grew',
  comment: 'Which quarter?',
  block: { index: 0, text: 'Revenue grew.' },
};

/** A rendered Markdown article with one comment waiting at its paragraph. */
function CommentedArticle() {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  return createElement(
    'article',
    { ref: setRoot, style: { position: 'relative' } },
    createElement('p', null, 'Revenue grew.'),
    createElement(ArticleAnnotationMarkers, { root, revision: '1', annotations: [COMMENT] })
  );
}

/** The page as it renders a Board thread: one slot in the panel, the conversation portalled. */
function Page({
  host,
  open,
  holds,
  onClose,
  panelKey = 'panel',
  article = ARTICLE,
}: {
  host: RelocatableHost;
  open: boolean;
  holds: boolean;
  onClose: () => void;
  /** A new key remounts the Board panel's slot, as a layout change does. */
  panelKey?: string;
  article?: ReturnType<typeof createElement>;
}) {
  const [, setPanel] = useState<HTMLElement | null>(null);
  return createElement(
    'div',
    null,
    createElement(
      'aside',
      { 'data-testid': 'board-panel' },
      createElement(RelocatableSlot, { host, key: `${panelKey}:${threadName(host)}` })
    ),
    createElement(
      'div',
      { key: threadName(host) },
      createPortal(createElement(Conversation, { thread: threadName(host) }), host.node)
    ),
    open
      ? createElement(BoardArticleDialog, {
          title: 'report.md',
          article,
          threadHost: host,
          holdsThread: holds,
          onPanelChange: setPanel,
          onClose,
        })
      : null
  );
}

describe('BoardArticleDialog', () => {
  let root: Root;
  let container: HTMLDivElement;
  let threadHost: RelocatableHost;
  let host: RelocatableHost;
  let open: boolean;
  let holds: boolean;
  const onClose = vi.fn(() => {
    open = false;
  });
  const render = (panelKey?: string) =>
    act(async () => {
      root.render(createElement(Page, { host: threadHost, open, holds, onClose, panelKey }));
    });

  beforeEach(() => {
    mounts = 0;
    open = false;
    onClose.mockClear();
    host = createRelocatableHost();
    threadHost = host;
    holds = true;
    threadNames.set(host, 'thread');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('borrows the one conversation while open and gives it back, draft and all', async () => {
    await render();
    const composer = document.querySelector<HTMLTextAreaElement>('textarea')!;
    composer.value = '这里数据过时了';
    expect(document.querySelector('[data-testid="board-panel"]')?.contains(composer)).toBe(true);

    open = true;
    await render();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.contains(composer)).toBe(true);
    expect(dialog?.textContent).toContain('Report');
    expect(document.querySelectorAll('textarea')).toHaveLength(1);

    // The backdrop closes it, as Escape and the conversation's own close do.
    await act(async () => {
      document.querySelector<HTMLElement>('[data-article-dismiss]')!.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="board-panel"]')?.contains(composer)).toBe(true);

    open = true;
    await render();
    expect(document.querySelector('[role="dialog"]')?.contains(composer)).toBe(true);
    expect(composer.value).toBe('这里数据过时了');
    expect(mounts).toBe(1);
  });

  it('keeps the conversation while a Board panel slot remounts under it', async () => {
    open = true;
    await render();
    const composer = document.querySelector<HTMLTextAreaElement>('textarea')!;
    await render('remounted');
    expect(document.querySelector('[role="dialog"]')?.contains(composer)).toBe(true);
    open = false;
    await render('remounted');
    expect(document.querySelector('[data-testid="board-panel"]')?.contains(composer)).toBe(true);
    expect(mounts).toBe(1);
  });

  it('returns the conversation with its scroll when the dialog lets go before unmounting', async () => {
    // A browser keeps an element's scroll offsets only across `moveBefore`
    // between two places in the document; inserting it again resets them.
    const insertBefore = Node.prototype.insertBefore;
    const appendChild = Node.prototype.appendChild;
    let moving = false;
    const scrolled = () => document.querySelector<HTMLTextAreaElement>('textarea')!;
    const reset = (node: Node) => {
      if (!moving && node === host.node)
        host.node.querySelector('textarea')?.setAttribute('data-scroll-top', '0');
    };
    Object.defineProperty(Element.prototype, 'moveBefore', {
      configurable: true,
      value(this: Element, node: Node, child: Node | null) {
        if (!this.isConnected || !node.isConnected)
          throw new DOMException('', 'HierarchyRequestError');
        moving = true;
        insertBefore.call(this, node, child);
        moving = false;
      },
    });
    Node.prototype.appendChild = function <T extends Node>(this: Node, node: T): T {
      reset(node);
      return appendChild.call(this, node) as T;
    };
    try {
      await render();
      scrolled().dataset.scrollTop = '1200';
      open = true;
      await render();
      expect(document.querySelector('[role="dialog"]')?.contains(scrolled())).toBe(true);
      // The page's two-step close: the dialog lets go, then unmounts.
      holds = false;
      await render();
      open = false;
      await render();
      expect(document.querySelector('[data-testid="board-panel"]')?.contains(scrolled())).toBe(
        true
      );
      expect(scrolled().dataset.scrollTop).toBe('1200');
    } finally {
      delete (Element.prototype as { moveBefore?: unknown }).moveBefore;
      Node.prototype.appendChild = appendChild;
    }
  });

  it('follows the panel to another thread and keeps the article', async () => {
    const other = createRelocatableHost();
    open = true;
    await render();
    const article = document.querySelector('article')!;
    // The breadcrumb opened another member: its conversation takes the pane.
    threadHost = other;
    await render();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('article')).toBe(article);
    // The pane holds the new thread alone; the old one left nothing behind.
    expect(other.node.parentElement?.childNodes).toHaveLength(1);
    expect(dialog.querySelector('textarea')?.dataset.thread).toBe('other');
    open = false;
    await render();
    expect(document.querySelector('[data-testid="board-panel"] textarea')?.dataset.thread).toBe(
      'other'
    );
  });

  it('closes an edit, then the comment list, then itself, one Escape each', async () => {
    // jsdom lays nothing out; the paragraph reads as one line.
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [new DOMRect(10, 10, 120, 16)],
    });
    open = true;
    await act(async () => {
      root.render(
        createElement(Page, {
          host: threadHost,
          open,
          holds,
          onClose,
          article: createElement(CommentedArticle),
        })
      );
    });
    const dialog = document.querySelector('[role="dialog"]')!;
    await act(async () =>
      dialog.querySelector<HTMLButtonElement>('[data-article-annotation-marker] button')!.click()
    );
    // The list mounts in the dialog's panel, so the modal keeps it interactive.
    const list = dialog.querySelector('[role="list"]')!;
    expect(list.textContent).toContain('Which quarter?');
    const escape = () =>
      act(async () => {
        (document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
      });
    await act(async () => list.querySelector<HTMLButtonElement>('[aria-label="Edit"]')!.click());
    expect(document.activeElement).toBe(list.querySelector('textarea'));
    await escape();
    expect(list.querySelector('textarea')).toBeNull();
    expect(document.querySelector('[role="list"]')).not.toBeNull();
    await escape();
    expect(document.querySelector('[role="list"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await escape();
    expect(onClose).toHaveBeenCalledTimes(1);
    delete (Range.prototype as Partial<Range>).getClientRects;
  });

  it('closes on Escape', async () => {
    open = true;
    await render();
    await act(async () => {
      document
        .querySelector('[role="dialog"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ArticleAnnotationMarkers', () => {
  /** A rendered fenced code block: a toolbar of actions over a sideways scroller. */
  const codeBlock = (code: string, scroll: string, actionsRect: string, preRect: string) =>
    createElement(
      'div',
      { 'data-streamdown': 'code-block' },
      createElement(
        'div',
        { 'data-streamdown': 'code-block-toolbar' },
        createElement(
          'div',
          { 'data-streamdown': 'code-block-actions', 'data-rect': actionsRect },
          createElement('button', { type: 'button' }, 'Copy')
        )
      ),
      createElement(
        'div',
        { 'data-streamdown': 'code-block-body', 'data-scroll': scroll },
        createElement('pre', { 'data-rect': preRect }, createElement('code', null, code))
      )
    );
  const comment = (id: string, code: string): ArticleAnnotation => ({
    ...COMMENT,
    id,
    quote: code,
    block: { index: -1, text: code },
  });

  it('puts the mark of a code block scrolled sideways left of its actions, others at the line end', async () => {
    // jsdom lays nothing out: elements state their boxes and scroll widths.
    const rectOf = (element: Element) => {
      const [x, y, width, height] = (element.getAttribute('data-rect') ?? '0,0,0,0')
        .split(',')
        .map(Number);
      return new DOMRect(x, y, width, height);
    };
    const scrollOf = (element: Element) =>
      (element.getAttribute('data-scroll') ?? '0,0').split(',').map(Number);
    const saved = {
      rect: HTMLElement.prototype.getBoundingClientRect,
      scrollWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth')!,
      clientWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!,
    };
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return rectOf(this);
    };
    Object.defineProperty(Element.prototype, 'scrollWidth', {
      configurable: true,
      get(this: Element) {
        return scrollOf(this)[0];
      },
    });
    Object.defineProperty(Element.prototype, 'clientWidth', {
      configurable: true,
      get(this: Element) {
        return scrollOf(this)[1];
      },
    });
    // The last line of the code that fits ends at x = 130.
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [new DOMRect(10, 300, 120, 16)],
    });
    function CodeArticle() {
      const [root, setRoot] = useState<HTMLElement | null>(null);
      return createElement(
        'div',
        { 'data-rect': '0,0,640,800' },
        createElement(
          'article',
          { ref: setRoot, 'data-rect': '0,0,600,800' },
          codeBlock('const wide = 1;', '900,400', '500,100,52,24', '0,124,900,40'),
          codeBlock('const fits = 2;', '400,400', '500,260,52,24', '0,284,400,40'),
          createElement(ArticleAnnotationMarkers, {
            root,
            revision: '1',
            annotations: [comment('wide', 'const wide = 1;'), comment('fits', 'const fits = 2;')],
          })
        )
      );
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(CodeArticle)));
      const marks = Array.from(
        container.querySelectorAll<HTMLElement>('[data-article-annotation-marker]')
      ).map((mark) => [mark.style.left, mark.style.top]);
      expect(marks).toEqual([
        // On the toolbar row, 2 px left of the actions (x = 500), not over the code.
        ['474px', '100px'],
        // At the end of its last line, centred on it.
        ['132px', '296px'],
      ]);
    } finally {
      act(() => root.unmount());
      container.remove();
      HTMLElement.prototype.getBoundingClientRect = saved.rect;
      Object.defineProperty(Element.prototype, 'scrollWidth', saved.scrollWidth);
      Object.defineProperty(Element.prototype, 'clientWidth', saved.clientWidth);
      delete (Range.prototype as Partial<Range>).getClientRects;
    }
  });
});

describe('article review', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // jsdom lays nothing out; the marks only need a box to stand at.
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [new DOMRect(0, 0, 100, 16)],
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    getDefaultStore().set(articleAnnotationsAtom, []);
    delete (Range.prototype as Partial<Range>).getClientRects;
  });

  /** A rendered article of paragraphs, with its review marks and header controls. */
  /** A rendered Markdown article with its change marks, comment marks and header controls. */
  function ReviewedArticle({
    paragraphs,
    markdown = paragraphs?.join('\n\n') ?? '',
    annotations = [],
  }: {
    paragraphs?: readonly string[];
    markdown?: string;
    annotations?: readonly ArticleAnnotation[];
  }) {
    const [element, setElement] = useState<HTMLElement | null>(null);
    const changes = useArticleChanges(element, markdown, true);
    return createElement(
      'div',
      null,
      createElement(
        'header',
        null,
        createElement(ArticleReviewControls, { threadId: 'thread' as never, changes })
      ),
      createElement(
        'article',
        {
          ref: setElement,
          'data-testid': 'viewport',
          onClick: (event: { currentTarget: Element }) => changes.seeInView(event.currentTarget),
        },
        createElement(MarkdownRenderer, {
          text: markdown,
          allowHtml: true,
          extraRehypePlugins: changes.rehypePlugins,
        }),
        createElement(ArticleAnnotationMarkers, { root: element, revision: markdown, annotations })
      )
    );
  }

  const button = (label: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (item) => item.getAttribute('aria-label') === label || item.textContent === label
    );

  const marks = (kind: 'ins' | 'del' | 'block') =>
    Array.from(
      container.querySelectorAll(`[data-lody-diff="${kind}"]`),
      (mark) => mark.textContent
    );

  it('marks only the changed words: deleted struck through, then the new ones highlighted', async () => {
    const render = (markdown: string) =>
      act(async () => root.render(createElement(ReviewedArticle, { markdown })));
    await render(
      [
        '# Weekly report',
        '',
        'Revenue grew **8%** this quarter.',
        '',
        '- Hiring paused',
        '- Office moved',
        '',
        '新的分支已经合并。',
        '',
        '```ts',
        'const rate = 8;',
        '```',
      ].join('\n')
    );
    // The first revision shown is what the reader has seen: nothing is marked.
    expect(container.querySelectorAll('[data-lody-diff]')).toHaveLength(0);
    expect(container.querySelector('header')!.textContent).toBe('');

    await render(
      [
        '# Weekly report',
        '',
        'Revenue grew **12%** in Q3.',
        '',
        '- Hiring paused',
        '',
        '新的分支已经发布。',
        '',
        '```ts',
        'const rate = 12;',
        '```',
      ].join('\n')
    );
    // Words, not paragraphs: the unchanged ones stay plain, even inside bold.
    expect(marks('del')).toEqual(['8', 'this quarter', 'Office moved', '合并']);
    expect(marks('ins')).toEqual(['12', 'in Q3', '发布']);
    expect(container.querySelector('strong')!.textContent).toBe('812%');
    // A rewritten code block shows as a line diff: the old line removed, the new one added.
    const codeDiff = container.querySelector(
      '[data-lody-diff="block"] [data-markdown-diff-block]'
    )!;
    expect(codeDiff.textContent).toContain('-const rate = 8;');
    expect(codeDiff.textContent).toContain('+const rate = 12;');
    // Deleted text is not the article's: comments read blocks without it.
    expect(articleBlockText(container.querySelector('p')!)).toBe('Revenue grew 12% in Q3.');
    expect(container.querySelector('header')!.textContent).toBe('5');

    Element.prototype.scrollIntoView = () => undefined;
    await act(async () => button('Next change')!.click());
    expect(container.querySelector('header')!.textContent).toBe('1/5');

    await act(async () => button('Clear change marks')!.click());
    expect(container.querySelectorAll('[data-lody-diff]')).toHaveLength(0);
    expect(container.querySelector('header')!.textContent).toBe('');
  });

  it('counts the changes on screen as seen when the reader clicks, and keeps the others', async () => {
    const render = (paragraphs: readonly string[]) =>
      act(async () => root.render(createElement(ReviewedArticle, { paragraphs })));
    await render(['Revenue grew 8%.', 'Hiring paused.', 'Outlook steady.']);
    await render(['Revenue grew 12%.', 'Hiring paused.', 'Outlook improving.']);
    expect(marks('ins')).toEqual(['12', 'improving']);

    // jsdom lays nothing out: the first paragraph is on screen, the last below it.
    const saved = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.dataset['testid'] === 'viewport') return new DOMRect(0, 0, 600, 400);
      return new DOMRect(
        0,
        this.closest('p')?.textContent?.startsWith('Outlook') ? 900 : 40,
        50,
        20
      );
    };
    try {
      await act(async () => {
        container
          .querySelector('[data-testid="viewport"]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    } finally {
      HTMLElement.prototype.getBoundingClientRect = saved;
    }
    expect(marks('ins')).toEqual(['improving']);
    expect(marks('del')).toEqual(['steady']);
    expect(container.querySelector('header')!.textContent).toBe('1');

    // A later revision is compared with what the reader has seen since.
    await render(['Revenue grew 12%.', 'Hiring resumed.', 'Outlook improving.']);
    expect(marks('del')).toEqual(['paused', 'steady']);
    expect(marks('ins')).toEqual(['resumed', 'improving']);
  });

  it('keeps deleted paragraphs in their order and marks a long paragraph without a full table', async () => {
    const render = (paragraphs: readonly string[]) =>
      act(async () => root.render(createElement(ReviewedArticle, { paragraphs })));
    await render(['Keep.', 'First removed.', 'Second removed.']);
    await render(['Keep.']);
    expect(marks('del')).toEqual(['First removed.', 'Second removed.']);

    // 15,000 characters with the last one changed: only the common start and
    // end are matched, so the comparison never builds a 15,000² table.
    const long = '长'.repeat(15_000);
    await render([`${long}一`]);
    await act(async () => button('Clear change marks')!.click());
    await render([`${long}二`]);
    expect(marks('del')).toEqual(['一']);
    expect(marks('ins')).toEqual(['二']);

    // A rewrite of 150 paragraphs into 150 others (22,500 pairs, past the
    // limit) is deleted and added as a whole, without comparing every pair.
    await act(async () => button('Clear change marks')!.click());
    await render(Array.from({ length: 150 }, (_, index) => `Old paragraph ${index}.`));
    await act(async () => button('Clear change marks')!.click());
    await render(Array.from({ length: 150 }, (_, index) => `New paragraph ${index}.`));
    expect(marks('del')).toHaveLength(150);
    expect(marks('ins')).toEqual(
      Array.from({ length: 150 }, (_, index) => `New paragraph ${index}.`)
    );
  });

  it('counts only the on-screen part of a change that spans plain and bold text as seen', async () => {
    const render = (markdown: string) =>
      act(async () => root.render(createElement(ReviewedArticle, { markdown })));
    await render('Alpha beta **gamma** delta.');
    await render('Alpha one **two** delta.');
    expect(marks('del')).toEqual(['beta gamma']);
    expect(marks('ins')).toEqual(['one ', 'two']);

    // The bold part is below the screen; the rest is on it.
    const saved = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.dataset['testid'] === 'viewport') return new DOMRect(0, 0, 600, 400);
      return new DOMRect(0, this.closest('strong') ? 900 : 40, 50, 20);
    };
    try {
      await act(async () => {
        container
          .querySelector('[data-testid="viewport"]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    } finally {
      HTMLElement.prototype.getBoundingClientRect = saved;
    }
    // The deleted words sat on screen with the first part: they went with it.
    expect(marks('ins')).toEqual(['two']);
    expect(marks('del')).toEqual([]);
  });

  it('says a folded details block has changes inside, and unfolds it to show one', async () => {
    const render = (body: string) =>
      act(async () =>
        root.render(
          createElement(ReviewedArticle, {
            markdown: [
              'Intro.',
              '',
              '<details>',
              '<summary>Notes</summary>',
              '',
              body,
              '',
              '</details>',
            ].join('\n'),
          })
        )
      );
    await render('The limit is 10.');
    expect(container.querySelector('[data-lody-diff="hint"]')).toBeNull();
    await render('The limit is 20.');
    const summary = container.querySelector('summary')!;
    expect(summary.querySelector('[data-lody-diff="hint"]')!.textContent).toBe('Changed inside');
    // The hint is not a change: it never counts as seen in place of the hidden ones.
    expect(summary.querySelector('[data-lody-diff-id]')).toBeNull();
    // Comments read the summary without it.
    expect(articleBlockText(summary)).toBe('Notes');

    // Clicking elsewhere while it is folded leaves the change inside unseen,
    // though a closed details still lays its content out on screen.
    const saved = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.dataset['testid'] === 'viewport'
        ? new DOMRect(0, 0, 600, 400)
        : new DOMRect(0, 40, 50, 20);
    };
    try {
      await act(async () => {
        container
          .querySelector('[data-testid="viewport"]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    } finally {
      HTMLElement.prototype.getBoundingClientRect = saved;
    }
    expect(marks('ins')).toEqual(['20']);
    expect(container.querySelector('[data-lody-diff="hint"]')).not.toBeNull();

    const details = container.querySelector('details')!;
    expect(details.open).toBe(false);
    Element.prototype.scrollIntoView = () => undefined;
    await act(async () => button('Next change')!.click());
    expect(details.open).toBe(true);
  });

  it('keeps a sent comment at its passage, says when the agent changed it, and resolves it', async () => {
    const sent: ArticleAnnotation = { ...COMMENT, sent: { number: 2, atMs: 1 } };
    getDefaultStore().set(articleAnnotationsAtom, [sent]);
    const render = (paragraphs: readonly string[]) =>
      act(async () =>
        root.render(
          createElement(ReviewedArticle, {
            paragraphs,
            annotations: getDefaultStore().get(articleAnnotationsAtom),
          })
        )
      );
    await render(['Revenue grew.']);
    // Sent comments are not waiting to go: no send control.
    expect(button('Send 1 comments')).toBeUndefined();
    await act(async () => button('Comments (1)')!.click());
    expect(document.body.textContent).toContain('#2 · Sent, waiting for the agent');

    await render(['Revenue grew 12% in Q3.']);
    expect(document.body.textContent).toContain('#2 · The agent changed this passage');

    await act(async () => button('Resolve')!.click());
    expect(getDefaultStore().get(articleAnnotationsAtom)).toEqual([]);
  });

  it('asks again about a sent comment as a new comment waiting to be sent', async () => {
    getDefaultStore().set(articleAnnotationsAtom, [{ ...COMMENT, sent: { number: 1, atMs: 1 } }]);
    await act(async () =>
      root.render(
        createElement(ReviewedArticle, {
          paragraphs: ['Revenue grew.'],
          annotations: getDefaultStore().get(articleAnnotationsAtom),
        })
      )
    );
    await act(async () => button('Comments (1)')!.click());
    await act(async () => button('Ask again')!.click());
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'Which region?'
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Save')!.click());
    expect(getDefaultStore().get(articleAnnotationsAtom)).toMatchObject([
      { quote: 'Revenue grew', comment: 'Which region?', previous: 'Which quarter?' },
    ]);
    expect(getDefaultStore().get(articleAnnotationsAtom)[0].sent).toBeUndefined();
    expect(button('Send 1 comments')).toBeDefined();
  });

  describe('HTML article', () => {
    const frame = () => container.querySelector('iframe')!;
    const fromPage = (data: unknown) =>
      act(async () => {
        window.dispatchEvent(new MessageEvent('message', { data, source: frame().contentWindow }));
      });
    /** Mounts a revision of the page and returns what the frame was asked to render. */
    const showRevision = async (html: string) => {
      await act(async () =>
        root.render(
          createElement(ArticleHtmlFrame, {
            key: html,
            html,
            title: 'bench.html',
            stateKey: 'thread:bench.html',
            comments: {
              threadId: 'beside' as never,
              ownerThreadId: 'thread' as never,
              path: 'bench.html',
            },
          })
        )
      );
      const posted: unknown[] = [];
      frame().contentWindow!.postMessage = (message: unknown) => {
        posted.push(message);
      };
      await fromPage({ type: 'lody-widget:ready' });
      return (posted[0] as { code: string }).code;
    };

    it("carries the reader's settings over to the agent's next revision", async () => {
      const first = await showRevision('<input id="stiffness" type="range">');
      expect(first).toContain('var saved=null;');
      await fromPage({
        type: 'lody-article:state',
        state: { controls: { '#stiffness': { value: '320' } }, details: [], scroll: [0, 40] },
      });
      const next = await showRevision('<input id="stiffness" type="range"><p>v2</p>');
      expect(next).toContain(
        'var saved={"controls":{"#stiffness":{"value":"320"}},"details":[],"scroll":[0,40]};'
      );
      // The page's own code runs between the state script and the restore.
      expect(next.indexOf('<p>v2</p>')).toBeLessThan(next.indexOf('__lodyArticleRestore()'));
    });

    it('puts the settings back after the page has set itself up, async ready handlers included', async () => {
      await showRevision('<input id="stiffness" value="170">');
      await fromPage({
        type: 'lody-article:state',
        state: { controls: { '#stiffness': { value: '320' } }, details: [], scroll: [0, 0] },
      });
      const code = await showRevision(
        '<input id="stiffness" value="170"><output id="shown"></output><script>' +
          "document.addEventListener('DOMContentLoaded', async () => {" +
          'await Promise.resolve();' +
          "const input = document.getElementById('stiffness');" +
          "input.value = '100';" +
          "input.addEventListener('input', () => { document.getElementById('shown').textContent = input.value; });" +
          '});</script>'
      );
      // Run the posted page as the widget page does: its markup, then each script in order.
      const page = new JSDOM('<!doctype html><body><div id="root"></div></body>', {
        runScripts: 'outside-only',
      });
      const pageDocument = page.window.document;
      const template = pageDocument.createElement('template');
      template.innerHTML = code;
      const pageRoot = pageDocument.getElementById('root')!;
      pageRoot.appendChild(template.content);
      for (const script of Array.from(pageRoot.querySelectorAll('script')))
        page.window.eval(script.textContent ?? '');
      // The handler and the restore chain are microtasks only.
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
      expect(pageDocument.querySelector<HTMLInputElement>('#stiffness')!.value).toBe('320');
      expect(pageDocument.querySelector('#shown')!.textContent).toBe('320');
      page.window.close();
    });

    it('shows errors the page reports and sends them with the next message on request', async () => {
      await showRevision('<script>tune()</script>');
      expect(container.querySelector('[data-article-page-errors]')).toBeNull();
      await fromPage({
        type: 'lody-article:error',
        message: 'ReferenceError: tune is not defined (line 1)',
      });
      await fromPage({
        type: 'lody-article:error',
        message: 'ReferenceError: tune is not defined (line 1)',
      });
      await fromPage({
        type: 'lody-article:error',
        message: 'Failed to load https://cdn.example/x.js',
      });
      // Messages from anything but this frame are not the page's.
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'lody-article:error', message: 'forged' },
            source: window,
          })
        );
      });
      const strip = container.querySelector('[data-article-page-errors]')!;
      expect(strip.textContent).toContain('The page reported 2 errors');
      expect(Array.from(strip.querySelectorAll('li'), (item) => item.textContent)).toEqual([
        'ReferenceError: tune is not defined (line 1)',
        'Failed to load https://cdn.example/x.js',
      ]);

      await act(async () => button('Add to the next message')!.click());
      expect(getDefaultStore().get(articleAnnotationsAtom)).toMatchObject([
        {
          threadId: 'beside',
          ownerThreadId: 'thread',
          path: 'bench.html',
          quote:
            'ReferenceError: tune is not defined (line 1)\nFailed to load https://cdn.example/x.js',
          block: { index: -1 },
        },
      ]);
      expect(button('Goes with the next message')!.disabled).toBe(true);
    });
  });
});
