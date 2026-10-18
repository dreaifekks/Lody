import { resolveSessionFileOpenTarget } from './session-file-open-target';
import type { BoardFileArea, BoardMeta, BoardFileEntry, BoardFileList } from '@lody/shared';
import { LazyDirectoryFileProvider, toFileEntry } from './lazy-directory-file-provider';
import type {
  FileWorkspaceOpenResult,
  FileWorkspaceProviderEntry,
} from './file-workspace-provider';

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
      (segments[position + 3] === 'files' || segments[position + 3] === 'memory')
  );
  if (index < 0) return null;
  const board =
    segments[index + 1] === workspaceId
      ? boards.find((entry) => entry.id === segments[index + 2])
      : undefined;
  const area = segments[index + 3] as BoardFileArea;
  return { board, area, path: segments.slice(index + 4).join('/'), filePath };
}
