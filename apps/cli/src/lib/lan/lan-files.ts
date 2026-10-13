import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Duplex, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  SESSION_FILE_MAX_COUNT,
  SESSION_FILE_MAX_SIZE_BYTES,
  SessionFileBlockSchema,
  type SessionFilePayload,
} from '@lody/shared';
import {
  LanFileRangeAnswerSchema,
  LanFileRangeRequestSchema,
  type LanFileRangeRequest,
} from '@lody/shared/lan-file-range';
import { z } from 'zod';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { connectLanMember, type LanMemberConnectOptions } from './lan-terminal';

/**
 * Files of a message, from the member whose desktop sends it to the member
 * that runs its session. They go from machine to machine like a terminal
 * does: the hub would keep every file in a stream, and a request in the hub
 * is no place for a hundred megabytes.
 *
 * After the hello a connection carries files one after another, each in two
 * steps. The sender announces a file with one line of JSON and waits for the
 * member to say `ready`, so a file the member will not take is refused before
 * its bytes travel. It then sends exactly the bytes it announced, and the
 * member answers with the block it stored them as. Every answer is one line;
 * a refusal is the last one of its connection.
 *
 * The same connection also gives a file back: a member that shows a message
 * asks for one file the other keeps, which answers with its size and then
 * exactly that many bytes. The asker checks them against the block.
 *
 * A `range` line asks for part of a file instead, so a video plays and a file
 * of any size is saved without being copied whole first: a block a session
 * keeps, or a file at a path the session's previews may read. The answer names
 * the size of the file and what identifies its present content, and is
 * followed by the bytes asked for.
 */
const HEADER_MAX_BYTES = 8 * 1024;
const ANSWER_MAX_BYTES = 64 * 1024;
const IDLE_TIMEOUT_MS = 60_000;

const FileHeaderSchema = z
  .object({
    type: z.literal('file'),
    sessionId: z.string().trim().min(1).max(256),
    fileName: z.string().min(1).max(1024),
    sizeBytes: z.number().int().positive().max(SESSION_FILE_MAX_SIZE_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const ReadRequestSchema = z
  .object({
    type: z.literal('read'),
    sessionId: z.string().trim().min(1).max(256),
    fileId: z.string().trim().min(1).max(256),
  })
  .strict();

const RefusalSchema = z.object({
  type: z.literal('error'),
  code: z.string().min(1),
  message: z.string(),
});
const ReadyAnswerSchema = z.union([z.object({ type: z.literal('ready') }), RefusalSchema]);
const ContentAnswerSchema = z.union([
  z.object({
    type: z.literal('content'),
    sizeBytes: z.number().int().positive().max(SESSION_FILE_MAX_SIZE_BYTES),
  }),
  RefusalSchema,
]);
const StoredAnswerSchema = z.union([
  z.object({ type: z.literal('stored'), file: SessionFileBlockSchema }),
  RefusalSchema,
]);

/** A file as it arrived, before the machine took it into a session. */
export type ReceivedLanFile = {
  sessionId: string;
  fileName: string;
  /** Where the bytes are; removed once `store` returns. */
  path: string;
  sizeBytes: number;
  sha256: string;
};

/** A file this machine keeps, as a member asks for it. */
export type LanFileToRead = {
  /** Where the bytes are. */
  path: string;
  sizeBytes: number;
};

export type LanFileToSend = {
  path: string;
  fileName: string;
};

// File systems bound a name in bytes, and a character may take four of them.
const FILE_NAME_MAX_BYTES = 200;
const FILE_EXTENSION_MAX_BYTES = 32;

/** A name that is safe as the last segment of a path on any platform. */
export function toStoredFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const cleaned = Array.from(base.trim(), (character) =>
    (character.codePointAt(0) ?? 0) < 32 ? '_' : character
  ).join('');
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'file';
  if (Buffer.byteLength(cleaned) <= FILE_NAME_MAX_BYTES) return cleaned;

  // Shortened by character, so none is cut in the middle, and before the
  // extension, which says what the file is.
  const extension = path.extname(cleaned);
  const kept = Buffer.byteLength(extension) <= FILE_EXTENSION_MAX_BYTES ? extension : '';
  const stem = Array.from(cleaned.slice(0, cleaned.length - kept.length));
  let bytes = Buffer.byteLength(stem.join('')) + Buffer.byteLength(kept);
  while (stem.length > 1 && bytes > FILE_NAME_MAX_BYTES) {
    bytes -= Buffer.byteLength(stem.pop() ?? '');
  }
  return `${stem.join('')}${kept}`;
}

/** Reads lines and counted bytes from one stream, in the order they arrive. */
export class ByteReader {
  private buffered: Buffer;
  private readonly source: AsyncIterator<Buffer>;
  private ended = false;

  constructor(stream: Readable, initial: Buffer) {
    this.buffered = initial;
    this.source = (stream as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  }

  private async more(): Promise<boolean> {
    if (this.ended) return false;
    const next = await this.source.next();
    if (next.done) {
      this.ended = true;
      return false;
    }
    this.buffered =
      this.buffered.length === 0 ? next.value : Buffer.concat([this.buffered, next.value]);
    return true;
  }

  /** `null` when the stream ended before another line began. */
  async readLine(maxBytes: number): Promise<string | null> {
    for (;;) {
      const newline = this.buffered.indexOf(0x0a);
      if (newline >= 0) {
        const line = this.buffered.subarray(0, newline).toString('utf8');
        this.buffered = this.buffered.subarray(newline + 1);
        return line;
      }
      if (this.buffered.length > maxBytes) throw new Error('line too long');
      if (!(await this.more())) {
        if (this.buffered.length === 0) return null;
        throw new Error('connection closed in the middle of a line');
      }
    }
  }

  async readBytes(count: number, write: (chunk: Buffer) => Promise<void>): Promise<void> {
    let remaining = count;
    while (remaining > 0) {
      if (this.buffered.length === 0 && !(await this.more())) {
        throw new Error('connection closed in the middle of a file');
      }
      const chunk = this.buffered.subarray(0, remaining);
      this.buffered = this.buffered.subarray(chunk.length);
      remaining -= chunk.length;
      await write(chunk);
    }
  }
}

function writeLine(stream: Duplex, value: unknown): void {
  if (!stream.destroyed) stream.write(`${JSON.stringify(value)}\n`);
}

function armIdleTimeout(stream: Duplex, timeoutMs: number): void {
  const socket = stream as Duplex & { setTimeout?: (ms: number, callback: () => void) => void };
  socket.setTimeout?.(timeoutMs, () => {
    stream.destroy(new Error('the connection was idle for too long'));
  });
}

function parseRequest<T>(schema: z.ZodType<T>, line: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * A range that broke off after its bytes were announced. No line can say so
 * any more, since it would be read as bytes of the file: the connection ends.
 */
export class LanFileRangeAborted extends Error {}

const RANGE_CHUNK_BYTES = 64 * 1024;

const revisionOf = (stat: fs.Stats): string =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;

function writeChunk(stream: Duplex, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Answers one `range` request from the file at `filePath`. A request this
 * file cannot answer is refused by throwing its reason before anything is
 * written. A file that changes while its bytes travel breaks the range off:
 * each part is checked after it was read and before it leaves, and the next
 * request, which carries the revision, is the one that is told.
 */
export async function serveFileRange(
  stream: Duplex,
  request: Pick<LanFileRangeRequest, 'offset' | 'length' | 'revision'>,
  filePath: string
): Promise<void> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not_a_file:that is not a file');
    const revision = revisionOf(stat);
    if (request.revision !== undefined && request.revision !== revision) {
      throw new Error('file_changed:the file changed since it was opened');
    }
    if (request.offset > stat.size) {
      throw new Error('invalid_range:the file ends before that offset');
    }
    const end = Math.min(stat.size, request.offset + (request.length ?? stat.size));
    writeLine(stream, {
      type: 'range',
      sizeBytes: stat.size,
      length: end - request.offset,
      revision,
    });
    try {
      for (let position = request.offset; position < end;) {
        const chunk = Buffer.allocUnsafe(Math.min(RANGE_CHUNK_BYTES, end - position));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0 || revisionOf(await handle.stat()) !== revision) {
          throw new Error('the file changed while it was read');
        }
        position += bytesRead;
        await writeChunk(stream, chunk.subarray(0, bytesRead));
      }
    } catch (error) {
      throw new LanFileRangeAborted(formatErrorMessage(error), { cause: error });
    }
  } finally {
    await handle.close();
  }
}

function classifyRefusal(error: unknown): { code: string; message: string } {
  const message = formatErrorMessage(error);
  const code = /^([a-z][a-z0-9_]*):/.exec(message)?.[1];
  return { code: code ?? 'file_refused', message };
}

/**
 * Takes the files a member sends over one connection. `admit` decides from
 * the announcement alone; `store` receives each file once its size and digest
 * are what was announced, and answers with the block the sender puts into its
 * message.
 */
export async function serveLanFileConnection(
  stream: Duplex,
  options: {
    initial: Buffer;
    /** Throws the reason when this machine takes no file for the session. */
    admit: (file: { sessionId: string; sizeBytes: number }) => Promise<void>;
    store: (file: ReceivedLanFile) => Promise<SessionFilePayload>;
    /** Throws the reason when this machine gives no such file back. */
    read?: (file: { sessionId: string; fileId: string }) => Promise<LanFileToRead>;
    /** Where the file of a `range` request is; throws the reason when it may not be read. */
    locate?: (file: LanFileRangeRequest) => Promise<string>;
    logger: Logger;
    idleTimeoutMs?: number;
  }
): Promise<void> {
  armIdleTimeout(stream, options.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
  // A sender that goes away is reported by whatever was reading from it.
  stream.on('error', () => {});
  const reader = new ByteReader(stream, options.initial);
  try {
    for (let received = 0; ;) {
      const line = await reader.readLine(HEADER_MAX_BYTES);
      if (line === null) return;
      if (line.trim() === '') continue;
      const range = parseRequest(LanFileRangeRequestSchema, line);
      if (range) {
        if (!options.locate)
          throw new Error('invalid_request:this machine gives no part of a file');
        await serveFileRange(stream, range, await options.locate(range));
        continue;
      }
      const read = parseRequest(ReadRequestSchema, line);
      if (read) {
        if (!options.read) throw new Error('invalid_request:this machine gives no files back');
        const file = await options.read(read);
        writeLine(stream, { type: 'content', sizeBytes: file.sizeBytes });
        await pipeline(fs.createReadStream(file.path, { end: file.sizeBytes - 1 }), stream, {
          end: false,
        });
        continue;
      }
      received += 1;
      if (received > SESSION_FILE_MAX_COUNT) {
        throw new Error(`too_many_files:at most ${SESSION_FILE_MAX_COUNT} files per message`);
      }
      let header: z.infer<typeof FileHeaderSchema>;
      try {
        header = FileHeaderSchema.parse(JSON.parse(line));
      } catch {
        throw new Error('invalid_request:the header of the file cannot be read');
      }

      await options.admit({ sessionId: header.sessionId, sizeBytes: header.sizeBytes });
      writeLine(stream, { type: 'ready' });

      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lody-lan-file-'));
      try {
        const target = path.join(directory, toStoredFileName(header.fileName));
        const handle = await fs.promises.open(target, 'wx', 0o600);
        const hash = crypto.createHash('sha256');
        try {
          await reader.readBytes(header.sizeBytes, async (chunk) => {
            hash.update(chunk);
            await handle.write(chunk);
          });
        } finally {
          await handle.close();
        }
        if (hash.digest('hex') !== header.sha256) {
          throw new Error('invalid_file:the file arrived damaged');
        }
        const file = await options.store({
          sessionId: header.sessionId,
          fileName: header.fileName,
          path: target,
          sizeBytes: header.sizeBytes,
          sha256: header.sha256,
        });
        writeLine(stream, { type: 'stored', file });
      } finally {
        await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  } catch (error) {
    options.logger.debug(`[lan-files] refused a file: ${formatErrorMessage(error)}`);
    if (error instanceof LanFileRangeAborted) stream.destroy();
    else writeLine(stream, { type: 'error', ...classifyRefusal(error) });
  } finally {
    stream.end();
  }
}

async function describeFile(file: LanFileToSend): Promise<{ sizeBytes: number; sha256: string }> {
  const stat = await fs.promises.stat(file.path);
  if (!stat.isFile()) throw new Error(`invalid_file:${file.fileName} is not a file`);
  if (stat.size <= 0) throw new Error(`invalid_file:${file.fileName} is empty`);
  if (stat.size > SESSION_FILE_MAX_SIZE_BYTES) {
    throw new Error(
      `invalid_file:${file.fileName} is larger than ${Math.floor(
        SESSION_FILE_MAX_SIZE_BYTES / (1024 * 1024)
      )} MB`
    );
  }
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file.path)) hash.update(chunk as Buffer);
  return { sizeBytes: stat.size, sha256: hash.digest('hex') };
}

/** The side of a connection that asks, reading the member's answers. */
function answersOf(stream: Duplex, options: { initial: Buffer; idleTimeoutMs?: number }) {
  armIdleTimeout(stream, options.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
  let failure: Error | null = null;
  stream.on('error', (error) => {
    failure ??= error;
  });
  const reader = new ByteReader(stream, options.initial);
  const unreachable = (error: unknown): Error =>
    new Error(`remote_unreachable:${formatErrorMessage(failure ?? error)}`, { cause: error });
  const readAnswer = async <T>(schema: z.ZodType<T>): Promise<T> => {
    let line: string | null;
    try {
      line = await reader.readLine(ANSWER_MAX_BYTES);
    } catch (error) {
      throw unreachable(error);
    }
    if (line === null) {
      throw new Error(
        `remote_unreachable:${failure ? formatErrorMessage(failure) : 'the machine closed the connection'}`
      );
    }
    try {
      return schema.parse(JSON.parse(line));
    } catch {
      throw new Error('remote_unreachable:the machine answered with something else');
    }
  };
  return { reader, readAnswer, unreachable };
}

function toRefusal(refusal: z.infer<typeof RefusalSchema>): Error {
  const prefix = `${refusal.code}:`;
  return new Error(
    refusal.message.startsWith(prefix) ? refusal.message : `${prefix}${refusal.message}`
  );
}

/**
 * Sends files over a connection the member already answered, and returns the
 * blocks it stored them as, in the order of `files`.
 */
export async function sendLanFiles(
  stream: Duplex,
  options: {
    initial: Buffer;
    sessionId: string;
    /** The machine the blocks have to name. */
    machineId: string;
    files: readonly LanFileToSend[];
    idleTimeoutMs?: number;
  }
): Promise<SessionFilePayload[]> {
  const { readAnswer } = answersOf(stream, options);
  const stored: SessionFilePayload[] = [];
  try {
    for (const file of options.files) {
      const { sizeBytes, sha256 } = await describeFile(file);
      writeLine(stream, {
        type: 'file',
        sessionId: options.sessionId,
        fileName: toStoredFileName(file.fileName),
        sizeBytes,
        sha256,
      });
      const ready = await readAnswer(ReadyAnswerSchema);
      if (ready.type === 'error') throw toRefusal(ready);
      await pipeline(fs.createReadStream(file.path), stream, { end: false });
      const answer = await readAnswer(StoredAnswerSchema);
      if (answer.type === 'error') throw toRefusal(answer);
      const block = answer.file;
      if (
        block.transport !== 'local' ||
        block.machineId !== options.machineId ||
        block.sha256.toLowerCase() !== sha256 ||
        block.sizeBytes !== sizeBytes
      ) {
        throw new Error('remote_unreachable:the machine stored another file than the one sent');
      }
      stored.push(block);
    }
    return stored;
  } finally {
    stream.end();
  }
}

/** Sends the files of a message to the member of a LAN that runs its session. */
export async function sendFilesToLanMember(
  options: LanMemberConnectOptions & {
    sessionId: string;
    files: readonly LanFileToSend[];
  }
): Promise<SessionFilePayload[]> {
  const { socket, rest } = await connectLanMember({ ...options, service: 'files' });
  try {
    return await sendLanFiles(socket, {
      initial: rest,
      sessionId: options.sessionId,
      machineId: options.machineId,
      files: options.files,
    });
  } finally {
    socket.destroy();
  }
}

/** A file a member keeps, as a block names it, and where its bytes go. */
export type LanFileToFetch = {
  sessionId: string;
  fileId: string;
  sizeBytes: number;
  sha256: string;
  /** Created by the fetch; it must not exist yet. */
  destinationPath: string;
};

/**
 * Asks a member that already answered for one file it keeps, and writes it to
 * `destinationPath` once its size and digest are those of the block. A file
 * that arrives otherwise is removed again.
 */
export async function readLanFile(
  stream: Duplex,
  options: LanFileToFetch & { initial: Buffer; idleTimeoutMs?: number }
): Promise<void> {
  const { reader, readAnswer, unreachable } = answersOf(stream, options);
  try {
    writeLine(stream, { type: 'read', sessionId: options.sessionId, fileId: options.fileId });
    const answer = await readAnswer(ContentAnswerSchema);
    if (answer.type === 'error') throw toRefusal(answer);
    if (answer.sizeBytes !== options.sizeBytes) {
      throw new Error('invalid_file:the machine keeps another file under that name');
    }
    const handle = await fs.promises.open(options.destinationPath, 'wx', 0o600);
    let complete = false;
    try {
      const hash = crypto.createHash('sha256');
      try {
        await reader.readBytes(answer.sizeBytes, async (chunk) => {
          hash.update(chunk);
          await handle.write(chunk);
        });
      } catch (error) {
        throw unreachable(error);
      }
      if (hash.digest('hex') !== options.sha256.toLowerCase()) {
        throw new Error('invalid_file:the file arrived damaged');
      }
      complete = true;
    } finally {
      await handle.close();
      if (!complete) await fs.promises.rm(options.destinationPath, { force: true });
    }
  } finally {
    stream.end();
  }
}

/** Fetches one file from the member of a LAN that keeps it. */
export async function fetchFileFromLanMember(
  options: LanMemberConnectOptions & LanFileToFetch
): Promise<void> {
  const { socket, rest } = await connectLanMember({ ...options, service: 'files' });
  try {
    await readLanFile(socket, { ...options, initial: rest });
  } finally {
    socket.destroy();
  }
}

/**
 * Asks a member that already answered for part of a file and passes its answer
 * on to `to` as it arrives: the line that announces the bytes, then the bytes.
 * A refusal is thrown; once the bytes were announced a failure is a
 * `LanFileRangeAborted`, and `to` has part of them.
 */
export async function relayLanFileRange(
  stream: Duplex,
  options: { initial: Buffer; request: LanFileRangeRequest; to: Duplex; idleTimeoutMs?: number }
): Promise<void> {
  const { reader, readAnswer } = answersOf(stream, options);
  try {
    writeLine(stream, options.request);
    const answer = await readAnswer(LanFileRangeAnswerSchema);
    if (answer.type === 'error') throw toRefusal(answer);
    writeLine(options.to, answer);
    try {
      await reader.readBytes(answer.length, async (chunk) => await writeChunk(options.to, chunk));
    } catch (error) {
      throw new LanFileRangeAborted(formatErrorMessage(error), { cause: error });
    }
  } finally {
    stream.end();
  }
}

/** Passes part of a file on from the member of a LAN that has it. */
export async function relayFileRangeFromLanMember(
  options: LanMemberConnectOptions & { request: LanFileRangeRequest; to: Duplex }
): Promise<void> {
  const { socket, rest } = await connectLanMember({ ...options, service: 'files' });
  try {
    await relayLanFileRange(socket, { initial: rest, request: options.request, to: options.to });
  } finally {
    socket.destroy();
  }
}
