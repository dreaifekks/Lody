import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_PREVIEW_PROTOCOL_VERSION,
  type FilePreviewV3Request,
  type FilePreviewV3Response,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';

import { MessageHandler } from '../src/lib/message-handler';
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

const SESSION = 'chat-1' as SessionId;

type Preview = {
  filePreviewService: {
    previewFile(request: FilePreviewV3Request): Promise<FilePreviewV3Response>;
  };
};

describe('MessageHandler file preview of a chat without a running agent', () => {
  let root: string;
  let previousDataDir: string | undefined;
  const handlers: MessageHandler[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-chat-preview-'));
    previousDataDir = process.env.LODY_DATA_DIR;
    process.env.LODY_DATA_DIR = path.join(root, 'data');
  });

  afterEach(async () => {
    for (const handler of handlers.splice(0)) await handler.cleanup();
    if (previousDataDir === undefined) delete process.env.LODY_DATA_DIR;
    else process.env.LODY_DATA_DIR = previousDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function preview(filePath: string): Promise<FilePreviewV3Response> {
    const workspaceDocument = {
      sessions: new Map<SessionId, unknown>(),
      repo: {
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        // A chat: no local project, no repository.
        getDocMeta: vi.fn(async () => ({ meta: { id: SESSION, machineId: 'machine-1' } })),
      },
    };
    const sessionManager = {
      on: vi.fn(),
      setRequestPermissionHandler: vi.fn(),
      // The agent process is gone (idle eviction, daemon restart).
      getSession: vi.fn(() => undefined),
      getPendingSession: vi.fn(() => undefined),
      cleanUp: vi.fn(async () => {}),
    };
    const handler = new MessageHandler(
      sessionManager as unknown as SessionManager,
      workspaceDocument as unknown as LoroDocumentManager,
      createSilentLogger(),
      {
        token: 'token',
        workspaceId: 'lw_home' as WorkspaceId,
        userId: 'local:home',
        machineId: 'machine-1',
        machineName: 'machine',
        cliVersion: '0.0.0',
        cloudPort: createTestCloudPort({}),
      }
    );
    handlers.push(handler);
    return await (handler as unknown as Preview).filePreviewService.previewFile({
      v: FILE_PREVIEW_PROTOCOL_VERSION,
      sessionId: SESSION,
      path: filePath,
    });
  }

  it('reads a file the agent left in the chat directory', async () => {
    const chatDir = path.join(root, 'data', 'chats', SESSION);
    fs.mkdirSync(chatDir, { recursive: true });
    fs.writeFileSync(path.join(chatDir, 'followup.md'), '# notes\n');

    expect(await preview('followup.md')).toMatchObject({ status: 'ok', path: 'followup.md' });
    expect(await preview(path.join(chatDir, 'followup.md'))).toMatchObject({
      status: 'ok',
      path: 'followup.md',
    });
  });

  it('still reports no workspace when the chat never ran here', async () => {
    expect(await preview('followup.md')).toMatchObject({
      status: 'error',
      code: 'workspace_root_unavailable',
    });
  });
});
