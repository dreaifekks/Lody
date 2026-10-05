import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { MachineId, SessionId } from '@lody/shared';
import { LanMemberPorts, MEMBER_PORT_RANGE, type MemberPortConnector } from './lan-member-ports';

const silent = { debug: () => {} };

/** A port of this machine nothing listens on right now. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** What the member's dev server says: it echoes upper-cased, behind the tunnel. */
async function memberServer(): Promise<net.Server> {
  const server = net.createServer((socket) =>
    socket.on('data', (data) => socket.write(data.toString().toUpperCase()))
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

const ask = async (port: number, text: string): Promise<string> =>
  await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    socket.once('data', (data) => {
      resolve(data.toString());
      socket.destroy();
    });
    socket.once('error', reject);
  });

const listens = async (port: number): Promise<boolean> =>
  await new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

describe('ports of this machine that carry a member’s dev server', () => {
  const closing: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closing.splice(0)) await close();
  });

  it('carries the member’s port under its own number while a session previews it', async () => {
    const member = await memberServer();
    closing.push(async () => await new Promise<void>((resolve) => member.close(() => resolve())));
    const asked: string[] = [];
    // Stands in for the tunnel: the member connects to its own port.
    const connect: MemberPortConnector = async (machineId, port, host) => {
      asked.push(`${machineId} ${host}:${port}`);
      return net.connect((member.address() as net.AddressInfo).port, '127.0.0.1');
    };
    const ports = new LanMemberPorts({ logger: silent, connect });
    closing.push(async () => await ports.closeAll());
    const target = { host: 'localhost', port: await freePort() };

    const port = await ports.open('s-1' as SessionId, 'server' as MachineId, target);
    expect(port).toBe(target.port);
    expect(await ask(port, 'hello')).toBe('HELLO');
    expect(asked).toEqual([`server localhost:${target.port}`]);

    // A second session shares the port; it closes once neither previews it.
    expect(await ports.open('s-2' as SessionId, 'server' as MachineId, target)).toBe(port);
    await ports.release('s-1' as SessionId);
    expect(await listens(port)).toBe(true);
    await ports.release('s-2' as SessionId);
    expect(await listens(port)).toBe(false);
  });

  it('picks another port when this machine already uses the member’s number', async () => {
    const span = MEMBER_PORT_RANGE.last - MEMBER_PORT_RANGE.first + 1;
    const taken = net.createServer();
    // Whichever port of the range is free here becomes the taken one: first
    // as the member's own number, then as the first random pick.
    let takenPort = MEMBER_PORT_RANGE.first;
    for (; ; takenPort += 1) {
      const listening = await new Promise<boolean>((resolve) => {
        taken.once('error', () => resolve(false));
        taken.listen(takenPort, '127.0.0.1', () => resolve(true));
      });
      if (listening) break;
    }
    closing.push(async () => await new Promise<void>((resolve) => taken.close(() => resolve())));
    const picks = [(takenPort - MEMBER_PORT_RANGE.first) / span];
    const ports = new LanMemberPorts({
      logger: silent,
      connect: async () => {
        throw new Error('not asked');
      },
      random: () => picks.shift() ?? Math.random(),
    });
    closing.push(async () => await ports.closeAll());

    const port = await ports.open('s-1' as SessionId, 'server' as MachineId, {
      host: 'localhost',
      port: takenPort,
    });
    expect(port).not.toBe(takenPort);
    expect(port).toBeGreaterThanOrEqual(MEMBER_PORT_RANGE.first);
    expect(port).toBeLessThanOrEqual(MEMBER_PORT_RANGE.last);
    expect(picks).toEqual([]);
  });
});
