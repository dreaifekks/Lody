import { classifyBrowserHostname } from '@lody/shared/browser-url';
import type { IBufferLine } from '@xterm/xterm';
import { isMac } from '@/lib/commands';
import { splitTextIntoFilePathSegments } from '@/lib/linkify-file-paths';

// Links in terminal output: http(s) URLs and the bare file paths chat already
// linkifies (`splitTextIntoFilePathSegments`, so `src/foo.ts:32` reads the same
// in both places). Detection runs per buffer row, so a link the terminal wrapped
// onto the next row is only recognized up to the row's end.
//
// A plain click opens a URL in the system browser; Cmd (macOS) / Ctrl + click
// opens it in the session's Browser panel instead. A loopback URL printed by a
// session on another LAN machine always goes to the panel: the system browser's
// localhost is this machine, the panel's Managed Preview reaches that machine's
// port. Paths only open with the modifier, into the side panel — output is full
// of paths and a stray click should not open tabs.

export type TerminalLinkKind = 'url' | 'path';

export type TerminalTextLink = {
  kind: TerminalLinkKind;
  text: string;
  /** UTF-16 offsets into the searched text, end exclusive. */
  start: number;
  end: number;
};

export type TerminalLineLink = {
  kind: TerminalLinkKind;
  text: string;
  /** 1-based cell columns, both inclusive (xterm `IBufferRange` x values). */
  startX: number;
  endX: number;
};

export type TerminalLinkAction =
  | { target: 'system-browser'; url: string }
  | { target: 'side-browser'; url: string }
  | { target: 'side-file'; path: string };

// Stops at whitespace, quotes, angle brackets and full-width punctuation, so a
// URL followed by Chinese prose (`http://localhost:3000，然后`) ends where it should.
const URL_PATTERN = /https?:\/\/(?=[\w[])[^\s"'`<>，。、；：！？（）【】「」『』《》“”‘’]+/g;
const URL_TRAILING_PUNCTUATION = '.,;:!?';
const CLOSING_TO_OPENING_BRACKET: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const URL_HOST_PATTERN = /^https?:\/\/(\[[^\]]*\]|[^/:?#]+)/i;

const countChar = (value: string, char: string): number => value.split(char).length - 1;

// Drop sentence punctuation and closing brackets the URL never opened, so
// `(see http://x/a_(b))` keeps `_(b)` but not the wrapping `)`.
const trimUrl = (raw: string): string => {
  let url = raw;
  for (;;) {
    const last = url.at(-1) ?? '';
    const opening = CLOSING_TO_OPENING_BRACKET[last];
    if (
      URL_TRAILING_PUNCTUATION.includes(last) ||
      (opening && countChar(url, last) > countChar(url, opening))
    ) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
};

/** Every URL in `text`, plus the file paths between them when `paths` is set. */
export function findTerminalLinks(text: string, options: { paths: boolean }): TerminalTextLink[] {
  const links: TerminalTextLink[] = [];
  const pushPaths = (from: number, to: number) => {
    if (!options.paths || from >= to) return;
    let offset = from;
    for (const segment of splitTextIntoFilePathSegments(text.slice(from, to))) {
      if (segment.type === 'path') {
        links.push({
          kind: 'path',
          text: segment.value,
          start: offset,
          end: offset + segment.value.length,
        });
      }
      offset += segment.value.length;
    }
  };

  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    pushPaths(cursor, match.index);
    links.push({ kind: 'url', text: url, start: match.index, end: match.index + url.length });
    cursor = match.index + url.length;
  }
  pushPaths(cursor, text.length);
  return links;
}

/**
 * Links in one buffer row, mapped from string offsets to cells: a wide (CJK)
 * character spans two cells, and an empty cell reads as a space.
 */
export function findTerminalLineLinks(
  line: Pick<IBufferLine, 'length' | 'getCell'>,
  options: { paths: boolean }
): TerminalLineLink[] {
  let text = '';
  const cellStarts: number[] = [];
  const cellEnds: number[] = [];
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x)!;
    const width = cell.getWidth();
    if (width === 0) continue;
    const chars = cell.getChars() || ' ';
    text += chars;
    for (let unit = 0; unit < chars.length; unit += 1) {
      cellStarts.push(x);
      cellEnds.push(x + width);
    }
  }
  return findTerminalLinks(text, options).map((link) => ({
    kind: link.kind,
    text: link.text,
    startX: cellStarts[link.start] + 1,
    endX: cellEnds[link.end - 1],
  }));
}

/** Cmd + click on macOS, Ctrl + click elsewhere. */
export function isSidePanelLinkModifier(event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>): boolean {
  return isMac() ? event.metaKey : event.ctrlKey;
}

/** `localhost`, `127.x`, `[::1]`, and the `0.0.0.0` dev servers print for "all interfaces". */
export function isLoopbackUrl(url: string): boolean {
  const host = url.match(URL_HOST_PATTERN)?.[1]?.toLowerCase();
  if (host === undefined) return false;
  return host === '0.0.0.0' || classifyBrowserHostname(host) === 'loopback';
}

// The Browser panel refuses `0.0.0.0`; on the machine that printed it, it means
// that machine's own interfaces, which localhost reaches.
const toSidePanelBrowserUrl = (url: string): string =>
  url.replace(/^(https?:\/\/)0\.0\.0\.0(?=[:/?#]|$)/i, '$1localhost');

export function resolveTerminalLinkAction(
  link: Pick<TerminalTextLink, 'kind' | 'text'>,
  context: {
    sidePanelModifier: boolean;
    sessionIsRemote: boolean;
    canOpenUrlInSidePanel: boolean;
  }
): TerminalLinkAction | null {
  if (link.kind === 'path') {
    return context.sidePanelModifier ? { target: 'side-file', path: link.text } : null;
  }
  if (
    context.canOpenUrlInSidePanel &&
    (context.sidePanelModifier || (context.sessionIsRemote && isLoopbackUrl(link.text)))
  ) {
    return { target: 'side-browser', url: toSidePanelBrowserUrl(link.text) };
  }
  return { target: 'system-browser', url: link.text };
}
