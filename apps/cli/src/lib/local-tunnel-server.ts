import fs from 'node:fs';
import net from 'node:net';
import { getLocalTunnelSocketPath } from '@lody/shared/node/local-terminal';
import { ensureLocalDaemonRunDir } from '@lody/shared/node/local-ipc';
import type { LanTunnelRequest } from '@/lib/lan/lan-tunnel';
import { serveTunnelRequest } from '@/lib/lan/lan-tunnel';
import { removeStaleUnixSocket } from '@/lib/stale-unix-socket';
import type { Logger } from '@/utils/logger';

/**
 * The local tunnel socket: a program of this machine names a machine and a
 * port, and the agent service connects it there, so the LAN's credential
 * never leaves the agent service.
 */
export class LocalTunnelServer {
  private server: net.Server | null = null;
  private socketPath: string | null = null;
  private readonly sockets = new Set<net.Socket>();

  constructor(
    private readonly options: {
      logger: Logger;
      connect: (request: LanTunnelRequest) => Promise<net.Socket>;
    }
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    ensureLocalDaemonRunDir();
    const socketPath = getLocalTunnelSocketPath();
    await removeStaleUnixSocket(socketPath, 'local_tunnel_socket_in_use');
    const server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      socket.pause();
      void serveTunnelRequest(socket, {
        logger: this.options.logger,
        connect: this.options.connect,
      });
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
      this.options.logger.warn(`[lan-tunnel] local tunnel socket failed: ${error.message}`);
    });
    this.server = server;
    this.socketPath = socketPath;
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
