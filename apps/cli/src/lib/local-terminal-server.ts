import fs from 'node:fs';
import net from 'node:net';
import { getLocalTerminalSocketPath } from '@lody/shared/node/local-terminal';
import { ensureLocalDaemonRunDir } from '@lody/shared/node/local-ipc';
import type { Logger } from '@/utils/logger';
import { serveTerminalConnection, type TerminalService } from '@/lib/terminal-connection';
import { removeStaleUnixSocket } from '@/lib/stale-unix-socket';

export interface LocalTerminalServerConfig {
  logger: Logger;
  terminalService: TerminalService;
}

let terminalServer: net.Server | null = null;
let activeSocketPath: string | null = null;
let terminalServerStart: Promise<void> | null = null;
// Tracks live client connections so shutdown can destroy them immediately.
// `net.Server.close()` only stops accepting new connections and otherwise waits
// for every open connection to end on its own; the Electron terminal relay holds
// a persistent (auto-reconnecting) connection, so without forcibly destroying
// these the listening socket would linger past process exit and block the next
// launch with `local_terminal_socket_in_use`.
const activeClientSockets = new Set<net.Socket>();

export async function startLocalTerminalServer(config: LocalTerminalServerConfig): Promise<void> {
  if (terminalServer) {
    return;
  }
  if (terminalServerStart) {
    return await terminalServerStart;
  }

  terminalServerStart = startLocalTerminalServerInner(config).finally(() => {
    terminalServerStart = null;
  });
  return await terminalServerStart;
}

async function startLocalTerminalServerInner(config: LocalTerminalServerConfig): Promise<void> {
  // The terminal socket lives in the 0700 daemon run dir (S1); make sure the
  // dir exists even when this server starts before the IPC socket servers.
  ensureLocalDaemonRunDir();
  const socketPath = getLocalTerminalSocketPath();
  await removeStaleUnixSocket(socketPath, 'local_terminal_socket_in_use');

  const server = net.createServer((socket) => {
    activeClientSockets.add(socket);
    socket.on('close', () => {
      activeClientSockets.delete(socket);
    });
    serveTerminalConnection(socket, { service: config.terminalService, logger: config.logger });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      terminalServer = server;
      activeSocketPath = socketPath;
      if (process.platform !== 'win32') {
        fs.chmodSync(socketPath, 0o600);
      }
      config.logger.debug(`[terminal] local terminal socket listening at ${socketPath}`);
      resolve();
    });
  });

  server.on('error', (error) => {
    config.logger.warn(`[terminal] local terminal server error: ${error.message}`);
    if (terminalServer === server) {
      terminalServer = null;
      activeSocketPath = null;
    }
    try {
      server.close();
    } catch {
      // already closed
    }
    if (process.platform !== 'win32' && fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  });
}

export async function stopLocalTerminalServer(): Promise<void> {
  if (!terminalServer) {
    return;
  }

  const server = terminalServer;
  const socketPath = activeSocketPath;
  terminalServer = null;
  activeSocketPath = null;

  // Force-close live client connections first. `server.close()` otherwise waits
  // for each one to end on its own, and the Electron relay keeps a persistent
  // connection — so without this the listening socket would linger past shutdown
  // and block the next launch with `local_terminal_socket_in_use`.
  for (const socket of activeClientSockets) {
    socket.destroy();
  }
  activeClientSockets.clear();

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  if (socketPath && process.platform !== 'win32' && fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }
}
