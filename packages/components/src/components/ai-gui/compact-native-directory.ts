import type { MessageContent } from '@lody/shared';
import { normalizeWorktreePath, normalizeWorktreeTitle } from '@/lib/worktree-path';
import {
  isCommandToolCall,
  type AssistantActivityRenderItem,
  type AssistantThoughtRenderItem,
  type AssistantToolCallRenderItem,
} from './assistant-turn-render-blocks';
import {
  extractFirstThoughtPreviewFromText,
  extractLatestStreamingThoughtPreview,
  extractLatestThoughtParagraphFromText,
  stripAgyPlaceholderFromMarkdown,
} from './streaming-thought-preview';
import { formatToolCommand } from './tool-call-command';

type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;

export type CompactToolCategory = 'read' | 'edit' | 'search' | 'command' | 'fetch' | 'other';

export type CompactToolCounts = {
  readFileCount: number;
  editFileCount: number;
  searchCount: number;
  commandCount: number;
  fetchCount: number;
  otherCount: number;
  backgroundCount: number;
};

export type CompactReadClusterFile = {
  /** Original host/canonical path for `onFilePathClick` when available. */
  path: string | null;
  /** Worktree-normalized display path shown when the cluster expands. */
  displayPath: string;
  /** Basename shown in the collapsed comma-separated summary. */
  fileName: string;
};

export type CompactDirectoryEntry =
  | {
      kind: 'thought';
      id: string;
      itemIndex: number;
      entry: AssistantThoughtRenderItem;
      excerpt: string;
      cleanedMarkdown: string;
      isPlaceholderOnly: boolean;
    }
  | {
      kind: 'read_cluster';
      id: string;
      firstItemIndex: number;
      items: readonly AssistantToolCallRenderItem[];
      files: readonly CompactReadClusterFile[];
    }
  | {
      kind: 'tool';
      id: string;
      itemIndex: number;
      entry: AssistantToolCallRenderItem;
      category: CompactToolCategory;
      shortTarget: string;
      filePath: string | null;
      hasDetail: boolean;
      isBackgrounded: boolean;
    };

export type ActiveCompactTool = {
  entry: AssistantToolCallRenderItem;
  category: CompactToolCategory;
  shortTarget: string;
};

const COMPACT_EXCERPT_MAX_CHARS = 140;
const LEADING_COMMAND_VERB_RE = /^(?:run|running|execute|executing|exec|bash|shell)\s*:?\s+/i;
const LEADING_READ_VERB_RE = /^(?:read|reading|view|viewing|open|opening)\s+/i;
const LEADING_EDIT_VERB_RE =
  /^(?:edit|editing|write|writing|update|updating|delete|deleting|move|moving)\s+/i;
const LEADING_SEARCH_VERB_RE = /^(?:search|searching|grep|find|finding|glob)\s+/i;
const LEADING_FETCH_VERB_RE = /^(?:fetch|fetching|web\s*fetch)\s+/i;
const LEADING_GENERIC_VERB_RE = /^(?:run|running|call|calling|use|using)\s+/i;

const getFileNameFromPath = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? filePath;
};

const sanitizeTitle = (title: string): string =>
  normalizeWorktreeTitle(title).replace(/`/g, '').replace(/\s+/g, ' ').trim();

/**
 * Extracts the first sentence from a cleaned single-line thought excerpt without
 * splitting on dots inside filenames or version numbers (e.g. `view.tsx`, `v0.113.1`).
 */
export const extractFirstSentence = (
  text: string,
  maxChars: number = COMPACT_EXCERPT_MAX_CHARS
): string => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';

  let sentenceEnd = normalized.length;
  for (let index = 0; index < normalized.length; index += 1) {
    const ch = normalized[index]!;
    if (ch === '。' || ch === '！' || ch === '？') {
      sentenceEnd = index + 1;
      break;
    }
    if (ch === '.' || ch === '!' || ch === '?') {
      const next = normalized[index + 1];
      if (next === undefined || next === ' ' || next === '\t' || next === '\n') {
        sentenceEnd = index + 1;
        break;
      }
    }
  }

  const first = normalized.slice(0, sentenceEnd).trim();
  if (first.length <= maxChars) return first;
  return `${first.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
};

export const extractLatestCompactThoughtSentence = (
  entries: readonly AssistantActivityRenderItem[]
): string | null => {
  const preview = extractLatestStreamingThoughtPreview(entries);
  if (!preview) return null;
  const sentence = extractFirstSentence(preview);
  return sentence || null;
};

/**
 * Scans an activity group's entries backwards and returns the full cleaned latest
 * valid paragraph from the most recent substantive `thought` entry, falling back
 * to earlier thoughts in the same group when the newest chunk is only a placeholder,
 * HTML comment, formatting-only line, or unclosed streaming bold heading.
 */
export const extractLatestCompactThoughtParagraph = (
  entries: readonly AssistantActivityRenderItem[]
): string | null => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.content.type !== 'thought') {
      continue;
    }
    const paragraph = extractLatestThoughtParagraphFromText(entry.content.text);
    if (paragraph !== null) {
      return paragraph;
    }
  }
  return null;
};

export const getCompactToolCategory = (toolCall: ToolCallMessage): CompactToolCategory => {
  switch (toolCall.kind) {
    case 'read':
      return 'read';
    case 'edit':
    case 'write':
    case 'delete':
    case 'move':
      return 'edit';
    case 'search':
      return 'search';
    case 'fetch':
      return 'fetch';
    case 'execute':
    case 'bash':
      return 'command';
    default:
      return isCommandToolCall(toolCall) ? 'command' : 'other';
  }
};

export const isBackgroundedToolCall = (toolCall: ToolCallMessage): boolean =>
  typeof toolCall.backgroundTaskId === 'string' && toolCall.backgroundTaskId.trim().length > 0;

export const getCompactToolFilePath = (toolCall: ToolCallMessage): string | null => {
  const locationPath = toolCall.locations?.[0]?.path?.trim();
  if (locationPath) return locationPath;
  for (const block of toolCall.content ?? []) {
    if (block.type === 'diff' && block.path?.trim()) {
      return block.path.trim();
    }
  }
  const category = getCompactToolCategory(toolCall);
  if ((category === 'read' || category === 'edit') && toolCall.title) {
    const cleaned = sanitizeTitle(toolCall.title)
      .replace(category === 'read' ? LEADING_READ_VERB_RE : LEADING_EDIT_VERB_RE, '')
      .trim();
    if (
      cleaned &&
      (cleaned.includes('/') || cleaned.includes('\\') || /\.\w{1,8}$/.test(cleaned))
    ) {
      return cleaned;
    }
  }
  return null;
};

export const getCompactToolShortTarget = (toolCall: ToolCallMessage): string => {
  const category = getCompactToolCategory(toolCall);
  if (category === 'command') {
    for (const block of toolCall.content ?? []) {
      if (block.type === 'terminal_command') {
        const formatted = formatToolCommand(block).replace(/\s+/g, ' ').trim();
        if (formatted) return formatted;
      }
    }
    if (toolCall.title) {
      const stripped = sanitizeTitle(toolCall.title).replace(LEADING_COMMAND_VERB_RE, '').trim();
      if (stripped) return stripped;
    }
  }

  if (category === 'read' || category === 'edit') {
    const filePath = getCompactToolFilePath(toolCall);
    if (filePath) {
      const normalized = normalizeWorktreePath(filePath);
      return getFileNameFromPath(normalized);
    }
  }

  if (toolCall.title) {
    const cleaned = sanitizeTitle(toolCall.title);
    const stripped =
      category === 'read'
        ? cleaned.replace(LEADING_READ_VERB_RE, '')
        : category === 'edit'
          ? cleaned.replace(LEADING_EDIT_VERB_RE, '')
          : category === 'search'
            ? cleaned.replace(LEADING_SEARCH_VERB_RE, '')
            : category === 'fetch'
              ? cleaned.replace(LEADING_FETCH_VERB_RE, '')
              : cleaned.replace(LEADING_GENERIC_VERB_RE, '');
    if (stripped.trim()) return stripped.trim();
    if (cleaned) return cleaned;
  }

  return toolCall.kind ?? 'tool';
};

const isToolCallRenderItem = (
  entry: AssistantActivityRenderItem
): entry is AssistantToolCallRenderItem => entry.content.type === 'tool_call';

/**
 * Finds the most recent in-progress non-background tool call in the segment.
 * Tools already detached to background (`backgroundTaskId` set) do not claim
 * the active foreground "Running <target>" header.
 */
export const findActiveNonBackgroundTool = (
  entries: readonly AssistantActivityRenderItem[]
): ActiveCompactTool | null => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || !isToolCallRenderItem(entry)) continue;
    if (entry.content.kind === 'think') continue;
    if (entry.content.status !== 'in_progress') continue;
    if (isBackgroundedToolCall(entry.content)) continue;
    return {
      entry,
      category: getCompactToolCategory(entry.content),
      shortTarget: getCompactToolShortTarget(entry.content),
    };
  }
  return null;
};

/**
 * Counts completed non-background tools and backgrounded tools for Row 1 of
 * the live Option C header (persisted while thinking and while tools run).
 */
export const summarizeCompactTools = (
  entries: readonly AssistantActivityRenderItem[]
): CompactToolCounts => {
  const readPaths = new Set<string>();
  const editPaths = new Set<string>();
  let readWithoutPath = 0;
  let editWithoutPath = 0;
  let searchCount = 0;
  let commandCount = 0;
  let fetchCount = 0;
  let otherCount = 0;
  let backgroundCount = 0;

  for (const entry of entries) {
    if (entry.content.type !== 'tool_call' || entry.content.kind === 'think') continue;
    const toolCall = entry.content;
    if (isBackgroundedToolCall(toolCall)) {
      backgroundCount += 1;
      continue;
    }
    if (toolCall.status !== 'completed') continue;

    const category = getCompactToolCategory(toolCall);
    const filePath = getCompactToolFilePath(toolCall);
    switch (category) {
      case 'read':
        if (filePath) readPaths.add(normalizeWorktreePath(filePath));
        else readWithoutPath += 1;
        break;
      case 'edit':
        if (filePath) editPaths.add(normalizeWorktreePath(filePath));
        else editWithoutPath += 1;
        break;
      case 'search':
        searchCount += 1;
        break;
      case 'command':
        commandCount += 1;
        break;
      case 'fetch':
        fetchCount += 1;
        break;
      default:
        otherCount += 1;
        break;
    }
  }

  return {
    readFileCount: readPaths.size + readWithoutPath,
    editFileCount: editPaths.size + editWithoutPath,
    searchCount,
    commandCount,
    fetchCount,
    otherCount,
    backgroundCount,
  };
};

export const hasCompactToolDetail = (toolCall: ToolCallMessage): boolean => {
  if (Boolean(toolCall.rawOutput)) {
    return true;
  }
  if (toolCall.permissionRequest && toolCall.permissionRequest.outcome?.outcome !== 'cancelled') {
    return true;
  }
  for (const block of toolCall.content ?? []) {
    if (
      block.type === 'diff' ||
      block.type === 'terminal_command' ||
      block.type === 'terminal_output' ||
      block.type === 'terminal'
    ) {
      return true;
    }
    if (block.type === 'content') {
      if (block.content.type === 'text') {
        if (block.content.text.trim().length > 0) return true;
      } else {
        return true;
      }
    }
  }
  return false;
};

const isClusterableReadTool = (entry: AssistantActivityRenderItem): boolean =>
  entry.content.type === 'tool_call' &&
  entry.content.kind === 'read' &&
  entry.content.status === 'completed' &&
  !isBackgroundedToolCall(entry.content);

/**
 * Builds the flat single-level Option C directory entries for an activity list:
 * - Strips Antigravity placeholder-only thoughts (preserving a single quiet
 *   placeholder entry only when live and nothing else exists yet)
 * - Extracts single-line first-sentence excerpts for each valid thought
 * - Clusters adjacent completed non-background `read` tools (2+) into one row
 * - Keeps all other tools as standalone single-line rows
 */
export const buildCompactDirectoryEntries = (
  entries: readonly AssistantActivityRenderItem[],
  options: { isLive: boolean }
): CompactDirectoryEntry[] => {
  const visible = entries.filter(
    (entry) => entry.content.type === 'thought' || entry.content.kind !== 'think'
  );
  const rawResult: CompactDirectoryEntry[] = [];
  let hasNonPlaceholderEntry = false;

  let index = 0;
  while (index < visible.length) {
    const entry = visible[index]!;
    if (entry.content.type === 'thought') {
      const cleanedMarkdown = stripAgyPlaceholderFromMarkdown(entry.content.text);
      const firstPreview = extractFirstThoughtPreviewFromText(entry.content.text);
      const excerpt = firstPreview ? extractFirstSentence(firstPreview) : '';
      const isPlaceholderOnly = cleanedMarkdown.length === 0 && excerpt.length === 0;
      if (!isPlaceholderOnly) {
        hasNonPlaceholderEntry = true;
      }
      rawResult.push({
        kind: 'thought',
        id: `thought:${entry.itemIndex}`,
        itemIndex: entry.itemIndex,
        entry: entry as AssistantThoughtRenderItem,
        excerpt: excerpt || extractFirstSentence(cleanedMarkdown),
        cleanedMarkdown,
        isPlaceholderOnly,
      });
      index += 1;
      continue;
    }

    if (!isToolCallRenderItem(entry)) {
      index += 1;
      continue;
    }

    if (isClusterableReadTool(entry)) {
      const group: AssistantToolCallRenderItem[] = [entry];
      let cursor = index + 1;
      while (cursor < visible.length) {
        const nextEntry = visible[cursor]!;
        if (!isToolCallRenderItem(nextEntry) || !isClusterableReadTool(nextEntry)) break;
        group.push(nextEntry);
        cursor += 1;
      }
      hasNonPlaceholderEntry = true;
      if (group.length >= 2) {
        const files: CompactReadClusterFile[] = group.map((item) => {
          const path = getCompactToolFilePath(item.content);
          const displayPath = path
            ? normalizeWorktreePath(path)
            : getCompactToolShortTarget(item.content);
          return {
            path,
            displayPath,
            fileName: getFileNameFromPath(displayPath),
          };
        });
        const firstTool = group[0]!;
        const firstStableId = firstTool.content.toolCallId || String(firstTool.itemIndex);
        rawResult.push({
          kind: 'read_cluster',
          id: `read-cluster:${firstStableId}`,
          firstItemIndex: firstTool.itemIndex,
          items: group,
          files,
        });
      } else {
        const filePath = getCompactToolFilePath(entry.content);
        rawResult.push({
          kind: 'tool',
          id: `tool:${entry.itemIndex}:${entry.content.toolCallId}`,
          itemIndex: entry.itemIndex,
          entry,
          category: 'read',
          shortTarget: getCompactToolShortTarget(entry.content),
          filePath,
          hasDetail: hasCompactToolDetail(entry.content),
          isBackgrounded: false,
        });
      }
      index = cursor;
      continue;
    }

    const toolEntry = entry;
    hasNonPlaceholderEntry = true;
    rawResult.push({
      kind: 'tool',
      id: `tool:${toolEntry.itemIndex}:${toolEntry.content.toolCallId}`,
      itemIndex: toolEntry.itemIndex,
      entry: toolEntry,
      category: getCompactToolCategory(toolEntry.content),
      shortTarget: getCompactToolShortTarget(toolEntry.content),
      filePath: getCompactToolFilePath(toolEntry.content),
      hasDetail: hasCompactToolDetail(toolEntry.content),
      isBackgrounded: isBackgroundedToolCall(toolEntry.content),
    });
    index += 1;
  }

  if (hasNonPlaceholderEntry) {
    return rawResult.filter((item) => !(item.kind === 'thought' && item.isPlaceholderOnly));
  }

  if (!options.isLive) {
    return [];
  }

  const firstPlaceholder = rawResult.find(
    (item) => item.kind === 'thought' && item.isPlaceholderOnly
  );
  return firstPlaceholder ? [firstPlaceholder] : [];
};
