import type { MessageContent } from '@lody/shared';
import { resolveMarkdownImagePath } from './session-file-open-target';

// A second look for a relative file link the session's machine could not find.
//
// An agent names a file the way it thinks of it, not the way the workspace
// spells it: `pending.md` for a file it keeps under `~/.local/state/…`, or
// `data-runtime/edit-session.ts` for one three folders down. The machine
// resolves a relative path against the session workspace only, so those links
// open on "file not found" although the conversation itself says where the file
// is. This module recovers that location from the conversation:
//
//   1. a longer path that ends in the link (`…/lody-kit/data-runtime/edit-session.ts`),
//      from prompts, prose, tool inputs and tool output;
//   2. the link placed under a directory the conversation named
//      (`d=~/.local/state/lody-ios-lan-watch` + `pending.md`).
//
// Candidates are only ever PROBED. The machine stays the one authority on what
// exists and what may be read, and a link that already resolves is never
// rewritten: the fallback runs after the machine has answered "not found".

export type FileLinkContext = {
  /** Prompts, prose and tool inputs, latest first. */
  readonly mentions: readonly string[];
  /** Tool output, latest first. Only searched for a path ending in the link. */
  readonly outputs: readonly string[];
};

export type FileLinkContextTurn = {
  readonly items?: readonly MessageContent[] | null;
  readonly inputConfig?: { readonly prompt?: string | null } | null;
};

export type FileLinkProbeResult =
  /** `path` is the machine's own spelling of what it found, when it reported one. */
  { readonly state: 'found'; readonly path?: string } | { readonly state: 'missing' | 'unknown' };
export type FileLinkProbe = (path: string) => Promise<FileLinkProbeResult>;

export const FILE_LINK_FALLBACK_PROBE_LIMIT = 16;

// A tool input can carry a whole file (`Write`) and an output a whole log; the
// path a command works on sits near its start, so a bounded head is enough.
const MAX_INPUT_CHARS = 4_000;
const MAX_OUTPUT_CHARS = 200_000;

const PATH_NAME_CHAR = /[A-Za-z0-9._@+-]/;
const PATH_TOKEN_PATTERN =
  /(?:~|\.{1,2})?(?:\/[A-Za-z0-9._@+-]+)+|[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)+/g;
const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9]+$/;

const normalizeLinkPath = (value: string): string =>
  value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '');

/** Absolute, home-relative and drive paths already say where they are. */
export function isRelativeFileLinkPath(path: string): boolean {
  const trimmed = path.trim();
  return trimmed !== '' && !/^(?:[\\/~]|[a-z]:[\\/])/i.test(trimmed);
}

const pushText = (target: string[], value: unknown, maxChars: number): void => {
  if (typeof value !== 'string' || value === '') return;
  target.push(value.length > maxChars ? value.slice(0, maxChars) : value);
};

const collectToolCall = (
  toolCall: Extract<MessageContent, { type: 'tool_call' }>,
  mentions: string[],
  outputs: string[]
): void => {
  pushText(mentions, toolCall.title, MAX_INPUT_CHARS);
  for (const location of toolCall.locations ?? []) {
    pushText(mentions, location.path, MAX_INPUT_CHARS);
  }
  for (const value of Object.values(toolCall.rawInput ?? {})) {
    pushText(mentions, value, MAX_INPUT_CHARS);
  }
  for (const block of toolCall.content ?? []) {
    if (block.type === 'terminal_command') {
      pushText(mentions, [block.command, ...(block.args ?? [])].join(' '), MAX_INPUT_CHARS);
      pushText(mentions, block.cwd, MAX_INPUT_CHARS);
    } else if (block.type === 'diff') {
      pushText(mentions, block.path, MAX_INPUT_CHARS);
    } else if (block.type === 'terminal_output') {
      pushText(outputs, block.output, MAX_OUTPUT_CHARS);
    } else if (block.type === 'content' && block.content.type === 'text') {
      pushText(outputs, block.content.text, MAX_OUTPUT_CHARS);
    }
  }
};

/** Reads `turns` in the order given; pass them latest first. */
export function collectFileLinkContext(
  turns: Iterable<FileLinkContextTurn | undefined>
): FileLinkContext {
  const mentions: string[] = [];
  const outputs: string[] = [];
  for (const turn of turns) {
    if (!turn) continue;
    const items = turn.items ?? [];
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]!;
      if (item.type === 'text') {
        pushText(mentions, item.text, Number.POSITIVE_INFINITY);
      } else if (item.type === 'proposed_plan') {
        pushText(mentions, item.markdown, Number.POSITIVE_INFINITY);
      } else if (item.type === 'tool_call') {
        collectToolCall(item, mentions, outputs);
      }
    }
    pushText(mentions, turn.inputConfig?.prompt, Number.POSITIVE_INFINITY);
  }
  return { mentions, outputs };
}

/** Every path in `text` that ends in `/<linkPath>`, widened left to its start. */
function findPathsEndingWith(text: string, linkPath: string): string[] {
  const needle = `/${linkPath}`;
  const found: string[] = [];
  let from = text.indexOf(needle);
  while (from !== -1) {
    const end = from + needle.length;
    const next = text[end];
    // `pending.md` must not answer for `pending.mdx` or `pending.md/…`.
    const endsHere = next === undefined || !/[A-Za-z0-9_/-]/.test(next);
    if (endsHere) {
      let start = from;
      while (
        start > 0 &&
        (text[start - 1] === '/' ||
          text[start - 1] === '~' ||
          PATH_NAME_CHAR.test(text[start - 1]!))
      ) {
        start -= 1;
      }
      const path = text.slice(start, end).replace(/^(?:\.\/)+/, '');
      const before = start > 0 ? text[start - 1] : '';
      // `//host/…` is the tail of a URL and `$d/…` hangs off a shell variable;
      // neither is a path on the machine.
      if (!path.startsWith('//') && before !== '$' && before !== '}') found.push(path);
    }
    from = text.indexOf(needle, from + 1);
  }
  return found;
}

/** The directories a mentioned path points at: itself when it has no extension, and its parent. */
function directoriesOf(token: string): string[] {
  const path = token.replace(/[.]+$/, '').replace(/^(?:\.\/)+/, '');
  const slash = path.lastIndexOf('/');
  const directories: string[] = [];
  if (!FILE_EXTENSION_PATTERN.test(path.slice(slash + 1))) directories.push(path);
  if (slash > 0) directories.push(path.slice(0, slash));
  return directories;
}

/** `…/lody-kit/data-runtime` + `data-runtime/edit-session.ts` shares the middle folder. */
function joinWithOverlap(directory: string, linkPath: string): string {
  const directorySegments = directory.split('/');
  const linkSegments = linkPath.split('/');
  for (
    let shared = Math.min(directorySegments.length, linkSegments.length - 1);
    shared > 0;
    shared -= 1
  ) {
    const tail = directorySegments.slice(-shared);
    if (tail.every((segment, index) => segment === linkSegments[index])) {
      return `${directory}/${linkSegments.slice(shared).join('/')}`;
    }
  }
  return `${directory}/${linkPath}`;
}

/**
 * Where else the link may live, most specific first: a mentioned path that ends
 * in it, then the link under a mentioned directory outside the workspace, then
 * under a mentioned workspace folder.
 */
export function buildFileLinkFallbackPaths(
  linkPath: string,
  context: FileLinkContext,
  limit = FILE_LINK_FALLBACK_PROBE_LIMIT
): string[] {
  const link = normalizeLinkPath(linkPath);
  if (!link || !isRelativeFileLinkPath(link)) return [];

  const seen = new Set<string>([link]);
  const exact: string[] = [];
  const outside: string[] = [];
  const inside: string[] = [];
  const add = (target: string[], path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    target.push(path);
  };

  for (const text of [...context.mentions, ...context.outputs]) {
    if (exact.length >= limit) break;
    for (const path of findPathsEndingWith(text, link)) add(exact, path);
  }
  for (const text of context.mentions) {
    if (exact.length + outside.length >= limit) break;
    for (const match of text.matchAll(PATH_TOKEN_PATTERN)) {
      // The second slash of `https://host/…` starts a host, not a root, and
      // `$d/…` names a variable, not a folder.
      const before = match.index > 0 ? text[match.index - 1] : '';
      if (before === '/' || before === '$') continue;
      for (const directory of directoriesOf(match[0])) {
        add(isRelativeFileLinkPath(directory) ? inside : outside, joinWithOverlap(directory, link));
      }
    }
  }
  return [...exact, ...outside, ...inside].slice(0, limit);
}

/** Reads a File Preview v3 answer to a one-byte request as an existence check. */
export function classifyFileLinkProbe(
  result:
    | { readonly status: string; readonly code?: string; readonly path?: string }
    | null
    | undefined
): FileLinkProbeResult {
  if (!result) return { state: 'unknown' };
  // The one-byte ceiling makes any real file "too large": it exists.
  if (result.status !== 'error' || result.code === 'too_large') {
    return { state: 'found', ...(result.path ? { path: result.path } : {}) };
  }
  return { state: result.code === 'file_not_found' ? 'missing' : 'unknown' };
}

/**
 * The path to open for a link an agent wrote. Returns `path` unchanged unless
 * the machine reports it missing AND one of the conversation's candidates
 * exists. A candidate is returned in the machine's spelling (`~/notes/a.md` as
 * `/home/me/notes/a.md`), because every later consumer of the path — the tab,
 * Copy Path, the editor actions — treats anything not absolute as relative to
 * the workspace.
 */
export async function resolveMissingFileLink(args: {
  readonly path: string;
  readonly probe: FileLinkProbe;
  readonly context: () => FileLinkContext;
  readonly limit?: number;
}): Promise<string> {
  if (!isRelativeFileLinkPath(args.path)) return args.path;
  const probe = (path: string) =>
    args.probe(path).catch((): FileLinkProbeResult => ({ state: 'unknown' }));
  if ((await probe(args.path)).state !== 'missing') return args.path;
  const candidates = buildFileLinkFallbackPaths(args.path, args.context(), args.limit);
  const results = await Promise.all(candidates.map(probe));
  for (const [index, result] of results.entries()) {
    if (result.state === 'found') return result.path ?? candidates[index]!;
  }
  return args.path;
}

/**
 * Where else an image of a Markdown document may be when it is not beside the
 * document: the places the document itself names, read first on the lines that
 * name the image. A note often names folders from its project or Board root
 * (`files/shots/` in `memory/report.md`), so a relative folder is tried from the
 * document's folder, the two folders above it and, for a workspace-relative
 * document, the workspace root.
 */
export function buildDocumentImageFallbackPaths(
  documentPath: string,
  src: string,
  documentText: string,
  limit = FILE_LINK_FALLBACK_PROBE_LIMIT
): string[] {
  const primary = resolveMarkdownImagePath(documentPath, src);
  if (primary === null || !isRelativeFileLinkPath(src)) return [];
  const link = normalizeLinkPath(src);
  const nearby = documentText.split('\n').filter((line) => line.includes(link));
  const base = documentPath.replace(/\\/g, '/');
  const folders: string[] = [];
  for (let end = base.lastIndexOf('/'); end > 0 && folders.length < 3; ) {
    folders.push(base.slice(0, end + 1));
    end = base.lastIndexOf('/', end - 1);
  }
  if (isRelativeFileLinkPath(base)) folders.push('');
  const seen = new Set([primary]);
  const paths: string[] = [];
  for (const candidate of buildFileLinkFallbackPaths(
    link,
    { mentions: [...nearby, documentText], outputs: [] },
    Number.POSITIVE_INFINITY
  )) {
    const resolved = isRelativeFileLinkPath(candidate)
      ? folders.map((folder) => resolveMarkdownImagePath(`${folder}_`, candidate))
      : [candidate];
    for (const path of resolved) {
      if (path === null || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
      if (paths.length === limit) return paths;
    }
  }
  return paths;
}
