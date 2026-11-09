// Lody's agent tools by name, and which of them a call in a transcript is.
// This file imports nothing: the LAN share reader bundles it by its path
// (through `lan-share-visible.ts`), so a share tells the same calls apart as
// the desktop does. The inputs are checked in `lody-agent-tools.ts`.

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

export type ToolCallLike = {
  title?: string | null;
  toolName?: string;
  rawInput?: { [key: string]: unknown };
};

/** Which tool a call is; a widget also says whose: Lody's or Claude Desktop's `show_widget`. */
export type AgentSurfaceTool =
  | { kind: 'review' }
  | { kind: 'notify' }
  | { kind: 'widget'; source: 'lody' | 'visualize' };

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

export const isCodexEnvelope = (
  raw: ToolCallLike['rawInput']
): raw is { server: string; tool: string; [key: string]: unknown } =>
  !!raw && typeof raw['server'] === 'string' && typeof raw['tool'] === 'string';

/**
 * A name that states its server decides alone: Codex's `{ server, tool, arguments }`
 * envelope, then a canonical `toolName` such as `mcp__lody__x`. Only without one
 * do a bare `toolName` and the title count, so another server's `lody_show_widget`
 * titled by its bare name is never taken for Lody's.
 */
const toolNameCandidates = (
  toolCall: ToolCallLike
): Array<{ server: string | null; tool: string }> => {
  const raw = toolCall.rawInput;
  if (isCodexEnvelope(raw)) return [{ server: raw.server, tool: raw.tool }];
  const candidates: Array<{ server: string | null; tool: string }> = [];
  for (const name of [toolCall.toolName, toolCall.title]) {
    if (typeof name !== 'string') continue;
    const split = splitToolName(name);
    if (!split) continue;
    if (name === toolCall.toolName && split.server !== null) return [split];
    candidates.push(split);
  }
  return candidates;
};

/**
 * Which experimental surface tool a call is, by name; `null` for any other
 * call. Names come from the agent's canonical tool name, Codex's MCP envelope
 * or the title; every agent spells MCP tool names differently.
 */
export const agentSurfaceToolOf = (toolCall: ToolCallLike): AgentSurfaceTool | null => {
  for (const { server, tool } of toolNameCandidates(toolCall)) {
    const lodyServer = server === null || server === 'lody';
    if (lodyServer && tool === LODY_AGENT_TOOL_NAMES.review) return { kind: 'review' };
    if (lodyServer && tool === LODY_AGENT_TOOL_NAMES.widget) {
      return { kind: 'widget', source: 'lody' };
    }
    if (lodyServer && tool === LODY_AGENT_TOOL_NAMES.notify) return { kind: 'notify' };
    if (server === 'visualize' && tool === 'show_widget') {
      return { kind: 'widget', source: 'visualize' };
    }
  }
  return null;
};

/** What a call was given: the arguments of Codex's envelope, or else its raw input. */
export const toolArguments = (toolCall: ToolCallLike): unknown => {
  const raw = toolCall.rawInput;
  if (!raw) return undefined;
  if (isCodexEnvelope(raw)) {
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
