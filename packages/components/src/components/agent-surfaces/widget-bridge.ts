import { parseLodyWidgetFrameMessage, type LodyWidgetFrameMessage } from '@lody/shared';

/**
 * The conversation's side of one widget frame: which messages it takes, from
 * whom, and how often. A widget is agent-written code, so nothing it says is
 * acted on directly — a prompt counts only right after the user clicked into
 * the widget, a link only asks.
 *
 * Kept free of React and the DOM so a later host (MCP Apps, for one) can reuse it.
 */

/** Tallest a widget grows before it scrolls inside the conversation. */
export const WIDGET_MAX_HEIGHT_PX = 1_200;
export const WIDGET_MIN_HEIGHT_PX = 24;

/** A burst of clicks sends once; a runaway script stops quickly. */
const PROMPT_MIN_INTERVAL_MS = 750;
const PROMPTS_PER_MINUTE = 12;
const LINK_MIN_INTERVAL_MS = 1_000;

export type WidgetBridgeHandlers = {
  /** The frame's own window; messages from any other source are ignored. */
  frameWindow: () => Window | null | undefined;
  onReady: () => void;
  onHeight: (height: number) => void;
  onPrompt: (text: string) => void;
  /**
   * Whether the user's own click on the frame asked, spending that click;
   * prompts without one are dropped.
   */
  takeUserClick: () => Promise<boolean>;
  onLink: (url: string) => void;
  now?: () => number;
};

export type WidgetBridge = {
  /**
   * Handles one `message` event; true when it was this frame's and accepted
   * (a prompt still waits for `takeUserClick`).
   */
  handle: (event: Pick<MessageEvent, 'source' | 'data'>) => boolean;
  /** `setWidgetState`, kept for the life of the frame and never persisted. */
  readonly widgetState: unknown;
};

/** Only http(s) leaves the app, and only after the user confirms. */
export const normalizeWidgetLink = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
};

export function createWidgetBridge(handlers: WidgetBridgeHandlers): WidgetBridge {
  const now = handlers.now ?? Date.now;
  let lastPromptAt = -Infinity;
  let promptTimes: number[] = [];
  let lastLinkAt = -Infinity;
  let widgetState: unknown = null;

  const accept = (message: LodyWidgetFrameMessage): boolean => {
    switch (message.type) {
      case 'lody-widget:ready':
        handlers.onReady();
        return true;
      case 'lody-widget:height':
        handlers.onHeight(
          Math.min(WIDGET_MAX_HEIGHT_PX, Math.max(WIDGET_MIN_HEIGHT_PX, Math.ceil(message.height)))
        );
        return true;
      case 'lody-widget:prompt': {
        // The limits first, so a refused burst spends no click; a refused
        // click spends none of the limits.
        const at = now();
        promptTimes = promptTimes.filter((time) => at - time < 60_000);
        if (
          at - lastPromptAt < PROMPT_MIN_INTERVAL_MS ||
          promptTimes.length >= PROMPTS_PER_MINUTE
        ) {
          return false;
        }
        const { text } = message;
        void handlers.takeUserClick().then((clicked) => {
          if (!clicked) return;
          lastPromptAt = at;
          promptTimes.push(at);
          handlers.onPrompt(text);
        });
        return true;
      }
      case 'lody-widget:link': {
        const url = normalizeWidgetLink(message.url);
        const at = now();
        if (!url || at - lastLinkAt < LINK_MIN_INTERVAL_MS) return false;
        lastLinkAt = at;
        handlers.onLink(url);
        return true;
      }
      case 'lody-widget:state':
        widgetState = message.state;
        return true;
      default:
        return false;
    }
  };

  return {
    handle: (event) => {
      const frame = handlers.frameWindow();
      if (!frame || event.source !== frame) return false;
      const message = parseLodyWidgetFrameMessage(event.data);
      return message ? accept(message) : false;
    },
    get widgetState() {
      return widgetState;
    },
  };
}

/**
 * The page's theme variables, from Lody's live design tokens: the VS Code
 * theme the user picked, in its light or dark mode.
 */
export function readWidgetThemeVars(root: HTMLElement = document.documentElement) {
  const style = getComputedStyle(root);
  const channel = (name: string): string | null => {
    const value = style.getPropertyValue(name).trim();
    return value ? value : null;
  };
  const vars: Record<string, string> = {};
  const set = (name: string, token: string, alpha?: number) => {
    const value = channel(token);
    if (value) vars[name] = alpha === undefined ? `hsl(${value})` : `hsl(${value} / ${alpha})`;
  };
  set('--surface-0', '--background');
  set('--surface-1', '--card');
  set('--surface-2', '--popover');
  set('--text-primary', '--foreground');
  set('--text-secondary', '--muted-foreground');
  set('--text-muted', '--muted-foreground', 0.7);
  set('--text-danger', '--destructive');
  set('--border', '--border');
  set('--border-strong', '--muted-foreground', 0.35);
  set('--border-stronger', '--muted-foreground', 0.6);
  const font = getComputedStyle(document.body).fontFamily;
  if (font) vars['--font-sans'] = font;
  return vars;
}
