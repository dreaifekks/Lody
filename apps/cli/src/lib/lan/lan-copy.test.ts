import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConnectionReader,
  copyEntryDestination,
  prepareCopyTarget,
  receiveCopyEntries,
  resolveMachinePath,
  sendCopyEntries,
  statCopySources,
} from './lan-copy';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-copy-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Two ends of a loopback connection. */
async function socketPair(): Promise<[net.Socket, net.Socket]> {
  const server = net.createServer({ pauseOnConnect: true });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const accepted = new Promise<net.Socket>((resolve) => server.once('connection', resolve));
  const client = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
  const other = await accepted;
  server.close();
  cleanups.push(() => {
    client.destroy();
    other.destroy();
  });
  return [client, other];
}

function listTree(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const relative = path.relative(root, path.join(entry.parentPath, entry.name));
      return entry.isDirectory() ? `${relative}/` : relative;
    })
    .sort();
}

describe('the entry stream of lan cp', () => {
  it('carries files, empty files, empty and nested directories whole', async () => {
    const from = tempDir();
    const to = tempDir();
    const big = crypto.randomBytes(3 * 1024 * 1024 + 17);
    fs.mkdirSync(path.join(from, 'site', 'a', 'b'), { recursive: true });
    fs.mkdirSync(path.join(from, 'site', 'empty'));
    fs.writeFileSync(path.join(from, 'site', 'a', 'b', 'big.bin'), big);
    fs.writeFileSync(path.join(from, 'site', 'nothing.txt'), '');
    fs.writeFileSync(path.join(from, 'site', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(from, 'single.txt'), 'one');
    const old = new Date('2020-01-02T03:04:05Z');
    fs.utimesSync(path.join(from, 'single.txt'), old, old);

    const [sender, receiver] = await socketPair();
    const sources = await statCopySources(
      [path.join(from, 'site'), path.join(from, 'single.txt')],
      true
    );
    const [sent, received] = await Promise.all([
      sendCopyEntries(sender, sources),
      receiveCopyEntries(
        new ConnectionReader(receiver),
        { path: to, directory: true },
        { preserveTimes: true }
      ),
    ]);

    expect(received).toEqual({ files: 4, bytes: big.length + 10 + 3, skipped: 0 });
    expect(sent).toEqual(received);
    expect(listTree(to)).toEqual([
      'single.txt',
      'site/',
      'site/a/',
      'site/a/b/',
      'site/a/b/big.bin',
      'site/empty/',
      'site/nothing.txt',
      'site/run.sh',
    ]);
    expect(fs.readFileSync(path.join(to, 'site', 'a', 'b', 'big.bin')).equals(big)).toBe(true);
    expect(fs.readFileSync(path.join(to, 'site', 'nothing.txt'))).toHaveLength(0);
    expect(fs.statSync(path.join(to, 'single.txt')).mtime.toISOString()).toBe(old.toISOString());
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(to, 'site', 'run.sh')).mode & 0o777).toBe(0o755);
    }
  });

  it('takes the name of a target that is no directory, and replaces a file there', async () => {
    const from = tempDir();
    const to = tempDir();
    fs.mkdirSync(path.join(from, 'site'));
    fs.writeFileSync(path.join(from, 'site', 'index.html'), 'new');
    fs.writeFileSync(path.join(from, 'a.bin'), 'fresh');
    fs.writeFileSync(path.join(to, 'b.bin'), 'stale');

    for (const [source, target] of [
      ['site', 'copy'],
      ['a.bin', 'b.bin'],
    ] as const) {
      const [sender, receiver] = await socketPair();
      const sources = await statCopySources([path.join(from, source)], true);
      await Promise.all([
        sendCopyEntries(sender, sources),
        receiveCopyEntries(
          new ConnectionReader(receiver),
          prepareCopyTarget(path.join(to, target), 1),
          { preserveTimes: false }
        ),
      ]);
    }

    expect(listTree(to)).toEqual(['b.bin', 'copy/', 'copy/index.html']);
    expect(fs.readFileSync(path.join(to, 'b.bin'), 'utf8')).toBe('fresh');
  });

  it('copies a link to a file and leaves out one to a directory', async () => {
    if (process.platform === 'win32') return;
    const from = tempDir();
    const to = tempDir();
    fs.mkdirSync(path.join(from, 'site', 'real'), { recursive: true });
    fs.writeFileSync(path.join(from, 'site', 'real', 'a.txt'), 'a');
    fs.symlinkSync(path.join(from, 'site', 'real', 'a.txt'), path.join(from, 'site', 'file-link'));
    fs.symlinkSync(path.join(from, 'site', 'real'), path.join(from, 'site', 'dir-link'));

    const [sender, receiver] = await socketPair();
    const [, received] = await Promise.all([
      sendCopyEntries(sender, await statCopySources([path.join(from, 'site')], true)),
      receiveCopyEntries(
        new ConnectionReader(receiver),
        { path: to, directory: true },
        { preserveTimes: false }
      ),
    ]);

    expect(received.skipped).toBe(1);
    expect(listTree(to)).toEqual(['site/', 'site/file-link', 'site/real/', 'site/real/a.txt']);
    expect(fs.lstatSync(path.join(to, 'site', 'file-link')).isFile()).toBe(true);
  });

  it('refuses entries that would leave the target, before writing anything', async () => {
    const to = tempDir();
    const outside = path.join(path.dirname(to), `${path.basename(to)}-outside`);
    for (const entry of ['../escape', '/etc/passwd', 'a//b', 'a/./b', '']) {
      const [sender, receiver] = await socketPair();
      sender.write(`${JSON.stringify({ type: 'file', path: entry, size: 1, mtimeMs: 0 })}\nx`);
      await expect(
        receiveCopyEntries(
          new ConnectionReader(receiver),
          { path: to, directory: true },
          { preserveTimes: false }
        )
      ).rejects.toThrow(/refused the entry/);
    }
    expect(fs.readdirSync(to)).toEqual([]);
    expect(fs.existsSync(outside)).toBe(false);

    const windows = { path: 'D:\\x', directory: true };
    for (const entry of ['a\\..\\..\\b', 'C:', 'a/b:stream']) {
      expect(() => copyEntryDestination(windows, entry, path.win32)).toThrow(/refused/);
    }
    expect(copyEntryDestination(windows, 'a/b.txt', path.win32)).toBe('D:\\x\\a\\b.txt');
    // `\` and `:` are ordinary on POSIX.
    expect(copyEntryDestination({ path: '/x', directory: true }, 'a:b\\c', path.posix)).toBe(
      '/x/a:b\\c'
    );
  });

  it('leaves no partial file when the connection breaks in the middle of one', async () => {
    const to = tempDir();
    const [sender, receiver] = await socketPair();
    const receiving = receiveCopyEntries(
      new ConnectionReader(receiver),
      { path: to, directory: true },
      { preserveTimes: false }
    );
    sender.write(`${JSON.stringify({ type: 'dir', path: 'site', mtimeMs: 0 })}\n`);
    sender.write(
      `${JSON.stringify({ type: 'file', path: 'site/a.bin', size: 1000, mtimeMs: 0 })}\n`
    );
    sender.end(Buffer.alloc(400));

    await expect(receiving).rejects.toThrow(/closed before the copy finished/);
    expect(listTree(to)).toEqual(['site/']);
  });

  it('stops at an error the sender reports', async () => {
    const to = tempDir();
    const [sender, receiver] = await socketPair();
    sender.write(`${JSON.stringify({ type: 'error', message: 'EACCES: permission denied' })}\n`);

    await expect(
      receiveCopyEntries(
        new ConnectionReader(receiver),
        { path: to, directory: true },
        { preserveTimes: false }
      )
    ).rejects.toThrow('EACCES: permission denied');
  });
});

describe('paths of lan cp', () => {
  it('reads ~ and relative paths from the home of the machine that holds them', () => {
    const posix = { home: '/home/me', paths: path.posix };
    expect(resolveMachinePath('~', posix)).toBe('/home/me');
    expect(resolveMachinePath('', posix)).toBe('/home/me');
    expect(resolveMachinePath('~/x/a.bin', posix)).toBe('/home/me/x/a.bin');
    expect(resolveMachinePath('x', posix)).toBe('/home/me/x');
    expect(resolveMachinePath('/srv/x', posix)).toBe('/srv/x');

    const windows = { home: 'C:\\Users\\me', paths: path.win32 };
    expect(resolveMachinePath('~/Desktop/', windows)).toBe('C:\\Users\\me\\Desktop');
    expect(resolveMachinePath('~\\Desktop', windows)).toBe('C:\\Users\\me\\Desktop');
    expect(resolveMachinePath('D:\\code\\x', windows)).toBe('D:\\code\\x');
    expect(resolveMachinePath('D:/code/x', windows)).toBe('D:\\code\\x');
  });

  it('puts several sources only into a directory, and needs the parent of a new path', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'file'), '');
    expect(prepareCopyTarget(dir, 2)).toEqual({ path: dir, directory: true });
    expect(prepareCopyTarget(path.join(dir, 'new'), 1)).toEqual({
      path: path.join(dir, 'new'),
      directory: false,
    });
    expect(() => prepareCopyTarget(path.join(dir, 'file'), 2)).toThrow(/is not a directory/);
    expect(() => prepareCopyTarget(path.join(dir, 'missing', 'new'), 1)).toThrow(
      /is not a directory/
    );
    await expect(statCopySources([dir], false)).rejects.toThrow(/copy it with -r/);
    await expect(statCopySources([path.join(dir, 'missing')], false)).rejects.toThrow(/ENOENT/);
  });
});
