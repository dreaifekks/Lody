import net from 'node:net';

const HEARD_MAX = 8 * 1024;

/**
 * Whether an SSH server answers at an address. It is the side that speaks
 * first, and it says its version; nothing is sent to it.
 */
export function probeSshServer(host: string, port: number, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let heard = '';
    const finish = (answers: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answers);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.on('data', (chunk: Buffer) => {
      heard += chunk.toString('latin1');
      // A server may say other lines before the one with its version.
      if (/(?:^|\n)SSH-/u.test(heard)) finish(true);
      else if (heard.length > HEARD_MAX) finish(false);
    });
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}
