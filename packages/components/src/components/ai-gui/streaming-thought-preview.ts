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

const trimHorizontalRange = (
  text: string,
  start: number,
  end: number
): { start: number; end: number } => {
  let trimmedStart = start;
  let trimmedEnd = end;
  while (trimmedStart < trimmedEnd && isHorizontalWhitespaceOrCr(text.charCodeAt(trimmedStart))) {
    trimmedStart += 1;
  }
  while (trimmedEnd > trimmedStart && isHorizontalWhitespaceOrCr(text.charCodeAt(trimmedEnd - 1))) {
    trimmedEnd -= 1;
  }
  return { start: trimmedStart, end: trimmedEnd };
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

/**
 * Finds the exclusive end offset of a CommonMark inline code span starting at
 * `openIndex` within `[openIndex, limit)`. Returns `-1` when unclosed.
 * Accepts an optional per-line `unclosedLengths` set so repeated unclosed runs
 * of the same length never rescan to `limit`.
 */
const findInlineCodeSpanEnd = (
  text: string,
  openIndex: number,
  limit: number,
  unclosedLengths?: Set<number>
): number => {
  const tickCount = countBacktickRun(text, openIndex, limit);
  if (tickCount === 0 || unclosedLengths?.has(tickCount)) {
    return -1;
  }

  let search = openIndex + tickCount;
  while (search < limit) {
    const nextTick = text.indexOf('`', search);
    if (nextTick === -1 || nextTick >= limit) {
      break;
    }
    const runLength = countBacktickRun(text, nextTick, limit);
    if (runLength === tickCount) {
      return nextTick + runLength;
    }
    search = nextTick + runLength;
  }

  unclosedLengths?.add(tickCount);
  return -1;
};

/**
 * Checks whether a line starting with `**` lacks a matching closing `**` outside
 * inline code spans within `[start, end)`.
 */
const hasUnclosedLeadingBoldRange = (text: string, start: number, end: number): boolean => {
  if (end - start < 2 || text.charCodeAt(start) !== 42 || text.charCodeAt(start + 1) !== 42) {
    return false;
  }

  let cursor = start + 2;
  let unclosedTicks: Set<number> | undefined;
  while (cursor < end) {
    const nextBold = text.indexOf('**', cursor);
    if (nextBold === -1 || nextBold + 2 > end) {
      return true;
    }
    const nextTick = text.indexOf('`', cursor);
    if (nextTick !== -1 && nextTick < nextBold) {
      unclosedTicks ??= new Set<number>();
      const spanEnd = findInlineCodeSpanEnd(text, nextTick, end, unclosedTicks);
      if (spanEnd !== -1) {
        cursor = spanEnd;
        continue;
      }
      cursor = nextTick + countBacktickRun(text, nextTick, end);
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
 * Replaces Markdown links/images `[label](url "title")` / `![alt](url)` with their
 * label text in a linear pass: skips inline code spans, ignores parentheses inside
 * quoted link titles, balances nested URL parentheses, and recursively resolves
 * nested links/images such as `[![alt](logo.png)](https://example.org)`.
 */
const replaceMarkdownLinks = (text: string, depth = 0): string => {
  if (!text.includes('[') || depth > MAX_LINK_RECURSION_DEPTH) {
    return text;
  }

  const len = text.length;
  let result = '';
  let index = 0;
  let unclosedTicks: Set<number> | undefined;

  while (index < len) {
    if (text.charCodeAt(index) === 96) {
      unclosedTicks ??= new Set<number>();
      const spanEnd = findInlineCodeSpanEnd(text, index, len, unclosedTicks);
      if (spanEnd !== -1) {
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
        unclosedTicks ??= new Set<number>();
        const spanEnd = findInlineCodeSpanEnd(text, labelEnd, len, unclosedTicks);
        if (spanEnd !== -1) {
          labelEnd = spanEnd;
          continue;
        }
        labelEnd += countBacktickRun(text, labelEnd, len);
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

    let parenDepth = 1;
    let quoteChar: string | null = null;
    let urlEnd = labelEnd + 2;
    while (urlEnd < len && parenDepth > 0) {
      const ch = text[urlEnd]!;
      if (ch === '\\' && urlEnd + 1 < len) {
        urlEnd += 2;
        continue;
      }
      if (quoteChar !== null) {
        if (ch === quoteChar) {
          quoteChar = null;
        }
        urlEnd += 1;
        continue;
      }
      if (
        (ch === '"' || ch === "'") &&
        urlEnd > labelEnd + 2 &&
        isHorizontalWhitespaceOrCr(text.charCodeAt(urlEnd - 1))
      ) {
        quoteChar = ch;
        urlEnd += 1;
        continue;
      }
      if (ch === '(') {
        parenDepth += 1;
      } else if (ch === ')') {
        parenDepth -= 1;
        if (parenDepth === 0) {
          break;
        }
      }
      urlEnd += 1;
    }

    if (parenDepth !== 0) {
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

/**
 * Slices a bounded prefix of `[start, end)` without splitting a complete inline
 * code span that starts before the cap. Massive code spans crossing the cap are
 * truncated at the cap and closed with matching backticks so literal code content
 * remains protected during Markdown cleanup.
 */
const sliceCodeSpanSafePrefix = (source: string, start: number, end: number): string => {
  if (end - start <= STREAMING_THOUGHT_PREVIEW_INLINE_CLEANUP_CAP) {
    return source.slice(start, end);
  }

  const capEnd = start + STREAMING_THOUGHT_PREVIEW_INLINE_CLEANUP_CAP;
  let cursor = start;
  let unclosedTicks: Set<number> | undefined;
  while (cursor < capEnd) {
    const nextTick = source.indexOf('`', cursor);
    if (nextTick === -1 || nextTick >= capEnd) {
      return source.slice(start, capEnd);
    }
    const tickCount = countBacktickRun(source, nextTick, end);
    unclosedTicks ??= new Set<number>();
    const spanEnd = findInlineCodeSpanEnd(source, nextTick, end, unclosedTicks);
    if (spanEnd === -1) {
      cursor = nextTick + tickCount;
      continue;
    }
    if (spanEnd <= capEnd) {
      cursor = spanEnd;
      continue;
    }
    if (spanEnd <= capEnd + STREAMING_THOUGHT_PREVIEW_MAX_CHARS) {
      return source.slice(start, spanEnd);
    }
    let safeCut = capEnd;
    while (safeCut > nextTick + tickCount && source.charCodeAt(safeCut - 1) === 96) {
      safeCut -= 1;
    }
    if (safeCut <= nextTick + tickCount) {
      return source.slice(start, nextTick);
    }
    return `${source.slice(start, safeCut)}${'`'.repeat(tickCount)}`;
  }

  return source.slice(start, capEnd);
};

/** Splits a bounded line into alternating `text` and `code` segments without sentinel chars. */
const tokenizeInlineCodeSegments = (text: string): InlineSegment[] => {
  if (!text.includes('`')) {
    return [{ kind: 'text', value: text }];
  }

  const len = text.length;
  const segments: InlineSegment[] = [];
  let cursor = 0;
  let unclosedTicks: Set<number> | undefined;

  while (cursor < len) {
    const nextTick = text.indexOf('`', cursor);
    if (nextTick === -1) {
      if (cursor < len) {
        segments.push({ kind: 'text', value: text.slice(cursor) });
      }
      break;
    }
    if (nextTick > cursor) {
      segments.push({ kind: 'text', value: text.slice(cursor, nextTick) });
    }

    const tickCount = countBacktickRun(text, nextTick, len);
    unclosedTicks ??= new Set<number>();
    const spanEnd = findInlineCodeSpanEnd(text, nextTick, len, unclosedTicks);
    if (spanEnd === -1) {
      cursor = nextTick + tickCount;
      continue;
    }

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
 * lines and unclosed bold headings with zero cleanup cost), then cleans a bounded
 * code-span-safe prefix using segment-based Markdown stripping.
 */
const cleanCandidateLineRange = (
  source: string,
  rawStart: number,
  rawEnd: number,
  isTrailingLine: boolean
): { preview: string | null; cleanedChars: number } => {
  let { start, end } = trimHorizontalRange(source, rawStart, rawEnd);
  if (
    start >= end ||
    startsWithFenceAt(source, start, end) ||
    hasUnclosedLeadingBoldRange(source, start, end) ||
    isFormattingOnlyRange(source, start, end)
  ) {
    return { preview: null, cleanedChars: 0 };
  }

  const placeholderProbe = source.slice(start, Math.min(end, start + PREFIX_PROBE_CHARS));
  const placeholderMatch = AGY_PLACEHOLDER_PREFIX_RE.exec(placeholderProbe);
  if (placeholderMatch) {
    start += placeholderMatch[0].length;
    ({ start, end } = trimHorizontalRange(source, start, end));
    if (
      start >= end ||
      hasUnclosedLeadingBoldRange(source, start, end) ||
      isFormattingOnlyRange(source, start, end)
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
    start += prefixMatch[0].length;
    ({ start, end } = trimHorizontalRange(source, start, end));
  }

  if (
    start >= end ||
    startsWithFenceAt(source, start, end) ||
    hasUnclosedLeadingBoldRange(source, start, end) ||
    isFormattingOnlyRange(source, start, end)
  ) {
    return { preview: null, cleanedChars: 0 };
  }

  const boundedSlice = sliceCodeSpanSafePrefix(source, start, end);
  const cleanedChars = boundedSlice.length;

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
  if (!text) {
    return { preview: null, cleanedChars };
  }

  if (isTrailingLine && isStreamingAgyPlaceholderPrefix(text)) {
    return { preview: null, cleanedChars };
  }

  return { preview: truncatePreview(text), cleanedChars };
};

/**
 * Scans `rawText` in a single O(n) forward index pass tracking cross-paragraph
 * HTML comments (`<!-- ... -->`) continuously while ignoring `<!--` inside inline
 * code spans, then resolves the first valid line of the latest valid paragraph
 * within a strict cleanup budget.
 */
export const inspectStreamingThoughtPreview = (
  rawText: string
): StreamingThoughtPreviewInspection => {
  if (!rawText) {
    return { preview: null, cleanedLineCount: 0, cleanedCharCount: 0 };
  }

  const len = rawText.length;
  const lines: CandidateLine[] = [];
  let pos = 0;
  let paragraphId = 0;
  let inHtmlComment = false;
  let nextCommentOpen = rawText.indexOf('<!--', 0);
  let nextCommentClose = -1;

  while (pos < len) {
    const nl = rawText.indexOf('\n', pos);
    const rawLineEnd = nl === -1 ? len : nl;
    const lineEnd =
      rawLineEnd > pos && rawText.charCodeAt(rawLineEnd - 1) === 13 ? rawLineEnd - 1 : rawLineEnd;

    if (isBlankLineRange(rawText, pos, lineEnd)) {
      paragraphId += 1;
      pos = nl === -1 ? len : nl + 1;
      continue;
    }

    if (!inHtmlComment && (nextCommentOpen === -1 || nextCommentOpen >= lineEnd)) {
      const trimmed = trimHorizontalRange(rawText, pos, lineEnd);
      if (trimmed.start < trimmed.end) {
        lines.push({ paragraphId, start: trimmed.start, end: trimmed.end });
      }
      pos = nl === -1 ? len : nl + 1;
      continue;
    }

    let cursor = pos;
    let visible = '';
    let unclosedTicks: Set<number> | undefined;
    while (cursor < lineEnd) {
      if (inHtmlComment) {
        if (nextCommentClose === -1 || nextCommentClose + 3 > lineEnd) {
          cursor = lineEnd;
          break;
        }
        inHtmlComment = false;
        cursor = nextCommentClose + 3;
        if (nextCommentOpen !== -1 && nextCommentOpen < cursor) {
          nextCommentOpen = rawText.indexOf('<!--', cursor);
        }
        continue;
      }

      if (nextCommentOpen !== -1 && nextCommentOpen < lineEnd) {
        const nextTick = rawText.indexOf('`', cursor);
        if (nextTick !== -1 && nextTick < nextCommentOpen) {
          unclosedTicks ??= new Set<number>();
          const spanEnd = findInlineCodeSpanEnd(rawText, nextTick, lineEnd, unclosedTicks);
          if (spanEnd !== -1) {
            visible += rawText.slice(cursor, spanEnd);
            cursor = spanEnd;
            if (nextCommentOpen < cursor) {
              nextCommentOpen = rawText.indexOf('<!--', cursor);
            }
            continue;
          }
          const tickCount = countBacktickRun(rawText, nextTick, lineEnd);
          visible += rawText.slice(cursor, nextTick + tickCount);
          cursor = nextTick + tickCount;
          continue;
        }

        if (nextCommentOpen > cursor) {
          visible += rawText.slice(cursor, nextCommentOpen);
        }
        inHtmlComment = true;
        nextCommentClose = rawText.indexOf('-->', nextCommentOpen + 4);
        cursor = nextCommentOpen + 4;
        nextCommentOpen = rawText.indexOf('<!--', cursor);
        continue;
      }

      visible += rawText.slice(cursor, lineEnd);
      cursor = lineEnd;
    }

    const trimmedVisible = visible.trim();
    if (trimmedVisible.length > 0) {
      lines.push({
        paragraphId,
        start: 0,
        end: trimmedVisible.length,
        text: trimmedVisible,
      });
    }

    pos = nl === -1 ? len : nl + 1;
  }

  let cleanedLineCount = 0;
  let cleanedCharCount = 0;
  let groupEnd = lines.length;
  const lastLineIndex = lines.length - 1;

  while (groupEnd > 0) {
    const currentParagraphId = lines[groupEnd - 1]!.paragraphId;
    let groupStart = groupEnd - 1;
    while (groupStart > 0 && lines[groupStart - 1]!.paragraphId === currentParagraphId) {
      groupStart -= 1;
    }

    for (let index = groupStart; index < groupEnd; index += 1) {
      const candidate = lines[index]!;
      const source = candidate.text ?? rawText;
      const result = cleanCandidateLineRange(
        source,
        candidate.start,
        candidate.end,
        index === lastLineIndex
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
      if (
        cleanedLineCount >= STREAMING_THOUGHT_PREVIEW_MAX_CLEANED_LINES ||
        cleanedCharCount >= STREAMING_THOUGHT_PREVIEW_MAX_CLEANED_CHARS
      ) {
        return { preview: null, cleanedLineCount, cleanedCharCount };
      }
    }

    groupEnd = groupStart;
  }

  return { preview: null, cleanedLineCount, cleanedCharCount };
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
