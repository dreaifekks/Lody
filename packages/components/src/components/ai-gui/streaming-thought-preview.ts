import type { AssistantActivityRenderItem } from './assistant-turn-render-blocks';

export const STREAMING_THOUGHT_PREVIEW_MAX_CHARS = 260;
export const STREAMING_THOUGHT_PREVIEW_INLINE_CLEANUP_CAP = 1_024;
export const STREAMING_THOUGHT_PREVIEW_MAX_CLEANED_CHARS = 8_192;
export const STREAMING_THOUGHT_PREVIEW_MAX_CLEANED_LINES = 32;
export const STREAMING_THOUGHT_PREVIEW_MIN_HOLD_MS = 1_500;
export const STREAMING_THOUGHT_PREVIEW_LOW_STIMULUS_HOLD_MS = 4_000;

const WORD_BOUNDARY_LOOKBACK_CHARS = 32;
const PREFIX_PROBE_CHARS = 96;
const MAX_LINK_RECURSION_DEPTH = 4;
const AGY_PLACEHOLDER_LOWER = "i'm thinking through how to approach this.";
const AGY_PLACEHOLDER_PREFIX_RE = /^i'm thinking through how to approach this\.(?:\s+|$)/i;
const BLOCK_PREFIX_RE = /^(?:>\s*|#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/;

type CandidateLine = {
  paragraphId: number;
  start: number;
  end: number;
  text?: string;
};

type InlineSegment = {
  kind: 'text' | 'code';
  value: string;
};

export type StreamingThoughtPreviewInspection = {
  preview: string | null;
  cleanedLineCount: number;
  cleanedCharCount: number;
};

const isHorizontalWhitespaceOrCr = (code: number): boolean =>
  code === 32 || code === 9 || code === 13 || code === 11 || code === 12 || code === 160;

const isAsciiWordCode = (code: number): boolean =>
  (code >= 48 && code <= 57) ||
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  code === 95;

const isFormattingOnlyChar = (code: number): boolean =>
  isHorizontalWhitespaceOrCr(code) ||
  code === 35 || // #
  code === 42 || // *
  code === 43 || // +
  code === 45 || // -
  code === 62 || // >
  code === 95 || // _
  code === 126; // ~

const isBlankLineRange = (text: string, start: number, end: number): boolean => {
  for (let index = start; index < end; index += 1) {
    if (!isHorizontalWhitespaceOrCr(text.charCodeAt(index))) {
      return false;
    }
  }
  return true;
};

const isFormattingOnlyRange = (text: string, start: number, end: number): boolean => {
  for (let index = start; index < end; index += 1) {
    if (!isFormattingOnlyChar(text.charCodeAt(index))) {
      return false;
    }
  }
  return true;
};

const trimHorizontalStart = (text: string, start: number, end: number): number => {
  let cursor = start;
  while (cursor < end && isHorizontalWhitespaceOrCr(text.charCodeAt(cursor))) {
    cursor += 1;
  }
  return cursor;
};

const trimHorizontalEnd = (text: string, start: number, end: number): number => {
  let cursor = end;
  while (cursor > start && isHorizontalWhitespaceOrCr(text.charCodeAt(cursor - 1))) {
    cursor -= 1;
  }
  return cursor;
};

const startsWithFenceAt = (text: string, start: number, end: number): boolean => {
  if (end - start < 3) {
    return false;
  }
  const ch = text.charCodeAt(start);
  return (
    (ch === 96 || ch === 126) &&
    text.charCodeAt(start + 1) === ch &&
    text.charCodeAt(start + 2) === ch
  );
};

const countBacktickRun = (text: string, index: number, limit: number): number => {
  let count = 0;
  while (index + count < limit && text.charCodeAt(index + count) === 96) {
    count += 1;
  }
  return count;
};

const isEscapedByBackslash = (text: string, index: number, boundStart: number): boolean => {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= boundStart && text.charCodeAt(cursor) === 92;
    cursor -= 1
  ) {
    backslashes += 1;
  }
  return (backslashes & 1) === 1;
};

const findCharCodeInRange = (text: string, code: number, start: number, end: number): number => {
  for (let index = start; index < end; index += 1) {
    if (text.charCodeAt(index) === code) {
      return index;
    }
  }
  return -1;
};

const findDoubleStarInRange = (text: string, start: number, end: number): number => {
  const limit = end - 1;
  for (let index = start; index < limit; index += 1) {
    if (text.charCodeAt(index) === 42 && text.charCodeAt(index + 1) === 42) {
      return index;
    }
  }
  return -1;
};

/**
 * Builds a single-pass O(end - start) index of CommonMark inline code span closing
 * offsets within `[start, end)` without ever scanning past `end`. Returns `null`
 * when no paired code spans exist.
 *
 * Unescaped backtick runs may open or close spans; backslash-escaped runs (`\``)
 * never open a span, but may still close an open span because backslashes are
 * literal inside CommonMark code spans.
 */
const buildCodeSpanEndMap = (
  text: string,
  start: number,
  end: number
): Map<number, number> | null => {
  const firstTick = findCharCodeInRange(text, 96, start, end);
  if (firstTick === -1) {
    return null;
  }

  const runs: Array<{ pos: number; len: number; escaped: boolean }> = [];
  let cursor = firstTick;
  while (cursor < end) {
    const pos = findCharCodeInRange(text, 96, cursor, end);
    if (pos === -1) {
      break;
    }
    const len = countBacktickRun(text, pos, end);
    runs.push({ pos, len, escaped: isEscapedByBackslash(text, pos, start) });
    cursor = pos + len;
  }

  if (runs.length < 2) {
    return null;
  }

  const nextCloseByLen = new Map<number, number>();
  let closeEndByOpenPos: Map<number, number> | null = null;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    if (!run.escaped) {
      const closeEnd = nextCloseByLen.get(run.len);
      if (closeEnd !== undefined) {
        closeEndByOpenPos ??= new Map<number, number>();
        closeEndByOpenPos.set(run.pos, closeEnd);
      }
    }
    nextCloseByLen.set(run.len, run.pos + run.len);
  }

  return closeEndByOpenPos;
};

/**
 * Checks whether a line starting with `**` lacks a matching closing `**` outside
 * inline code spans within `[start, end)` in O(end - start) time without scanning
 * past `end`.
 */
const hasUnclosedLeadingBoldRange = (text: string, start: number, end: number): boolean => {
  if (end - start < 2 || text.charCodeAt(start) !== 42 || text.charCodeAt(start + 1) !== 42) {
    return false;
  }

  let nextBold = findDoubleStarInRange(text, start + 2, end);
  if (nextBold === -1) {
    return true;
  }

  let nextTick = findCharCodeInRange(text, 96, start + 2, nextBold);
  if (nextTick === -1) {
    return false;
  }

  const codeSpanEndMap = buildCodeSpanEndMap(text, start + 2, end);
  if (!codeSpanEndMap) {
    return false;
  }

  let cursor = start + 2;
  while (cursor < end) {
    if (nextBold < cursor) {
      nextBold = findDoubleStarInRange(text, cursor, end);
    }
    if (nextBold === -1) {
      return true;
    }
    if (nextTick !== -1 && nextTick < cursor) {
      nextTick = findCharCodeInRange(text, 96, cursor, nextBold);
    }
    if (nextTick !== -1 && nextTick < nextBold) {
      const spanEnd = codeSpanEndMap.get(nextTick);
      cursor = spanEnd ?? nextTick + countBacktickRun(text, nextTick, end);
      continue;
    }
    return false;
  }

  return true;
};

const isStreamingAgyPlaceholderPrefix = (text: string): boolean => {
  const lower = text.toLowerCase();
  return lower.length > 0 && AGY_PLACEHOLDER_LOWER.startsWith(lower);
};

const truncatePreview = (text: string): string => {
  if (text.length <= STREAMING_THOUGHT_PREVIEW_MAX_CHARS) {
    return text;
  }
  const hardLimit = STREAMING_THOUGHT_PREVIEW_MAX_CHARS - 1;
  let cut = hardLimit;
  const minBoundary = Math.max(1, hardLimit - WORD_BOUNDARY_LOOKBACK_CHARS);
  const lastSpace = text.lastIndexOf(' ', hardLimit);
  if (lastSpace >= minBoundary) {
    cut = lastSpace;
  }
  return `${text.slice(0, cut).trimEnd()}…`;
};

const stripTrailingAtxHashes = (text: string): string => {
  let end = text.length;
  while (end > 0 && isHorizontalWhitespaceOrCr(text.charCodeAt(end - 1))) {
    end -= 1;
  }
  let hashStart = end;
  while (hashStart > 0 && text.charCodeAt(hashStart - 1) === 35) {
    hashStart -= 1;
  }
  if (
    hashStart < end &&
    hashStart > 0 &&
    isHorizontalWhitespaceOrCr(text.charCodeAt(hashStart - 1))
  ) {
    let spaceStart = hashStart;
    while (spaceStart > 0 && isHorizontalWhitespaceOrCr(text.charCodeAt(spaceStart - 1))) {
      spaceStart -= 1;
    }
    return text.slice(0, spaceStart);
  }
  return text;
};

/** Linear O(n) single-`*` emphasis stripping (leaves `2 * 3` untouched). */
const stripStarEmphasis = (text: string): string => {
  if (!text.includes('*')) {
    return text;
  }
  const len = text.length;
  let result = '';
  let cursor = 0;
  while (cursor < len) {
    const open = text.indexOf('*', cursor);
    if (open === -1) {
      result += text.slice(cursor);
      break;
    }
    if (open + 1 >= len || isHorizontalWhitespaceOrCr(text.charCodeAt(open + 1))) {
      result += text.slice(cursor, open + 1);
      cursor = open + 1;
      continue;
    }
    const close = text.indexOf('*', open + 1);
    if (close === -1) {
      result += text.slice(cursor);
      break;
    }
    if (isHorizontalWhitespaceOrCr(text.charCodeAt(close - 1))) {
      result += text.slice(cursor, close);
      cursor = close;
      continue;
    }
    result += text.slice(cursor, open);
    result += text.slice(open + 1, close);
    cursor = close + 1;
  }
  return result;
};

/** Linear O(n) single-`_` emphasis stripping (preserves intraword `snake_case`). */
const stripUnderscoreEmphasis = (text: string): string => {
  if (!text.includes('_')) {
    return text;
  }
  const len = text.length;
  const validClosers: number[] = [];
  for (let index = 1; index < len; index += 1) {
    if (
      text.charCodeAt(index) === 95 &&
      !isHorizontalWhitespaceOrCr(text.charCodeAt(index - 1)) &&
      (index + 1 === len || !isAsciiWordCode(text.charCodeAt(index + 1)))
    ) {
      validClosers.push(index);
    }
  }
  if (validClosers.length === 0) {
    return text;
  }

  let result = '';
  let cursor = 0;
  let closerPtr = 0;
  while (cursor < len) {
    const open = text.indexOf('_', cursor);
    if (open === -1) {
      result += text.slice(cursor);
      break;
    }
    const isValidOpener =
      (open === 0 || !isAsciiWordCode(text.charCodeAt(open - 1))) &&
      open + 1 < len &&
      !isHorizontalWhitespaceOrCr(text.charCodeAt(open + 1));
    if (!isValidOpener) {
      result += text.slice(cursor, open + 1);
      cursor = open + 1;
      continue;
    }

    while (closerPtr < validClosers.length && validClosers[closerPtr]! <= open) {
      closerPtr += 1;
    }
    if (closerPtr >= validClosers.length) {
      result += text.slice(cursor);
      break;
    }
    const close = validClosers[closerPtr]!;
    let innerOpener = -1;
    let probe = text.indexOf('_', open + 1);
    while (probe !== -1 && probe < close) {
      if (
        isHorizontalWhitespaceOrCr(text.charCodeAt(probe - 1)) &&
        probe + 1 < close &&
        !isHorizontalWhitespaceOrCr(text.charCodeAt(probe + 1))
      ) {
        innerOpener = probe;
        break;
      }
      probe = text.indexOf('_', probe + 1);
    }
    if (innerOpener !== -1) {
      result += text.slice(cursor, innerOpener);
      cursor = innerOpener;
      continue;
    }

    result += text.slice(cursor, open);
    result += text.slice(open + 1, close);
    cursor = close + 1;
    closerPtr += 1;
  }
  return result;
};

/**
 * Scans a Markdown link destination + optional quoted title starting at `openParenIndex`
 * (`(`) within `[openParenIndex, limit)`. Supports `<url>` angle-bracket destinations,
 * balanced nested parentheses, and whitespace-preceded `"..."` / `'...'` titles.
 * Returns the index of the matching `)`, or `-1` when unclosed.
 */
const findMarkdownLinkDestinationEnd = (
  text: string,
  openParenIndex: number,
  limit: number
): number => {
  if (openParenIndex >= limit || text.charCodeAt(openParenIndex) !== 40) {
    return -1;
  }

  let cursor = openParenIndex + 1;
  while (cursor < limit && isHorizontalWhitespaceOrCr(text.charCodeAt(cursor))) {
    cursor += 1;
  }

  if (cursor < limit && text.charCodeAt(cursor) === 60) {
    cursor += 1;
    let foundCloseAngle = false;
    while (cursor < limit) {
      const code = text.charCodeAt(cursor);
      if (code === 92 && cursor + 1 < limit) {
        cursor += 2;
        continue;
      }
      if (code === 62) {
        cursor += 1;
        foundCloseAngle = true;
        break;
      }
      if (code === 60 || code === 10) {
        return -1;
      }
      cursor += 1;
    }
    if (!foundCloseAngle) {
      return -1;
    }
  }

  let parenDepth = 1;
  let quoteChar: string | null = null;
  while (cursor < limit && parenDepth > 0) {
    const ch = text[cursor]!;
    if (ch === '\\' && cursor + 1 < limit) {
      cursor += 2;
      continue;
    }
    if (quoteChar !== null) {
      if (ch === quoteChar) {
        quoteChar = null;
      }
      cursor += 1;
      continue;
    }
    if (
      (ch === '"' || ch === "'") &&
      cursor > openParenIndex + 1 &&
      isHorizontalWhitespaceOrCr(text.charCodeAt(cursor - 1))
    ) {
      quoteChar = ch;
      cursor += 1;
      continue;
    }
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        return cursor;
      }
    }
    cursor += 1;
  }

  return -1;
};

/**
 * Fast O(k) check for lines consisting solely of whitespace and empty-label links
 * or images such as `![](image.png)` or `[](https://example.com/...)`.
 */
const isEmptyLinkOnlyRange = (text: string, start: number, end: number): boolean => {
  let cursor = start;
  let sawLink = false;
  while (cursor < end) {
    while (cursor < end && isHorizontalWhitespaceOrCr(text.charCodeAt(cursor))) {
      cursor += 1;
    }
    if (cursor >= end) {
      break;
    }
    if (text.charCodeAt(cursor) === 33) {
      cursor += 1;
    }
    if (cursor >= end || text.charCodeAt(cursor) !== 91) {
      return false;
    }
    cursor += 1;
    while (cursor < end && isHorizontalWhitespaceOrCr(text.charCodeAt(cursor))) {
      cursor += 1;
    }
    if (cursor + 1 >= end || text.charCodeAt(cursor) !== 93 || text.charCodeAt(cursor + 1) !== 40) {
      return false;
    }
    const urlEnd = findMarkdownLinkDestinationEnd(text, cursor + 1, end);
    if (urlEnd === -1) {
      return false;
    }
    sawLink = true;
    cursor = urlEnd + 1;
  }
  return sawLink;
};

/**
 * Replaces Markdown links/images `[label](url "title")` / `![alt](url)` with their
 * label text in O(n) time: skips inline code spans via `buildCodeSpanEndMap`, supports
 * `<url>` destinations, ignores parentheses inside quoted link titles, balances nested
 * URL parentheses, and recursively resolves nested links/images.
 */
const replaceMarkdownLinks = (text: string, depth = 0): string => {
  if (!text.includes('[') || depth > MAX_LINK_RECURSION_DEPTH) {
    return text;
  }

  const len = text.length;
  const codeSpanEndMap = buildCodeSpanEndMap(text, 0, len);
  let result = '';
  let index = 0;

  while (index < len) {
    if (text.charCodeAt(index) === 96) {
      const spanEnd = codeSpanEndMap?.get(index);
      if (spanEnd !== undefined) {
        result += text.slice(index, spanEnd);
        index = spanEnd;
        continue;
      }
      const tickCount = countBacktickRun(text, index, len);
      result += text.slice(index, index + tickCount);
      index += tickCount;
      continue;
    }

    const isImage = text[index] === '!' && text[index + 1] === '[';
    if (!isImage && text[index] !== '[') {
      result += text[index];
      index += 1;
      continue;
    }

    const labelStart = isImage ? index + 2 : index + 1;
    let labelDepth = 1;
    let labelEnd = labelStart;
    while (labelEnd < len && labelDepth > 0) {
      const code = text.charCodeAt(labelEnd);
      if (code === 92 && labelEnd + 1 < len) {
        labelEnd += 2;
        continue;
      }
      if (code === 96) {
        const spanEnd = codeSpanEndMap?.get(labelEnd);
        labelEnd = spanEnd ?? labelEnd + countBacktickRun(text, labelEnd, len);
        continue;
      }
      if (code === 91) {
        labelDepth += 1;
      } else if (code === 93) {
        labelDepth -= 1;
        if (labelDepth === 0) {
          break;
        }
      }
      labelEnd += 1;
    }

    if (labelDepth !== 0 || text[labelEnd + 1] !== '(') {
      result += text[index];
      index += 1;
      continue;
    }

    const urlEnd = findMarkdownLinkDestinationEnd(text, labelEnd + 1, len);
    if (urlEnd === -1) {
      result += text[index];
      index += 1;
      continue;
    }

    const labelSlice = text.slice(labelStart, labelEnd);
    result += replaceMarkdownLinks(labelSlice, depth + 1);
    index = urlEnd + 1;
  }

  return result;
};

const trimSplitBacktickRunEnd = (
  source: string,
  start: number,
  cut: number,
  end: number
): number => {
  if (cut <= start || cut >= end || source.charCodeAt(cut) !== 96) {
    return cut;
  }
  let safeCut = cut;
  while (safeCut > start && source.charCodeAt(safeCut - 1) === 96) {
    safeCut -= 1;
  }
  return safeCut;
};

/**
 * Slices a bounded prefix of `[start, end)` within `maxBudgetChars` without
 * splitting a complete inline code span (or an unclosed backtick run) at the cap.
 * Massive code spans crossing the cap are truncated and closed with matching
 * backticks so literal code content remains protected during Markdown cleanup.
 */
const sliceCodeSpanSafePrefix = (
  source: string,
  start: number,
  end: number,
  maxBudgetChars: number
): string => {
  const cap = Math.min(STREAMING_THOUGHT_PREVIEW_INLINE_CLEANUP_CAP, maxBudgetChars);
  if (cap <= 0) {
    return '';
  }
  if (end - start <= cap) {
    return source.slice(start, end);
  }

  const capEnd = start + cap;
  const safeCapEnd = trimSplitBacktickRunEnd(source, start, capEnd, end);
  const firstTick = findCharCodeInRange(source, 96, start, capEnd);
  if (firstTick === -1) {
    return source.slice(start, safeCapEnd);
  }

  const codeSpanEndMap = buildCodeSpanEndMap(source, start, end);
  if (!codeSpanEndMap) {
    return source.slice(start, safeCapEnd);
  }

  let cursor = firstTick;
  while (cursor < capEnd) {
    const spanEnd = codeSpanEndMap.get(cursor);
    if (spanEnd === undefined) {
      const nextTick = findCharCodeInRange(
        source,
        96,
        cursor + countBacktickRun(source, cursor, end),
        capEnd
      );
      if (nextTick === -1) {
        return source.slice(start, safeCapEnd);
      }
      cursor = nextTick;
      continue;
    }
    if (spanEnd <= capEnd) {
      const nextTick = findCharCodeInRange(source, 96, spanEnd, capEnd);
      if (nextTick === -1) {
        return source.slice(start, safeCapEnd);
      }
      cursor = nextTick;
      continue;
    }
    if (
      spanEnd <= capEnd + STREAMING_THOUGHT_PREVIEW_MAX_CHARS &&
      spanEnd - start <= maxBudgetChars
    ) {
      return source.slice(start, spanEnd);
    }
    const tickCount = countBacktickRun(source, cursor, end);
    let safeCut = Math.min(capEnd, start + maxBudgetChars - tickCount);
    while (safeCut > cursor + tickCount && source.charCodeAt(safeCut - 1) === 96) {
      safeCut -= 1;
    }
    if (safeCut <= cursor + tickCount) {
      return source.slice(start, cursor);
    }
    return `${source.slice(start, safeCut)}${'`'.repeat(tickCount)}`;
  }

  return source.slice(start, safeCapEnd);
};

/** Splits a bounded line into alternating `text` and `code` segments in O(n) time. */
const tokenizeInlineCodeSegments = (text: string): InlineSegment[] => {
  if (!text.includes('`')) {
    return [{ kind: 'text', value: text }];
  }

  const len = text.length;
  const codeSpanEndMap = buildCodeSpanEndMap(text, 0, len);
  const segments: InlineSegment[] = [];
  let cursor = 0;

  while (cursor < len) {
    const nextTick = text.indexOf('`', cursor);
    if (nextTick === -1) {
      if (cursor < len) {
        segments.push({ kind: 'text', value: text.slice(cursor) });
      }
      break;
    }

    const spanEnd = codeSpanEndMap?.get(nextTick);
    if (spanEnd === undefined) {
      if (isEscapedByBackslash(text, nextTick, 0)) {
        if (nextTick - 1 > cursor) {
          segments.push({ kind: 'text', value: text.slice(cursor, nextTick - 1) });
        }
        segments.push({ kind: 'code', value: '`' });
        cursor = nextTick + 1;
        continue;
      }
      if (nextTick > cursor) {
        segments.push({ kind: 'text', value: text.slice(cursor, nextTick) });
      }
      cursor = nextTick + countBacktickRun(text, nextTick, len);
      continue;
    }

    if (nextTick > cursor) {
      segments.push({ kind: 'text', value: text.slice(cursor, nextTick) });
    }
    const tickCount = countBacktickRun(text, nextTick, len);
    let content = text.slice(nextTick + tickCount, spanEnd - tickCount);
    if (
      content.length >= 2 &&
      content.startsWith(' ') &&
      content.endsWith(' ') &&
      content.trim().length > 0
    ) {
      content = content.slice(1, -1);
    }
    segments.push({ kind: 'code', value: content });
    cursor = spanEnd;
  }

  return segments;
};

const cleanInlineTextSegment = (text: string): string =>
  stripUnderscoreEmphasis(stripStarEmphasis(text.replace(/\*\*|__|~~/g, '').replace(/`+/g, '')));

/**
 * Validates a full candidate line using index-based checks (skipping formatting-only
 * lines, empty-label link lines, and unclosed bold headings with zero cleanup cost),
 * then cleans a bounded code-span-safe prefix within `maxBudgetChars`.
 */
const cleanCandidateLineRange = (
  source: string,
  rawStart: number,
  rawEnd: number,
  maxBudgetChars: number
): { preview: string | null; cleanedChars: number } => {
  let start = trimHorizontalStart(source, rawStart, rawEnd);
  let end = trimHorizontalEnd(source, start, rawEnd);
  if (
    start >= end ||
    startsWithFenceAt(source, start, end) ||
    isFormattingOnlyRange(source, start, end) ||
    hasUnclosedLeadingBoldRange(source, start, end) ||
    isEmptyLinkOnlyRange(source, start, end)
  ) {
    return { preview: null, cleanedChars: 0 };
  }

  const placeholderProbe = source.slice(start, Math.min(end, start + PREFIX_PROBE_CHARS));
  const placeholderMatch = AGY_PLACEHOLDER_PREFIX_RE.exec(placeholderProbe);
  if (placeholderMatch) {
    start = trimHorizontalStart(source, start + placeholderMatch[0].length, end);
    end = trimHorizontalEnd(source, start, end);
    if (
      start >= end ||
      isFormattingOnlyRange(source, start, end) ||
      hasUnclosedLeadingBoldRange(source, start, end) ||
      isEmptyLinkOnlyRange(source, start, end)
    ) {
      return { preview: null, cleanedChars: 0 };
    }
  }

  for (let iteration = 0; iteration < 8 && start < end; iteration += 1) {
    const probe = source.slice(start, Math.min(end, start + PREFIX_PROBE_CHARS));
    const prefixMatch = BLOCK_PREFIX_RE.exec(probe);
    if (!prefixMatch) {
      break;
    }
    start = trimHorizontalStart(source, start + prefixMatch[0].length, end);
    end = trimHorizontalEnd(source, start, end);
  }

  if (
    start >= end ||
    startsWithFenceAt(source, start, end) ||
    isFormattingOnlyRange(source, start, end) ||
    hasUnclosedLeadingBoldRange(source, start, end) ||
    isEmptyLinkOnlyRange(source, start, end)
  ) {
    return { preview: null, cleanedChars: 0 };
  }

  const boundedSlice = sliceCodeSpanSafePrefix(source, start, end, maxBudgetChars);
  const cleanedChars = boundedSlice.length;
  if (cleanedChars === 0) {
    return { preview: null, cleanedChars: 0 };
  }

  const linksResolved = replaceMarkdownLinks(boundedSlice);
  const segments = tokenizeInlineCodeSegments(linksResolved);
  const lastSegment = segments[segments.length - 1];
  if (lastSegment && lastSegment.kind === 'text') {
    lastSegment.value = stripTrailingAtxHashes(lastSegment.value);
  }

  let text = segments
    .map((segment) =>
      segment.kind === 'code' ? segment.value : cleanInlineTextSegment(segment.value)
    )
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    return { preview: null, cleanedChars };
  }

  text = text.replace(AGY_PLACEHOLDER_PREFIX_RE, '').trim();
  if (!text || isStreamingAgyPlaceholderPrefix(text)) {
    return { preview: null, cleanedChars };
  }

  return { preview: truncatePreview(text), cleanedChars };
};

/**
 * Scans `rawText` in a strictly O(n) forward index pass tracking cross-paragraph
 * HTML comments (`<!-- ... -->`) continuously while skipping same-paragraph inline
 * code spans (including multiline spans) via `buildCodeSpanEndMap` and monotonic
 * cursors.
 */
const scanThoughtCandidateLines = (rawText: string): CandidateLine[] => {
  if (!rawText) {
    return [];
  }

  const len = rawText.length;
  const lines: CandidateLine[] = [];
  let pos = 0;
  let paragraphId = 0;
  let inHtmlComment = false;
  let nextCommentOpen = rawText.indexOf('<!--', 0);
  let nextCommentClose = -1;
  let nextTick = rawText.indexOf('`', 0);

  while (pos < len) {
    const nl0 = rawText.indexOf('\n', pos);
    const rawLineEnd0 = nl0 === -1 ? len : nl0;
    const lineEnd0 =
      rawLineEnd0 > pos && rawText.charCodeAt(rawLineEnd0 - 1) === 13
        ? rawLineEnd0 - 1
        : rawLineEnd0;

    if (isBlankLineRange(rawText, pos, lineEnd0)) {
      paragraphId += 1;
      pos = nl0 === -1 ? len : nl0 + 1;
      continue;
    }

    if (!inHtmlComment && nextCommentOpen === -1) {
      const start = trimHorizontalStart(rawText, pos, lineEnd0);
      const end = trimHorizontalEnd(rawText, start, lineEnd0);
      if (start < end) {
        lines.push({ paragraphId, start, end });
      }
      pos = nl0 === -1 ? len : nl0 + 1;
      continue;
    }

    // Collect the contiguous non-blank paragraph `[paraStart, paraEnd)`.
    const paraStart = pos;
    let paraEnd = rawLineEnd0;
    let scanPos = nl0 === -1 ? len : nl0 + 1;
    while (scanPos < len) {
      const nl = rawText.indexOf('\n', scanPos);
      const rawLineEnd = nl === -1 ? len : nl;
      const lineEnd =
        rawLineEnd > scanPos && rawText.charCodeAt(rawLineEnd - 1) === 13
          ? rawLineEnd - 1
          : rawLineEnd;
      if (isBlankLineRange(rawText, scanPos, lineEnd)) {
        break;
      }
      paraEnd = rawLineEnd;
      scanPos = nl === -1 ? len : nl + 1;
    }
    const nextPosAfterPara = scanPos;

    if (!inHtmlComment && (nextCommentOpen === -1 || nextCommentOpen >= paraEnd)) {
      let lineStart = paraStart;
      while (lineStart < paraEnd) {
        const nl = rawText.indexOf('\n', lineStart);
        const rawLineEnd = nl === -1 || nl >= paraEnd ? paraEnd : nl;
        const lineEnd =
          rawLineEnd > lineStart && rawText.charCodeAt(rawLineEnd - 1) === 13
            ? rawLineEnd - 1
            : rawLineEnd;
        const start = trimHorizontalStart(rawText, lineStart, lineEnd);
        const end = trimHorizontalEnd(rawText, start, lineEnd);
        if (start < end) {
          lines.push({ paragraphId, start, end });
        }
        lineStart = nl === -1 || nl >= paraEnd ? paraEnd : nl + 1;
      }
      pos = nextPosAfterPara;
      continue;
    }

    if (nextTick !== -1 && nextTick < paraStart) {
      nextTick = rawText.indexOf('`', paraStart);
    }
    const codeSpanEndMap =
      nextTick !== -1 && nextTick < paraEnd
        ? buildCodeSpanEndMap(rawText, paraStart, paraEnd)
        : null;

    let nextNl = rawText.indexOf('\n', paraStart);
    if (nextNl >= paraEnd) {
      nextNl = -1;
    }

    let lineBuf = '';
    let hasLineBuf = false;
    let unbufferedStart = -1;
    let unbufferedEnd = -1;

    const flushVisibleLine = () => {
      let end = unbufferedEnd;
      if (unbufferedStart !== -1 && end > unbufferedStart && rawText.charCodeAt(end - 1) === 13) {
        end -= 1;
      }
      if (!hasLineBuf) {
        if (unbufferedStart !== -1 && unbufferedStart < end) {
          const start = trimHorizontalStart(rawText, unbufferedStart, end);
          const trimmedEnd = trimHorizontalEnd(rawText, start, end);
          if (start < trimmedEnd) {
            lines.push({ paragraphId, start, end: trimmedEnd });
          }
        }
      } else {
        if (unbufferedStart !== -1 && unbufferedStart < end) {
          lineBuf += rawText.slice(unbufferedStart, end);
        }
        const trimmed = lineBuf.trim();
        if (trimmed.length > 0) {
          lines.push({ paragraphId, start: 0, end: trimmed.length, text: trimmed });
        }
        lineBuf = '';
        hasLineBuf = false;
      }
      unbufferedStart = -1;
      unbufferedEnd = -1;
    };

    const appendVisibleChunk = (chunkStart: number, chunkEnd: number) => {
      if (chunkStart >= chunkEnd) {
        return;
      }
      if (unbufferedStart === -1) {
        unbufferedStart = chunkStart;
        unbufferedEnd = chunkEnd;
      } else if (unbufferedEnd === chunkStart) {
        unbufferedEnd = chunkEnd;
      } else {
        lineBuf += rawText.slice(unbufferedStart, unbufferedEnd);
        hasLineBuf = true;
        unbufferedStart = chunkStart;
        unbufferedEnd = chunkEnd;
      }
    };

    const emitVisibleRange = (segStart: number, segEnd: number) => {
      let segCursor = segStart;
      while (segCursor < segEnd) {
        if (nextNl !== -1 && nextNl < segCursor) {
          nextNl = rawText.indexOf('\n', segCursor);
          if (nextNl >= paraEnd) {
            nextNl = -1;
          }
        }
        if (nextNl === -1 || nextNl >= segEnd) {
          appendVisibleChunk(segCursor, segEnd);
          break;
        }
        appendVisibleChunk(segCursor, nextNl);
        flushVisibleLine();
        segCursor = nextNl + 1;
      }
    };

    let cursor = paraStart;
    while (cursor < paraEnd) {
      if (inHtmlComment) {
        if (nextCommentClose === -1 || nextCommentClose + 3 > paraEnd) {
          cursor = paraEnd;
          break;
        }
        const commentEnd = nextCommentClose + 3;
        if (nextNl !== -1 && nextNl < cursor) {
          nextNl = rawText.indexOf('\n', cursor);
          if (nextNl >= paraEnd) {
            nextNl = -1;
          }
        }
        if (nextNl !== -1 && nextNl < commentEnd) {
          flushVisibleLine();
        }
        inHtmlComment = false;
        cursor = commentEnd;
        if (nextCommentOpen !== -1 && nextCommentOpen < cursor) {
          nextCommentOpen = rawText.indexOf('<!--', cursor);
        }
        if (codeSpanEndMap !== null && nextTick !== -1 && nextTick < cursor) {
          nextTick = rawText.indexOf('`', cursor);
        }
        continue;
      }

      const commentPos =
        nextCommentOpen !== -1 && nextCommentOpen < paraEnd ? nextCommentOpen : paraEnd;
      const tickPos =
        codeSpanEndMap !== null && nextTick !== -1 && nextTick < paraEnd ? nextTick : paraEnd;

      if (tickPos < commentPos) {
        const spanEnd = codeSpanEndMap!.get(tickPos);
        if (spanEnd !== undefined) {
          emitVisibleRange(cursor, spanEnd);
          cursor = spanEnd;
          nextTick = rawText.indexOf('`', cursor);
          if (nextCommentOpen !== -1 && nextCommentOpen < cursor) {
            nextCommentOpen = rawText.indexOf('<!--', cursor);
          }
          continue;
        }
        const runEnd = tickPos + countBacktickRun(rawText, tickPos, paraEnd);
        emitVisibleRange(cursor, runEnd);
        cursor = runEnd;
        nextTick = rawText.indexOf('`', cursor);
        continue;
      }

      if (commentPos < paraEnd) {
        emitVisibleRange(cursor, commentPos);
        inHtmlComment = true;
        nextCommentClose = rawText.indexOf('-->', commentPos + 4);
        cursor = commentPos + 4;
        nextCommentOpen = rawText.indexOf('<!--', cursor);
        continue;
      }

      emitVisibleRange(cursor, paraEnd);
      cursor = paraEnd;
    }

    flushVisibleLine();
    pos = nextPosAfterPara;
  }

  return lines;
};

/**
 * Scans `rawText` in a strictly O(n) forward index pass tracking cross-paragraph
 * HTML comments (`<!-- ... -->`) continuously while skipping same-paragraph inline
 * code spans (including multiline spans) via `buildCodeSpanEndMap` and monotonic
 * cursors, then resolves the first valid line of the latest valid paragraph within
 * a pre-deducted cleanup budget.
 */
export const inspectStreamingThoughtPreview = (
  rawText: string
): StreamingThoughtPreviewInspection => {
  if (!rawText) {
    return { preview: null, cleanedLineCount: 0, cleanedCharCount: 0 };
  }

  const lines = scanThoughtCandidateLines(rawText);
  let cleanedLineCount = 0;
  let cleanedCharCount = 0;
  let groupEnd = lines.length;

  while (groupEnd > 0) {
    const currentParagraphId = lines[groupEnd - 1]!.paragraphId;
    let groupStart = groupEnd - 1;
    while (groupStart > 0 && lines[groupStart - 1]!.paragraphId === currentParagraphId) {
      groupStart -= 1;
    }

    for (let index = groupStart; index < groupEnd; index += 1) {
      const remainingChars = STREAMING_THOUGHT_PREVIEW_MAX_CLEANED_CHARS - cleanedCharCount;
      if (cleanedLineCount >= STREAMING_THOUGHT_PREVIEW_MAX_CLEANED_LINES || remainingChars <= 0) {
        return { preview: null, cleanedLineCount, cleanedCharCount };
      }

      const candidate = lines[index]!;
      const source = candidate.text ?? rawText;
      const result = cleanCandidateLineRange(
        source,
        candidate.start,
        candidate.end,
        remainingChars
      );
      if (result.cleanedChars > 0) {
        cleanedLineCount += 1;
        cleanedCharCount += result.cleanedChars;
      }
      if (result.preview !== null) {
        return {
          preview: result.preview,
          cleanedLineCount,
          cleanedCharCount,
        };
      }
    }

    groupEnd = groupStart;
  }

  return { preview: null, cleanedLineCount, cleanedCharCount };
};

/**
 * Extracts the first valid cleaned line from the FIRST valid paragraph of a thought
 * (skipping Antigravity placeholders, HTML comments, formatting-only lines, and
 * unclosed bold headings) within the same O(n) bounded cleanup budget.
 */
export const extractFirstThoughtPreviewFromText = (rawText: string): string | null => {
  if (!rawText) {
    return null;
  }

  const lines = scanThoughtCandidateLines(rawText);
  let cleanedLineCount = 0;
  let cleanedCharCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const remainingChars = STREAMING_THOUGHT_PREVIEW_MAX_CLEANED_CHARS - cleanedCharCount;
    if (cleanedLineCount >= STREAMING_THOUGHT_PREVIEW_MAX_CLEANED_LINES || remainingChars <= 0) {
      return null;
    }

    const candidate = lines[index]!;
    const source = candidate.text ?? rawText;
    const result = cleanCandidateLineRange(source, candidate.start, candidate.end, remainingChars);
    if (result.cleanedChars > 0) {
      cleanedLineCount += 1;
      cleanedCharCount += result.cleanedChars;
    }
    if (result.preview !== null) {
      return result.preview;
    }
  }

  return null;
};

/**
 * Removes standalone Antigravity placeholder paragraphs (`"I'm thinking through how
 * to approach this."`) and leading placeholder prefixes from a thought's Markdown
 * body while preserving all substantive Markdown verbatim.
 */
export const stripAgyPlaceholderFromMarkdown = (rawText: string): string => {
  if (!rawText) {
    return '';
  }
  const paragraphs = rawText.split(/\r?\n[ \t]*\r?\n+/);
  const kept: string[] = [];
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    if (
      trimmed.toLowerCase() === AGY_PLACEHOLDER_LOWER ||
      isStreamingAgyPlaceholderPrefix(trimmed)
    ) {
      continue;
    }
    const stripped = paragraph.replace(
      /^\s*i'm thinking through how to approach this\.(?:[ \t]*\r?\n|[ \t]+)/i,
      ''
    );
    if (stripped.trim().length > 0) {
      kept.push(stripped.trimEnd());
    }
  }
  return kept.join('\n\n').trim();
};

export const extractStreamingThoughtPreviewFromText = (rawText: string): string | null =>
  inspectStreamingThoughtPreview(rawText).preview;

/**
 * Scans an activity group's entries backwards and returns the preview of the most
 * recent `thought` entry that yields a valid preview, falling back to earlier
 * thoughts in the same group when the newest chunk is still a placeholder or
 * an unclosed streaming bold heading.
 */
export const extractLatestStreamingThoughtPreview = (
  entries: readonly AssistantActivityRenderItem[]
): string | null => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.content.type !== 'thought') {
      continue;
    }
    const preview = extractStreamingThoughtPreviewFromText(entry.content.text);
    if (preview !== null) {
      return preview;
    }
  }
  return null;
};

type ThoughtPreviewRowCandidate =
  | {
      type: 'assistant';
      key: string;
      item: { message: { id: string; finished?: boolean; endedAt?: number } };
      content:
        | { kind: 'footer' }
        | { kind: 'subagent_tasks' }
        | {
            kind: 'activity_group_header';
            expanded: boolean;
            block: { summary: { hasThought: boolean } };
          }
        | { kind: string };
    }
  | { type: string };

/**
 * Resolves the single virtual row key eligible to display the live streaming thought preview:
 * the trailing collapsed activity group (skipping only trailing `footer` and `subagent_tasks`
 * rows of the same assistant turn) of an unfinished turn (`finished !== true` and no numeric
 * `endedAt`), provided the group contains thoughts. Intentionally independent of shimmer state.
 */
export const resolveLiveThoughtPreviewRowKey = (
  virtualRows: readonly ThoughtPreviewRowCandidate[],
  enabled: boolean
): string | null => {
  if (!enabled) {
    return null;
  }

  let trailingTurnMessageId: string | null = null;
  for (let index = virtualRows.length - 1; index >= 0; index -= 1) {
    const row = virtualRows[index];
    if (!row || row.type !== 'assistant') {
      return null;
    }
    const assistantRow = row as Extract<ThoughtPreviewRowCandidate, { type: 'assistant' }>;
    if (trailingTurnMessageId === null) {
      trailingTurnMessageId = assistantRow.item.message.id;
    } else if (assistantRow.item.message.id !== trailingTurnMessageId) {
      return null;
    }
    if (
      assistantRow.item.message.finished === true ||
      typeof assistantRow.item.message.endedAt === 'number'
    ) {
      return null;
    }
    if (assistantRow.content.kind === 'footer' || assistantRow.content.kind === 'subagent_tasks') {
      continue;
    }
    if (
      assistantRow.content.kind === 'activity_group_header' &&
      'expanded' in assistantRow.content &&
      !assistantRow.content.expanded &&
      assistantRow.content.block.summary.hasThought
    ) {
      return assistantRow.key;
    }
    return null;
  }

  return null;
};
