import type { AssistantActivityRenderItem } from './assistant-turn-render-blocks';

export const STREAMING_THOUGHT_PREVIEW_MAX_CHARS = 260;
export const STREAMING_THOUGHT_PREVIEW_INLINE_CLEANUP_CAP = 1_024;
export const STREAMING_THOUGHT_PREVIEW_MIN_HOLD_MS = 1_500;
export const STREAMING_THOUGHT_PREVIEW_LOW_STIMULUS_HOLD_MS = 4_000;

const WORD_BOUNDARY_LOOKBACK_CHARS = 32;
const PREFIX_PROBE_CHARS = 96;
const AGY_PLACEHOLDER_PREFIX_RE = /^i'm thinking through how to approach this\.(?:\s+|$)/i;
const BLOCK_PREFIX_RE = /^(?:>\s*|#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/;

type CandidateLine = {
  paragraphId: number;
  start: number;
  end: number;
  text?: string;
};

export type StreamingThoughtPreviewInspection = {
  preview: string | null;
  cleanedLineCount: number;
  cleanedCharCount: number;
};

const isHorizontalWhitespaceOrCr = (code: number): boolean =>
  code === 32 || code === 9 || code === 13 || code === 11 || code === 12 || code === 160;

const isBlankLineRange = (text: string, start: number, end: number): boolean => {
  for (let index = start; index < end; index += 1) {
    if (!isHorizontalWhitespaceOrCr(text.charCodeAt(index))) {
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

const hasUnclosedLeadingBoldRange = (text: string, start: number, end: number): boolean => {
  if (end - start < 2 || text.charCodeAt(start) !== 42 || text.charCodeAt(start + 1) !== 42) {
    return false;
  }
  const closeIndex = text.indexOf('**', start + 2);
  return closeIndex === -1 || closeIndex + 2 > end;
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

const extractInlineCodeSpans = (
  text: string
): { masked: string; spans: string[]; openToken: string; closeToken: string } => {
  const spans: string[] = [];
  if (!text.includes('`')) {
    return { masked: text, spans, openToken: '', closeToken: '' };
  }

  let openToken = '\uE000';
  let closeToken = '\uE001';
  while (text.includes(openToken) || text.includes(closeToken)) {
    openToken += '\uE000';
    closeToken += '\uE001';
  }

  let masked = '';
  let index = 0;
  while (index < text.length) {
    if (text.charCodeAt(index) !== 96) {
      masked += text[index];
      index += 1;
      continue;
    }

    let tickCount = 0;
    while (index + tickCount < text.length && text.charCodeAt(index + tickCount) === 96) {
      tickCount += 1;
    }

    let search = index + tickCount;
    let closeStart = -1;
    while (search < text.length) {
      const nextTick = text.indexOf('`', search);
      if (nextTick === -1) {
        break;
      }
      let runLength = 0;
      while (nextTick + runLength < text.length && text.charCodeAt(nextTick + runLength) === 96) {
        runLength += 1;
      }
      if (runLength === tickCount) {
        closeStart = nextTick;
        break;
      }
      search = nextTick + runLength;
    }

    if (closeStart === -1) {
      index += tickCount;
      continue;
    }

    let content = text.slice(index + tickCount, closeStart);
    if (
      content.length >= 2 &&
      content.startsWith(' ') &&
      content.endsWith(' ') &&
      content.trim().length > 0
    ) {
      content = content.slice(1, -1);
    }

    const spanIndex = spans.length;
    spans.push(content);
    masked += `${openToken}${spanIndex}${closeToken}`;
    index = closeStart + tickCount;
  }

  return { masked, spans, openToken, closeToken };
};

const restoreInlineCodeSpans = (
  text: string,
  spans: readonly string[],
  openToken: string,
  closeToken: string
): string => {
  if (spans.length === 0) {
    return text;
  }

  let restored = '';
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(openToken, cursor);
    if (start === -1) {
      restored += text.slice(cursor);
      break;
    }
    restored += text.slice(cursor, start);
    const idStart = start + openToken.length;
    const end = text.indexOf(closeToken, idStart);
    if (end === -1) {
      restored += text.slice(start);
      break;
    }
    const spanIndex = Number(text.slice(idStart, end));
    restored += spans[spanIndex] ?? '';
    cursor = end + closeToken.length;
  }
  return restored;
};

/**
 * Replaces Markdown links/images `[label](url)` / `![alt](url)` with `label` / `alt`
 * in a single linear pass, balancing nested parentheses inside URLs.
 */
const replaceMarkdownLinks = (text: string): string => {
  if (!text.includes('[')) {
    return text;
  }

  let result = '';
  let index = 0;
  while (index < text.length) {
    const isImage = text[index] === '!' && text[index + 1] === '[';
    if (!isImage && text[index] !== '[') {
      result += text[index];
      index += 1;
      continue;
    }

    const labelStart = isImage ? index + 2 : index + 1;
    let labelDepth = 1;
    let labelEnd = labelStart;
    while (labelEnd < text.length && labelDepth > 0) {
      const ch = text[labelEnd];
      if (ch === '\\' && labelEnd + 1 < text.length) {
        labelEnd += 2;
        continue;
      }
      if (ch === '[') {
        labelDepth += 1;
      } else if (ch === ']') {
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
    let urlEnd = labelEnd + 2;
    while (urlEnd < text.length && parenDepth > 0) {
      const ch = text[urlEnd];
      if (ch === '\\' && urlEnd + 1 < text.length) {
        urlEnd += 2;
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

    result += text.slice(labelStart, labelEnd);
    index = urlEnd + 1;
  }

  return result;
};

/**
 * Validates a full candidate line using index-based checks (so 138k single-line
 * unclosed bold headings never slice through their midpoint) and only then
 * runs inline Markdown cleanup on at most `STREAMING_THOUGHT_PREVIEW_INLINE_CLEANUP_CAP` chars.
 */
const cleanCandidateLineRange = (
  source: string,
  rawStart: number,
  rawEnd: number
): { preview: string | null; cleanedChars: number } => {
  let { start, end } = trimHorizontalRange(source, rawStart, rawEnd);
  if (
    start >= end ||
    startsWithFenceAt(source, start, end) ||
    hasUnclosedLeadingBoldRange(source, start, end)
  ) {
    return { preview: null, cleanedChars: 0 };
  }

  const placeholderProbe = source.slice(start, Math.min(end, start + PREFIX_PROBE_CHARS));
  const placeholderMatch = AGY_PLACEHOLDER_PREFIX_RE.exec(placeholderProbe);
  if (placeholderMatch) {
    start += placeholderMatch[0].length;
    ({ start, end } = trimHorizontalRange(source, start, end));
    if (start >= end || hasUnclosedLeadingBoldRange(source, start, end)) {
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
    hasUnclosedLeadingBoldRange(source, start, end)
  ) {
    return { preview: null, cleanedChars: 0 };
  }

  const boundedEnd = Math.min(end, start + STREAMING_THOUGHT_PREVIEW_INLINE_CLEANUP_CAP);
  const boundedSlice = source.slice(start, boundedEnd);
  const cleanedChars = boundedSlice.length;

  const { masked, spans, openToken, closeToken } = extractInlineCodeSpans(boundedSlice);

  let text = replaceMarkdownLinks(masked)
    .replace(/\s+#+$/, '')
    .replace(/`+/g, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/\*([^\s*](?:[^*\n]*[^\s*])?)\*/g, '$1')
    .replace(/(^|[^\w])_([^\s_](?:[^_\n]*[^\s_])?)_(?=$|[^\w])/g, '$1$2');

  text = restoreInlineCodeSpans(text, spans, openToken, closeToken).replace(/\s+/g, ' ').trim();

  if (!text) {
    return { preview: null, cleanedChars };
  }

  text = text.replace(AGY_PLACEHOLDER_PREFIX_RE, '').trim();
  if (!text) {
    return { preview: null, cleanedChars };
  }

  return { preview: truncatePreview(text), cleanedChars };
};

/**
 * Scans `rawText` in a single O(n) forward index pass tracking cross-paragraph
 * HTML comments (`<!-- ... -->`) continuously, then resolves the first valid line
 * of the latest valid paragraph.
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
  while (groupEnd > 0) {
    const currentParagraphId = lines[groupEnd - 1]!.paragraphId;
    let groupStart = groupEnd - 1;
    while (groupStart > 0 && lines[groupStart - 1]!.paragraphId === currentParagraphId) {
      groupStart -= 1;
    }

    for (let index = groupStart; index < groupEnd; index += 1) {
      const candidate = lines[index]!;
      const source = candidate.text ?? rawText;
      const result = cleanCandidateLineRange(source, candidate.start, candidate.end);
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
