import { z } from 'zod';

/**
 * Experimental Lody MCP tools that put something in front of the user: an
 * alert, a plan to review, an interactive widget. Each is offered to agents
 * only while its experiment is on (the workspace `agentTools` setting row), and
 * the conversation renders its calls specially only while the same experiment
 * is on for the viewing device.
 */
export const LODY_AGENT_TOOL_IDS = ['notify', 'review', 'widget'] as const;
export type LodyAgentToolId = (typeof LODY_AGENT_TOOL_IDS)[number];

export const LODY_AGENT_TOOL_NAMES = {
  notify: 'lody_notify_user',
  review: 'lody_request_review',
  widget: 'lody_show_widget',
} as const satisfies Record<LodyAgentToolId, string>;

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
  title?: string;
  body: string;
  at: number;
};

/* ------------------------------------------------------------------------ */
/* Recognizing calls in a transcript                                         */
/* ------------------------------------------------------------------------ */

type ToolCallLike = {
  title?: string | null;
  toolName?: string;
  rawInput?: { [key: string]: unknown };
};

export type AgentSurfaceToolCall =
  | { kind: 'review'; input: LodyRequestReviewInput | null }
  | {
      kind: 'widget';
      /** `lody` for Lody's tool, `visualize` for Claude Desktop's `show_widget`. */
      source: 'lody' | 'visualize';
      input: LodyShowWidgetInput | null;
    }
  | { kind: 'notify'; input: LodyNotifyUserInput | null };

const NAME_SEPARATORS = /__|[./:]\s*|\s+/;

/** `mcp__lody__x`, `mcp.lody.x`, `lody/x`, `lody: x` or a bare `x`. */
const splitToolName = (name: string): { server: string | null; tool: string } | null => {
  const parts = name
    .trim()
    .split(NAME_SEPARATORS)
    .filter((part) => part.length > 0);
  const tool = parts.at(-1);
  if (!tool || parts.length > 4) return null;
  const server = parts.length >= 2 ? (parts.at(-2) ?? null) : null;
  return { server, tool };
};

const toolNameCandidates = (
  toolCall: ToolCallLike
): Array<{ server: string | null; tool: string }> => {
  const candidates: Array<{ server: string | null; tool: string }> = [];
  const raw = toolCall.rawInput;
  // Codex reports MCP calls as `{ server, tool, arguments }`.
  if (raw && typeof raw['server'] === 'string' && typeof raw['tool'] === 'string') {
    candidates.push({ server: raw['server'], tool: raw['tool'] });
  }
  for (const name of [toolCall.toolName, toolCall.title]) {
    if (typeof name !== 'string') continue;
    const split = splitToolName(name);
    if (split) candidates.push(split);
  }
  return candidates;
};

const toolArguments = (toolCall: ToolCallLike): unknown => {
  const raw = toolCall.rawInput;
  if (!raw) return undefined;
  if (typeof raw['server'] === 'string' && typeof raw['tool'] === 'string') {
    const args = raw['arguments'];
    if (typeof args === 'string') {
      try {
        return JSON.parse(args) as unknown;
      } catch {
        return undefined;
      }
    }
    return args;
  }
  return raw;
};

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
 * Which experimental surface a tool call belongs to, with its input once the
 * input is complete and valid (`null` while it streams or when malformed).
 * Names come from the agent's canonical tool name, Codex's MCP envelope or the
 * title; every agent spells MCP tool names differently.
 */
export const matchAgentSurfaceToolCall = (toolCall: ToolCallLike): AgentSurfaceToolCall | null => {
  for (const { server, tool } of toolNameCandidates(toolCall)) {
    const lodyServer = server === null || server === 'lody';
    if (lodyServer && tool === LODY_AGENT_TOOL_NAMES.review) {
      return {
        kind: 'review',
        input: parseInput(LodyRequestReviewInputSchema, toolArguments(toolCall)),
      };
    }
    if (lodyServer && tool === LODY_AGENT_TOOL_NAMES.widget) {
      return {
        kind: 'widget',
        source: 'lody',
        input: parseInput(LodyShowWidgetInputSchema, toolArguments(toolCall)),
      };
    }
    if (lodyServer && tool === LODY_AGENT_TOOL_NAMES.notify) {
      return {
        kind: 'notify',
        input: parseInput(LodyNotifyUserInputSchema, toolArguments(toolCall)),
      };
    }
    if (server === 'visualize' && tool === 'show_widget') {
      return {
        kind: 'widget',
        source: 'visualize',
        input: parseInput(VisualizeWidgetInputSchema, toolArguments(toolCall)),
      };
    }
  }
  return null;
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
