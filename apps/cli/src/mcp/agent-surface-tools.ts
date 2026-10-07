import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import {
  LODY_AGENT_TOOL_NAMES,
  LODY_WIDGET_CDN_ORIGINS,
  LodyNotifyUserInputSchema,
  LodyRequestReviewInputSchema,
  LodyShowWidgetInputSchema,
  type LodyAgentToolId,
  type LodyNotifyUserInput,
} from '@lody/shared';
import type { createSessionToolRegistrar } from './session-tool-router';

/*
 * Experimental tools that put something in front of the user. Every agent
 * reads these descriptions; several (Codex code mode, Kimi, Pi) never read the
 * server instructions, so each description says when and how to use its tool.
 */

const CDN_HOSTS = LODY_WIDGET_CDN_ORIGINS.map((origin) => new URL(origin).host).join(', ');

export const AGENT_SURFACE_TOOL_DESCRIPTIONS = {
  notify: [
    'Send the user a short notification (phone push and desktop alert) about this conversation.',
    'Use it ONLY when the user must decide or act, when you are blocked and cannot continue without them, or when a long task finished while they may be away.',
    'Never use it for routine progress updates, and never twice for the same event.',
    "Write `body` in the user's language: one or two sentences saying what happened and what you need. `title` is optional; the conversation title is used otherwise.",
    'Lody skips the phone alert when the user is already reading this conversation.',
    'Calls are rate limited (one per minute per conversation, a few per hour); a refused call returns retryAfterSeconds, so do not retry before then.',
  ].join(' '),
  review: [
    'Submit a plan for the user to review in a side panel, where they can comment on passages and choose Approve or Request changes.',
    'Use it after discussing a task and writing a concrete implementation plan (or design/proposal), before you start implementing.',
    "Pass the complete plan inline as Markdown in `markdown` (never a file path), a short `title`, and optionally a one-sentence `summary`. Write all of it in the user's language.",
    "The call returns immediately. After calling it, END YOUR TURN and wait: the decision arrives as the user's next message, quoting the passages they commented on.",
    'A newer review in this conversation replaces older ones, so after changes resubmit the full revised plan. Do not repeat the plan in your reply text.',
  ].join(' '),
  widget: [
    'Show an interactive visual inline in the conversation: a clickable flowchart, diagram, chart, or small explorable for teaching. Input: `title` and `widget_code` (an SVG or HTML fragment).',
    'Put only the visual in widget_code; explanations go in your reply text.',
    'widget_code is a fragment: no <!DOCTYPE>, <html>, <head> or <body>. Keep backgrounds transparent and never hardcode text colors.',
    'Use the host CSS variables so it works in light and dark mode: text --text-primary, --text-secondary, --text-muted; surfaces --surface-0/1/2; borders --border, --border-strong; status --text-accent, --text-danger, --text-success, --text-warning; also --radius, --font-sans, --font-mono.',
    'SVG: width="100%" with a viewBox (680 wide renders 1:1); helper classes t, ts, th for text, box for shapes, node for clickable groups, arr for arrows, and c-blue, c-teal, c-purple, c-coral, c-amber, c-green, c-red, c-pink, c-gray for colored groups.',
    'Height follows the content (capped): never use position: fixed, fullscreen, or nested scrolling.',
    "Make nodes clickable with onclick=\"sendPrompt('a follow-up question')\"; this fills the user's message box for them to send. Open links with <a href> or openLink(url); the user confirms.",
    `External scripts, styles and fonts load only from ${CDN_HOSTS}; nothing else is reachable. Load a library with <script src> before the inline script that uses it.`,
  ].join(' '),
} as const satisfies Record<LodyAgentToolId, string>;

const textResult = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

export function registerAgentSurfaceTools(
  server: McpServer,
  registerSessionTool: ReturnType<typeof createSessionToolRegistrar>,
  options: {
    /** Tools to list; the daemon's handler table registers every one. */
    offered: (id: LodyAgentToolId) => boolean;
    notify: (input: LodyNotifyUserInput) => Promise<CallToolResult>;
  }
): void {
  // A Session tool: on the local platform it runs in the daemon, which owns
  // the notifications port and the rate limit.
  if (options.offered('notify')) {
    registerSessionTool(
      LODY_AGENT_TOOL_NAMES.notify,
      {
        title: 'Notify the user',
        description: AGENT_SURFACE_TOOL_DESCRIPTIONS.notify,
        inputSchema: LodyNotifyUserInputSchema,
      },
      options.notify
    );
  }

  // The conversation renders these calls from their input; answering is all
  // the server does.
  if (options.offered('review')) {
    server.registerTool(
      LODY_AGENT_TOOL_NAMES.review,
      {
        title: 'Request a plan review',
        description: AGENT_SURFACE_TOOL_DESCRIPTIONS.review,
        inputSchema: LodyRequestReviewInputSchema,
      },
      async () =>
        textResult({
          ok: true,
          note: "The plan is open for the user's review. End your turn now; their decision arrives as their next message.",
        })
    );
  }
  if (options.offered('widget')) {
    server.registerTool(
      LODY_AGENT_TOOL_NAMES.widget,
      {
        title: 'Show a widget',
        description: AGENT_SURFACE_TOOL_DESCRIPTIONS.widget,
        inputSchema: LodyShowWidgetInputSchema,
      },
      async () => textResult({ ok: true, note: 'The widget is shown in the conversation.' })
    );
  }
}
