import { z } from 'zod';

/**
 * Part of a file, asked for in one line and answered with one line and then
 * exactly the bytes that line announces. A member of a LAN asks another one
 * over the connection that carries files; the desktop asks the agent service
 * of its own machine over the local file socket, naming the machine as well.
 *
 * The file is a block a session keeps (`fileId`) or a file at a path the
 * session's previews may read (`path`). `revision` names the content the
 * answer was read from: a later request that carries it is refused once the
 * file is another one, so the parts of two files are never joined.
 */
const rangeFields = {
  type: z.literal('range'),
  sessionId: z.string().trim().min(1).max(256),
  fileId: z.string().trim().min(1).max(256).optional(),
  path: z.string().min(1).max(4096).optional(),
  offset: z.number().int().nonnegative(),
  /** To the end of the file when absent; `0` asks for the size and revision alone. */
  length: z.number().int().nonnegative().optional(),
  revision: z.string().min(1).max(128).optional(),
};

const namesOneFile = (value: { fileId?: string; path?: string }) =>
  (value.fileId === undefined) !== (value.path === undefined);

export const LanFileRangeRequestSchema = z.object(rangeFields).strict().refine(namesOneFile);
export type LanFileRangeRequest = z.infer<typeof LanFileRangeRequestSchema>;

export const LocalFileRangeRequestSchema = z
  .object({
    ...rangeFields,
    workspaceId: z.string().trim().min(1).max(256),
    /** The machine that has the file. */
    machineId: z.string().trim().min(1).max(256),
  })
  .strict()
  .refine(namesOneFile);
export type LocalFileRangeRequest = z.infer<typeof LocalFileRangeRequestSchema>;

export const LanFileRangeAnswerSchema = z.union([
  z.object({
    type: z.literal('range'),
    /** The size of the whole file. */
    sizeBytes: z.number().int().nonnegative(),
    /** How many bytes follow this line. */
    length: z.number().int().nonnegative(),
    revision: z.string().min(1).max(128),
  }),
  z.object({ type: z.literal('error'), code: z.string().min(1), message: z.string() }),
]);
export type LanFileRangeAnswer = z.infer<typeof LanFileRangeAnswerSchema>;
