import { z } from 'zod';

/**
 * A Board's shared directory, on the machine that keeps it:
 * `<data dir>/boards/<workspaceId>/<boardId>/` with two areas. `files/` holds
 * whatever the members share; `memory/` holds the notes agents keep while they
 * work, indexed by `memory/MEMORY.md`, which the coordinator maintains.
 *
 * A path names a file inside one area, `/`-separated and relative. Nothing
 * outside the area can be named: no absolute path, no `..`, no empty segment.
 */
export const BOARD_FILE_AREAS = ['files', 'memory'] as const;
export type BoardFileArea = (typeof BOARD_FILE_AREAS)[number];
export const BoardFileAreaSchema = z.enum(BOARD_FILE_AREAS);
export const BOARD_MEMORY_INDEX = 'MEMORY.md';
/** A listing stops here; the rest is reported as truncated. */
export const BOARD_FILES_LIST_MAX = 500;

export const BoardFilePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !/^[A-Za-z]:/.test(value) &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'BOARD_PATH_OUTSIDE'
  );

export const BoardFileEntrySchema = z
  .object({
    path: z.string().min(1).max(1024),
    sizeBytes: z.number().int().nonnegative(),
    modifiedAtMs: z.number().nonnegative(),
  })
  .strict();
export type BoardFileEntry = z.infer<typeof BoardFileEntrySchema>;

export const BoardFileListSchema = z
  .object({
    entries: z.array(BoardFileEntrySchema).max(BOARD_FILES_LIST_MAX),
    truncated: z.boolean(),
  })
  .strict();
export type BoardFileList = z.infer<typeof BoardFileListSchema>;

/** Which Board file a member asks about, and as which member session. */
export const BoardFileScopeSchema = z
  .object({
    boardId: z.string().startsWith('bd_').max(256),
    /** A member of the Board: the caller, or the coordinator for the desktop. */
    sessionId: z.string().trim().min(1).max(256),
    area: BoardFileAreaSchema,
  })
  .strict();
export type BoardFileScope = z.infer<typeof BoardFileScopeSchema>;
