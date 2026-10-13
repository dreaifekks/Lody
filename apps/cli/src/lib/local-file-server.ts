import fs from 'node:fs';
import net from 'node:net';
import {
  LocalFileRangeRequestSchema,
  type LocalFileRangeRequest,
} from '@lody/shared/lan-file-range';
import { getLocalFileSocketPath } from '@lody/shared/node/local-terminal';
import { ensureLocalDaemonRunDir } from '@lody/shared/node/local-ipc';
import { readFirstLine, writeLine } from '@/lib/lan/lan-terminal';
import { removeStaleUnixSocket } from '@/lib/stale-unix-socket';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

/**
 * The local file socket: the desktop of this machine asks for part of a file
 * in the first line of a connection and reads the answer from it, so a video
 * plays and a file of any size is saved without passing through a response
 * that holds it whole. The file may be on another machine of a LAN; its
 * credential never leaves the agent service.
 */
export class LocalFileServer {
  private server: net.Server | null = null;
  private socketPath: string | null = null;
  private readonly sockets = new Set<net.Socket>();

  constructor(
    private readonly options: {
      logger: Logger;
      /** Answers on the socket and ends it. */
      serve: (request: LocalFileRangeRequest, socket: net.Socket) => Promise<void>;
      /** Where to listen; the socket of this installation by default. */
      socketPath?: string;
    }
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    const socketPath = this.options.socketPath ?? getLocalFileSocketPath();
    if (!this.options.socketPath) ensureLocalDaemonRunDir();
    await removeStaleUnixSocket(socketPath, 'local_file_socket_in_use');
    const server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      // A desktop that stops reading is reported by whatever was writing to it.
      socket.on('error', () => {});
      void this.answer(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
    server.on('error', (error) => {
      this.options.logger.warn(`[lan-files] local file socket failed: ${error.message}`);
    });
    this.server = server;
    this.socketPath = socketPath;
  }

  private async answer(socket: net.Socket): Promise<void> {
    let line: string;
    try {
      ({ line } = await readFirstLine(socket));
    } catch (error) {
      this.options.logger.debug(`[lan-files] local request failed: ${formatErrorMessage(error)}`);
      socket.destroy();
      return;
    }
    let request: LocalFileRangeRequest;
    try {
      request = LocalFileRangeRequestSchema.parse(JSON.parse(line));
    } catch {
      writeLine(socket, {
        type: 'error',
        code: 'invalid_request',
        message: 'invalid_request:the request cannot be read',
      });
      socket.end();
      return;
    }
    await this.options.serve(request, socket);
  }

  async stop(): Promise<void> {
    const server = this.server;
    const socketPath = this.socketPath;
    this.server = null;
    this.socketPath = null;
    if (!server) return;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (socketPath && process.platform !== 'win32' && fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  }
}
