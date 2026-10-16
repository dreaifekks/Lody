import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore, type WorkspaceSummary } from '@lody/platform';
import type {
  LocalSessionControlResponse,
  MachineId,
  MachineMeta,
  SessionFilePayload,
  SessionFileReadLocalRequest,
  SessionFileSendLocalRequest,
  SessionId,
  SessionMeta,
  WorkspaceId,
} from '@lody/shared';
import { normalizeBoardMeta } from '@lody/shared';
import {
  LanFileRangeAnswerSchema,
  type LanFileRangeAnswer,
  type LocalFileRangeRequest,
} from '@lody/shared/lan-file-range';
import { getLanHubWorkspaceId } from '@lody/shared/lan-hub';
import type { LanTerminalEndpoint } from '@lody/shared/lan-terminal';
import { addLanHub, type LanHub } from '@lody/shared/node/lan-hub';
import { BoardDirectory } from '@/lib/board-directory';
import { LocalFileServer } from '@/lib/local-file-server';
import { getSessionFileBlobPath } from '@/lib/session-file-blob-store';
import type { Logger } from '@/utils/logger';
import { LanFileHandoff, type LanFileWorkspace } from './lan-file-handoff';
import { sendFilesToLanMember, toStoredFileName } from './lan-files';
import { connectLanMember, deriveLanTerminalKey } from './lan-terminal';
import { LanTerminalHost } from './lan-terminal-host';

const silentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  setDebug: () => {},
  child: () => silentLogger(),
  close: async () => {},
});

const lanHub = (name: string, token: string): LanHub =>
  addLanHub([], { name, url: 'http://127.0.0.1:8788', token }).hub;

const home = lanHub('Home', 'home-credential');
const office = lanHub('Office', 'office-credential');
const HOME = getLanHubWorkspaceId(home.id);

const SERVER = 'server-machine' as MachineId;
const CLIENT = 'client-machine' as MachineId;

const sha256 = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');

type StoredFile = { sessionId: string; fileName: string; bytes: Buffer };

/**
 * The workspace of the Home LAN on the server machine: it keeps what it is
 * handed in memory and answers as the agent service does.
 */
function serverWorkspace(sessions: Record<string, Partial<SessionMeta> | 'deleted'>) {
  const stored: StoredFile[] = [];
  const workspace: LanFileWorkspace = {
    lookupSession: async (sessionId) => {
      const session = sessions[sessionId];
      if (!session) return { type: 'missing' };
      if (session === 'deleted') return { type: 'deleted' };
      return { type: 'found', meta: { id: sessionId, ...session } as SessionMeta };
    },
    readMachine: async () => undefined,
    storeLocally: async (request: SessionFileSendLocalRequest) => {
      const filePath = request.paths[0]!;
      const bytes = fs.readFileSync(filePath);
      const fileName = path.basename(filePath);
      stored.push({ sessionId: request.sessionId, fileName, bytes });
      const file: SessionFilePayload = {
        type: 'file',
        fileId: `file-${stored.length}`,
        fileName,
        mimeType: 'application/octet-stream',
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
        textPreview: false,
        transport: 'local',
        machineId: SERVER,
        uploadedAt: 1,
      };
      return [
        {
          type: 'session/file-send-local_response',
          sessionId: request.sessionId,
          workspaceId: request.workspaceId,
          success: true,
          files: [file],
        },
      ] as LocalSessionControlResponse[];
    },
  };
  return { workspace, stored };
}

describe('files between LAN members', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-files-test-'));
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  /** Where a machine of the test keeps the files of its sessions. */
  const keptPath: typeof getSessionFileBlobPath = (args) =>
    getSessionFileBlobPath({ ...args, homeDir: path.join(scratch, 'kept') });

  const keep = (sessionId: string, fileId: string, bytes: Buffer): void => {
    const filePath = keptPath({ workspaceId: HOME, sessionId, fileId });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, bytes);
  };

  const writeFile = (name: string, bytes: Buffer): string => {
    const directory = fs.mkdtempSync(path.join(scratch, 'file-'));
    const filePath = path.join(directory, name);
    fs.writeFileSync(filePath, bytes);
    return filePath;
  };

  /** The server machine: a member of Home that runs the sessions named. */
  async function startServer(
    sessions: Record<string, Partial<SessionMeta> | 'deleted'> = {},
    options: {
      takesFiles?: boolean;
      resolvePath?: (workspaceId: string, sessionId: string, filePath: string) => Promise<string>;
    } = {}
  ) {
    const { workspace, stored } = serverWorkspace(sessions);
    const handoff = new LanFileHandoff({
      machineId: SERVER,
      logger: silentLogger(),
      hubs: () => [home],
      workspace: (workspaceId) => (workspaceId === HOME ? workspace : null),
      localSessions: (workspaceId) => (workspaceId === HOME ? workspace.lookupSession : null),
      keptPath,
      ...(options.resolvePath ? { resolvePath: options.resolvePath } : {}),
    });
    const published = new Map<string, LanTerminalEndpoint | undefined>();
    const host = new LanTerminalHost({
      machineId: SERVER,
      logger: silentLogger(),
      lans: { hubs: [home], workspaces: createStore<readonly WorkspaceSummary[]>([]) },
      port: 0,
      probeAddress: async () => '127.0.0.1',
      serviceFor: () => null,
      ...(options.takesFiles === false
        ? {}
        : { filesFor: (workspaceId: string) => handoff.receiverFor(workspaceId) }),
      publish: async (workspaceId, endpoint) => {
        published.set(workspaceId, endpoint);
      },
    });
    cleanups.push(() => host.close());
    await host.refresh();
    const endpoint = published.get(HOME);
    if (!endpoint) throw new Error('the server published no endpoint');
    return { endpoint, stored, handoff };
  }

  /** The client machine: a member that sends what its desktop handed it. */
  function startClient(
    endpoint: LanTerminalEndpoint | undefined,
    options: { hubs?: LanHub[]; capabilities?: MachineMeta['protocolCapabilities'] } = {}
  ) {
    const workspace: LanFileWorkspace = {
      lookupSession: async () => ({ type: 'missing' }),
      readMachine: async () =>
        ({
          id: SERVER,
          name: 'devbox',
          protocolCapabilities: options.capabilities ?? { lanFiles: 1 },
          ...(endpoint ? { lanTerminal: endpoint } : {}),
        }) as MachineMeta,
      storeLocally: async () => {
        throw new Error('the client stores nothing for another machine');
      },
    };
    return new LanFileHandoff({
      machineId: CLIENT,
      logger: silentLogger(),
      hubs: () => options.hubs ?? [home],
      workspace: (workspaceId) => (workspaceId === HOME ? workspace : null),
      localSessions: () => null,
    });
  }

  const request = (
    paths: string[],
    sessionId = 'home-session'
  ): SessionFileSendLocalRequest & { targetMachineId: MachineId } => ({
    type: 'session/file-send-local',
    machineId: CLIENT,
    targetMachineId: SERVER,
    sessionId: sessionId as SessionId,
    workspaceId: HOME as WorkspaceId,
    paths,
  });

  it('takes the files of a message to the machine that runs its session', async () => {
    const { endpoint, stored } = await startServer({ 'home-session': { machineId: SERVER } });
    const picture = crypto.randomBytes(300_000);
    const notes = Buffer.from('第一行\nsecond line\n', 'utf8');

    const response = await startClient(endpoint).send(
      request([writeFile('screenshot.png', picture), writeFile('笔记.txt', notes)])
    );

    expect(response).toMatchObject({ success: true, sessionId: 'home-session' });
    expect(response.files).toMatchObject([
      {
        fileName: 'screenshot.png',
        transport: 'local',
        machineId: SERVER,
        sha256: sha256(picture),
      },
      { fileName: '笔记.txt', transport: 'local', machineId: SERVER, sha256: sha256(notes) },
    ]);
    expect(stored.map((file) => [file.sessionId, file.fileName])).toEqual([
      ['home-session', 'screenshot.png'],
      ['home-session', '笔记.txt'],
    ]);
    expect(stored[0]?.bytes.equals(picture)).toBe(true);
    expect(stored[1]?.bytes.equals(notes)).toBe(true);
  });

  it('takes the files of a conversation its first message is about to create', async () => {
    const { endpoint, stored } = await startServer({});

    const response = await startClient(endpoint).send(
      request([writeFile('draft.txt', Buffer.from('hello'))], 'not-created-yet')
    );

    expect(response.success).toBe(true);
    expect(stored.map((file) => file.sessionId)).toEqual(['not-created-yet']);
  });

  it.each([
    ['a session of another machine', { machineId: CLIENT }, 'session_machine_mismatch'],
    ['an archived session', { machineId: SERVER, isArchived: true }, 'session_archived'],
    ['a deleted session', 'deleted' as const, 'session_deleted'],
  ])('refuses %s before its bytes travel', async (_name, session, code) => {
    const { endpoint, stored } = await startServer({ 'home-session': session });

    const response = await startClient(endpoint).send(
      request([writeFile('large.bin', crypto.randomBytes(2_000_000))])
    );

    expect(response).toMatchObject({ success: false, error: code });
    expect(response.message).toContain('devbox did not take the files');
    expect(stored).toEqual([]);
  });

  it('does not ask a machine that says nothing about files or publishes no endpoint', async () => {
    const { endpoint, stored } = await startServer({});
    const file = writeFile('a.txt', Buffer.from('a'));

    const silent = await startClient(endpoint, { capabilities: { lanControl: 1 } }).send(
      request([file])
    );
    const closed = await startClient(undefined).send(request([file]));

    for (const response of [silent, closed]) {
      expect(response).toMatchObject({ success: false, error: 'remote_unreachable' });
      expect(response.message).toContain('devbox takes no files');
    }
    expect(stored).toEqual([]);
  });

  it('reports a member whose listener serves terminals only', async () => {
    const { endpoint, stored } = await startServer({}, { takesFiles: false });

    const response = await startClient(endpoint).send(
      request([writeFile('a.txt', Buffer.from('a'))])
    );

    expect(response).toMatchObject({ success: false, error: 'remote_unreachable' });
    expect(response.message).toContain('serves no files');
    expect(stored).toEqual([]);
  });

  it('reports a member of a build from before files, which answers every hello alike', async () => {
    const key = deriveLanTerminalKey(home.token);
    const received: string[] = [];
    const old = tls.createServer(
      {
        ciphers: 'ECDHE-PSK-CHACHA20-POLY1305',
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
        pskCallback: (_socket, identity) => (identity === home.id ? key : null),
      },
      (socket) => {
        socket.once('data', (chunk: Buffer) => {
          received.push(chunk.toString('utf8'));
          socket.write(`${JSON.stringify({ type: 'hello', version: 1, machineId: SERVER })}\n`);
        });
        socket.on('error', () => {});
      }
    );
    await new Promise<void>((resolve) => old.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => old.close(() => resolve())));
    const { port } = old.address() as { port: number };

    const response = await startClient({ version: 1, host: '127.0.0.1', port }).send(
      request([writeFile('a.txt', Buffer.from('never sent'))])
    );

    expect(response).toMatchObject({ success: false, error: 'remote_unreachable' });
    expect(response.message).toContain('update it');
    // Only the hello reached it: nothing it could take for terminal input.
    expect(received.join('')).not.toContain('never sent');
    expect(received.join('').trim().split('\n')).toHaveLength(1);
  });

  it('refuses a machine that does not hold the credential of the LAN', async () => {
    const { endpoint, stored } = await startServer({});
    const file = writeFile('a.txt', Buffer.from('a'));

    await expect(
      sendFilesToLanMember({
        endpoint,
        lanId: home.id,
        key: deriveLanTerminalKey('guessed-credential'),
        machineId: SERVER,
        sessionId: 'home-session',
        files: [{ path: file, fileName: 'a.txt' }],
      })
    ).rejects.toThrow(/^remote_unreachable:/);
    await expect(
      sendFilesToLanMember({
        endpoint,
        lanId: office.id,
        key: deriveLanTerminalKey(office.token),
        machineId: SERVER,
        sessionId: 'home-session',
        files: [{ path: file, fileName: 'a.txt' }],
      })
    ).rejects.toThrow(/^remote_unreachable:/);
    expect(stored).toEqual([]);
  });

  it('answers that no LAN reaches the machine for a workspace that is not one', async () => {
    const { endpoint } = await startServer({});

    const response = await startClient(endpoint, { hubs: [office] }).send(
      request([writeFile('a.txt', Buffer.from('a'))])
    );

    expect(response).toMatchObject({ success: false, error: 'remote_unreachable' });
    expect(response.message).toContain('no LAN of this machine reaches it');
  });

  describe('reading a file another member keeps', () => {
    const readRequest = (
      bytes: Buffer,
      overrides: Partial<SessionFileReadLocalRequest> = {}
    ): SessionFileReadLocalRequest => ({
      type: 'session/file-read-local',
      machineId: CLIENT,
      targetMachineId: SERVER,
      sessionId: 'home-session' as SessionId,
      workspaceId: HOME as WorkspaceId,
      fileId: 'file-picture',
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
      destinationPath: path.join(fs.mkdtempSync(path.join(scratch, 'read-')), 'picture.png'),
      ...overrides,
    });

    it('writes the bytes the member keeps where the desktop asked', async () => {
      const picture = crypto.randomBytes(3_000_000);
      keep('home-session', 'file-picture', picture);
      const { endpoint } = await startServer({ 'home-session': { machineId: SERVER } });
      const asked = readRequest(picture);

      const response = await startClient(endpoint).read(asked);

      expect(response).toMatchObject({ success: true, sessionId: 'home-session' });
      expect(fs.readFileSync(asked.destinationPath).equals(picture)).toBe(true);
    });

    it('reads a file this machine keeps without a LAN', async () => {
      const picture = crypto.randomBytes(1000);
      keep('home-session', 'file-picture', picture);
      const { handoff } = await startServer({ 'home-session': { machineId: SERVER } });
      const asked = readRequest(picture, { machineId: SERVER, targetMachineId: undefined });

      const response = await handoff.read(asked);

      expect(response.success).toBe(true);
      expect(fs.readFileSync(asked.destinationPath).equals(picture)).toBe(true);
    });

    it.each([
      ['a deleted session', 'deleted' as const, 'file-picture', 'session_deleted'],
      ['a file it does not keep', { machineId: SERVER }, 'file-other', 'file_not_found'],
      ['a name that leaves the store', { machineId: SERVER }, '..', 'invalid_request'],
    ])('refuses %s and leaves nothing behind', async (_name, session, fileId, code) => {
      const picture = crypto.randomBytes(1000);
      keep('home-session', 'file-picture', picture);
      const { endpoint } = await startServer({ 'home-session': session });
      const asked = readRequest(picture, { fileId });

      const response = await startClient(endpoint).read(asked);

      expect(response).toMatchObject({ success: false, error: code });
      expect(response.message).toContain('devbox');
      expect(fs.existsSync(asked.destinationPath)).toBe(false);
    });

    it('refuses bytes that are not those of the block, remote or local', async () => {
      const picture = crypto.randomBytes(1000);
      keep('home-session', 'file-picture', picture);
      const { endpoint, handoff } = await startServer({ 'home-session': { machineId: SERVER } });
      const other = crypto.randomBytes(1000);

      const remote = readRequest(picture, { sha256: sha256(other) });
      const local = readRequest(picture, {
        machineId: SERVER,
        targetMachineId: undefined,
        sha256: sha256(other),
      });
      const resized = readRequest(picture, { sizeBytes: 999 });

      expect(await startClient(endpoint).read(remote)).toMatchObject({ error: 'invalid_file' });
      expect(await handoff.read(local)).toMatchObject({ error: 'invalid_file' });
      expect(await startClient(endpoint).read(resized)).toMatchObject({ error: 'invalid_file' });
      for (const asked of [remote, local, resized]) {
        expect(fs.existsSync(asked.destinationPath)).toBe(false);
      }
    });

    it('does not ask a machine that says nothing about files', async () => {
      const picture = crypto.randomBytes(10);
      const { endpoint } = await startServer({});

      const response = await startClient(endpoint, { capabilities: { lanControl: 1 } }).read(
        readRequest(picture)
      );

      expect(response).toMatchObject({ success: false, error: 'remote_unreachable' });
      expect(response.message).toContain('devbox gives no files');
    });
  });

  describe('reading part of a file', () => {
    const RANGES = { lanFiles: 1, lanFileRanges: 1 };

    /** The local file socket of a machine, as its desktop connects to it. */
    async function desktopOf(handoff: LanFileHandoff) {
      const socketPath = path.join(fs.mkdtempSync(path.join(scratch, 'desktop-')), 'files.sock');
      const server = new LocalFileServer({
        logger: silentLogger(),
        socketPath,
        serve: async (asked, socket) => await handoff.range(asked, socket),
      });
      await server.start();
      cleanups.push(() => server.stop());
      return socketPath;
    }

    const rangeRequest = (
      overrides: Partial<LocalFileRangeRequest> = {}
    ): LocalFileRangeRequest => ({
      type: 'range',
      workspaceId: HOME,
      machineId: SERVER,
      sessionId: 'home-session',
      offset: 0,
      ...(overrides.path === undefined ? { fileId: 'file-clip' } : {}),
      ...overrides,
    });

    /**
     * Asks as a desktop does and reads to the end of the connection.
     * `afterFirstBytes` runs once the answer and the first bytes of the file
     * arrived, before any more of them is read.
     */
    async function ask(
      socketPath: string,
      asked: LocalFileRangeRequest,
      afterFirstBytes?: (socket: net.Socket) => void
    ): Promise<{ answer: LanFileRangeAnswer; body: Buffer }> {
      const socket = net.connect(socketPath);
      cleanups.push(() => socket.destroy());
      socket.write(`${JSON.stringify(asked)}\n`);
      let line: string | null = null;
      let pending = Buffer.alloc(0);
      const body: Buffer[] = [];
      let paused = afterFirstBytes;
      for await (const chunk of socket as AsyncIterable<Buffer>) {
        if (line === null) {
          pending = Buffer.concat([pending, chunk]);
          const newline = pending.indexOf(0x0a);
          if (newline < 0) continue;
          line = pending.subarray(0, newline).toString('utf8');
          body.push(pending.subarray(newline + 1));
        } else {
          body.push(chunk);
        }
        if (paused && body.some((part) => part.length > 0)) {
          paused(socket);
          paused = undefined;
        }
      }
      if (line === null) throw new Error('the agent service gave no answer');
      return {
        answer: LanFileRangeAnswerSchema.parse(JSON.parse(line)),
        body: Buffer.concat(body),
      };
    }

    it('gives the part of a kept file that was asked for, from another member', async () => {
      const clip = crypto.randomBytes(1_500_000);
      keep('home-session', 'file-clip', clip);
      const { endpoint } = await startServer({ 'home-session': { machineId: SERVER } });
      const desktop = await desktopOf(startClient(endpoint, { capabilities: RANGES }));

      const whole = await ask(desktop, rangeRequest());
      const middle = await ask(desktop, rangeRequest({ offset: 700_000, length: 200_000 }));
      const tail = await ask(desktop, rangeRequest({ offset: 1_400_000, length: 500_000 }));
      const size = await ask(desktop, rangeRequest({ length: 0 }));

      expect(whole.answer).toMatchObject({ type: 'range', sizeBytes: clip.length });
      expect(whole.body.equals(clip)).toBe(true);
      expect(middle.answer).toMatchObject({ sizeBytes: clip.length, length: 200_000 });
      expect(middle.body.equals(clip.subarray(700_000, 900_000))).toBe(true);
      // A range that reaches past the end stops there.
      expect(tail.answer).toMatchObject({ length: 100_000 });
      expect(tail.body.equals(clip.subarray(1_400_000))).toBe(true);
      expect(size.answer).toMatchObject({ sizeBytes: clip.length, length: 0 });
      expect(size.body.length).toBe(0);
    });

    it('gives a file by its path where the member resolves it, and tells a refusal', async () => {
      const video = crypto.randomBytes(300_000);
      const videoPath = writeFile('demo.mp4', video);
      const { endpoint } = await startServer(
        { 'home-session': { machineId: SERVER } },
        {
          resolvePath: async (_workspaceId, sessionId, filePath) => {
            if (sessionId !== 'home-session' || filePath !== 'out/demo.mp4') {
              throw new Error('path_not_allowed:File is outside the workspace');
            }
            return videoPath;
          },
        }
      );
      const desktop = await desktopOf(startClient(endpoint, { capabilities: RANGES }));

      const part = await ask(desktop, rangeRequest({ path: 'out/demo.mp4', offset: 100_000 }));
      const refused = await ask(desktop, rangeRequest({ path: '/etc/passwd' }));

      expect(part.answer).toMatchObject({ type: 'range', sizeBytes: video.length });
      expect(part.body.equals(video.subarray(100_000))).toBe(true);
      expect(refused.answer).toMatchObject({ type: 'error', code: 'path_not_allowed' });
      expect(refused.body.length).toBe(0);
    });

    it('refuses an offset past the end, and a file the session does not keep', async () => {
      keep('home-session', 'file-clip', crypto.randomBytes(1000));
      const { endpoint } = await startServer({ 'home-session': { machineId: SERVER } });
      const desktop = await desktopOf(startClient(endpoint, { capabilities: RANGES }));

      const atEnd = await ask(desktop, rangeRequest({ offset: 1000 }));
      const past = await ask(desktop, rangeRequest({ offset: 1001 }));
      const missing = await ask(desktop, rangeRequest({ fileId: 'file-other' }));

      expect(atEnd.answer).toMatchObject({ type: 'range', sizeBytes: 1000, length: 0 });
      expect(past.answer).toMatchObject({ type: 'error', code: 'invalid_range' });
      expect(missing.answer).toMatchObject({ type: 'error', code: 'file_not_found' });
    });

    it('refuses the next part of a file that became another one', async () => {
      keep('home-session', 'file-clip', crypto.randomBytes(1000));
      const { endpoint } = await startServer({ 'home-session': { machineId: SERVER } });
      const desktop = await desktopOf(startClient(endpoint, { capabilities: RANGES }));

      const first = await ask(desktop, rangeRequest({ length: 500 }));
      if (first.answer.type !== 'range') throw new Error('the first part was refused');
      const { revision } = first.answer;
      const same = await ask(desktop, rangeRequest({ offset: 500, revision }));
      keep('home-session', 'file-clip', crypto.randomBytes(2000));
      const changed = await ask(desktop, rangeRequest({ offset: 500, revision }));

      expect(same.answer).toMatchObject({ type: 'range', length: 500, revision });
      expect(changed.answer).toMatchObject({ type: 'error', code: 'file_changed' });
    });

    it('refuses the next part of a file written over in place under its size and time', async () => {
      const filePath = keptPath({
        workspaceId: HOME,
        sessionId: 'home-session',
        fileId: 'file-clip',
      });
      const written = 1_700_000_000;
      keep('home-session', 'file-clip', Buffer.alloc(1000, 'A'));
      fs.utimesSync(filePath, written, written);
      const before = fs.statSync(filePath);
      const { endpoint } = await startServer({ 'home-session': { machineId: SERVER } });
      const desktop = await desktopOf(startClient(endpoint, { capabilities: RANGES }));

      const first = await ask(desktop, rangeRequest({ length: 500 }));
      if (first.answer.type !== 'range') throw new Error('the first part was refused');
      // Only the change time tells such a file from the one it was, and that
      // moves with the clock: the file is written until it has moved.
      do {
        fs.writeFileSync(filePath, Buffer.alloc(1000, 'B'));
        fs.utimesSync(filePath, written, written);
      } while (fs.statSync(filePath).ctimeMs === before.ctimeMs);
      const after = fs.statSync(filePath);
      const next = await ask(
        desktop,
        rangeRequest({ offset: 500, revision: first.answer.revision })
      );

      expect([after.ino, after.size, after.mtimeMs]).toEqual([
        before.ino,
        before.size,
        before.mtimeMs,
      ]);
      expect(first.body.equals(Buffer.alloc(500, 'A'))).toBe(true);
      expect(next.answer).toMatchObject({ type: 'error', code: 'file_changed' });
      expect(next.body.length).toBe(0);
    });

    it('lets go of the member when the desktop leaves while the member is silent', async () => {
      const key = deriveLanTerminalKey(home.token);
      let left: () => void = () => {};
      const memberLeft = new Promise<void>((resolve) => (left = resolve));
      // A member that announces a part and sends only its first bytes.
      const silent = tls.createServer(
        {
          ciphers: 'ECDHE-PSK-CHACHA20-POLY1305',
          minVersion: 'TLSv1.2',
          maxVersion: 'TLSv1.2',
          pskCallback: (_socket, identity) => (identity === home.id ? key : null),
        },
        (socket) => {
          let lines = 0;
          socket.on('error', () => {});
          socket.once('close', left);
          socket.on('data', () => {
            lines += 1;
            socket.write(
              lines === 1
                ? `${JSON.stringify({ type: 'hello', version: 1, machineId: SERVER, service: 'files' })}\n`
                : `${JSON.stringify({ type: 'range', sizeBytes: 1000, length: 1000, revision: 'r1' })}\nfirst bytes`
            );
          });
        }
      );
      await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()));
      cleanups.push(() => new Promise<void>((resolve) => silent.close(() => resolve())));
      const { port } = silent.address() as { port: number };
      const desktop = await desktopOf(
        startClient({ version: 1, host: '127.0.0.1', port }, { capabilities: RANGES })
      );

      const asked = ask(desktop, rangeRequest(), (socket) => socket.destroy()).catch(() => null);

      await memberLeft;
      await asked;
    });

    it('breaks off a part whose file changes while it travels', async () => {
      // Larger than every buffer between the file and the desktop holds, so the
      // member is still reading when the desktop has its first bytes.
      const size = 64 * 1024 * 1024;
      const filePath = keptPath({
        workspaceId: HOME,
        sessionId: 'home-session',
        fileId: 'file-clip',
      });
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.closeSync(fs.openSync(filePath, 'w'));
      fs.truncateSync(filePath, size);
      const { endpoint } = await startServer({ 'home-session': { machineId: SERVER } });
      const desktop = await desktopOf(startClient(endpoint, { capabilities: RANGES }));

      const cut = await ask(desktop, rangeRequest(), () => fs.truncateSync(filePath, 1024));

      expect(cut.answer).toMatchObject({ type: 'range', sizeBytes: size, length: size });
      expect(cut.body.length).toBeGreaterThan(0);
      expect(cut.body.length).toBeLessThan(size);
    });

    it('does not ask a member that says nothing about parts of files', async () => {
      keep('home-session', 'file-clip', crypto.randomBytes(1000));
      const { endpoint } = await startServer({ 'home-session': { machineId: SERVER } });
      const desktop = await desktopOf(startClient(endpoint));

      const { answer, body } = await ask(desktop, rangeRequest());

      expect(answer).toMatchObject({ type: 'error', code: 'unsupported' });
      expect(answer.type === 'error' && answer.message).toContain('devbox gives no part of a file');
      expect(body.length).toBe(0);
    });

    it('gives a file this machine keeps without a LAN, and none of a workspace it cannot reach', async () => {
      const clip = crypto.randomBytes(5000);
      keep('home-session', 'file-clip', clip);
      const { handoff } = await startServer({ 'home-session': { machineId: SERVER } });
      const desktop = await desktopOf(handoff);

      const own = await ask(desktop, rangeRequest({ offset: 4000 }));
      const elsewhere = await ask(desktop, rangeRequest({ machineId: CLIENT }));
      const unknown = await ask(
        desktop,
        rangeRequest({ workspaceId: 'lw_other', machineId: CLIENT })
      );

      expect(own.body.equals(clip.subarray(4000))).toBe(true);
      // The client machine publishes no endpoint in this workspace.
      expect(elsewhere.answer).toMatchObject({ type: 'error', code: 'unsupported' });
      expect(unknown.answer).toMatchObject({ type: 'error', code: 'remote_unreachable' });
    });

    it('refuses a request the socket cannot read', async () => {
      const { handoff } = await startServer({});
      const desktop = await desktopOf(handoff);

      const both = await ask(desktop, rangeRequest({ path: 'a.mp4', fileId: 'file-clip' }));

      expect(both.answer).toMatchObject({ type: 'error', code: 'invalid_request' });
    });
  });

  describe('what a member sends itself', () => {
    /** Speaks the protocol by hand, as a member that does not follow it would. */
    async function open(endpoint: LanTerminalEndpoint) {
      const { socket, rest } = await connectLanMember({
        endpoint,
        lanId: home.id,
        key: deriveLanTerminalKey(home.token),
        machineId: SERVER,
        service: 'files',
      });
      cleanups.push(() => socket.destroy());
      let buffered = rest.toString('utf8');
      const waiting: Array<() => void> = [];
      socket.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        for (const wake of waiting.splice(0)) wake();
      });
      socket.on('close', () => {
        for (const wake of waiting.splice(0)) wake();
      });
      socket.on('error', () => {});
      socket.resume();
      const answer = async (): Promise<Record<string, unknown>> => {
        for (;;) {
          const newline = buffered.indexOf('\n');
          if (newline >= 0) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            return JSON.parse(line) as Record<string, unknown>;
          }
          if (socket.destroyed || socket.readableEnded) throw new Error('closed without an answer');
          await new Promise<void>((resolve) => waiting.push(resolve));
        }
      };
      const announce = (header: Record<string, unknown>) =>
        socket.write(`${JSON.stringify({ type: 'file', sessionId: 'home-session', ...header })}\n`);
      return { socket, answer, announce };
    }

    it('refuses a file from its announcement, before a byte of it is sent', async () => {
      const { endpoint, stored } = await startServer({
        'home-session': { machineId: SERVER, isArchived: true },
      });
      const member = await open(endpoint);

      member.announce({ fileName: 'a.bin', sizeBytes: 50_000_000, sha256: 'a'.repeat(64) });

      // The answer to an announcement is `ready` or the refusal; nothing was sent yet.
      expect(await member.answer()).toMatchObject({ type: 'error', code: 'session_archived' });
      expect(stored).toEqual([]);
    });

    it('refuses bytes that are not the file it announced', async () => {
      const { endpoint, stored } = await startServer({});
      const member = await open(endpoint);
      const bytes = Buffer.from('what was sent');

      member.announce({
        fileName: 'a.txt',
        sizeBytes: bytes.length,
        sha256: sha256(Buffer.from('what was announced')),
      });
      expect(await member.answer()).toEqual({ type: 'ready' });
      member.socket.write(bytes);

      expect(await member.answer()).toMatchObject({ type: 'error', code: 'invalid_file' });
      expect(stored).toEqual([]);
    });

    it('refuses a file larger than a message may carry, and a header it cannot read', async () => {
      const { endpoint, stored } = await startServer({});

      const large = await open(endpoint);
      large.announce({ fileName: 'a.bin', sizeBytes: 101 * 1024 * 1024, sha256: 'a'.repeat(64) });
      expect(await large.answer()).toMatchObject({ type: 'error', code: 'invalid_request' });

      const unreadable = await open(endpoint);
      unreadable.socket.write('not json\n');
      expect(await unreadable.answer()).toMatchObject({ type: 'error', code: 'invalid_request' });
      expect(stored).toEqual([]);
    });

    it('stores a file under its name alone, whatever path the name carries', async () => {
      const { endpoint, stored } = await startServer({});
      const member = await open(endpoint);
      const bytes = Buffer.from('content');

      member.announce({
        fileName: '../../etc/cron.d/job',
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
      });
      expect(await member.answer()).toEqual({ type: 'ready' });
      member.socket.write(bytes);

      expect(await member.answer()).toMatchObject({ type: 'stored', file: { fileName: 'job' } });
      expect(stored.map((file) => file.fileName)).toEqual(['job']);
    });

    it('takes no more files over a connection than a message may carry', async () => {
      const { endpoint, stored } = await startServer({});
      const member = await open(endpoint);
      const bytes = Buffer.from('x');

      for (let index = 0; index < 8; index += 1) {
        member.announce({ fileName: `${index}.txt`, sizeBytes: 1, sha256: sha256(bytes) });
        expect(await member.answer()).toEqual({ type: 'ready' });
        member.socket.write(bytes);
        expect(await member.answer()).toMatchObject({ type: 'stored' });
      }
      member.announce({ fileName: '8.txt', sizeBytes: 1, sha256: sha256(bytes) });

      expect(await member.answer()).toMatchObject({ type: 'error', code: 'too_many_files' });
      expect(stored).toHaveLength(8);
    });
  });
});

describe('Board shared directories between LAN members', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-board-files-test-'));
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const board = normalizeBoardMeta({
    version: 1,
    id: 'bd_shared',
    name: 'Shared',
    coordinatorSessionId: 'coordinator',
    createdAtMs: 1,
    createdByUserId: 'user',
    files: { machineId: SERVER },
  })!;
  const readBoard = async (_workspaceId: string, boardId: string) =>
    boardId === board.id ? board : null;
  const lookupIn =
    (sessions: Record<string, Partial<SessionMeta>>): LanFileWorkspace['lookupSession'] =>
    async (sessionId) =>
      sessions[sessionId]
        ? { type: 'found', meta: { id: sessionId, ...sessions[sessionId] } as SessionMeta }
        : { type: 'missing' };

  /** The machine that keeps the Board directory, with its own replica of the sessions. */
  async function startKeeper(sessions: Record<string, Partial<SessionMeta>>) {
    const directory = new BoardDirectory(() => path.join(scratch, 'keeper-data'));
    const workspace: LanFileWorkspace = {
      lookupSession: lookupIn(sessions),
      readMachine: async () => undefined,
      storeLocally: async () => [],
    };
    const handoff = new LanFileHandoff({
      machineId: SERVER,
      logger: silentLogger(),
      hubs: () => [home],
      workspace: (workspaceId) => (workspaceId === HOME ? workspace : null),
      localSessions: (workspaceId) => (workspaceId === HOME ? workspace.lookupSession : null),
      boards: { directory, readBoard },
    });
    const published = new Map<string, LanTerminalEndpoint | undefined>();
    const host = new LanTerminalHost({
      machineId: SERVER,
      logger: silentLogger(),
      lans: { hubs: [home], workspaces: createStore<readonly WorkspaceSummary[]>([]) },
      port: 0,
      probeAddress: async () => '127.0.0.1',
      serviceFor: () => null,
      filesFor: (workspaceId: string) => handoff.receiverFor(workspaceId),
      publish: async (workspaceId, endpoint) => {
        published.set(workspaceId, endpoint);
      },
    });
    cleanups.push(() => host.close());
    await host.refresh();
    const endpoint = published.get(HOME);
    if (!endpoint) throw new Error('the keeper published no endpoint');
    return { endpoint, root: directory.boardPath(HOME, board.id) };
  }

  /** A member on another machine; its replica may claim more than the keeper's. */
  function startMember(
    endpoint: LanTerminalEndpoint,
    sessions: Record<string, Partial<SessionMeta>>
  ) {
    const workspace: LanFileWorkspace = {
      lookupSession: lookupIn(sessions),
      readMachine: async () =>
        ({
          id: SERVER,
          name: 'keeper',
          protocolCapabilities: { lanFiles: 1, lanBoardFiles: 1 },
          lanTerminal: endpoint,
        }) as MachineMeta,
      storeLocally: async () => [],
    };
    return new LanFileHandoff({
      machineId: CLIENT,
      logger: silentLogger(),
      hubs: () => [home],
      workspace: (workspaceId) => (workspaceId === HOME ? workspace : null),
      localSessions: (workspaceId) => (workspaceId === HOME ? workspace.lookupSession : null),
      boards: { directory: new BoardDirectory(() => path.join(scratch, 'member-data')), readBoard },
    });
  }

  const members = {
    coordinator: { boardId: 'bd_shared', machineId: SERVER },
    thread: { boardId: 'bd_shared', machineId: CLIENT },
  } as Record<string, Partial<SessionMeta>>;
  const scope = (sessionId: string, area: 'files' | 'memory' = 'files') =>
    ({ boardId: 'bd_shared', sessionId, area }) as const;

  it('puts, lists and reads Board files from another machine of the LAN', async () => {
    const { endpoint, root } = await startKeeper(members);
    const member = startMember(endpoint, members);
    const source = path.join(scratch, 'plan.md');
    fs.writeFileSync(source, '# Plan\n第一步\n');

    const entry = await member.putBoardFile(HOME, scope('thread'), 'design/plan.md', source);
    expect(entry).toMatchObject({ path: 'design/plan.md', sizeBytes: fs.statSync(source).size });
    expect(fs.readFileSync(path.join(root, 'files', 'design', 'plan.md'), 'utf8')).toBe(
      '# Plan\n第一步\n'
    );
    await member.putBoardFile(HOME, scope('thread', 'memory'), 'MEMORY.md', source);

    expect((await member.listBoardFiles(HOME, scope('thread'))).entries.map((e) => e.path)).toEqual(
      ['design/plan.md']
    );
    expect(
      (await member.listBoardFiles(HOME, scope('thread', 'memory'))).entries.map((e) => e.path)
    ).toEqual(['MEMORY.md']);
    const copy = path.join(scratch, 'copy.md');
    await member.readBoardFile(HOME, scope('thread'), 'design/plan.md', copy);
    expect(fs.readFileSync(copy, 'utf8')).toBe('# Plan\n第一步\n');
  });

  it('refuses a session the keeper does not know as a member, whatever the asker claims', async () => {
    const { endpoint, root } = await startKeeper({ ...members, stranger: { machineId: CLIENT } });
    // The asking machine's replica says the stranger joined; the keeper's says it did not.
    const member = startMember(endpoint, {
      ...members,
      stranger: { boardId: 'bd_shared', machineId: CLIENT },
    });
    const source = path.join(scratch, 'note.md');
    fs.writeFileSync(source, 'note');

    await expect(member.listBoardFiles(HOME, scope('stranger'))).rejects.toThrow(
      'BOARD_NOT_MEMBER'
    );
    await expect(member.putBoardFile(HOME, scope('stranger'), 'note.md', source)).rejects.toThrow(
      'BOARD_NOT_MEMBER'
    );
    expect(fs.existsSync(path.join(root, 'files', 'note.md'))).toBe(false);
  });

  it('refuses names outside the Board directory, including through a link', async () => {
    const { endpoint, root } = await startKeeper(members);
    const member = startMember(endpoint, members);
    const source = path.join(scratch, 'escape.md');
    fs.writeFileSync(source, 'escape');
    const outside = path.join(scratch, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');

    await expect(
      member.putBoardFile(HOME, scope('thread'), '../escape.md', source)
    ).rejects.toThrow('BOARD_PATH_OUTSIDE');
    await expect(
      member.readBoardFile(
        HOME,
        scope('thread'),
        '../../../outside/secret.txt',
        path.join(scratch, 'a')
      )
    ).rejects.toThrow('BOARD_PATH_OUTSIDE');
    fs.mkdirSync(path.join(root, 'files'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'files', 'link'));
    await expect(
      member.readBoardFile(HOME, scope('thread'), 'link/secret.txt', path.join(scratch, 'b'))
    ).rejects.toThrow('BOARD_PATH_OUTSIDE');
    await expect(
      member.putBoardFile(HOME, scope('thread'), 'link/planted.md', source)
    ).rejects.toThrow('BOARD_PATH_OUTSIDE');
    expect(fs.existsSync(path.join(outside, 'planted.md'))).toBe(false);
    expect(fs.existsSync(path.join(scratch, 'escape.md'))).toBe(true);
    // A link is never listed either.
    expect((await member.listBoardFiles(HOME, scope('thread'))).entries).toEqual([]);
  });

  it('refuses a file that is a link, on the keeper and from another member', async () => {
    const { endpoint, root } = await startKeeper(members);
    const member = startMember(endpoint, members);
    const secret = path.join(scratch, 'secret.txt');
    fs.writeFileSync(secret, 'secret');
    fs.mkdirSync(path.join(root, 'files'), { recursive: true });
    fs.symlinkSync(secret, path.join(root, 'files', 'leaf.txt'));
    const directory = new BoardDirectory(() => path.join(scratch, 'keeper-data'));

    await expect(
      directory.read(HOME, board.id, 'files', 'leaf.txt', path.join(scratch, 'a'))
    ).rejects.toThrow('BOARD_PATH_OUTSIDE');
    await expect(
      member.readBoardFile(HOME, scope('thread'), 'leaf.txt', path.join(scratch, 'b'))
    ).rejects.toThrow('BOARD_PATH_OUTSIDE');
    expect(fs.existsSync(path.join(scratch, 'a'))).toBe(false);
    expect(fs.existsSync(path.join(scratch, 'b'))).toBe(false);
  });

  it('refuses an area whose root, or a directory above it, is a link', async () => {
    const { endpoint, root } = await startKeeper(members);
    const member = startMember(endpoint, members);
    const outside = path.join(scratch, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    const source = path.join(scratch, 'planted.md');
    fs.writeFileSync(source, 'planted');

    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'files'));
    await expect(member.listBoardFiles(HOME, scope('thread'))).rejects.toThrow(
      'BOARD_PATH_OUTSIDE'
    );
    await expect(
      member.readBoardFile(HOME, scope('thread'), 'secret.txt', path.join(scratch, 'copy'))
    ).rejects.toThrow('BOARD_PATH_OUTSIDE');
    await expect(member.putBoardFile(HOME, scope('thread'), 'planted.md', source)).rejects.toThrow(
      'BOARD_PATH_OUTSIDE'
    );

    // The same when the Board directory itself is the link.
    fs.rmSync(root, { recursive: true });
    fs.symlinkSync(outside, root);
    await expect(
      member.putBoardFile(HOME, scope('thread', 'memory'), 'planted.md', source)
    ).rejects.toThrow('BOARD_PATH_OUTSIDE');
    expect(fs.readdirSync(outside)).toEqual(['secret.txt']);
  });
});

describe('toStoredFileName', () => {
  it('keeps a name and drops the path it came with', () => {
    expect(toStoredFileName('截图 2026-09-29.png')).toBe('截图 2026-09-29.png');
    expect(toStoredFileName('/home/me/notes.md')).toBe('notes.md');
    expect(toStoredFileName('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
    expect(toStoredFileName('../../etc/passwd')).toBe('passwd');
  });

  it('names what has no usable name', () => {
    for (const name of ['', '   ', '.', '..', 'folder/', '../..']) {
      expect(toStoredFileName(name)).toBe('file');
    }
    expect(toStoredFileName('a\u0000b\nc.txt')).toBe('a_b_c.txt');
  });

  it('fits a long name into what a file system takes, whole characters and extension kept', () => {
    const stored = toStoredFileName(`${'图'.repeat(200)}😀.png`);

    expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(200);
    expect(stored.endsWith('.png')).toBe(true);
    expect(stored.slice(0, -4)).toMatch(/^图+$/);
    expect(Buffer.from(stored, 'utf8').toString('utf8')).toBe(stored);
  });
});
