import net from 'node:net';
import type { MachineId, SessionId } from '@lody/shared';
import { getLocalTunnelSocketPath } from '@lody/shared/node/local-terminal';
import { joinSockets, requestTunnel } from '@/lib/lan/lan-tunnel';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

/** A connection to a port another member reaches, as that member reaches it. */
export type MemberPortConnector = (
  machineId: MachineId,
  port: number,
  host: string
) => Promise<net.Socket>;

/** Through this agent service's own tunnel socket, the way `lan forward` connects. */
export const connectMemberPortThroughLocalTunnel: MemberPortConnector = async (
  machineId,
  port,
  host
) => {
  const socket = net.connect(getLocalTunnelSocketPath());
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.pause();
    return await requestTunnel(socket, { port, host, machineId });
  } catch (error) {
    socket.destroy();
    throw error;
  }
};

/** Ports a carrying port is chosen from, at random, when the member's own number is taken here. */
export const MEMBER_PORT_RANGE = { first: 10_000, last: 19_999 } as const;
const MEMBER_PORT_ATTEMPTS = 20;

type Forward = { server: net.Server; port: number; sessions: Set<SessionId> };

/**
 * Loopback ports of this machine that carry every connection to the dev
 * server of a session another member of the LAN runs. The preview of such a
 * session proxies one as it proxies a port of this machine. Each keeps the
 * number of the port it carries when this machine has it free, so addresses
 * a page spells out still lead there; otherwise it is a free port between
 * 10000 and 19999. It stays open while a session previews through it.
 */
export class LanMemberPorts {
  private readonly forwards = new Map<string, Promise<Forward>>();

  constructor(
    private readonly options: {
      logger: Pick<Logger, 'debug'>;
      connect?: MemberPortConnector;
      random?: () => number;
    }
  ) {}

  /** Carries `host:port` of the member to a port of this machine's loopback, which it returns. */
  async open(
    sessionId: SessionId,
    machineId: MachineId,
    target: { host: string; port: number }
  ): Promise<number> {
    const key = `${machineId}\n${target.host}\n${target.port}`;
    // A session previews one target at a time.
    await this.release(sessionId, key);
    let forward = this.forwards.get(key);
    if (!forward) {
      forward = this.listen(machineId, target);
      this.forwards.set(key, forward);
      forward.catch(() => this.forwards.delete(key));
    }
    const opened = await forward;
    opened.sessions.add(sessionId);
    return opened.port;
  }

  /** Ends what a session no longer previews through, except the port `keep`. */
  async release(sessionId: SessionId, keep?: string): Promise<void> {
    for (const [key, pending] of [...this.forwards]) {
      if (key === keep) continue;
      const forward = await pending.catch(() => null);
      if (!forward?.sessions.delete(sessionId) || forward.sessions.size > 0) continue;
      this.forwards.delete(key);
      forward.server.close();
    }
  }

  async closeAll(): Promise<void> {
    const forwards = [...this.forwards.values()];
    this.forwards.clear();
    for (const pending of forwards) (await pending.catch(() => null))?.server.close();
  }

  private async listen(
    machineId: MachineId,
    target: { host: string; port: number }
  ): Promise<Forward> {
    const connect = this.options.connect ?? connectMemberPortThroughLocalTunnel;
    const server = net.createServer({ pauseOnConnect: true }, (client) => {
      connect(machineId, target.port, target.host).then(
        (upstream) => joinSockets(client, upstream),
        (error: unknown) => {
          this.options.logger.debug(
            `[preview] ${machineId} did not carry port ${target.port}: ${formatErrorMessage(error)}`
          );
          client.destroy();
        }
      );
    });
    const random = this.options.random ?? Math.random;
    const span = MEMBER_PORT_RANGE.last - MEMBER_PORT_RANGE.first + 1;
    for (let attempt = 0; ; attempt += 1) {
      const port =
        attempt === 0 ? target.port : MEMBER_PORT_RANGE.first + Math.floor(random() * span);
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
          });
        });
        return { server, port, sessions: new Set() };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // A port below 1024 is refused to an ordinary user rather than taken.
        if (code !== 'EADDRINUSE' && !(attempt === 0 && code === 'EACCES')) throw error;
        if (attempt >= MEMBER_PORT_ATTEMPTS)
          throw new Error('No free port between 10000 and 19999 on this machine', {
            cause: error,
          });
      }
    }
  }
}
