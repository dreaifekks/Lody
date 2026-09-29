import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SessionFileSendLocalRequest,
  SessionFileSendLocalResponse,
  SessionId,
  WorkspaceId,
} from '@lody/shared';
import type { CloudPort } from '@lody/platform';

import { MessageHandler, type MessageDispatchContext } from '../src/lib/message-handler';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { SessionManager } from '../src/session/session-manager';
import type { Logger } from '../src/utils/logger';
import { createTestCloudPort } from './test-cloud-port';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

const WORKSPACE = 'lw_home' as WorkspaceId;
const SESSION = 'session-1' as SessionId;

type Handoff = {
  handleSessionFileSendLocal: (
    message: SessionFileSendLocalRequest,
    context: MessageDispatchContext
  ) => Promise<void>;
  /** The files whose upload to a relay was started, as `<session>:<file>`. */
  sessionFileBackfillInFlight: Set<string>;
};

describe('MessageHandler local file handoff', () => {
  let root: string;
  let previousDataDir: string | undefined;
  const handlers: MessageHandler[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-file-handoff-'));
    previousDataDir = process.env.LODY_DATA_DIR;
    process.env.LODY_DATA_DIR = path.join(root, 'data');
  });

  afterEach(async () => {
    for (const handler of handlers.splice(0)) await handler.cleanup();
    if (previousDataDir === undefined) delete process.env.LODY_DATA_DIR;
    else process.env.LODY_DATA_DIR = previousDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Hands one file over for a session whose metadata is `sessionRecord`. */
  async function handOff(
    sessionRecord: unknown,
    cloudPort: Partial<Pick<CloudPort, 'attachmentUpload'>> = {}
  ) {
    // Never settles: a started upload stays observable for the assertions.
    const getOrCreateSessionDoc = vi.fn(() => new Promise<never>(() => {}));
    const workspaceDocument = {
      sessions: new Map<SessionId, unknown>(),
      repo: {
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        getDocMeta: vi.fn(async () => sessionRecord),
      },
      getOrCreateSessionDoc,
    };
    const sessionManager = {
      on: vi.fn(),
      setRequestPermissionHandler: vi.fn(),
      getSession: vi.fn(),
      cleanUp: vi.fn(async () => {}),
    };
    const handler = new MessageHandler(
      sessionManager as unknown as SessionManager,
      workspaceDocument as unknown as LoroDocumentManager,
      createSilentLogger(),
      {
        token: 'token',
        workspaceId: WORKSPACE,
        userId: 'local:home',
        machineId: 'machine-1',
        machineName: 'machine',
        cliVersion: '0.0.0',
        cloudPort: createTestCloudPort(cloudPort),
      }
    );
    handlers.push(handler);
    // A member of a LAN is attached to its hub, which is when uploads start.
    await handler.enableRemoteBackfillAndScan();

    const source = path.join(root, 'picked', 'screenshot.png');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'the bytes of a picture');

    const sent: SessionFileSendLocalResponse[] = [];
    await (handler as unknown as Handoff).handleSessionFileSendLocal(
      {
        type: 'session/file-send-local',
        machineId: 'machine-1',
        sessionId: SESSION,
        workspaceId: WORKSPACE,
        paths: [source],
      } as SessionFileSendLocalRequest,
      { source: 'local', send: (message) => sent.push(message as SessionFileSendLocalResponse) }
    );
    expect(sent).toHaveLength(1);
    return {
      response: sent[0]!,
      uploadsStarted: [...(handler as unknown as Handoff).sessionFileBackfillInFlight],
    };
  }

  const storedBytes = (fileId: string): string =>
    fs.readFileSync(
      path.join(root, 'data', 'session-files', WORKSPACE, SESSION, fileId),
      'utf8'
    );

  it('takes the files of a conversation its first message is about to create', async () => {
    const { response, uploadsStarted } = await handOff(undefined);

    expect(response).toMatchObject({
      success: true,
      files: [
        { fileName: 'screenshot.png', transport: 'local', machineId: 'machine-1', sizeBytes: 22 },
      ],
    });
    expect(storedBytes(response.files![0]!.fileId)).toBe('the bytes of a picture');
    // Looking for the file in the conversation would open its document, and
    // so create it ahead of the client that sends the message.
    expect(uploadsStarted).toEqual([]);
  });

  it('leaves such files to the upload where there is a relay to upload to', async () => {
    const { response } = await handOff(undefined, {
      attachmentUpload: { serverBaseUrl: 'https://relay.example' },
    });

    expect(response).toMatchObject({ success: false, error: 'session_not_found' });
    expect(fs.existsSync(path.join(root, 'data', 'session-files'))).toBe(false);
  });

  it('takes no file for a conversation that was deleted', async () => {
    const { response } = await handOff({ exists: false, meta: undefined });

    expect(response).toMatchObject({ success: false, error: 'session_not_found' });
    expect(fs.existsSync(path.join(root, 'data', 'session-files'))).toBe(false);
  });

  it('takes the files of a conversation that exists', async () => {
    const { response, uploadsStarted } = await handOff({
      meta: { id: SESSION, machineId: 'machine-1' },
    });

    expect(response).toMatchObject({ success: true, files: [{ fileName: 'screenshot.png' }] });
    expect(storedBytes(response.files![0]!.fileId)).toBe('the bytes of a picture');
    expect(uploadsStarted).toEqual([`${SESSION}:${response.files![0]!.fileId}`]);
  });
});
