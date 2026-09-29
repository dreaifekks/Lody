import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeSshServer } from '../src/node/ssh-probe';

describe('whether an SSH server answers', () => {
  const servers: net.Server[] = [];

  /** A server on this machine that says `greeting` to whoever connects, then hangs up. */
  const listen = async (greeting: string): Promise<number> => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end(greeting);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('the server has no port');
    return address.port;
  };

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
    );
  });

  it('takes the version an SSH server starts with for an answer', async () => {
    expect(await probeSshServer('127.0.0.1', await listen('SSH-2.0-OpenSSH_9.6\r\n'))).toBe(true);
    expect(
      await probeSshServer('127.0.0.1', await listen('Be welcome.\r\nSSH-2.0-OpenSSH_9.6\r\n'))
    ).toBe(true);
  });

  it('takes nothing else for one', async () => {
    expect(await probeSshServer('127.0.0.1', await listen('HTTP/1.1 400 Bad Request\r\n'))).toBe(
      false
    );
    expect(await probeSshServer('127.0.0.1', await listen('NOSSH-2.0\r\n'))).toBe(false);

    const port = await listen('');
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
    );
    expect(await probeSshServer('127.0.0.1', port)).toBe(false);
  });
});
