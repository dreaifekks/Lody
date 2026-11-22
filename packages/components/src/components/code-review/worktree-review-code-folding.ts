import type { FileDiffMetadata } from '@pierre/diffs';

export const DEFAULT_MIN_FOLD_SPAN_LINES = 6;
export const DEFAULT_FOLD_CHANGE_MARGIN_LINES = 1;

export type FoldableBlockKind = 'brace' | 'bracket';

export interface FoldableCodeBlock {
  readonly id: string;
  readonly kind: FoldableBlockKind;
  /** 1-based line containing the opening `{` or `[`. */
  readonly openLine: number;
  /** 1-based line containing the matching closing `}` or `]`. */
  readonly closeLine: number;
  /** 1-based first hidden context line (`openLine + 1`). */
  readonly hideStartLine: number;
  /**
   * 1-based last hidden context line (`closeLine` when `closeLine` holds only
   * closing punctuation/comments, or `closeLine - 1` when `closeLine` continues
   * into another clause/block such as `} else {`, `}, {`, or `}, [deps]);`).
   */
  readonly hideEndLine: number;
  /** Number of hidden lines (`hideEndLine - hideStartLine + 1`). */
  readonly hiddenLineCount: number;
  /** Total lines spanned by the block (`closeLine - openLine + 1`). */
  readonly spanLines: number;
  /** Leading indentation width (in columns) of `openLine`. */
  readonly indentColumns: number;
}

export interface ScannedBracketBlock extends FoldableCodeBlock {
  /** 0-based column of the opening delimiter on `openLine`. */
  readonly openColumn: number;
  /** 0-based column of the closing delimiter on `closeLine`. */
  readonly closeColumn: number;
  /** True when `closeLine` carries meaningful tokens after the closing delimiter. */
  readonly closeLineContinues: boolean;
}

export interface FindFoldableBlocksOptions {
  /** 1-based inclusive start line of the expanded enclosing function. */
  readonly startLine: number;
  /** 1-based inclusive end line of the expanded enclosing function. */
  readonly endLine: number;
  /** 1-based new-file line numbers containing diff additions or deletion boundaries. */
  readonly changedLines: ReadonlySet<number>;
  /** Minimum lines spanned (`closeLine - openLine + 1`) to qualify. Defaults to 6. */
  readonly minSpanLines?: number;
  /** Unchanged buffer lines around every diff change that must not be folded. Defaults to 1. */
  readonly changeMarginLines?: number;
  /** Exclude the enclosing function's own outermost `{ ... }` body. Defaults to true. */
  readonly excludeOuterFunctionBody?: boolean;
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);

const REGEX_PRECEDING_PUNCTUATION = new Set([
  '(',
  '[',
  '{',
  ',',
  ';',
  ':',
  '?',
  '=',
  '!',
  '&',
  '|',
  '^',
  '~',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
]);

function isIdentifierStart(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36 ||
    code >= 128
  );
}

function isIdentifierPart(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return isIdentifierStart(ch) || (code >= 48 && code <= 57);
}

function measureIndentColumns(line: string): number {
  let cols = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === ' ') cols += 1;
    else if (ch === '\t') cols += 2;
    else break;
  }
  return cols;
}

/**
 * Checks whether the remainder of `closeLine` after `closeColumn` contains
 * continuation tokens (like `else {`, `catch`, `finally`, `while`, `, {`, or
 * `, [deps])`) rather than pure closing punctuation and optional comments.
 */
function hasMeaningfulContinuationAfterClose(line: string, closeColumn: number): boolean {
  let i = closeColumn + 1;
  const len = line.length;
  while (i < len) {
    const ch = line[i]!;
    const next = i + 1 < len ? line[i + 1]! : '';
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      return false;
    }
    if (ch === '/' && next === '*') {
      const endComment = line.indexOf('*/', i + 2);
      if (endComment === -1) return false;
      i = endComment + 2;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}' || ch === ';' || ch === ',') {
      i += 1;
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Attempts to scan a single-line JS/TS regex literal starting at `startIndex`
 * (where `line[startIndex] === '/'`). Returns the index of the closing `/`
 * (plus trailing flags) if a valid single-line regex closes on `line`, or `-1`.
 */
function tryScanRegexLiteralEnd(line: string, startIndex: number): number {
  const len = line.length;
  if (startIndex + 1 >= len) return -1;
  const first = line[startIndex + 1]!;
  // Empty regex `//` is a line comment, `/*` is a block comment, `/>` is JSX self-close.
  if (first === '/' || first === '*' || first === '>') return -1;

  let inCharClass = false;
  let i = startIndex + 1;
  while (i < len) {
    const ch = line[i]!;
    if (ch === '\r' || ch === '\n') return -1;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (inCharClass) {
      if (ch === ']') inCharClass = false;
      i += 1;
      continue;
    }
    if (ch === '[') {
      inCharClass = true;
      i += 1;
      continue;
    }
    if (ch === '/') {
      let end = i;
      while (end + 1 < len && /[a-z]/iu.test(line[end + 1]!)) {
        end += 1;
      }
      return end;
    }
    i += 1;
  }
  return -1;
}

export function splitSourceLines(text: string): readonly string[] {
  if (text.length === 0) return [];
  const raw = text.split('\n');
  if (raw.length > 1 && raw[raw.length - 1] === '') {
    raw.pop();
  }
  return raw;
}

type OpenStackEntry =
  | {
      readonly kind: FoldableBlockKind;
      readonly line: number;
      readonly column: number;
      readonly indentColumns: number;
    }
  | {
      readonly kind: 'template-expr';
      readonly line: number;
      readonly column: number;
    };

/**
 * Scans JS/TS/TSX/C-like source lines for balanced multi-line `{ ... }` and
 * `[ ... ]` blocks while skipping single/double strings, template literals
 * (including nested `${ ... }` interpolations), regex literals, and single/multi-line
 * comments.
 */
export function scanBracketBlocks(sourceLines: readonly string[]): readonly ScannedBracketBlock[] {
  const blocks: ScannedBracketBlock[] = [];
  const stack: OpenStackEntry[] = [];

  // Mode stack: `'code'` at base; pushes `'template'` when inside `` `...` ``.
  // When `${` is encountered inside `'template'`, we push a `'template-expr'`
  // sentinel onto `stack` and push `'code'` onto `modes`. Closing that `}`
  // pops `'code'` back to `'template'`.
  const modes: Array<'code' | 'template'> = ['code'];
  let inBlockComment = false;

  // Tracks whether the most recent non-whitespace token allows a `/` to start a regex.
  let regexAllowed = true;
  let lastNonWsChar = '';

  for (let lineIdx = 0; lineIdx < sourceLines.length; lineIdx += 1) {
    const rawLine = sourceLines[lineIdx] ?? '';
    const line = rawLine.endsWith('\n')
      ? rawLine.slice(0, rawLine.endsWith('\r\n') ? -2 : -1)
      : rawLine.endsWith('\r')
        ? rawLine.slice(0, -1)
        : rawLine;
    const lineNumber = lineIdx + 1;
    const indentColumns = measureIndentColumns(line);

    let i = 0;
    const len = line.length;

    while (i < len) {
      const ch = line[i]!;
      const next = i + 1 < len ? line[i + 1]! : '';

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }

      const mode = modes[modes.length - 1] ?? 'code';

      if (mode === 'template') {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '`') {
          modes.pop();
          regexAllowed = false;
          lastNonWsChar = '`';
          i += 1;
          continue;
        }
        if (ch === '$' && next === '{') {
          stack.push({ kind: 'template-expr', line: lineNumber, column: i });
          modes.push('code');
          regexAllowed = true;
          lastNonWsChar = '{';
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }

      // Code mode
      if (ch === ' ' || ch === '\t') {
        i += 1;
        continue;
      }

      // Single-line comment
      if (ch === '/' && next === '/') {
        break;
      }

      // Multi-line comment
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i += 2;
        continue;
      }

      // Single or double-quoted string (resets at EOL for malformed resilience)
      if (ch === "'" || ch === '"') {
        const quote = ch;
        i += 1;
        while (i < len) {
          const cur = line[i]!;
          if (cur === '\\') {
            i += 2;
            continue;
          }
          i += 1;
          if (cur === quote) break;
        }
        regexAllowed = false;
        lastNonWsChar = quote;
        continue;
      }

      // Template literal start
      if (ch === '`') {
        modes.push('template');
        i += 1;
        continue;
      }

      // Regex literal vs division / JSX closing slash
      if (ch === '/') {
        if (regexAllowed && lastNonWsChar !== '<') {
          const regexEnd = tryScanRegexLiteralEnd(line, i);
          if (regexEnd !== -1) {
            regexAllowed = false;
            lastNonWsChar = '/';
            i = regexEnd + 1;
            continue;
          }
        }
        regexAllowed = true;
        lastNonWsChar = '/';
        i += 1;
        continue;
      }

      // Identifiers & keywords (for regex lookbehind accuracy)
      if (isIdentifierStart(ch)) {
        let end = i + 1;
        while (end < len && isIdentifierPart(line[end]!)) {
          end += 1;
        }
        const word = line.slice(i, end);
        regexAllowed = REGEX_PRECEDING_KEYWORDS.has(word);
        lastNonWsChar = word[word.length - 1] ?? ch;
        i = end;
        continue;
      }

      // Numbers
      if (ch >= '0' && ch <= '9') {
        let end = i + 1;
        while (end < len && /[0-9a-fA-FxXoObBn._]/u.test(line[end]!)) {
          end += 1;
        }
        regexAllowed = false;
        lastNonWsChar = line[end - 1] ?? ch;
        i = end;
        continue;
      }

      // Opening `{` or `[`
      if (ch === '{' || ch === '[') {
        stack.push({
          kind: ch === '{' ? 'brace' : 'bracket',
          line: lineNumber,
          column: i,
          indentColumns,
        });
        regexAllowed = true;
        lastNonWsChar = ch;
        i += 1;
        continue;
      }

      // Closing `}` or `]`
      if (ch === '}' || ch === ']') {
        const expectedKind: FoldableBlockKind = ch === '}' ? 'brace' : 'bracket';
        if (ch === '}' && stack.length > 0 && stack[stack.length - 1]!.kind === 'template-expr') {
          stack.pop();
          if (modes.length > 1) {
            modes.pop();
          }
          i += 1;
          continue;
        }

        // Find matching open delimiter (stopping before a `template-expr` barrier).
        let matchIndex = -1;
        for (let s = stack.length - 1; s >= 0; s -= 1) {
          const entry = stack[s]!;
          if (entry.kind === 'template-expr') break;
          if (entry.kind === expectedKind) {
            matchIndex = s;
            break;
          }
        }

        if (matchIndex !== -1) {
          const open = stack[matchIndex]! as Extract<OpenStackEntry, { kind: FoldableBlockKind }>;
          stack.length = matchIndex;

          if (lineNumber > open.line) {
            const closeLineContinues = hasMeaningfulContinuationAfterClose(line, i);
            const hideStartLine = open.line + 1;
            const hideEndLine = closeLineContinues ? lineNumber - 1 : lineNumber;
            const hiddenLineCount = Math.max(0, hideEndLine - hideStartLine + 1);
            const spanLines = lineNumber - open.line + 1;
            blocks.push({
              id: `${open.line}:${lineNumber}:${open.kind}`,
              kind: open.kind,
              openLine: open.line,
              closeLine: lineNumber,
              hideStartLine,
              hideEndLine,
              hiddenLineCount,
              spanLines,
              indentColumns: open.indentColumns,
              openColumn: open.column,
              closeColumn: i,
              closeLineContinues,
            });
          }
        }

        regexAllowed = ch === '}';
        lastNonWsChar = ch;
        i += 1;
        continue;
      }

      // Track `++` / `--` (cannot precede regex) vs single `+` / `-` (can precede regex)
      if ((ch === '+' && next === '+') || (ch === '-' && next === '-')) {
        regexAllowed = false;
        lastNonWsChar = ch;
        i += 2;
        continue;
      }

      regexAllowed = REGEX_PRECEDING_PUNCTUATION.has(ch);
      lastNonWsChar = ch;
      i += 1;
    }
  }

  return blocks;
}

/**
 * Collects all 1-based new-file line numbers that contain additions or sit
 * directly adjacent to pure deletions in a parsed `@pierre/diffs` `FileDiffMetadata`.
 */
export function collectDiffChangedNewLines(
  fileDiff: Pick<FileDiffMetadata, 'hunks'> | null | undefined
): ReadonlySet<number> {
  const changed = new Set<number>();
  if (!fileDiff) return changed;

  for (const hunk of fileDiff.hunks) {
    let newLine = hunk.additionCount === 0 ? hunk.additionStart + 1 : hunk.additionStart;
    for (const part of hunk.hunkContent) {
      if (part.type === 'context') {
        newLine += part.lines;
        continue;
      }
      if (part.additions > 0) {
        for (let offset = 0; offset < part.additions; offset += 1) {
          changed.add(newLine + offset);
        }
        newLine += part.additions;
      } else if (part.deletions > 0) {
        // Pure deletion sits between `newLine - 1` and `newLine`.
        if (newLine > 1) changed.add(newLine - 1);
        changed.add(newLine);
      }
    }
  }

  return changed;
}

function isBlockStrictlyInside(inner: ScannedBracketBlock, outer: ScannedBracketBlock): boolean {
  if (inner === outer) return false;
  const startsAfter =
    inner.openLine > outer.openLine ||
    (inner.openLine === outer.openLine && inner.openColumn > outer.openColumn);
  const endsBefore =
    inner.closeLine < outer.closeLine ||
    (inner.closeLine === outer.closeLine && inner.closeColumn < outer.closeColumn);
  return startsAfter && endsBefore;
}

function findOuterFunctionBodyBlock(
  inRangeBlocks: readonly ScannedBracketBlock[],
  startLine: number,
  endLine: number
): ScannedBracketBlock | null {
  const topLevelBraces = inRangeBlocks.filter(
    (candidate) =>
      candidate.kind === 'brace' &&
      !inRangeBlocks.some((other) => isBlockStrictlyInside(candidate, other))
  );
  if (topLevelBraces.length === 0) return null;

  const sortOuterFirst = (a: ScannedBracketBlock, b: ScannedBracketBlock) =>
    a.openLine - b.openLine || b.closeLine - a.closeLine || a.openColumn - b.openColumn;

  // Priority 1: top-level `{ ... }` closing directly on the function's `endLine`.
  const exactEndMatches = topLevelBraces
    .filter((b) => b.closeLine === endLine)
    .sort(sortOuterFirst);
  if (exactEndMatches.length > 0) {
    return exactEndMatches[0]!;
  }

  // Priority 2: top-level `{ ... }` opening on `startLine` (e.g., `useCallback(() => { ... }, [deps])`).
  const exactStartMatches = topLevelBraces
    .filter((b) => b.openLine === startLine)
    .sort(sortOuterFirst);
  if (exactStartMatches.length > 0) {
    return exactStartMatches[0]!;
  }

  // Priority 3: single top-level `{ ... }` inside a multi-line wrapper like
  // `const fn = useCallback(\n  () => {\n ...\n  },\n  [deps]\n);`.
  if (topLevelBraces.length === 1) {
    return topLevelBraces[0]!;
  }

  return null;
}

function blockTouchesChangedLines(
  block: Pick<FoldableCodeBlock, 'openLine' | 'closeLine'>,
  changedLines: ReadonlySet<number>,
  margin: number
): boolean {
  if (changedLines.size === 0) return false;
  const minLine = block.openLine - margin;
  const maxLine = block.closeLine + margin;
  for (const line of changedLines) {
    if (line >= minLine && line <= maxLine) {
      return true;
    }
  }
  return false;
}

/**
 * Finds non-overlapping, top-level foldable unchanged `{ ... }` and `[ ... ]`
 * blocks inside an expanded function range `[startLine, endLine]`.
 *
 * Excludes:
 * - The enclosing function's own outermost `{ ... }` body.
 * - Any block intersecting a diff add/delete line (plus `±changeMarginLines`).
 * - Blocks shorter than `minSpanLines` (default 6) or hiding fewer than 2 lines.
 * - Inner sub-blocks already covered by an accepted outer foldable block.
 */
export function findFoldableBlocksInRange(
  sourceLines: readonly string[],
  options: FindFoldableBlocksOptions
): readonly FoldableCodeBlock[] {
  const {
    startLine,
    endLine,
    changedLines,
    minSpanLines = DEFAULT_MIN_FOLD_SPAN_LINES,
    changeMarginLines = DEFAULT_FOLD_CHANGE_MARGIN_LINES,
    excludeOuterFunctionBody = true,
  } = options;

  if (sourceLines.length === 0 || endLine <= startLine) return [];

  const allBlocks = scanBracketBlocks(sourceLines);
  const inRangeBlocks = allBlocks.filter(
    (block) => block.openLine >= startLine && block.closeLine <= endLine
  );
  if (inRangeBlocks.length === 0) return [];

  const outerFunctionBody = excludeOuterFunctionBody
    ? findOuterFunctionBodyBlock(inRangeBlocks, startLine, endLine)
    : null;

  // Filter BEFORE outer-block deduplication so inner unchanged blocks inside a
  // modified outer `if (...) { ... }` or inside the excluded function body remain eligible.
  const eligible = inRangeBlocks.filter((block) => {
    if (outerFunctionBody && block === outerFunctionBody) return false;
    if (block.spanLines < minSpanLines) return false;
    if (block.hiddenLineCount < 2) return false;
    if (blockTouchesChangedLines(block, changedLines, changeMarginLines)) return false;
    return true;
  });

  if (eligible.length === 0) return [];

  eligible.sort(
    (a, b) => a.openLine - b.openLine || b.closeLine - a.closeLine || a.openColumn - b.openColumn
  );

  const accepted: FoldableCodeBlock[] = [];
  for (const candidate of eligible) {
    const coveredByOuter = accepted.some(
      (outer) =>
        (outer.openLine <= candidate.openLine && candidate.closeLine <= outer.closeLine) ||
        (candidate.openLine >= outer.openLine && candidate.openLine <= outer.hideEndLine)
    );
    if (coveredByOuter) continue;

    accepted.push({
      id: candidate.id,
      kind: candidate.kind,
      openLine: candidate.openLine,
      closeLine: candidate.closeLine,
      hideStartLine: candidate.hideStartLine,
      hideEndLine: candidate.hideEndLine,
      hiddenLineCount: candidate.hiddenLineCount,
      spanLines: candidate.spanLines,
      indentColumns: candidate.indentColumns,
    });
  }

  return accepted;
}

/**
 * Generates `@pierre/diffs` `unsafeCSS` hiding `[hideStartLine .. hideEndLine]`
 * context lines in `unified` diff mode while strictly scoping to
 * `[data-line-type^="context"]` so gutter numbers stay aligned and diff
 * addition/deletion rows are never hidden.
 *
 * Returns an empty string in `split` mode to safely suspend block folding
 * and avoid left/right row misalignment.
 */
export function buildFoldedLinesUnsafeCSS(
  collapsedBlocks: readonly FoldableCodeBlock[],
  diffStyle: 'unified' | 'split' = 'unified'
): string {
  if (diffStyle !== 'unified' || collapsedBlocks.length === 0) return '';

  const hiddenLines = new Set<number>();
  for (const block of collapsedBlocks) {
    for (let line = block.hideStartLine; line <= block.hideEndLine; line += 1) {
      hiddenLines.add(line);
    }
  }
  if (hiddenLines.size === 0) return '';

  const sortedLines = Array.from(hiddenLines).sort((a, b) => a - b);
  const selectors: string[] = [];
  for (const line of sortedLines) {
    selectors.push(
      `[data-line="${line}"][data-line-type^="context"]`,
      `[data-column-number="${line}"][data-line-type^="context"]`
    );
  }
  return `${selectors.join(',\n')} {\n  display: none !important;\n}`;
}

export function formatFoldBlockLabel(
  block: Pick<FoldableCodeBlock, 'kind' | 'hiddenLineCount'>
): string {
  return block.kind === 'bracket'
    ? `… [ ${block.hiddenLineCount} 行 ]`
    : `… { ${block.hiddenLineCount} 行 }`;
}
