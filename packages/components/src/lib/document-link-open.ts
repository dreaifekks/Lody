import type { BoardFileArea, BoardMeta, SessionId } from '@lody/shared';
import { boardDocumentFilePath, resolveBoardFileLink } from './board-directory-file-provider';
import { parseMarkdownAgentFileHref } from './markdown-agent-file-link';
import { isRelativeFileLinkPath, type FileLinkProbeResult } from './session-file-link-fallback';
import { normalizeIndexedRelativePath, resolveMarkdownImagePath } from './session-file-open-target';

// Where a file link in a rendered DOCUMENT leads: a Markdown preview in a side
// file tab or the article window, a Board file or memory preview, the Board's
// shared notes, a reply card's full reply. A conversation's own links keep
// `session-file-link-open.ts`; this is the document counterpart.
//
// The link alone says which machine and directory it reads:
//   - a path into a Board directory is that Board's, read through its member
//     file channel;
//   - any other absolute or home path is the owning session's machine;
//   - a relative path is read from the document's folder first. Agents also
//     write paths from the root of the project they work in, so a path the
//     folder does not hold is then tried in the owning session's workspace.
//
// Candidates are only probed; the machine that serves a file still decides
// what may be read.

/**
 * Where a file is read from. A path on a named LAN machine (`<machine>:<path>`)
 * is meant to become the third kind.
 */
export type FileSource =
  | { readonly kind: 'session'; readonly sessionId: SessionId }
  | { readonly kind: 'board'; readonly boardId: string };

/** One file: its source, and its path there (`<area>/<path>` in a Board). */
export type FileTarget = {
  readonly source: FileSource;
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
};

/** A file of a Board's directory. */
export type BoardFileTarget = FileTarget & {
  readonly source: Extract<FileSource, { kind: 'board' }>;
};

export const isBoardFileTarget = (target: FileTarget): target is BoardFileTarget =>
  target.source.kind === 'board';

/** Whether the file exists, as far as its source can tell. */
export type FileTargetProbe = (target: FileTarget) => Promise<FileLinkProbeResult>;

/** One string per source, for keys. */
export const fileSourceKey = (source: FileSource): string =>
  source.kind === 'session' ? `session:${source.sessionId}` : `board:${source.boardId}`;

export const isSameFileTarget = (a: FileTarget, b: FileTarget): boolean =>
  a.path === b.path && fileSourceKey(a.source) === fileSourceKey(b.source);

/** A Board file's area and the path inside it. */
export function splitBoardFilePath(path: string): { area: BoardFileArea; path: string } {
  const slash = path.indexOf('/');
  return { area: path.slice(0, slash) as BoardFileArea, path: path.slice(slash + 1) };
}

/** The spelling the session page's opener recognizes as a Board file (`resolveBoardFileLink`). */
export const boardFileLinkPath = (workspaceId: string | null, target: FileTarget): string =>
  target.source.kind === 'board'
    ? `boards/${workspaceId}/${target.source.boardId}/${target.path}`
    : target.path;

/** The link's path beside the document, in the document's own source; null when it leaves it. */
function besideDocument(
  document: FileTarget,
  path: string,
  workspaceId: string | null
): FileTarget | null {
  const joined = resolveMarkdownImagePath(document.path, path);
  if (joined === null) return null;
  if (document.source.kind === 'session') return { source: document.source, path: joined };
  const scoped = workspaceId
    ? boardDocumentFilePath(joined, workspaceId, document.source.boardId)
    : null;
  return scoped === null ? null : { source: document.source, path: scoped };
}

/**
 * The file a document's link names, or null for an href that is not a file.
 * `readerSessionId` reads a Board document: its workspace and machine answer
 * the links the Board does not.
 */
export async function resolveDocumentLink(args: {
  readonly href: string;
  readonly document: FileTarget;
  readonly readerSessionId: SessionId;
  readonly workspaceId: string | null;
  readonly boards: readonly BoardMeta[];
  readonly probe: FileTargetProbe;
}): Promise<FileTarget | null> {
  const link = parseMarkdownAgentFileHref(args.href);
  if (!link) return null;
  let path = link.filePath;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* A literal percent sign. */
  }
  path = path.replace(/\\/g, '/');
  if (!path) return null;

  const board = resolveBoardFileLink(path, args.workspaceId, args.boards, 'canonical');
  if (board)
    return {
      source: { kind: 'board', boardId: board.boardId },
      path: `${board.area}/${board.path}`,
    };

  const owner: FileSource =
    args.document.source.kind === 'session'
      ? args.document.source
      : { kind: 'session', sessionId: args.readerSessionId };
  const lines = {
    ...(link.startLine === undefined ? {} : { startLine: link.startLine }),
    ...(link.endLine === undefined ? {} : { endLine: link.endLine }),
  };
  if (!isRelativeFileLinkPath(path)) return { source: owner, path, ...lines };

  const rooted: FileTarget = {
    source: owner,
    path: normalizeIndexedRelativePath(path) ?? path,
    ...lines,
  };
  const near = besideDocument(args.document, path, args.workspaceId);
  if (near === null) return rooted;
  const nearWithLines: FileTarget = near.source.kind === 'session' ? { ...near, ...lines } : near;
  if (isSameFileTarget(near, rooted)) return nearWithLines;
  // A folder that cannot answer (machine away) keeps the document's reading.
  if ((await args.probe(near)).state !== 'missing') return nearWithLines;
  return (await args.probe(rooted)).state === 'found' ? rooted : nearWithLines;
}
