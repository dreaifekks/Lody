import { z } from 'zod';
import {
  agentSurfaceToolOf,
  isCodexEnvelope,
  LODY_AGENT_TOOL_IDS,
  toolArguments,
  type LodyAgentToolId,
  type ToolCallLike,
} from './lody-agent-tool-names';

export {
  LODY_AGENT_TOOL_IDS,
  LODY_AGENT_TOOL_NAMES,
  type LodyAgentToolId,
} from './lody-agent-tool-names';

export const isLodyAgentToolId = (value: unknown): value is LodyAgentToolId =>
  typeof value === 'string' && (LODY_AGENT_TOOL_IDS as readonly string[]).includes(value);

/** Parses a comma-separated list, keeping only known ids in canonical order. */
export const parseLodyAgentToolIds = (value: string | null | undefined): LodyAgentToolId[] => {
  const requested = new Set((value ?? '').split(',').map((part) => part.trim()));
  return LODY_AGENT_TOOL_IDS.filter((id) => requested.has(id));
};

export const LODY_NOTIFY_TITLE_MAX_CHARS = 80;
export const LODY_NOTIFY_BODY_MAX_CHARS = 500;
export const LODY_REVIEW_TITLE_MAX_CHARS = 120;
export const LODY_REVIEW_SUMMARY_MAX_CHARS = 500;
export const LODY_REVIEW_MARKDOWN_MAX_CHARS = 100_000;
export const LODY_WIDGET_TITLE_MAX_CHARS = 120;
export const LODY_WIDGET_CODE_MAX_CHARS = 200_000;

export const LodyNotifyUserInputSchema = z
  .object({
    title: z.string().trim().min(1).max(LODY_NOTIFY_TITLE_MAX_CHARS).optional(),
    body: z.string().trim().min(1).max(LODY_NOTIFY_BODY_MAX_CHARS),
  })
  .strict();
export type LodyNotifyUserInput = z.infer<typeof LodyNotifyUserInputSchema>;

export const LodyRequestReviewInputSchema = z
  .object({
    title: z.string().trim().min(1).max(LODY_REVIEW_TITLE_MAX_CHARS),
    markdown: z.string().trim().min(1).max(LODY_REVIEW_MARKDOWN_MAX_CHARS),
    summary: z.string().trim().min(1).max(LODY_REVIEW_SUMMARY_MAX_CHARS).optional(),
  })
  .strict();
export type LodyRequestReviewInput = z.infer<typeof LodyRequestReviewInputSchema>;

export const LodyShowWidgetInputSchema = z
  .object({
    title: z.string().trim().min(1).max(LODY_WIDGET_TITLE_MAX_CHARS),
    widget_code: z.string().min(1).max(LODY_WIDGET_CODE_MAX_CHARS),
  })
  .strict();
export type LodyShowWidgetInput = z.infer<typeof LodyShowWidgetInputSchema>;

/** What `lody_notify_user` answers the agent. */
export type LodyNotifyUserResult =
  | { ok: true; noticeId: string }
  | { ok: false; code: 'AGENT_NOTICE_DISABLED'; message: string }
  | { ok: false; code: 'AGENT_NOTICE_RATE_LIMITED'; message: string; retryAfterSeconds: number };

/** A durable pointer to the latest `lody_notify_user` message of a session. */
export type SessionAgentNoticeMeta = {
  /** Unique per message; a device alerts once per id. */
  id: string;
  /**
   * `config_change`: Lody's own notice that an Agent wrote a Role or Schedule,
   * shown whether or not the Agent notification experiment is on. Absent: a
   * `lody_notify_user` message.
   */
  kind?: 'config_change';
  title?: string;
  body: string;
  at: number;
};

/**
 * The id of the notice for one Agent write of a Role or Schedule: the same for
 * a retry of that write, different for any other write. The conversation's
 * system line and the device alerts share it, so devices alert once.
 */
export const agentConfigNoticeId = (write: {
  workspaceId: string;
  kind: 'schedule' | 'agent-role';
  objectId: string;
  action: string;
  requestId: string;
}): string =>
  ['config', write.workspaceId, write.kind, write.objectId, write.action, write.requestId].join(
    ':'
  );

/* ------------------------------------------------------------------------ */
/* Recognizing calls in a transcript                                         */
/* ------------------------------------------------------------------------ */

export type AgentSurfaceToolCall =
  | { kind: 'review'; input: LodyRequestReviewInput | null }
  | {
      kind: 'widget';
      /** `lody` for Lody's tool, `visualize` for Claude Desktop's `show_widget`. */
      source: 'lody' | 'visualize';
      input: LodyShowWidgetInput | null;
    }
  | { kind: 'notify'; input: LodyNotifyUserInput | null };

const parseInput = <T>(schema: z.ZodType<T>, value: unknown): T | null => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** Claude Desktop's `show_widget` adds `loading_messages`, which Lody ignores. */
const VisualizeWidgetInputSchema = z
  .object({
    title: z.string().trim().min(1).max(LODY_WIDGET_TITLE_MAX_CHARS).optional(),
    widget_code: z.string().min(1).max(LODY_WIDGET_CODE_MAX_CHARS),
  })
  .passthrough()
  .transform((value) => ({ title: value.title ?? 'Widget', widget_code: value.widget_code }));

/**
 * Which experimental surface a tool call belongs to (`agentSurfaceToolOf`), with
 * its input once the input is complete and valid (`null` while it streams or
 * when malformed).
 */
export const matchAgentSurfaceToolCall = (toolCall: ToolCallLike): AgentSurfaceToolCall | null => {
  const tool = agentSurfaceToolOf(toolCall);
  if (!tool) return null;
  const args = toolArguments(toolCall);
  if (tool.kind === 'review') {
    return { kind: 'review', input: parseInput(LodyRequestReviewInputSchema, args) };
  }
  if (tool.kind === 'notify') {
    return { kind: 'notify', input: parseInput(LodyNotifyUserInputSchema, args) };
  }
  return {
    kind: 'widget',
    source: tool.source,
    input:
      tool.source === 'lody'
        ? parseInput(LodyShowWidgetInputSchema, args)
        : parseInput(VisualizeWidgetInputSchema, args),
  };
};

/**
 * The `rawInput` history keeps for a widget or plan review: only the validated
 * input, inside a minimal Codex envelope when the call came as one, so the
 * stored call is still recognized and nothing past the schema is stored.
 * `undefined` for every other call and while the input is incomplete or invalid.
 */
export const agentSurfaceStoredInput = (
  toolCall: ToolCallLike
): { [key: string]: unknown } | undefined => {
  const match = matchAgentSurfaceToolCall(toolCall);
  if (!match || match.kind === 'notify' || !match.input) return undefined;
  const raw = toolCall.rawInput;
  return isCodexEnvelope(raw)
    ? { server: raw.server, tool: raw.tool, arguments: match.input }
    : match.input;
};

/* ------------------------------------------------------------------------ */
/* File widgets referenced from reply text                                   */
/* ------------------------------------------------------------------------ */

export type AgentTextWidgetEmbed = {
  /** `codex`: a `visualize{...}` line; `antigravity`: an `<agent-embed>` tag. */
  format: 'codex' | 'antigravity';
  /** Absolute path on the agent's machine. */
  path: string;
  title?: string;
  /** Codex's layout hint; Lody always uses the conversation width. */
  mode?: string;
};

export type AgentTextSegment =
  | { type: 'text'; text: string }
  | { type: 'widget'; embed: AgentTextWidgetEmbed; source: string };

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const CODEX_VISUALIZE_LINE = /^\s*visualize(\{.*\})\s*$/;
const AGENT_EMBED_LINE =
  /^\s*<agent-embed\s+src\s*=\s*(?:"([^"]+)"|'([^']+)')\s*(?:\/>|>\s*<\/agent-embed>)\s*$/i;

const isAbsolutePath = (value: string): boolean =>
  value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);

const parseCodexVisualize = (json: string): AgentTextWidgetEmbed | null => {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const path = record['path'];
  if (typeof path !== 'string' || !isAbsolutePath(path)) return null;
  return {
    format: 'codex',
    path,
    ...(typeof record['title'] === 'string' && record['title'].trim()
      ? { title: record['title'].trim().slice(0, LODY_WIDGET_TITLE_MAX_CHARS) }
      : {}),
    ...(typeof record['mode'] === 'string' ? { mode: record['mode'] } : {}),
  };
};

const fileUrlToPath = (src: string): string | null => {
  if (!src.toLowerCase().startsWith('file://')) return null;
  try {
    const url = new URL(src);
    if (url.protocol !== 'file:' || (url.host !== '' && url.host !== 'localhost')) return null;
    const pathname = decodeURIComponent(url.pathname);
    // `file:///C:/x` keeps the drive letter after the leading slash.
    const path = /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
    return isAbsolutePath(path) ? path : null;
  } catch {
    return null;
  }
};

/**
 * Splits reply text around file widgets written on their own line: Codex's
 * `visualize{"path":...}` line and Antigravity's `<agent-embed src="file://...">`.
 * Lines inside fenced code blocks are text. Returns one text segment when the
 * reply has no widget.
 */
export const splitAgentTextWidgets = (text: string): AgentTextSegment[] => {
  if (!text.includes('visualize{') && !/<agent-embed/i.test(text)) {
    return [{ type: 'text', text }];
  }
  const segments: AgentTextSegment[] = [];
  let buffer: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (buffer.length === 0) return;
    const chunk = buffer.join('\n');
    if (chunk.trim().length > 0) segments.push({ type: 'text', text: chunk });
    buffer = [];
  };
  for (const line of text.split('\n')) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      buffer.push(line);
      continue;
    }
    if (fence === null) {
      const codex = CODEX_VISUALIZE_LINE.exec(line);
      const embed = codex?.[1] ? parseCodexVisualize(codex[1]) : null;
      if (embed) {
        flush();
        segments.push({ type: 'widget', embed, source: line });
        continue;
      }
      const tag = AGENT_EMBED_LINE.exec(line);
      const path = tag ? fileUrlToPath(tag[1] ?? tag[2] ?? '') : null;
      if (path) {
        flush();
        segments.push({ type: 'widget', embed: { format: 'antigravity', path }, source: line });
        continue;
      }
    }
    buffer.push(line);
  }
  flush();
  return segments.length > 0 ? segments : [{ type: 'text', text }];
};
