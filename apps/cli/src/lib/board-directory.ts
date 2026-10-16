import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BOARD_FILES_LIST_MAX,
  BoardFilePathSchema,
  type BoardFileArea,
  type BoardFileEntry,
  type BoardFileList,
} from '@lody/shared';

/** Ids become one path segment each; anything else is not an id. */
const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The shared directories of the Boards this machine keeps:
 * `<data dir>/boards/<workspaceId>/<boardId>/{files,memory}/`. Only names inside
 * one area resolve; a symbolic link is neither listed nor followed out.
 */
export class BoardDirectory {
  constructor(private readonly dataDir: () => string) {}

  /** The absolute directory of a Board, as members on this machine are told. */
  boardPath(workspaceId: string, boardId: string): string {
    if (!SEGMENT.test(workspaceId) || !SEGMENT.test(boardId))
      throw new Error('invalid_request:that is not a Board');
    return path.join(this.dataDir(), 'boards', workspaceId, boardId);
  }

  private async area(workspaceId: string, boardId: string, area: BoardFileArea) {
    const directory = path.join(this.boardPath(workspaceId, boardId), area);
    await fs.promises.mkdir(directory, { recursive: true });
    return await fs.promises.realpath(directory);
  }

  /** Where a file of the area is; throws `BOARD_PATH_OUTSIDE` for any other name. */
  async resolve(
    workspaceId: string,
    boardId: string,
    area: BoardFileArea,
    relativePath: string
  ): Promise<string> {
    if (!BoardFilePathSchema.safeParse(relativePath).success)
      throw new Error('BOARD_PATH_OUTSIDE:the path leaves the Board directory');
    const root = await this.area(workspaceId, boardId, area);
    // A link inside the area could still point out of it: resolve the part that
    // exists and keep the names that do not yet.
    const parts = relativePath.split('/');
    let real = root;
    for (let index = parts.length; index >= 0; index--) {
      const existing = await fs.promises
        .realpath(path.join(root, ...parts.slice(0, index)))
        .catch(() => null);
      if (existing !== null) {
        real = path.join(existing, ...parts.slice(index));
        break;
      }
    }
    if (real !== root && !real.startsWith(`${root}${path.sep}`))
      throw new Error('BOARD_PATH_OUTSIDE:the path leaves the Board directory');
    return real;
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
