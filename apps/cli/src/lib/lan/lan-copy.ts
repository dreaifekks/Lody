// Files copied between machines of a LAN (`lody-lan lan cp`), over the tunnel
// service members open to each other. One request line names what is copied;
// a stream of entries then carries directories and the bytes of files as they
// are, each file announced with its exact size, so nothing is encoded and the
// receiver reads no more than it writes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type tls from 'node:tls';
import { machineSupportsLanCopy, type MachineProtocolCapabilities } from '@lody/shared';
import { z } from 'zod';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { connectLanMember, writeLine, type LanMemberConnectOptions } from './lan-terminal';

/** How much of a file is read and sent at once. */
const CHUNK_BYTES = 256 * 1024;
/** A header names one path; a longer line is no header. */
const LINE_MAX_BYTES = 64 * 1024;

const copyFlags = {
  recursive: z.boolean(),
  preserveTimes: z.boolean(),
  /**
   * The machine whose files are meant, on the local tunnel socket of this
   * machine's agent service; a member serves only its own.
   */
  machineId: z.string().min(1).optional(),
};

/** Entries into `path` there, from as many sources as `sources` says. */
export const LanCopyPutRequestSchema = z.object({
  type: z.literal('put'),
  path: z.string(),
  sources: z.number().int().min(1),
  ...copyFlags,
});

/** Entries of `paths` there. */
export const LanCopyGetRequestSchema = z.object({
  type: z.literal('get'),
  paths: z.array(z.string()).min(1),
  ...copyFlags,
});

export type LanCopyRequest =
  | z.infer<typeof LanCopyPutRequestSchema>
  | z.infer<typeof LanCopyGetRequestSchema>;

const ErrorSchema = z.object({ type: z.literal('error'), message: z.string() });

const AnswerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), path: z.string(), directory: z.boolean() }),
  ErrorSchema,
]);

const DoneSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('done'), files: z.number(), bytes: z.number() }),
  ErrorSchema,
]);

const permissions = {
  /** POSIX permission bits; absent from a Windows sender, whose bits mean nothing elsewhere. */
  mode: z.number().int().min(0).max(0o777).optional(),
  mtimeMs: z.number(),
};

const EntrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('dir'), path: z.string(), ...permissions }),
  z.object({
    type: z.literal('file'),
    path: z.string(),
    size: z.number().int().min(0),
    ...permissions,
  }),
  z.object({
    type: z.literal('end'),
    files: z.number(),
    bytes: z.number(),
    /** Links to directories, and what is neither file nor directory, left out. */
    skipped: z.number().optional(),
  }),
  ErrorSchema,
]);
export type LanCopyEntry = z.infer<typeof EntrySchema>;

export type LanCopyResult = { files: number; bytes: number; skipped: number };

function parse<T>(schema: z.ZodType<T>, line: string, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`the other side sent no ${what}`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`the other side sent no ${what}`);
  return parsed.data;
}

/**
 * Lines and exact byte counts off a connection, read only as fast as they are
 * used: a receiver that writes slowly holds the sender back.
 */
export class ConnectionReader {
  private buffered: Buffer;
  private readonly chunks: AsyncIterator<Buffer>;

  constructor(socket: net.Socket, initial: Buffer = Buffer.alloc(0)) {
    this.buffered = initial;
    this.chunks = socket[Symbol.asyncIterator]();
  }

  async line(): Promise<string> {
    let newline = this.buffered.indexOf(0x0a);
    while (newline < 0) {
      if (this.buffered.length > LINE_MAX_BYTES) throw new Error('the other side sent no line');
      await this.fill();
      newline = this.buffered.indexOf(0x0a);
    }
    const line = this.buffered.subarray(0, newline).toString('utf8');
    this.buffered = this.buffered.subarray(newline + 1);
    return line;
  }

  /** Hands exactly `size` bytes to `write`, a chunk at a time. */
  async bytes(size: number, write: (chunk: Buffer) => Promise<void>): Promise<void> {
    let left = size;
    while (left > 0) {
      if (this.buffered.length === 0) await this.fill();
      const chunk = this.buffered.subarray(0, left);
      this.buffered = this.buffered.subarray(chunk.length);
      left -= chunk.length;
      await write(chunk);
    }
  }

  private async fill(): Promise<void> {
    const next = await this.chunks.next();
    if (next.done) throw new Error('the connection closed before the copy finished');
    this.buffered =
      this.buffered.length === 0 ? next.value : Buffer.concat([this.buffered, next.value]);
  }
}

/** Writes and waits while the connection holds more than it has sent. */
function send(socket: net.Socket, data: string | Buffer): Promise<void> {
  if (!socket.writable) return Promise.reject(new Error('the connection closed'));
  if (socket.write(data)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      socket.off('drain', onDrain);
      socket.off('close', onClose);
      socket.off('error', finish);
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => finish();
    const onClose = () => finish(new Error('the connection closed'));
    socket.on('drain', onDrain);
    socket.on('close', onClose);
    socket.on('error', finish);
  });
}

function header(entry: LanCopyEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

/**
 * A path named to the machine that holds it: `~` is its home, a relative path
 * starts there, as with scp. `paths` are those of that machine.
 */
export function resolveMachinePath(
  input: string,
  options: { home?: string; paths?: path.PlatformPath } = {}
): string {
  const paths = options.paths ?? path;
  const home = options.home ?? os.homedir();
  if (input === '~') return home;
  if (input.startsWith('~/') || (paths.sep === '\\' && input.startsWith('~\\'))) {
    return paths.resolve(home, input.slice(2));
  }
  return paths.resolve(home, input);
}

export type CopySource = { path: string; name: string; stats: fs.Stats };

/**
 * The sources of a copy, followed when they are links, as scp and `cp -H`
 * follow what the command line names. A directory needs `recursive`.
 */
export async function statCopySources(
  sources: readonly string[],
  recursive: boolean
): Promise<CopySource[]> {
  const found: CopySource[] = [];
  for (const source of sources) {
    const stats = await fs.promises.stat(source);
    if (stats.isDirectory() && !recursive) {
      throw new Error(`${source} is a directory; copy it with -r`);
    }
    if (!stats.isDirectory() && !stats.isFile()) throw new Error(`${source} is not a regular file`);
    const name = path.basename(source);
    if (!name) throw new Error(`${source} has no name to copy it under`);
    found.push({ path: source, name, stats });
  }
  return found;
}

function permissionsOf(stats: fs.Stats): { mode?: number; mtimeMs: number } {
  return {
    ...(process.platform === 'win32' ? {} : { mode: stats.mode & 0o777 }),
    mtimeMs: stats.mtimeMs,
  };
}

/** Sends sources as entries, and the end; `progress` says where a failure left the stream. */
export async function sendCopyEntries(
  socket: net.Socket,
  sources: readonly CopySource[],
  progress: { inFile: boolean } = { inFile: false }
): Promise<LanCopyResult> {
  const result: LanCopyResult = { files: 0, bytes: 0, skipped: 0 };

  const sendFile = async (absolute: string, relative: string) => {
    const handle = await fs.promises.open(absolute, 'r');
    try {
      // The size is read from the open file, which is what is sent.
      const stats = await handle.stat();
      await send(
        socket,
        header({ type: 'file', path: relative, size: stats.size, ...permissionsOf(stats) })
      );
      progress.inFile = true;
      let position = 0;
      while (position < stats.size) {
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, stats.size - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) throw new Error(`${absolute} shrank while it was copied`);
        await send(socket, buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      progress.inFile = false;
      result.files += 1;
      result.bytes += stats.size;
    } finally {
      await handle.close();
    }
  };

  const sendTree = async (absolute: string, relative: string, stats: fs.Stats) => {
    if (!stats.isDirectory()) {
      await sendFile(absolute, relative);
      return;
    }
    await send(socket, header({ type: 'dir', path: relative, ...permissionsOf(stats) }));
    const names = (await fs.promises.readdir(absolute)).sort();
    for (const name of names) {
      const child = path.join(absolute, name);
      let childStats = await fs.promises.lstat(child);
      // A link to a file copies the file; one to a directory, or to nothing, is left out.
      if (childStats.isSymbolicLink()) {
        childStats = await fs.promises.stat(child).catch(() => childStats);
        if (childStats.isDirectory() || childStats.isSymbolicLink()) {
          result.skipped += 1;
          continue;
        }
      }
      if (!childStats.isFile() && !childStats.isDirectory()) {
        result.skipped += 1;
        continue;
      }
      await sendTree(child, `${relative}/${name}`, childStats);
    }
  };

  for (const source of sources) await sendTree(source.path, source.name, source.stats);
  await send(socket, header({ type: 'end', ...result }));
  return result;
}

/** Where entries land: into a directory that exists, or as the path itself, as with scp. */
export type CopyTarget = { path: string; directory: boolean };

export function prepareCopyTarget(target: string, sources: number): CopyTarget {
  if (fs.statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
    return { path: target, directory: true };
  }
  if (sources > 1) throw new Error(`${target} is not a directory`);
  const parent = path.dirname(target);
  if (!fs.statSync(parent, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${parent} is not a directory`);
  }
  return { path: target, directory: false };
}

/**
 * Where an entry lands. Entries are named relative to the target, `/` between
 * their parts; one that would leave the target is refused. Into a target that
 * is no directory, the source itself takes the target's name.
 */
export function copyEntryDestination(
  target: CopyTarget,
  entryPath: string,
  paths: path.PlatformPath = path
): string {
  const parts = entryPath.split('/');
  // On Windows `\` separates too, and `:` names a drive or a stream.
  const foreign = paths.sep === '\\' ? /[\\:]/ : null;
  if (parts.some((part) => part === '' || part === '.' || part === '..' || foreign?.test(part))) {
    throw new Error(`refused the entry ${JSON.stringify(entryPath)}`);
  }
  return paths.join(target.path, ...(target.directory ? parts : parts.slice(1)));
}

async function writeAll(handle: fs.promises.FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset);
    offset += bytesWritten;
  }
}

/**
 * Takes entries until the end. A file is written beside its destination under
 * a temporary name and renamed over it once whole, so a broken copy leaves
 * neither a partial file nor its temporary one.
 */
export async function receiveCopyEntries(
  reader: ConnectionReader,
  target: CopyTarget,
  options: { preserveTimes: boolean }
): Promise<LanCopyResult> {
  const posix = process.platform !== 'win32';
  const directories: Array<{ path: string; mode?: number; mtimeMs: number }> = [];
  const result: LanCopyResult = { files: 0, bytes: 0, skipped: 0 };
  for (;;) {
    const entry = parse(EntrySchema, await reader.line(), 'copy entry');
    if (entry.type === 'error') throw new Error(entry.message);
    if (entry.type === 'end') {
      result.skipped = entry.skipped ?? 0;
      break;
    }
    const destination = copyEntryDestination(target, entry.path);
    if (entry.type === 'dir') {
      await fs.promises.mkdir(destination, { recursive: true });
      directories.push({ path: destination, mode: entry.mode, mtimeMs: entry.mtimeMs });
      continue;
    }
    const temporary = path.join(
      path.dirname(destination),
      `.${path.basename(destination)}.lody-part-${crypto.randomBytes(4).toString('hex')}`
    );
    const handle = await fs.promises.open(temporary, 'wx');
    try {
      try {
        await reader.bytes(entry.size, async (chunk) => await writeAll(handle, chunk));
      } finally {
        await handle.close();
      }
      if (posix && entry.mode !== undefined) await fs.promises.chmod(temporary, entry.mode);
      if (options.preserveTimes) {
        await fs.promises.utimes(temporary, new Date(), new Date(entry.mtimeMs));
      }
      await fs.promises.rename(temporary, destination);
    } catch (error) {
      await fs.promises.rm(temporary, { force: true });
      throw error;
    }
    result.files += 1;
    result.bytes += entry.size;
  }
  // A directory gets its bits and time after what it holds was written into it.
  for (const directory of directories.reverse()) {
    if (posix && directory.mode !== undefined) {
      await fs.promises.chmod(directory.path, directory.mode);
    }
    if (options.preserveTimes) {
      await fs.promises.utimes(directory.path, new Date(), new Date(directory.mtimeMs));
    }
  }
  return result;
}

/**
 * Answers a put or get with the files of this machine. A failure before or
 * between entries is told to the other side; one in the middle of a file
 * breaks the connection, since its bytes cannot be told from an answer.
 */
export async function serveLanCopy(
  socket: net.Socket,
  request: LanCopyRequest,
  options: { initial: Buffer; logger: Logger }
): Promise<void> {
  const progress = { inFile: false };
  socket.on('error', (error) => {
    options.logger.debug(`[lan-copy] ${request.type} connection failed: ${error.message}`);
  });
  try {
    if (request.type === 'put') {
      const target = prepareCopyTarget(resolveMachinePath(request.path), request.sources);
      writeLine(socket, { type: 'ready', ...target });
      const reader = new ConnectionReader(socket, options.initial);
      const result = await receiveCopyEntries(reader, target, request);
      writeLine(socket, { type: 'done', files: result.files, bytes: result.bytes });
    } else {
      const sources = await statCopySources(
        request.paths.map((entry) => resolveMachinePath(entry)),
        request.recursive
      );
      const first = sources[0];
      writeLine(socket, {
        type: 'ready',
        path: first?.path ?? '',
        directory: first?.stats.isDirectory() ?? false,
      });
      await sendCopyEntries(socket, sources, progress);
    }
    socket.end();
  } catch (error) {
    const message = formatErrorMessage(error);
    options.logger.debug(`[lan-copy] ${request.type} failed: ${message}`);
    if (progress.inFile || !socket.writable) {
      socket.destroy();
      return;
    }
    writeLine(socket, { type: 'error', message });
    socket.end();
  }
}

/**
 * Puts a copy request to a member, which answers it on the returned
 * connection. A member whose build predates `lan cp` is not asked.
 */
export async function openLanCopy(
  options: LanMemberConnectOptions & {
    /** What the member says of itself in the LAN. */
    machine: { name?: string; protocolCapabilities?: MachineProtocolCapabilities };
    request: LanCopyRequest;
  }
): Promise<tls.TLSSocket> {
  if (!machineSupportsLanCopy(options.machine)) {
    throw new Error(
      `${options.machine.name ?? options.machineId} runs a build without lan cp; update it`
    );
  }
  const { socket, rest } = await connectLanMember({ ...options, service: 'tunnel' });
  if (rest.length > 0) socket.unshift(rest);
  const { machineId: _machineId, ...request } = options.request;
  writeLine(socket, request);
  return socket;
}

async function readAnswer(reader: ConnectionReader): Promise<CopyTarget> {
  const answer = parse(AnswerSchema, await reader.line(), 'copy answer');
  if (answer.type === 'error') throw new Error(answer.message);
  return { path: answer.path, directory: answer.directory };
}

/**
 * Copies sources of this machine into `target` there. The answer is read
 * while entries are sent, so a receiver that fails is heard at once.
 */
export async function putCopy(
  socket: net.Socket,
  options: {
    target: string;
    sources: readonly CopySource[];
    recursive: boolean;
    preserveTimes: boolean;
    machineId?: string;
  }
): Promise<LanCopyResult & CopyTarget> {
  writeLine(socket, {
    type: 'put',
    path: options.target,
    sources: options.sources.length,
    recursive: options.recursive,
    preserveTimes: options.preserveTimes,
    ...(options.machineId ? { machineId: options.machineId } : {}),
  } satisfies LanCopyRequest);
  const reader = new ConnectionReader(socket);
  const target = await readAnswer(reader);
  const answered = reader.line().then((line) => parse(DoneSchema, line, 'copy answer'));
  const sending = sendCopyEntries(socket, options.sources);
  // Whichever settles first: the receiver may refuse while entries still go out.
  const done = await Promise.race([sending.then(async () => await answered), answered]).catch(
    async (error: unknown) => {
      const answer = await answered.catch(() => null);
      if (answer?.type === 'error') return answer;
      throw error;
    }
  );
  if (done.type === 'error') throw new Error(done.message);
  const sent = await sending;
  return { ...target, ...sent };
}

/** Copies sources there into `target` of this machine. */
export async function getCopy(
  socket: net.Socket,
  options: {
    sources: readonly string[];
    target: CopyTarget;
    recursive: boolean;
    preserveTimes: boolean;
    machineId?: string;
  }
): Promise<LanCopyResult> {
  writeLine(socket, {
    type: 'get',
    paths: [...options.sources],
    recursive: options.recursive,
    preserveTimes: options.preserveTimes,
    ...(options.machineId ? { machineId: options.machineId } : {}),
  } satisfies LanCopyRequest);
  const reader = new ConnectionReader(socket);
  await readAnswer(reader);
  return await receiveCopyEntries(reader, options.target, options);
}
