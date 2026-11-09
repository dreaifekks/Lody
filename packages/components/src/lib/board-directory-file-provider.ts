import { resolveSessionFileOpenTarget } from './session-file-open-target';
import type { BoardFileArea, BoardMeta, BoardFileEntry, BoardFileList } from '@lody/shared';
import { LazyDirectoryFileProvider, toFileEntry } from './lazy-directory-file-provider';
import type {
  FileWorkspaceOpenResult,
  FileWorkspaceProviderEntry,
  FileWorkspaceProviderState,
} from './file-workspace-provider';
import type {
  SessionFileChangedFilesResult,
  SessionFileDiffResult,
  SessionFileProvider,
} from './session-file-provider';
import { isBinaryImagePath } from './image-file-preview';

/**
 * One area of a Board's shared directory as the session file tree shows it.
 * The agent service lists the whole area at once (500 files at most), so the
 * root holds every file and the tree builds the folders from their paths. The
 * Board panel previews a file itself (`BoardFilePreview`), from `entry`.
 */
export class BoardDirectoryFileProvider extends LazyDirectoryFileProvider {
  private readonly listed = new Map<string, BoardFileEntry>();

  constructor(private readonly list: () => Promise<BoardFileList>) {
    super();
  }

  /** The listed file at a path, as the Board preview and download take it. */
  entry(path: string): BoardFileEntry | undefined {
    return this.listed.get(path);
  }

  async searchFiles(query: string): Promise<readonly FileWorkspaceProviderEntry[]> {
    const normalized = query.trim().toLowerCase();
    return (await this.listFiles()).filter((entry) =>
      entry.path.toLowerCase().includes(normalized)
    );
  }

  async openFile(pathOrFileId: string): Promise<FileWorkspaceOpenResult> {
    return {
      status: 'unavailable',
      entry: toFileEntry(pathOrFileId),
      reason: 'metadata-only',
      message: 'Board files open in the Board panel.',
    };
  }

  protected async loadDirectoryEntries(): Promise<readonly FileWorkspaceProviderEntry[]> {
    const { entries } = await this.list();
    this.listed.clear();
    for (const entry of entries) this.listed.set(entry.path, entry);
    return entries.map((entry) => toFileEntry(entry.path, entry.sizeBytes));
  }
}

export type BoardFileLinkTarget = {
  /** The Board the path names, even one the catalog does not list (yet). */
  boardId: string;
  board: BoardMeta | undefined;
  area: BoardFileArea;
  path: string;
  filePath: string;
};

/** Recognize the Board directory before ordinary workspace path shortening. */
export function resolveBoardFileLink(
  href: string,
  workspaceId: string | null,
  boards: readonly BoardMeta[],
  pathKind: 'markdown-href' | 'canonical' = 'markdown-href'
): BoardFileLinkTarget | null {
  const { filePath } = resolveSessionFileOpenTarget({
    rawPath: href,
    pathKind,
    preserveWorktreePath: true,
  });
  const segments = filePath.split('/');
  const index = segments.findIndex(
    (part, position) =>
      part === 'boards' &&
      segments[position + 1] === workspaceId &&
      (segments[position + 3] === 'files' || segments[position + 3] === 'memory')
  );
  if (index < 0) return null;
  const boardId = segments[index + 2]!;
  const board = boards.find((entry) => entry.id === boardId);
  const area = segments[index + 3] as BoardFileArea;
  return { boardId, board, area, path: segments.slice(index + 4).join('/'), filePath };
}

/**
 * The `<area>/<path>` of a Board that a path one of its documents names reads:
 * one resolved against the document (`files/a.md` + `shot.png`), or a path
 * into that Board's directory, absolute or in its canonical spelling
 * (`boards/<ws>/<board>/…`). Anything else is not the Board's.
 */
export function boardDocumentFilePath(
  path: string,
  workspaceId: string,
  boardId: string
): string | null {
  let parts = path.split('/');
  if (/^(?:\/|[a-z]:\/)/i.test(path) || parts[0] === 'boards') {
    const index = parts.findIndex(
      (part, position) =>
        part === 'boards' &&
        parts[position + 1] === workspaceId &&
        parts[position + 2] === boardId
    );
    if (index < 0) return null;
    parts = parts.slice(index + 3);
  }
  const [area, ...rest] = parts;
  return (area === 'files' || area === 'memory') && rest.length && !rest.includes('..')
    ? parts.join('/')
    : null;
}

/** What reading one file of a Board directory answers (`machineRpc.openMemberFile`). */
export type BoardMemberFileResource =
  | { readonly ok: true; readonly url: string; readonly sizeBytes: number }
  | { readonly ok: false; readonly error: string };

/** The first bytes of a Board text file the viewer shows; the rest is cut. */
const BOARD_TEXT_READ_BYTES = 1024 * 1024;

/**
 * One Board's directory for the file viewer (the article window), the way a
 * session's provider serves its workspace. Paths are the Board's canonical
 * spelling (`boards/<ws>/<board>/<area>/<path>`), so a document's images and a
 * comparison's options resolve inside the Board, and every read goes through
 * `read` to the machine that keeps the directory. Read-only, with no listing
 * or history.
 */
export class BoardMemberFileProvider implements SessionFileProvider {
  readonly kind = 'code-collab' as const;

  constructor(
    private readonly workspaceId: string,
    private readonly boardId: string,
    /** Reads `<area>/<path>` of this Board. */
    private readonly read: (path: string) => Promise<BoardMemberFileResource>
  ) {}

  getState(): FileWorkspaceProviderState {
    return { kind: this.kind, ready: true, sourceState: 'live-readonly' };
  }

  async listFiles(): Promise<readonly FileWorkspaceProviderEntry[]> {
    return [];
  }

  async searchFiles(): Promise<readonly FileWorkspaceProviderEntry[]> {
    return [];
  }

  async getFile(path: string): Promise<FileWorkspaceProviderEntry> {
    return toFileEntry(path);
  }

  async saveText(path: string): Promise<FileWorkspaceOpenResult> {
    return { status: 'unavailable', entry: toFileEntry(path), reason: 'permission-denied' };
  }

  async getDiff(path: string): Promise<SessionFileDiffResult> {
    return { status: 'unavailable', path, reason: 'metadata-only' };
  }

  async listChangedFiles(): Promise<SessionFileChangedFilesResult> {
    return { status: 'unavailable', reason: 'metadata-only' };
  }

  async openFile(path: string): Promise<FileWorkspaceOpenResult> {
    const areaPath = boardDocumentFilePath(path, this.workspaceId, this.boardId);
    if (areaPath === null)
      return { status: 'unavailable', entry: toFileEntry(path), reason: 'permission-denied' };
    const resource = await this.read(areaPath);
    if (!resource.ok)
      return {
        status: 'unavailable',
        entry: toFileEntry(path),
        reason: /ENOENT/.test(resource.error) ? 'deleted' : 'transient-io',
        message: resource.error,
      };
    const entry = toFileEntry(path, resource.sizeBytes);
    const binary: FileWorkspaceOpenResult = {
      status: 'ready',
      entry: { ...entry, kind: 'binary' },
      snapshot: { kind: 'binary', url: resource.url },
    };
    if (isBinaryImagePath(path)) return binary;
    const cut = resource.sizeBytes > BOARD_TEXT_READ_BYTES;
    const response = await fetch(
      resource.url,
      cut ? { headers: { Range: `bytes=0-${BOARD_TEXT_READ_BYTES - 1}` } } : {}
    );
    let text: string;
    try {
      // A file is text when its bytes are UTF-8; a cut may split the last character.
      text = new TextDecoder('utf-8', { fatal: true }).decode(await response.arrayBuffer(), {
        stream: cut,
      });
    } catch {
      return binary;
    }
    return {
      status: 'ready',
      entry,
      snapshot: { kind: 'text', text, ...(cut ? { truncated: true } : {}) },
    };
  }
}
