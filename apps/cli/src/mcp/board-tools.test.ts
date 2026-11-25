import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { LoroDoc } from 'loro-crdt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boardMaintenanceStepId,
  boardMaintenanceTurn,
  createSessionMirror,
  getSessionRoomId,
  normalizeBoardMeta,
  workspaceFlockKeys,
  type MachineId,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { createLoroSessionData } from '@lody/shared/session-data';
import { BoardDirectory } from '@/lib/board-directory';
import { BOARD_LINE_MAX_PINS, BoardLineStore } from '@/lib/board-line-store';
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

describe('Board project group scope', () => {
  it('checks every member, including additional directories and exact local machine identity', async () => {
    const { assertBoardProjectInScope } = await import('@/lib/board-directory');
    const { SessionProjectRunSchema } = await import('@lody/shared');
    const scoped = normalizeBoardMeta({
      ...board,
      context: {
        projects: [
          { kind: 'local', machineId: MACHINE, localProjectId: 'allowed', name: 'Allowed' },
        ],
      },
    })!;
    const manager = {
      syncFlockDocOrThrow: async () => {},
      repo: { openFlockDoc: async () => ({ flock: { get: () => scoped } }) },
    } as unknown as Parameters<typeof assertBoardProjectInScope>[0];
    const run = SessionProjectRunSchema.parse({
      id: 'd835a1ee-4f85-4e15-9dca-2bca912e36bf',
      name: 'Group',
      root: 'project-group-d835a1ee-4f85-4e15-9dca-2bca912e36bf',
      members: {
        first: {
          o: 0,
          src: { kind: 'local', machineId: MACHINE, localProjectId: 'allowed' },
          placement: { kind: 'root', dir: 'first' },
          path: 'first',
          base: 'main',
        },
        second: {
          o: 1,
          src: { kind: 'local', machineId: MACHINE, localProjectId: 'outside' },
          placement: { kind: 'root', dir: 'second' },
          path: 'second',
          base: 'main',
          access: 'additional',
        },
      },
    });
    const check = () =>
      assertBoardProjectInScope(manager, WORKSPACE, board.id, MACHINE, run, silentLogger());
    await expect(check()).rejects.toMatchObject({ code: 'BOARD_PROJECT_OUT_OF_SCOPE' });
    run.members.second!.src = {
      kind: 'local',
      machineId: 'other' as MachineId,
      localProjectId: 'allowed' as never,
    };
    await expect(check()).rejects.toMatchObject({ code: 'BOARD_PROJECT_OUT_OF_SCOPE' });
    run.members.second!.src = {
      kind: 'local',
      machineId: MACHINE,
      localProjectId: 'allowed' as never,
    };
    await expect(check()).resolves.toBeUndefined();
  });
});

describe('Board line MCP tools (expand & pin)', () => {
  let scratch: string;
  let lineStore: BoardLineStore;
  let coordinatorLoro: LoroDoc;
  let coordinatorMirror: ReturnType<typeof createSessionMirror>;
  let coordinatorSessionData: ReturnType<typeof createLoroSessionData>;

  const createCaller = (options: {
    sessionId: SessionId;
    machineId?: MachineId;
    boardFilesMachine?: MachineId | null;
    coordinatorMachineId?: MachineId | null;
  }) => {
    const localMachine = options.machineId ?? MACHINE;
    const activeBoard = normalizeBoardMeta({
      ...board,
      files:
        options.boardFilesMachine === null
          ? undefined
          : { machineId: options.boardFilesMachine ?? MACHINE },
    })!;
    const coordMachine =
      options.coordinatorMachineId === null
        ? undefined
        : (options.coordinatorMachineId ?? activeBoard.files?.machineId);
    const sessions: Record<string, SessionMeta> = {
      coordinator: {
        id: 'coordinator' as SessionId,
        boardId: activeBoard.id,
        ...(coordMachine ? { machineId: coordMachine } : {}),
        boardRole: 'coordinator',
      } as SessionMeta,
      [SESSION]: {
        id: SESSION,
        boardId: activeBoard.id,
        machineId: localMachine,
      } as SessionMeta,
    };
    const environment = {
      auth: { machineId: localMachine },
      workspace: { id: WORKSPACE },
      manager: {
        syncFlockDocOrThrow: async () => {},
        getOrCreateSessionDoc: async (id: SessionId) => {
          if (id !== ('coordinator' as SessionId)) throw new Error(`unexpected doc ${id}`);
          return { sessionData: coordinatorSessionData };
        },
        repo: {
          openFlockDoc: async () => ({
            flock: {
              get: (key: unknown) =>
                JSON.stringify(key) === JSON.stringify(workspaceFlockKeys.board(activeBoard.id))
                  ? activeBoard
                  : undefined,
            },
          }),
          getDocMeta: async (roomId: string) => {
            if (roomId === getSessionRoomId('coordinator' as SessionId)) {
              return { meta: sessions.coordinator };
            }
            if (roomId === getSessionRoomId(SESSION)) {
              return { meta: sessions[SESSION] };
            }
            return undefined;
          },
        },
      },
      host: {
        boardLineStore: lineStore,
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
        machineId: localMachine,
        workspaceId: WORKSPACE,
        sessionId: options.sessionId,
        localControlSocketPath: undefined,
        workdir: scratch,
      })
    );
    return async (name: string, args: Record<string, unknown>) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`no tool ${name}`);
      const res = await runWithSessionCommandEnvironment(environment, () => handler(args));
      const text = res.content.map((item) => (item.type === 'text' ? item.text : '')).join('');
      return { isError: Boolean(res.isError), text };
    };
  };

  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'board-line-mcp-')));
    lineStore = new BoardLineStore(() => path.join(scratch, 'data'));
    coordinatorLoro = new LoroDoc();
    coordinatorMirror = createSessionMirror({
      doc: coordinatorLoro,
      initialState: { session: { id: 'coordinator' as SessionId }, history: [] },
    });
    coordinatorSessionData = createLoroSessionData({
      sessionId: 'coordinator' as SessionId,
      doc: coordinatorLoro,
      writer: coordinatorMirror.historyWriter,
    });
  });

  afterEach(() => {
    coordinatorMirror.dispose();
    coordinatorLoro.free();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('expands fold nodes with full child summaries and expands segment Loro history with pagination and 32 KiB cap', async () => {
    const turns: SessionHistoryInput[] = [
      {
        id: 'u-1',
        role: 'user',
        timestamp: '2026-11-25T10:00:00.000Z',
        items: [{ type: 'text', text: 'First question' }],
        fileDiff: [],
      },
      {
        id: 'a-1',
        role: 'assistant',
        userTurnId: 'u-1',
        timestamp: '2026-11-25T10:00:10.000Z',
        finished: true,
        items: [
          { type: 'thought', text: 'Hidden chain of thought' },
          { type: 'text', text: 'First answer' },
        ],
        fileDiff: [],
      },
      boardMaintenanceTurn(
        'r1',
        { boardId: board.id, kind: 'fold_rollover', trigger: 'idle', status: 'running' },
        '2026-11-25T10:00:20.000Z'
      ),
      {
        id: `assistant:${boardMaintenanceStepId('r1', 'seal')}`,
        role: 'assistant',
        userTurnId: boardMaintenanceStepId('r1', 'seal'),
        timestamp: '2026-11-25T10:00:25.000Z',
        finished: true,
        items: [{ type: 'text', text: 'Internal seal JSON' }],
        fileDiff: [],
      },
      {
        id: 'u-2',
        role: 'user',
        timestamp: '2026-11-25T10:01:00.000Z',
        items: [{ type: 'text', text: 'Second question' }],
        fileDiff: [],
      },
      {
        id: 'a-2',
        role: 'assistant',
        userTurnId: 'u-2',
        timestamp: '2026-11-25T10:01:10.000Z',
        finished: true,
        items: [{ type: 'text', text: 'Second answer' }],
        fileDiff: [],
      },
    ];
    for (const turn of turns) {
      await coordinatorSessionData.commands.appendTurn(turn);
    }

    const seg1 = await lineStore.appendSegment(WORKSPACE, board.id, {
      id: 'seg_00000001',
      coversFrom: '2026-11-25T10:00:00.000Z',
      coversTo: '2026-11-25T10:01:10.000Z',
      title: 'Segment One',
      tags: ['alpha'],
      summary: 'Full summary of segment one.',
      summaryQuality: 'written',
      outcome: 'rolled',
      turnRange: { startTurnId: 'u-1', endTurnId: 'a-2', turnCount: 2 },
    });
    const seg2 = await lineStore.appendSegment(WORKSPACE, board.id, {
      id: 'seg_00000002',
      coversFrom: '2026-11-25T10:02:00.000Z',
      coversTo: '2026-11-25T10:03:00.000Z',
      title: 'Segment Two',
      tags: ['beta'],
      summary: 'Full summary of segment two.',
      summaryQuality: 'written',
      outcome: 'rolled',
      turnRange: { startTurnId: 'u-2', endTurnId: 'a-2', turnCount: 1 },
    });
    const fld = await lineStore.appendFold(WORKSPACE, board.id, {
      id: 'fld_00000001',
      covers: [seg1.meta.id, seg2.meta.id],
      title: 'Early Milestone',
      tags: ['milestone'],
      summary: 'Combined summary of 1 and 2.',
    });

    const callAsMember = createCaller({ sessionId: SESSION });

    // Expand fold node.
    const foldRes = await callAsMember('lody_board_line_expand', { nodeId: fld.meta.id });
    expect(foldRes.isError).toBe(false);
    const foldPayload = JSON.parse(foldRes.text);
    expect(foldPayload.node.id).toBe('fld_00000001');
    expect(foldPayload.children).toHaveLength(2);
    expect(foldPayload.children[0]).toMatchObject({
      id: 'seg_00000001',
      title: 'Segment One',
      summary: 'Full summary of segment one.',
    });
    expect(foldPayload.children[1]).toMatchObject({
      id: 'seg_00000002',
      title: 'Segment Two',
      summary: 'Full summary of segment two.',
    });

    // Expand segment node with pagination (excluding thinking & maintenance entries).
    const page1 = await callAsMember('lody_board_line_expand', {
      nodeId: seg1.meta.id,
      offset: 0,
      limit: 2,
    });
    expect(page1.isError).toBe(false);
    const p1 = JSON.parse(page1.text);
    expect(p1.totalTurns).toBe(4);
    expect(p1.turns.map((t: { id: string; text: string }) => [t.id, t.text])).toEqual([
      ['u-1', 'First question'],
      ['a-1', 'First answer'],
    ]);
    expect(p1.hasMore).toBe(true);
    expect(p1.nextOffset).toBe(2);
    expect(page1.text).not.toContain('Hidden chain of thought');
    expect(page1.text).not.toContain('Internal seal JSON');

    const page2 = await callAsMember('lody_board_line_expand', {
      nodeId: seg1.meta.id,
      offset: 2,
      limit: 2,
    });
    const p2 = JSON.parse(page2.text);
    expect(p2.turns.map((t: { id: string }) => t.id)).toEqual(['u-2', 'a-2']);
    expect(p2.hasMore).toBe(false);

    // Byte cap enforcement (<= 32 KiB) on huge turns.
    for (let i = 3; i <= 12; i++) {
      await coordinatorSessionData.commands.appendTurn({
        id: `big-${i}`,
        role: 'user',
        timestamp: `2026-11-25T11:${String(i).padStart(2, '0')}:00.000Z`,
        items: [{ type: 'text', text: `Turn ${i}: ${'A'.repeat(7000)}` }],
        fileDiff: [],
      });
    }
    const bigSeg = await lineStore.appendSegment(WORKSPACE, board.id, {
      id: 'seg_00000003',
      coversFrom: '2026-11-25T11:03:00.000Z',
      coversTo: '2026-11-25T11:12:00.000Z',
      title: 'Big Segment',
      summary: 'Big summary.',
      summaryQuality: 'written',
      outcome: 'rolled',
      turnRange: { startTurnId: 'big-3', endTurnId: 'big-12', turnCount: 10 },
    });
    const bigRes = await callAsMember('lody_board_line_expand', { nodeId: bigSeg.meta.id });
    expect(bigRes.isError).toBe(false);
    expect(Buffer.byteLength(bigRes.text)).toBeLessThanOrEqual(32 * 1024);
    const bigPayload = JSON.parse(bigRes.text);
    expect(bigPayload.truncatedByBytes).toBe(true);
    expect(bigPayload.hasMore).toBe(true);
    expect(bigPayload.turns.length).toBeGreaterThan(0);

    // Remote machine returns BOARD_LINE_LOCAL_ONLY.
    const callRemote = createCaller({
      sessionId: SESSION,
      machineId: 'other-machine' as MachineId,
      boardFilesMachine: MACHINE,
    });
    const remoteRes = await callRemote('lody_board_line_expand', { nodeId: seg1.meta.id });
    expect(remoteRes.isError).toBe(true);
    expect(remoteRes.text).toContain('BOARD_LINE_LOCAL_ONLY');
  });

  it('restricts lody_board_line_pin to the Board coordinator and enforces the 8-pin limit', async () => {
    const ids: string[] = [];
    for (let i = 1; i <= BOARD_LINE_MAX_PINS + 1; i++) {
      const seg = await lineStore.appendSegment(WORKSPACE, board.id, {
        coversFrom: `2026-11-${String(i).padStart(2, '0')}T08:00:00.000Z`,
        coversTo: `2026-11-${String(i).padStart(2, '0')}T09:00:00.000Z`,
        title: `Segment ${i}`,
        summary: `Summary ${i}`,
        summaryQuality: 'written',
        outcome: 'rolled',
        turnRange: { startTurnId: `u-${i}`, endTurnId: `a-${i}`, turnCount: 1 },
      });
      ids.push(seg.meta.id);
    }

    // Non-coordinator thread is rejected.
    const callAsThread = createCaller({ sessionId: SESSION });
    const denied = await callAsThread('lody_board_line_pin', { nodeId: ids[0]!, pinned: true });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('BOARD_COORDINATOR_REQUIRED');

    // Coordinator can pin up to 8 nodes; 9th fails cleanly until one is unpinned.
    const callAsCoordinator = createCaller({ sessionId: 'coordinator' as SessionId });
    for (let i = 0; i < BOARD_LINE_MAX_PINS; i++) {
      const res = await callAsCoordinator('lody_board_line_pin', {
        nodeId: ids[i]!,
        pinned: true,
      });
      expect(res.isError).toBe(false);
      expect(JSON.parse(res.text).pins).toHaveLength(i + 1);
    }
    const overLimit = await callAsCoordinator('lody_board_line_pin', {
      nodeId: ids[BOARD_LINE_MAX_PINS]!,
      pinned: true,
    });
    expect(overLimit.isError).toBe(true);
    expect(overLimit.text).toContain('BOARD_LINE_PIN_LIMIT');

    const unpin = await callAsCoordinator('lody_board_line_pin', {
      nodeId: ids[0]!,
      pinned: false,
    });
    expect(unpin.isError).toBe(false);
    expect(JSON.parse(unpin.text).pins).toHaveLength(BOARD_LINE_MAX_PINS - 1);
  });

  it('strictly caps serialized fold and segment expand payloads to <= 32 KiB UTF-8 and supports lossless charOffset continuation', async () => {
    const cjkSummary = '中文摘要内容测试段落。'.repeat(1200); // 12,000 CJK chars ≈ 36 KiB UTF-8
    const hugeTurnText = Array.from(
      { length: 1500 },
      (_, i) => `[段${String(i).padStart(4, '0')}中文正文]`
    ).join(''); // ~19,500 chars, ~45 KiB UTF-8

    await coordinatorSessionData.commands.appendTurn({
      id: 'huge-cjk-turn',
      role: 'user',
      timestamp: '2026-11-25T12:00:00.000Z',
      items: [{ type: 'text', text: hugeTurnText }],
      fileDiff: [],
    });
    const segBig = await lineStore.appendSegment(WORKSPACE, board.id, {
      id: 'seg_c0000001',
      coversFrom: '2026-11-25T12:00:00.000Z',
      coversTo: '2026-11-25T12:01:00.000Z',
      title: 'Huge CJK Segment',
      summary: cjkSummary,
      summaryQuality: 'written',
      outcome: 'rolled',
      turnRange: { startTurnId: 'huge-cjk-turn', endTurnId: 'huge-cjk-turn', turnCount: 1 },
    });

    const callAsMember = createCaller({ sessionId: SESSION });

    // Reconstruct the entire huge CJK turn across charOffset pages while every response stays <= 32 KiB.
    let reconstructed = '';
    let charOffset: number | undefined;
    let pages = 0;
    for (;;) {
      const res = await callAsMember('lody_board_line_expand', {
        nodeId: segBig.meta.id,
        offset: 0,
        ...(charOffset !== undefined ? { charOffset } : {}),
      });
      expect(res.isError).toBe(false);
      expect(Buffer.byteLength(res.text, 'utf8')).toBeLessThanOrEqual(32 * 1024);
      const payload = JSON.parse(res.text);
      if (pages === 0) {
        expect(payload.summaryTruncated).toBe(true);
        expect(payload.turns[0].truncated).toBe(true);
        expect(payload.turns[0].hint).toContain('nextCharOffset');
      } else {
        expect(payload.summary).toBeUndefined();
      }
      expect(payload.turns).toHaveLength(1);
      reconstructed += payload.turns[0].text;
      pages++;
      if (payload.nextCharOffset === undefined) {
        expect(payload.hasMore).toBe(false);
        break;
      }
      expect(payload.nextCharOffset).toBeGreaterThan(charOffset ?? 0);
      charOffset = payload.nextCharOffset;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBeGreaterThan(1);
    expect(reconstructed).toBe(hugeTurnText);

    // Fold node with huge fold summary + 5 large CJK children paginates cleanly with every page <= 32 KiB.
    const childIds: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const child = await lineStore.appendSegment(WORKSPACE, board.id, {
        id: `seg_f000000${i}`,
        coversFrom: `2026-11-2${i}T08:00:00.000Z`,
        coversTo: `2026-11-2${i}T09:00:00.000Z`,
        title: `CJK Child ${i}`,
        summary: `子段${i}：${'折叠正文内容测试。'.repeat(600)}`, // ~16 KiB UTF-8 each
        summaryQuality: 'written',
        outcome: 'rolled',
        turnRange: { startTurnId: `u-${i}`, endTurnId: `a-${i}`, turnCount: 1 },
      });
      childIds.push(child.meta.id);
    }
    const bigFold = await lineStore.appendFold(WORKSPACE, board.id, {
      id: 'fld_c0000001',
      covers: childIds,
      title: 'Huge CJK Fold',
      summary: cjkSummary,
    });
    const seenChildIds: string[] = [];
    let foldOffset = 0;
    let foldPages = 0;
    for (;;) {
      const res = await callAsMember('lody_board_line_expand', {
        nodeId: bigFold.meta.id,
        offset: foldOffset,
      });
      expect(res.isError).toBe(false);
      expect(Buffer.byteLength(res.text, 'utf8')).toBeLessThanOrEqual(32 * 1024);
      const payload = JSON.parse(res.text);
      if (foldPages === 0) {
        expect(payload.summaryTruncated).toBe(true);
      } else {
        expect(payload.summary).toBeUndefined();
      }
      expect(payload.children.length).toBeGreaterThan(0);
      seenChildIds.push(...payload.children.map((c: { id: string }) => c.id));
      foldPages++;
      if (!payload.hasMore) break;
      foldOffset = payload.nextOffset;
      expect(foldPages).toBeLessThan(10);
    }
    expect(foldPages).toBeGreaterThan(1);
    expect(seenChildIds).toEqual(childIds);
  });

  it('materializes only the requested segment page via readTurn without reading earlier turns and fails closed when keeper is unknown', async () => {
    for (let i = 1; i <= 25; i++) {
      await coordinatorSessionData.commands.appendTurn({
        id: `pre-${i}`,
        role: 'user',
        timestamp: `2026-11-25T08:${String(i).padStart(2, '0')}:00.000Z`,
        items: [{ type: 'text', text: `Earlier turn ${i}` }],
        fileDiff: [],
      });
    }
    for (let i = 1; i <= 6; i++) {
      await coordinatorSessionData.commands.appendTurn({
        id: `seg-turn-${i}`,
        role: 'user',
        timestamp: `2026-11-25T09:${String(i).padStart(2, '0')}:00.000Z`,
        items: [{ type: 'text', text: `Segment turn ${i}` }],
        fileDiff: [],
      });
    }
    const seg = await lineStore.appendSegment(WORKSPACE, board.id, {
      id: 'seg_0000cafe',
      coversFrom: '2026-11-25T09:01:00.000Z',
      coversTo: '2026-11-25T09:06:00.000Z',
      title: 'Indexed Segment',
      summary: 'Indexed summary.',
      summaryQuality: 'written',
      outcome: 'rolled',
      turnRange: { startTurnId: 'seg-turn-1', endTurnId: 'seg-turn-6', turnCount: 6 },
    });

    const readTurnSpy = vi.spyOn(coordinatorSessionData.history, 'readTurn');
    const callAsMember = createCaller({ sessionId: SESSION });
    const page = await callAsMember('lody_board_line_expand', {
      nodeId: seg.meta.id,
      offset: 2,
      limit: 2,
    });
    expect(page.isError).toBe(false);
    const parsed = JSON.parse(page.text);
    expect(parsed.turns.map((t: { id: string }) => t.id)).toEqual(['seg-turn-3', 'seg-turn-4']);
    expect(readTurnSpy.mock.calls.map((c) => c[0])).toEqual(['seg-turn-3', 'seg-turn-4']);

    // Unknown keeper (no board.files and no coordinatorMeta.machineId) fails closed with BOARD_LINE_LOCAL_ONLY.
    const callUnknownKeeper = createCaller({
      sessionId: 'coordinator' as SessionId,
      boardFilesMachine: null,
      coordinatorMachineId: null,
    });
    const expUnknown = await callUnknownKeeper('lody_board_line_expand', { nodeId: seg.meta.id });
    expect(expUnknown.isError).toBe(true);
    expect(expUnknown.text).toContain('BOARD_LINE_LOCAL_ONLY');

    const pinUnknown = await callUnknownKeeper('lody_board_line_pin', {
      nodeId: seg.meta.id,
      pinned: true,
    });
    expect(pinUnknown.isError).toBe(true);
    expect(pinUnknown.text).toContain('BOARD_LINE_LOCAL_ONLY');
  });
});
