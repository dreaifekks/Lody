import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  BOARD_FILES_LIST_MAX,
  BoardFilePathSchema,
  getWorkspaceFlockDocId,
  normalizeBoardMeta,
  workspaceFlockKeys,
  type BoardFileArea,
  type BoardFileEntry,
  type BoardFileList,
  type BoardId,
  type BoardMeta,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroDocumentManager } from './loro/doc';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

/** Ids become one path segment each; anything else is not an id. */
const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

const outside = () => new Error('BOARD_PATH_OUTSIDE:the path leaves the Board directory');

/**
 * A Board row as this daemon reads it. Its replica of the workspace catalog
 * holds only the rows it has synced, and a daemon syncs the catalog only when
 * something asks: a Board made on another machine since is not there until
 * this sync brings it. A failed sync leaves the local rows.
 */
export async function readSyncedBoard(
  manager: Pick<LoroDocumentManager, 'repo' | 'syncFlockDocOrThrow'>,
  workspaceId: string,
  boardId: string,
  logger: Pick<Logger, 'warn'>
): Promise<BoardMeta | null> {
  const docId = getWorkspaceFlockDocId(workspaceId as WorkspaceId);
  await manager.syncFlockDocOrThrow(docId, { reason: 'board-files' }).catch((error: unknown) => {
    logger.warn(`Board catalog refresh failed; using local rows: ${formatErrorMessage(error)}`);
  });
  const catalog = await manager.repo.openFlockDoc(docId);
  return normalizeBoardMeta(catalog.flock.get(workspaceFlockKeys.board(boardId as BoardId)));
}

/**
 * The shared directories of the Boards this machine keeps:
 * `<data dir>/boards/<workspaceId>/<boardId>/{files,memory}/`. Only names inside
 * one area resolve; a symbolic link is neither listed nor followed.
 */
export class BoardDirectory {
  constructor(private readonly dataDir: () => string) {}

  /** The absolute directory of a Board, as members on this machine are told. */
  boardPath(workspaceId: string, boardId: string): string {
    if (!SEGMENT.test(workspaceId) || !SEGMENT.test(boardId))
      throw new Error('invalid_request:that is not a Board');
    return path.join(this.dataDir(), 'boards', workspaceId, boardId);
  }

  /**
   * The root of an area, named from the data directory. Each directory on the
   * way down must be a directory, never a link, so no link moves the root.
   */
  private async area(workspaceId: string, boardId: string, area: BoardFileArea) {
    this.boardPath(workspaceId, boardId);
    let directory = this.dataDir();
    await fs.promises.mkdir(directory, { recursive: true });
    for (const segment of ['boards', workspaceId, boardId, area]) {
      directory = path.join(directory, segment);
      await fs.promises.mkdir(directory, { recursive: true });
      if (!(await fs.promises.lstat(directory)).isDirectory()) throw outside();
    }
    return directory;
  }

  /** Where a file of the area is; throws `BOARD_PATH_OUTSIDE` for any other name. */
  async resolve(
    workspaceId: string,
    boardId: string,
    area: BoardFileArea,
    relativePath: string
  ): Promise<string> {
    if (!BoardFilePathSchema.safeParse(relativePath).success) throw outside();
    const root = await this.area(workspaceId, boardId, area);
    // No name on the way may be a link; the names after the first missing one
    // do not exist yet.
    const parts = relativePath.split('/');
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const stat = await fs.promises.lstat(current).catch(() => null);
      if (!stat) break;
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()))
        throw outside();
    }
    return path.join(root, ...parts);
  }

  async list(workspaceId: string, boardId: string, area: BoardFileArea): Promise<BoardFileList> {
    const root = await this.area(workspaceId, boardId, area);
    const entries: BoardFileEntry[] = [];
    let truncated = false;
    const walk = async (directory: string, prefix: string): Promise<void> => {
      const children = await fs.promises.readdir(directory, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (truncated) return;
        const relative = prefix ? `${prefix}/${child.name}` : child.name;
        const absolute = path.join(directory, child.name);
        if (child.isDirectory()) await walk(absolute, relative);
        else if (child.isFile()) {
          if (entries.length === BOARD_FILES_LIST_MAX) {
            truncated = true;
            return;
          }
          const stat = await fs.promises.stat(absolute);
          entries.push({ path: relative, sizeBytes: stat.size, modifiedAtMs: stat.mtimeMs });
        }
      }
    };
    await walk(root, '');
    return { entries, truncated };
  }

  /** Copies a file of the area to `destinationPath`, which must not exist yet. */
  async read(
    workspaceId: string,
    boardId: string,
    area: BoardFileArea,
    relativePath: string,
    destinationPath: string
  ): Promise<{ sizeBytes: number }> {
    const source = await fs.promises.open(
      await this.resolve(workspaceId, boardId, area, relativePath),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    await pipeline(
      source.createReadStream(),
      fs.createWriteStream(destinationPath, { flags: 'wx' })
    );
    return { sizeBytes: (await fs.promises.stat(destinationPath)).size };
  }

  /** Puts a copy of `sourcePath` at a name of the area, replacing what was there at once. */
  async put(
    workspaceId: string,
    boardId: string,
    area: BoardFileArea,
    relativePath: string,
    sourcePath: string
  ): Promise<BoardFileEntry> {
    const target = await this.resolve(workspaceId, boardId, area, relativePath);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const partial = `${target}.${crypto.randomUUID()}.part`;
    try {
      await fs.promises.copyFile(sourcePath, partial);
      await fs.promises.rename(partial, target);
    } finally {
      await fs.promises.rm(partial, { force: true });
    }
    const stat = await fs.promises.stat(target);
    return { path: relativePath, sizeBytes: stat.size, modifiedAtMs: stat.mtimeMs };
  }
}
