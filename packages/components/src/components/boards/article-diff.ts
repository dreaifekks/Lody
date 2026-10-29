/**
 * What changed in a Markdown article since the reader last looked, marked in
 * place: deleted words struck through, then the words that replaced them
 * highlighted, only where the text changed. Code blocks, display math and
 * other blocks that cannot carry inline marks are outlined as a whole.
 *
 * Works on the rendered (hast) tree, after sanitizing, so the marks are the
 * renderer's own elements and never pass through the HTML parser. The
 * article is cut into containers (paragraphs, headings, table cells, list
 * item text, code blocks…); containers are aligned with the ones the reader
 * saw, and paired containers are diffed word by word (one CJK character per
 * word). What the reader saw is kept as containers, not as Markdown, so
 * marking part of the changes seen just folds those changes into it.
 */

/** The parts of hast this module reads and writes. */
export interface DiffText {
  type: 'text';
  value: string;
}
export interface DiffElement {
  type: 'element';
  tagName: string;
  properties: Record<string, unknown>;
  children: DiffNode[];
}
export type DiffNode = DiffText | DiffElement | { type: 'comment' | 'raw' | 'doctype' };
export interface DiffRoot {
  type: 'root';
  children: DiffNode[];
}
type DiffParent = DiffRoot | DiffElement;

/**
 * A unit of the article as the reader saw it. An inline container is a list
 * of tokens: words, spaces and punctuation of its text, and one token for
 * each element that is kept whole (inline code, math, an image). A block
 * container is one token, its text.
 */
export interface ArticleContainer {
  readonly kind: 'inline' | 'block';
  readonly tokens: readonly string[];
}

/** One change the reader can see: its id is its index in the diff. */
type Op = { readonly type: 'equal' | 'insert' | 'delete'; readonly token: string };

type Alignment =
  | { readonly type: 'equal'; readonly base: number; readonly current: number }
  | {
      readonly type: 'modified';
      readonly base: number;
      readonly current: number;
      /** Token ops, with the hunk id of each changed run. */
      readonly ops: readonly (Op & { readonly hunk: number })[];
    }
  | {
      readonly type: 'replaced';
      readonly base: number;
      readonly current: number;
      readonly hunk: number;
    }
  | { readonly type: 'inserted'; readonly current: number; readonly hunk: number }
  | { readonly type: 'deleted'; readonly base: number; readonly hunk: number };

export interface ArticleDiff {
  readonly alignment: readonly Alignment[];
  readonly hunks: number;
}

const BLOCK_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'blockquote',
  'pre',
  'details',
  'summary',
  'div',
  'section',
  'hr',
  'dl',
  'dt',
  'dd',
  'figure',
  'figcaption',
]);
/** Elements whose text is inline content to diff word by word. */
const INLINE_CONTAINER_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'td',
  'th',
  'dt',
  'dd',
  'summary',
  'figcaption',
  'li',
]);

const classNames = (element: DiffElement): string[] => {
  const value = element.properties['className'];
  return Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : [];
};

/** Kept whole inside inline text: one token each. */
const isAtomicInline = (element: DiffElement): boolean =>
  element.tagName === 'code' ||
  element.tagName === 'img' ||
  element.tagName === 'br' ||
  element.tagName === 'svg' ||
  classNames(element).some((name) => name === 'katex' || name.startsWith('math-'));

/** Blocks shown as a whole: code, display math, diagrams. */
const isAtomicBlock = (element: DiffElement): boolean =>
  element.tagName === 'pre' ||
  element.tagName === 'hr' ||
  classNames(element).some((name) => name === 'katex-display' || name === 'math-display');

const isBlock = (node: DiffNode): node is DiffElement =>
  node.type === 'element' && (BLOCK_TAGS.has(node.tagName) || isAtomicBlock(node));

const textOf = (node: DiffNode): string =>
  node.type === 'text'
    ? node.value
    : node.type === 'element'
      ? node.tagName === 'img'
        ? String(node.properties['alt'] ?? '')
        : node.children.map(textOf).join('')
      : '';

const WORD_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_]+|\s+|[^]/gu;

export const tokenizeText = (text: string): string[] => text.match(WORD_PATTERN) ?? [];

/** An atomic element's token: its tag and text, marked so it never equals a word. */
const atomicToken = (element: DiffElement): string =>
  `\u0000${element.tagName}\u0000${textOf(element)}`;
const tokenText = (token: string): string =>
  token.startsWith('\u0000') ? token.slice(token.indexOf('\u0000', 1) + 1) : token;

/** Where a container's tokens come from, so marks can be put back into the tree. */
type Leaf =
  | {
      readonly kind: 'text';
      readonly parent: DiffElement;
      readonly node: DiffText;
      readonly tokens: string[];
    }
  | {
      readonly kind: 'atomic';
      readonly parent: DiffElement;
      readonly node: DiffElement;
      readonly token: string;
    };

interface FoundContainer {
  readonly container: ArticleContainer;
  readonly parent: DiffParent;
  readonly element: DiffElement;
  /** Inline containers: their leaves in order. */
  readonly leaves: readonly Leaf[];
}

function collectLeaves(element: DiffElement, leaves: Leaf[]): void {
  for (const child of element.children) {
    if (child.type === 'text') {
      if (child.value)
        leaves.push({
          kind: 'text',
          parent: element,
          node: child,
          tokens: tokenizeText(child.value),
        });
    } else if (child.type === 'element') {
      if (isBlock(child)) continue;
      if (isAtomicInline(child))
        leaves.push({ kind: 'atomic', parent: element, node: child, token: atomicToken(child) });
      else collectLeaves(child, leaves);
    }
  }
}

function collectContainers(parent: DiffParent, found: FoundContainer[]): void {
  for (const child of parent.children) {
    if (child.type !== 'element') continue;
    if (isAtomicBlock(child)) {
      found.push({
        container: { kind: 'block', tokens: [textOf(child)] },
        parent,
        element: child,
        leaves: [],
      });
      continue;
    }
    if (INLINE_CONTAINER_TAGS.has(child.tagName)) {
      const leaves: Leaf[] = [];
      collectLeaves(child, leaves);
      const tokens = leaves.flatMap((leaf) => (leaf.kind === 'text' ? leaf.tokens : [leaf.token]));
      // A list item that only wraps blocks (a loose item's paragraphs) has no text of its own.
      if (tokens.some((token) => token.trim()))
        found.push({ container: { kind: 'inline', tokens }, parent, element: child, leaves });
    }
    collectContainers(child, found);
  }
}

const containerKey = (container: ArticleContainer): string =>
  `${container.kind}\u0001${container.tokens.join('')}`;

/**
 * The middle of two lists the full comparison table may cover: past this many
 * cells (about 16 MB) the differing middle counts as replaced as a whole, so a
 * long paragraph rewritten throughout never stalls the page.
 */
const MAX_TABLE_CELLS = 4_000_000;
/** Container pairs compared between two equal containers, at most. */
const MAX_PAIRED_GAP = 10_000;

/**
 * Longest common subsequence of two lists by key: the pairs of equal indices,
 * in order. The common start and end are matched first; only the middle that
 * differs goes through the table.
 */
function commonPairs<T>(
  a: readonly T[],
  b: readonly T[],
  key: (item: T) => string
): [number, number][] {
  const ak = a.map(key);
  const bk = b.map(key);
  let start = 0;
  while (start < ak.length && start < bk.length && ak[start] === bk[start]) start += 1;
  let endA = ak.length;
  let endB = bk.length;
  while (endA > start && endB > start && ak[endA - 1] === bk[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const pairs: [number, number][] = [];
  for (let index = 0; index < start; index += 1) pairs.push([index, index]);
  const rows = endA - start;
  const width = endB - start + 1;
  if (rows > 0 && width > 1 && (rows + 1) * width <= MAX_TABLE_CELLS) {
    const table = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i -= 1)
      for (let j = width - 2; j >= 0; j -= 1)
        table[i * width + j] =
          ak[start + i] === bk[start + j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0;
    let j = 0;
    while (i < rows && j < width - 1) {
      if (ak[start + i] === bk[start + j]) {
        pairs.push([start + i, start + j]);
        i += 1;
        j += 1;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i += 1;
      else j += 1;
    }
  }
  for (let offset = 0; endA + offset < ak.length; offset += 1)
    pairs.push([endA + offset, endB + offset]);
  return pairs;
}

function diffTokens(base: readonly string[], current: readonly string[]): Op[] {
  const raw: Op[] = [];
  let i = 0;
  let j = 0;
  for (const [bi, cj] of [
    ...commonPairs(base, current, (token) => token),
    [base.length, current.length],
  ]) {
    while (i < bi) raw.push({ type: 'delete', token: base[i++] });
    while (j < cj) raw.push({ type: 'insert', token: current[j++] });
    if (bi < base.length) {
      raw.push({ type: 'equal', token: base[i] });
      i += 1;
      j += 1;
    }
  }
  // A lone space between two changes joins them, and each changed run reads
  // as its deleted words, then its new ones: "~~this quarter~~ in Q3", not
  // "~~this~~ in ~~quarter~~ Q3".
  const ops: Op[] = [];
  let deleted: Op[] = [];
  let inserted: Op[] = [];
  const flush = () => {
    ops.push(...deleted, ...inserted);
    deleted = [];
    inserted = [];
  };
  raw.forEach((op, index) => {
    if (op.type === 'delete') deleted.push(op);
    else if (op.type === 'insert') inserted.push(op);
    else if (
      !op.token.trim() &&
      (deleted.length > 0 || inserted.length > 0) &&
      raw[index + 1] &&
      raw[index + 1].type !== 'equal'
    ) {
      deleted.push({ type: 'delete', token: op.token });
      inserted.push({ type: 'insert', token: op.token });
    } else {
      flush();
      ops.push(op);
    }
  });
  flush();
  return ops;
}

/** Aligns the containers the reader saw with the current ones and numbers each change. */
export function diffArticle(
  base: readonly ArticleContainer[],
  current: readonly ArticleContainer[]
): ArticleDiff {
  const alignment: Alignment[] = [];
  let hunks = 0;
  let i = 0;
  let j = 0;
  const pushModified = (bi: number, cj: number) => {
    const a = base[bi];
    const b = current[cj];
    if (a.kind === 'inline' && b.kind === 'inline') {
      let open = false;
      const ops = diffTokens(a.tokens, b.tokens).map((op) => {
        if (op.type === 'equal') {
          open = false;
          return { ...op, hunk: -1 };
        }
        if (!open) {
          open = true;
          hunks += 1;
        }
        return { ...op, hunk: hunks - 1 };
      });
      alignment.push({ type: 'modified', base: bi, current: cj, ops });
    } else alignment.push({ type: 'replaced', base: bi, current: cj, hunk: hunks++ });
  };
  // Between two equal containers, pair the changed ones that still look alike
  // (same kind, enough words in common), in order; the rest were deleted or added.
  const pairGap = (bi: number, cj: number) => {
    const olds = base.slice(i, bi);
    const news = current.slice(j, cj);
    // A gap this large is a rewrite: its containers count as deleted and added,
    // without comparing them pair by pair.
    if (olds.length * news.length > MAX_PAIRED_GAP) {
      while (i < bi) alignment.push({ type: 'deleted', base: i++, hunk: hunks++ });
      while (j < cj) alignment.push({ type: 'inserted', current: j++, hunk: hunks++ });
      return;
    }
    const width = news.length + 1;
    const score = new Float64Array((olds.length + 1) * width);
    // How alike two containers are: the share of words they have in common,
    // counted as multisets (cheap; order is left to the word diff).
    const wordCounts = (container: ArticleContainer): Map<string, number> => {
      const counts = new Map<string, number>();
      const tokens =
        container.kind === 'block' ? tokenizeText(container.tokens[0]) : container.tokens;
      for (const token of tokens) if (token.trim()) counts.set(token, (counts.get(token) ?? 0) + 1);
      return counts;
    };
    const total = (counts: Map<string, number>) =>
      [...counts.values()].reduce((sum, n) => sum + n, 0);
    const oldWords = olds.map(wordCounts);
    const newWords = news.map(wordCounts);
    const likeness = (x: number, y: number): number => {
      if (olds[x].kind !== news[y].kind) return 0;
      let shared = 0;
      for (const [word, count] of oldWords[x])
        shared += Math.min(count, newWords[y].get(word) ?? 0);
      return shared / Math.max(total(oldWords[x]), total(newWords[y]), 1);
    };
    const like = olds.map((_, x) => news.map((__, y) => likeness(x, y)));
    for (let x = olds.length - 1; x >= 0; x -= 1)
      for (let y = news.length - 1; y >= 0; y -= 1)
        score[x * width + y] = Math.max(
          score[(x + 1) * width + y],
          score[x * width + y + 1],
          like[x][y] >= 0.3 ? like[x][y] + score[(x + 1) * width + y + 1] : 0
        );
    let x = 0;
    let y = 0;
    while (x < olds.length && y < news.length) {
      const here = score[x * width + y];
      if (like[x][y] >= 0.3 && here === like[x][y] + score[(x + 1) * width + y + 1]) {
        pushModified(i + x++, j + y++);
      } else if (here === score[(x + 1) * width + y])
        alignment.push({ type: 'deleted', base: i + x++, hunk: hunks++ });
      else alignment.push({ type: 'inserted', current: j + y++, hunk: hunks++ });
    }
    while (x < olds.length) alignment.push({ type: 'deleted', base: i + x++, hunk: hunks++ });
    while (y < news.length) alignment.push({ type: 'inserted', current: j + y++, hunk: hunks++ });
    i = bi;
    j = cj;
  };
  for (const [bi, cj] of commonPairs(base, current, containerKey)) {
    pairGap(bi, cj);
    alignment.push({ type: 'equal', base: i++, current: j++ });
  }
  pairGap(base.length, current.length);
  return { alignment, hunks };
}

/**
 * What the reader has seen once the given changes count as seen: those
 * changes folded into the containers they saw, the rest left as they were.
 */
export function markArticleChangesSeen(
  base: readonly ArticleContainer[],
  current: readonly ArticleContainer[],
  diff: ArticleDiff,
  seen: ReadonlySet<number>
): ArticleContainer[] {
  return diff.alignment.flatMap((item): ArticleContainer[] => {
    switch (item.type) {
      case 'equal':
        return [base[item.base]];
      case 'modified':
        return [
          {
            kind: 'inline',
            tokens: item.ops.flatMap((op) =>
              op.type === 'equal'
                ? [op.token]
                : (op.type === 'insert') === seen.has(op.hunk)
                  ? [op.token]
                  : []
            ),
          },
        ];
      case 'replaced':
        return [seen.has(item.hunk) ? current[item.current] : base[item.base]];
      case 'inserted':
        return seen.has(item.hunk) ? [current[item.current]] : [];
      default:
        // Deleted.
        return seen.has(item.hunk) ? [] : [base[item.base]];
    }
  });
}

export const DIFF_ID_ATTRIBUTE = 'data-lody-diff-id';
/** On marks: `ins`, `del`, or `block` (a whole block outlined). */
export const DIFF_KIND_ATTRIBUTE = 'data-lody-diff';

// Marked words take the full text colour (a quote's muted grey on a tint
// falls under 4.5:1); the tint and the strike line say what changed.
const INSERT_STYLE =
  'background-color:hsl(var(--status-success) / 0.16);color:hsl(var(--foreground));text-decoration:none;border-radius:2px;box-decoration-break:clone;-webkit-box-decoration-break:clone';
const DELETE_STYLE =
  'background-color:hsl(var(--destructive) / 0.08);color:hsl(var(--foreground));text-decoration:line-through;text-decoration-color:hsl(var(--destructive));border-radius:2px';
const BLOCK_STYLE = 'box-shadow:0 0 0 2px hsl(var(--status-success) / 0.35);border-radius:6px';

const mark = (tagName: 'ins' | 'del', hunk: number, children: DiffNode[]): DiffElement => ({
  type: 'element',
  tagName,
  properties: {
    [DIFF_ID_ATTRIBUTE]: String(hunk),
    [DIFF_KIND_ATTRIBUTE]: tagName,
    style: tagName === 'ins' ? INSERT_STYLE : DELETE_STYLE,
  },
  children,
});
const text = (value: string): DiffText => ({ type: 'text', value });

/** Puts a modified container's token ops back into its leaves. */
/**
 * Puts a modified container's token ops back into its leaves, and returns
 * the ops with the hunk of each as marked: a change that spans several leaves
 * (plain text, then bold) is marked once per leaf, each part with its own
 * hunk, so a part on screen counts as seen without the parts off screen.
 */
function markInline(
  found: FoundContainer,
  ops: readonly (Op & { hunk: number })[],
  newHunk: () => number
): (Op & { hunk: number })[] {
  // Each leaf's replacement children, and deleted runs waiting for the next place to go.
  const replaced = new Map<DiffNode, DiffNode[]>();
  const marked = ops.map((op) => ({ ...op }));
  const parts = new Map<string, number>();
  const firstLeaf = new Map<number, number>();
  let leafIndex = 0;
  const partOf = (hunk: number): number => {
    const first = firstLeaf.get(hunk);
    if (first === undefined) firstLeaf.set(hunk, leafIndex);
    if (first === undefined || first === leafIndex) return hunk;
    const key = `${hunk}:${leafIndex}`;
    let part = parts.get(key);
    if (part === undefined) parts.set(key, (part = newHunk()));
    return part;
  };
  let pending: { hunk: number; text: string } | null = null;
  let opIndex = 0;
  const takeDeleted = (): DiffNode[] => {
    const run: DiffNode[] = [];
    while (opIndex < ops.length && ops[opIndex].type === 'delete') {
      const hunk = partOf(ops[opIndex].hunk);
      marked[opIndex].hunk = hunk;
      const token = tokenText(ops[opIndex++].token);
      if (pending && pending.hunk === hunk) pending.text += token;
      else {
        if (pending) run.push(mark('del', pending.hunk, [text(pending.text)]));
        pending = { hunk, text: token };
      }
    }
    if (pending) run.push(mark('del', pending.hunk, [text(pending.text)]));
    pending = null;
    return run;
  };
  for (const [index, leaf] of found.leaves.entries()) {
    leafIndex = index;
    const out: DiffNode[] = [];
    const tokens = leaf.kind === 'text' ? leaf.tokens : [leaf.token];
    let plain = '';
    let inserted: { hunk: number; nodes: DiffNode[] } | null = null;
    const flushPlain = () => {
      if (plain) out.push(text(plain));
      plain = '';
    };
    const flushInserted = () => {
      if (inserted) out.push(mark('ins', inserted.hunk, inserted.nodes));
      inserted = null;
    };
    for (const token of tokens) {
      const deleted = takeDeleted();
      if (deleted.length) {
        flushPlain();
        flushInserted();
        out.push(...deleted);
      }
      const op = ops[opIndex];
      const hunk = op.type === 'insert' ? partOf(op.hunk) : -1;
      marked[opIndex++].hunk = hunk;
      const piece: DiffNode = leaf.kind === 'atomic' ? leaf.node : text(token);
      if (op.type === 'insert') {
        flushPlain();
        if (inserted && inserted.hunk !== hunk) flushInserted();
        inserted ??= { hunk, nodes: [] };
        const last = inserted.nodes.at(-1);
        if (piece.type === 'text' && last?.type === 'text') last.value += piece.value;
        else inserted.nodes.push(piece);
      } else {
        flushInserted();
        if (piece.type === 'text') plain += piece.value;
        else out.push(piece);
      }
    }
    flushPlain();
    flushInserted();
    replaced.set(leaf.node, out);
  }
  leafIndex = found.leaves.length;
  const trailing = takeDeleted();
  if (trailing.length) found.element.children.push(...trailing);
  const rebuild = (element: DiffElement) => {
    element.children = element.children.flatMap((child) => {
      const next = replaced.get(child);
      if (next) return next;
      if (child.type === 'element' && !isBlock(child)) rebuild(child);
      return [child];
    });
  };
  rebuild(found.element);
  return marked;
}

/** A deleted container shown where it was: struck text in its own paragraph, or inline in a cell. */
function insertDeleted(
  container: ArticleContainer,
  hunk: number,
  before: FoundContainer | undefined,
  after: FoundContainer | undefined,
  root: DiffRoot
): void {
  const struck = mark('del', hunk, [text(container.tokens.map(tokenText).join(''))]);
  const anchor = before ?? after;
  const blockParent = (parent: DiffParent) =>
    parent.type === 'root' || !['tr', 'thead', 'tbody', 'tfoot', 'table'].includes(parent.tagName);
  if (anchor && blockParent(anchor.parent)) {
    const siblings = anchor.parent.children;
    const index = siblings.indexOf(anchor.element);
    const paragraph: DiffElement = {
      type: 'element',
      tagName: 'p',
      properties: { [DIFF_KIND_ATTRIBUTE]: 'removed' },
      children: [struck],
    };
    // After the anchor, past deletions already put there, so they keep their order.
    let at = before ? index : index + 1;
    if (!before)
      while (
        siblings[at]?.type === 'element' &&
        (siblings[at] as DiffElement).properties[DIFF_KIND_ATTRIBUTE] === 'removed'
      )
        at += 1;
    siblings.splice(at, 0, paragraph);
  } else if (anchor) {
    anchor.element.children.unshift(struck);
  } else {
    root.children.push({
      type: 'element',
      tagName: 'p',
      properties: { [DIFF_KIND_ATTRIBUTE]: 'removed' },
      children: [struck],
    });
  }
}

/** Outlines a block that changed as a whole. */
function outlineBlock(found: FoundContainer, hunk: number): void {
  const siblings = found.parent.children;
  siblings[siblings.indexOf(found.element)] = {
    type: 'element',
    tagName: 'div',
    properties: {
      [DIFF_ID_ATTRIBUTE]: String(hunk),
      [DIFF_KIND_ATTRIBUTE]: 'block',
      style: BLOCK_STYLE,
    },
    children: [found.element],
  };
}

/** The containers of a rendered article, in document order. */
export function readArticleContainers(root: DiffRoot): ArticleContainer[] {
  const found: FoundContainer[] = [];
  collectContainers(root, found);
  return found.map((item) => item.container);
}

/**
 * Marks the changes since `base` in a rendered article, in place, and
 * returns its containers. Without a base it only reads them.
 */
export function markArticleChanges(
  root: DiffRoot,
  base: readonly ArticleContainer[] | null
): { readonly containers: ArticleContainer[]; readonly diff: ArticleDiff | null } {
  const found: FoundContainer[] = [];
  collectContainers(root, found);
  const containers = found.map((item) => item.container);
  if (!base) return { containers, diff: null };
  const compared = diffArticle(base, containers);
  let hunks = compared.hunks;
  const newHunk = () => hunks++;
  // Inline marks first, then deleted containers beside their neighbours, then
  // outlines last: an outline replaces its block, which deletions anchor to.
  const outlines: [FoundContainer, number][] = [];
  const deletions: (() => void)[] = [];
  const alignment = compared.alignment.map((item) =>
    item.type === 'modified'
      ? { ...item, ops: markInline(found[item.current], item.ops, newHunk) }
      : item
  );
  for (const [index, item] of alignment.entries()) {
    if (item.type === 'modified') continue;
    else if (item.type === 'replaced' || item.type === 'inserted') {
      const target = found[item.current];
      if (target.container.kind === 'block') outlines.push([target, item.hunk]);
      else
        markInline(
          target,
          target.container.tokens.map((token) => ({ type: 'insert', token, hunk: item.hunk })),
          // A container added whole is one change, however many leaves it spans.
          () => item.hunk
        );
      // A rewritten code block is outlined; its old text would only be noise.
      if (
        item.type === 'replaced' &&
        !(target.container.kind === 'block' && base[item.base].kind === 'block')
      )
        deletions.push(() => insertDeleted(base[item.base], item.hunk, target, undefined, root));
    } else if (item.type === 'deleted') {
      const next = alignment.slice(index + 1).find((later) => 'current' in later);
      const previous = alignment
        .slice(0, index)
        .reverse()
        .find((earlier) => 'current' in earlier);
      deletions.push(() =>
        insertDeleted(
          base[item.base],
          item.hunk,
          next && 'current' in next ? found[next.current] : undefined,
          !next && previous && 'current' in previous ? found[previous.current] : undefined,
          root
        )
      );
    }
  }
  for (const insert of deletions) insert();
  for (const [target, hunk] of outlines) outlineBlock(target, hunk);
  return { containers, diff: { alignment, hunks } };
}
