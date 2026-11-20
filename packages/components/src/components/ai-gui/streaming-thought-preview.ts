import type { AssistantActivityRenderItem } from './assistant-turn-render-blocks';

export const STREAMING_THOUGHT_PREVIEW_TAIL_WINDOW_CHARS = 8_192;
export const STREAMING_THOUGHT_PREVIEW_MAX_CHARS = 260;
export const STREAMING_THOUGHT_PREVIEW_MIN_HOLD_MS = 1_500;
export const STREAMING_THOUGHT_PREVIEW_LOW_STIMULUS_HOLD_MS = 4_000;

const INLINE_CLEANUP_LINE_CAP = 1_024;
const WORD_BOUNDARY_LOOKBACK_CHARS = 32;
const AGY_PLACEHOLDER_PREFIX_RE = /^i'm thinking through how to approach this\.(?:\s+|$)/i;
const FENCE_LINE_RE = /^(?:`{3,}|~{3,})/;

type ParagraphRange = {
  start: number;
  end: number;
  nextLimit: number;
};

const isWhitespaceCode = (code: number): boolean =>
  code === 32 ||
  code === 9 ||
  code === 10 ||
  code === 13 ||
  code === 11 ||
  code === 12 ||
  code === 160;

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

/**
 * Finds the latest non-empty paragraph before `limit` in a single linear reverse scan
 * without backtracking regexes, so 138k+ thought payloads stay bounded to the tail.
 */
const findPreviousParagraphRange = (text: string, limit: number): ParagraphRange | null => {
  let paraEnd = limit;
  while (paraEnd > 0 && isWhitespaceCode(text.charCodeAt(paraEnd - 1))) {
    paraEnd -= 1;
  }
  if (paraEnd <= 0) {
    return null;
  }

  let lineEnd = paraEnd;
  while (lineEnd > 0) {
    const nl = text.lastIndexOf('\n', lineEnd - 1);
    if (nl === -1) {
      return { start: 0, end: paraEnd, nextLimit: 0 };
    }
    const prevNl = nl > 0 ? text.lastIndexOf('\n', nl - 1) : -1;
    if (isBlankLineRange(text, prevNl + 1, nl)) {
      return {
        start: nl + 1,
        end: paraEnd,
        nextLimit: prevNl > 0 ? prevNl : 0,
      };
    }
    lineEnd = nl;
  }

  return { start: 0, end: paraEnd, nextLimit: 0 };
};

const hasUnclosedLeadingBold = (line: string): boolean =>
  line.startsWith('**') && line.indexOf('**', 2) === -1;

const stripLeadingBlockPrefixes = (input: string): string => {
  let current = input;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const next = current
      .replace(/^>\s*/, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .trimStart();
    if (next === current) {
      break;
    }
    current = next;
  }
  return current;
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

const cleanPreviewLine = (rawLine: string): string | null => {
  let text = rawLine.trim();
  if (!text || FENCE_LINE_RE.test(text) || hasUnclosedLeadingBold(text)) {
    return null;
  }

  text = text.replace(AGY_PLACEHOLDER_PREFIX_RE, '').trim();
  if (!text || hasUnclosedLeadingBold(text)) {
    return null;
  }

  text = stripLeadingBlockPrefixes(text);
  if (!text || FENCE_LINE_RE.test(text) || hasUnclosedLeadingBold(text)) {
    return null;
  }

  // Cap line length before inline cleanup so pathological single-line paragraphs stay O(1).
  if (text.length > INLINE_CLEANUP_LINE_CAP) {
    text = text.slice(0, INLINE_CLEANUP_LINE_CAP);
  }

  text = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\s+#+$/, '')
    .replace(/`+/g, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/\*([^\s*](?:[^*\n]*[^\s*])?)\*/g, '$1')
    .replace(/(^|[^\w])_([^\s_](?:[^_\n]*[^\s_])?)_(?=$|[^\w])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    return null;
  }

  text = text.replace(AGY_PLACEHOLDER_PREFIX_RE, '').trim();
  if (!text) {
    return null;
  }

  return truncatePreview(text);
};

const extractPreviewFromParagraphText = (paragraph: string): string | null => {
  const lines = paragraph.split(/\r?\n/);
  let inHtmlComment = false;

  for (const rawLine of lines) {
    let line = rawLine.trim();

    while (line && (inHtmlComment || line.startsWith('<!--'))) {
      if (inHtmlComment) {
        const closeIndex = line.indexOf('-->');
        if (closeIndex === -1) {
          line = '';
          break;
        }
        inHtmlComment = false;
        line = line.slice(closeIndex + 3).trim();
      } else {
        const closeIndex = line.indexOf('-->', 4);
        if (closeIndex === -1) {
          inHtmlComment = true;
          line = '';
          break;
        }
        line = line.slice(closeIndex + 3).trim();
      }
    }

    if (!line) {
      continue;
    }

    const cleaned = cleanPreviewLine(line);
    if (cleaned !== null) {
      return cleaned;
    }
  }

  return null;
};

/**
 * Extracts a cleaned, bounded single-paragraph preview from a thought string.
 * Walks backwards paragraph by paragraph and bounds per-paragraph inspection to
 * `STREAMING_THOUGHT_PREVIEW_TAIL_WINDOW_CHARS` so 138k+ thoughts never stall rendering.
 */
export const extractStreamingThoughtPreviewFromText = (rawText: string): string | null => {
  if (!rawText) {
    return null;
  }

  let cursor = rawText.length;
  while (cursor > 0) {
    const range = findPreviousParagraphRange(rawText, cursor);
    if (!range) {
      return null;
    }
    cursor = range.nextLimit;

    const length = range.end - range.start;
    if (length <= STREAMING_THOUGHT_PREVIEW_TAIL_WINDOW_CHARS) {
      const preview = extractPreviewFromParagraphText(rawText.slice(range.start, range.end));
      if (preview !== null) {
        return preview;
      }
      continue;
    }

    const headPreview = extractPreviewFromParagraphText(
      rawText.slice(range.start, range.start + STREAMING_THOUGHT_PREVIEW_TAIL_WINDOW_CHARS)
    );
    if (headPreview !== null) {
      return headPreview;
    }

    const tailStart = Math.max(
      range.start,
      range.end - STREAMING_THOUGHT_PREVIEW_TAIL_WINDOW_CHARS
    );
    const alignedNewline = rawText.indexOf('\n', tailStart);
    const alignedTailStart =
      alignedNewline !== -1 && alignedNewline < range.end ? alignedNewline + 1 : tailStart;
    const tailPreview = extractPreviewFromParagraphText(rawText.slice(alignedTailStart, range.end));
    if (tailPreview !== null) {
      return tailPreview;
    }
  }

  return null;
};

/**
 * Scans an activity group's entries backwards and returns the preview of its
 * latest `thought` entry, retaining the thought while subsequent tool calls run.
 */
export const extractLatestStreamingThoughtPreview = (
  entries: readonly AssistantActivityRenderItem[]
): string | null => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.content.type === 'thought') {
      return extractStreamingThoughtPreviewFromText(entry.content.text);
    }
  }
  return null;
};

type ThoughtPreviewRowCandidate =
  | {
      type: 'assistant';
      key: string;
      item: { message: { id: string; finished?: boolean } };
      content:
        | { kind: 'footer' }
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
 * the trailing collapsed activity group (skipping only its own trailing footer) of an
 * unfinished assistant turn at the end of the conversation, provided it contains thoughts.
 * Intentionally independent of shimmer state so low-stimulus and non-shimmer states work.
 */
export const resolveLiveThoughtPreviewRowKey = (
  virtualRows: readonly ThoughtPreviewRowCandidate[],
  enabled: boolean
): string | null => {
  if (!enabled) {
    return null;
  }

  let trailingFooterMessageId: string | null = null;
  for (let index = virtualRows.length - 1; index >= 0; index -= 1) {
    const row = virtualRows[index];
    if (!row || row.type !== 'assistant') {
      return null;
    }
    const assistantRow = row as Extract<ThoughtPreviewRowCandidate, { type: 'assistant' }>;
    if (assistantRow.content.kind === 'footer') {
      if (trailingFooterMessageId !== null) {
        return null;
      }
      trailingFooterMessageId = assistantRow.item.message.id;
      continue;
    }
    if (
      trailingFooterMessageId !== null &&
      assistantRow.item.message.id !== trailingFooterMessageId
    ) {
      return null;
    }
    if (
      assistantRow.item.message.finished !== true &&
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
