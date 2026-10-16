import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeBoardMeta,
  workspaceFlockKeys,
  type MachineId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { BoardDirectory } from '@/lib/board-directory';
import { LanFileHandoff, type LanFileWorkspace } from '@/lib/lan/lan-file-handoff';
import {
  runWithSessionCommandEnvironment,
  type SessionCommandEnvironment,
} from '@/lib/session-command-environment';
import type { Logger } from '@/utils/logger';
import { registerBoardTools } from './board-tools';
import { createSessionToolRegistrar, type SessionToolHandlers } from './session-tool-router';

const WORKSPACE = 'ws_board_tools';
const MACHINE = 'machine-keeper' as MachineId;
const SESSION = 'thread' as SessionId;

const silentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
});

const board = normalizeBoardMeta({
  version: 1,
  id: 'bd_tools',
  name: 'Tools',
  coordinatorSessionId: 'coordinator',
  createdAtMs: 1,
  createdByUserId: 'user',
  files: { machineId: MACHINE },
})!;

describe('Board file tools on the caller machine', () => {
  let scratch: string;
  let workdir: string;
  let outside: string;
  let boardRoot: string;
  let call: (name: string, args: Record<string, unknown>) => Promise<string>;

  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'board-tools-test-')));
    workdir = path.join(scratch, 'workdir');
    outside = path.join(scratch, 'outside');
    fs.mkdirSync(workdir);
    fs.mkdirSync(outside);
    const sessions: Record<string, Partial<SessionMeta>> = {
      coordinator: { boardId: board.id, machineId: MACHINE, boardRole: 'coordinator' },
      [SESSION]: { boardId: board.id, machineId: MACHINE },
    };
    const lookupSession: LanFileWorkspace['lookupSession'] = async (sessionId) =>
      sessions[sessionId]
        ? { type: 'found', meta: { id: sessionId, ...sessions[sessionId] } as SessionMeta }
        : { type: 'missing' };
    const directory = new BoardDirectory(() => path.join(scratch, 'data'));
    boardRoot = directory.boardPath(WORKSPACE, board.id);
    const handoff = new LanFileHandoff({
      machineId: MACHINE,
      logger: silentLogger(),
      hubs: () => [],
      workspace: () => null,
      localSessions: (workspaceId) => (workspaceId === WORKSPACE ? lookupSession : null),
      boards: {
        directory,
        readBoard: async (_ws, boardId) => (boardId === board.id ? board : null),
      },
    });
    const environment = {
      workspace: { id: WORKSPACE },
      manager: {
        syncFlockDocOrThrow: async () => {},
        repo: {
          openFlockDoc: async () => ({
            flock: {
              get: (key: unknown) =>
                JSON.stringify(key) === JSON.stringify(workspaceFlockKeys.board(board.id))
                  ? board
                  : undefined,
            },
          }),
          getDocMeta: async () => ({ meta: { id: SESSION, ...sessions[SESSION] } }),
        },
      },
      host: {
        boardFiles: {
          list: async (scope) => await handoff.listBoardFiles(WORKSPACE, scope),
          read: async (scope, filePath, destinationPath) =>
            await handoff.readBoardFile(WORKSPACE, scope, filePath, destinationPath),
          put: async (scope, filePath, sourcePath) =>
            await handoff.putBoardFile(WORKSPACE, scope, filePath, sourcePath),
        },
      },
    } as unknown as SessionCommandEnvironment;
    const handlers: SessionToolHandlers = new Map();
    registerBoardTools(
      createSessionToolRegistrar(
        { registerTool: () => undefined } as unknown as McpServer,
        async (_name, _args, execute) => await execute(),
        handlers
      ),
      () => ({
        machineId: MACHINE,
        workspaceId: WORKSPACE,
        sessionId: SESSION,
        localControlSocketPath: undefined,
        workdir,
      })
    );
    call = async (name, args) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`no tool ${name}`);
      const result = await runWithSessionCommandEnvironment(environment, () => handler(args));
      const text = result.content.map((item) => (item.type === 'text' ? item.text : '')).join('');
      return result.isError ? `error: ${text}` : text;
    };
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('puts and reads files inside the working directory', async () => {
    fs.writeFileSync(path.join(workdir, 'plan.md'), '# Plan');
    expect(await call('lody_board_files_write', { source: path.join(workdir, 'plan.md') })).toMatch(
      /"path":"plan.md"/
    );
    const saveTo = path.join(workdir, 'copy.md');
    expect(await call('lody_board_files_read', { path: 'plan.md', saveTo })).toMatch(/savedTo/);
    expect(fs.readFileSync(saveTo, 'utf8')).toBe('# Plan');
  });

  it('refuses a source outside the working directory, directly or through a link', async () => {
    const key = path.join(outside, 'id_ed25519');
    fs.writeFileSync(key, 'private key');
    fs.symlinkSync(key, path.join(workdir, 'key-link'));
    fs.symlinkSync(outside, path.join(workdir, 'dir-link'));

    for (const source of [
      key,
      path.join(workdir, 'key-link'),
      path.join(workdir, 'dir-link', 'id_ed25519'),
    ])
      expect(await call('lody_board_files_write', { source, path: 'key' })).toMatch(
        /^error: File is outside the session workspace/
      );
    expect(fs.existsSync(path.join(boardRoot, 'files', 'key'))).toBe(false);
  });

  it('refuses a destination outside the working directory, directly or through a link', async () => {
    fs.writeFileSync(path.join(workdir, 'notes.md'), 'notes');
    await call('lody_board_files_write', { source: path.join(workdir, 'notes.md') });
    fs.symlinkSync(outside, path.join(workdir, 'dir-link'));

    for (const saveTo of [
      path.join(outside, 'planted.md'),
      path.join(workdir, 'dir-link', 'planted.md'),
    ])
      expect(await call('lody_board_files_read', { path: 'notes.md', saveTo })).toMatch(
        /^error: File is outside the session workspace/
      );
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
