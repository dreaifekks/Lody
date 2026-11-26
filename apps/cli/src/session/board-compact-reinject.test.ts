import {
  LODY_MAX_CHAIN_DEPTH,
  normalizeBoardMeta,
  parseSessionNotification,
  type BoardId,
  type BoardMeta,
  type LocalProjectId,
  type MachineId,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOARD_COMPACT_USAGE_DROP_MIN_BASELINE,
  BOARD_CONTEXT_REMINDER_HEADER,
  BoardCompactReinjectTracker,
  buildBoardCompactReminder,
  createFileBoardCompactReinjectStore,
  createMemoryBoardCompactReinjectStore,
  detectContextUsageDropCompaction,
  extractTurnPromptText,
  hasCompletedCompactionMarker,
  hasNonTextInputBlocks,
  isExplicitCompactCommand,
  isExplicitCompactTurnInput,
  isSlashCommandInput,
  stripBoardCompactReminder,
} from './board-compact-reinject';

const makeBoard = (overrides: Partial<BoardMeta> = {}): BoardMeta =>
  normalizeBoardMeta({
    version: 1,
    id: 'bd_test' as BoardId,
    name: 'Lody Lan',
    purpose: 'Personal LAN fork features',
    instructions: 'Follow repository rules strictly.',
    coordinatorSessionId: 'session-coord' as SessionId,
    createdAtMs: 1_000,
    createdByUserId: 'owner-user',
    rules: {
      maxRoundsPerThread: 3,
      reportHumanTurns: false,
      executorConstraints: 'Keep files under files/<topic>/.',
    },
    ...overrides,
  })!;

describe('board-compact-reinject helpers', () => {
  describe('extractTurnPromptText', () => {
    it('returns the first non-empty trimmed text block, skipping attachments and blanks', () => {
      expect(
        extractTurnPromptText(
          [
            {
              type: 'image',
              imageId: 'img-1',
              mimeType: 'image/png',
            } as never,
            { type: 'text', text: '   ' },
            { type: 'text', text: '  /compact keep decisions  ' },
            { type: 'text', text: 'second block' },
          ],
          'fallback'
        )
      ).toBe('/compact keep decisions');
    });

    it('falls back to trimmed raw prompt when inputBlocks has no non-empty text', () => {
      expect(extractTurnPromptText([], '  /compact  ')).toBe('/compact');
      expect(extractTurnPromptText(undefined, '  hello  ')).toBe('hello');
      expect(extractTurnPromptText(undefined, undefined)).toBe('');
    });
  });

  describe('command detection', () => {
    it('matches bare and parameterized /compact commands only', () => {
      expect(isExplicitCompactCommand('/compact')).toBe(true);
      expect(isExplicitCompactCommand('  /compact  ')).toBe(true);
      expect(isExplicitCompactCommand('/compact keep key decisions')).toBe(true);
      expect(isExplicitCompactCommand('/compact\nkeep key decisions')).toBe(true);

      expect(isExplicitCompactCommand('/compaction')).toBe(false);
      expect(isExplicitCompactCommand('/compact-now')).toBe(false);
      expect(isExplicitCompactCommand('please /compact')).toBe(false);
      expect(isExplicitCompactCommand('/status')).toBe(false);
    });

    it('identifies slash commands including namespaced commands while ignoring filesystem paths and normal text', () => {
      expect(isSlashCommandInput('/compact')).toBe(true);
      expect(isSlashCommandInput('/compact focus on tests')).toBe(true);
      expect(isSlashCommandInput('/status')).toBe(true);
      expect(isSlashCommandInput('/review-pr 123')).toBe(true);
      expect(isSlashCommandInput('/foo_bar')).toBe(true);
      expect(isSlashCommandInput('/mcp:github:prompt')).toBe(true);
      expect(isSlashCommandInput('/mcp:github:prompt arg1')).toBe(true);
      expect(isSlashCommandInput('/plugin.cmd')).toBe(true);

      expect(isSlashCommandInput('/home/dreaife/Lody/README.md check this')).toBe(false);
      expect(isSlashCommandInput('/etc/hosts')).toBe(false);
      expect(isSlashCommandInput('continue fixing the bug')).toBe(false);
      expect(isSlashCommandInput('')).toBe(false);
    });

    it('requires pure-text input for explicit /compact turn detection (rejecting attachments/references)', () => {
      expect(isExplicitCompactTurnInput([{ type: 'text', text: '/compact' }])).toBe(true);
      expect(
        isExplicitCompactTurnInput([{ type: 'text', text: '  /compact keep decisions  ' }])
      ).toBe(true);
      expect(hasNonTextInputBlocks([{ type: 'text', text: '/compact' }])).toBe(false);

      const withImage = [
        { type: 'image', imageId: 'img-1', mimeType: 'image/png' },
        { type: 'text', text: '/compact' },
      ] as never;
      expect(hasNonTextInputBlocks(withImage)).toBe(true);
      expect(isExplicitCompactTurnInput(withImage, '/compact')).toBe(false);

      const withAttachment = [
        { type: 'text', text: '/compact' },
        { type: 'local_attachment', path: '/tmp/a.txt', name: 'a.txt' },
      ] as never;
      expect(isExplicitCompactTurnInput(withAttachment, '/compact')).toBe(false);
    });
  });

  describe('stripBoardCompactReminder', () => {
    const reminder = `<board_context_reminder>\n${BOARD_CONTEXT_REMINDER_HEADER}\n\nRole: thread.\n</board_context_reminder>`;

    it('strips trailing, leading, standalone, concatenated, and embedded Lody reminder blocks cleanly', () => {
      expect(stripBoardCompactReminder(`继续\n\n${reminder}`)).toBe('继续');
      expect(stripBoardCompactReminder(`继续${reminder}`)).toBe('继续');
      expect(stripBoardCompactReminder(`${reminder}\n\n继续`)).toBe('继续');
      expect(stripBoardCompactReminder(reminder)).toBe('');
      expect(stripBoardCompactReminder(`前文\n\n${reminder}\n\n后文`)).toBe('前文\n\n后文');
    });

    it('preserves user-authored XML that happens to reuse the <board_context_reminder> tag name', () => {
      const userXml = '请保留 <board_context_reminder>示例</board_context_reminder> 这段 XML';
      expect(stripBoardCompactReminder(userXml)).toBe(userXml);
      expect(stripBoardCompactReminder(`${userXml}\n\n${reminder}`)).toBe(userXml);
    });

    it('returns text without a reminder block verbatim', () => {
      expect(stripBoardCompactReminder('  keep spaces  ')).toBe('  keep spaces  ');
    });
  });

  describe('hasCompletedCompactionMarker', () => {
    it('returns true only for assistant entries containing a completed context_compaction tool call', () => {
      const completed = {
        id: 'assistant:1',
        role: 'assistant',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'c1',
            title: 'Compacting context',
            status: 'completed',
            activityKind: 'context_compaction',
          },
        ],
      } as unknown as SessionHistoryInput;
      expect(hasCompletedCompactionMarker(completed)).toBe(true);

      const failed = {
        id: 'assistant:2',
        role: 'assistant',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'c2',
            title: 'Compacting context',
            status: 'failed',
            activityKind: 'context_compaction',
          },
        ],
      } as unknown as SessionHistoryInput;
      expect(hasCompletedCompactionMarker(failed)).toBe(false);

      const inProgress = {
        id: 'assistant:3',
        role: 'assistant',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'c3',
            title: 'Compacting context',
            status: 'in_progress',
            activityKind: 'context_compaction',
          },
        ],
      } as unknown as SessionHistoryInput;
      expect(hasCompletedCompactionMarker(inProgress)).toBe(false);

      const ordinaryTool = {
        id: 'assistant:4',
        role: 'assistant',
        items: [{ type: 'tool_call', toolCallId: 't1', title: 'Read', status: 'completed' }],
      } as unknown as SessionHistoryInput;
      expect(hasCompletedCompactionMarker(ordinaryTool)).toBe(false);

      expect(hasCompletedCompactionMarker(undefined)).toBe(false);
    });
  });

  describe('detectContextUsageDropCompaction', () => {
    it('detects drops meeting baseline, ratio, and delta thresholds', () => {
      expect(
        detectContextUsageDropCompaction({
          startUsed: BOARD_COMPACT_USAGE_DROP_MIN_BASELINE,
          afterUsed: 20_000,
        })
      ).toBe(true);
      expect(
        detectContextUsageDropCompaction({
          startUsed: 100_000,
          afterUsed: 65_000,
        })
      ).toBe(true);
      // Mid-turn growth from below threshold to high peak, then sharp drop.
      expect(
        detectContextUsageDropCompaction({
          startUsed: 25_000,
          peakUsed: 95_000,
          afterUsed: 22_000,
        })
      ).toBe(true);
    });

    it('rejects false positives below baseline, ratio, delta, or when ineligible', () => {
      expect(detectContextUsageDropCompaction({ startUsed: 39_999, afterUsed: 10_000 })).toBe(
        false
      );
      // Ratio > 0.65 even though delta >= 20_000
      expect(detectContextUsageDropCompaction({ startUsed: 100_000, afterUsed: 66_000 })).toBe(
        false
      );
      // Ratio <= 0.65 even though delta < 20_000
      expect(detectContextUsageDropCompaction({ startUsed: 50_000, afterUsed: 32_500 })).toBe(
        false
      );
      expect(
        detectContextUsageDropCompaction({
          startUsed: 120_000,
          afterUsed: 20_000,
          ineligible: true,
        })
      ).toBe(false);
      expect(detectContextUsageDropCompaction({ startUsed: 120_000, afterUsed: undefined })).toBe(
        false
      );
      expect(detectContextUsageDropCompaction({ startUsed: 120_000, afterUsed: -1 })).toBe(false);
    });
  });

  describe('buildBoardCompactReminder', () => {
    it('renders concise coordinator boundaries, anchors, scope, rules, and instructions without first-turn bloat', () => {
      const board = makeBoard({
        context: {
          projects: [
            {
              kind: 'local',
              machineId: 'machine-1' as MachineId,
              localProjectId: 'local-project-1' as LocalProjectId,
              name: 'Lody',
            },
          ],
        },
      });
      const text = buildBoardCompactReminder({
        board,
        role: 'coordinator',
        directory: '/data/boards/ws/bd_test',
      });

      expect(text.startsWith('<board_context_reminder>\n')).toBe(true);
      expect(text.endsWith('\n</board_context_reminder>')).toBe(true);
      expect(text).toContain('Role: main session (coordinator) of Board "Lody Lan".');
      expect(text).toContain('Goal: Personal LAN fork features.');
      expect(text).toContain('Assign work only; do not implement tasks yourself');
      expect(text).toContain('lody_session_create');
      expect(text).toContain('REVERSE_CHAT_FORBIDDEN');
      expect(text).toContain(`Delegation chain cap: ${LODY_MAX_CHAIN_DEPTH}`);
      expect(text).toContain('lody_board_notes_replace');
      expect(text).toContain('/data/boards/ws/bd_test/files');
      expect(text).toContain('You maintain MEMORY.md.');
      expect(text).toContain('lody_help({command: TOOL_NAME})');
      expect(text).toContain('BOARD_PROJECT_OUT_OF_SCOPE');
      expect(text).toContain('Keep files under files/<topic>/.');
      expect(text).toContain('Follow repository rules strictly.');

      // First-turn one-off boilerplate is intentionally omitted.
      expect(text).not.toContain('article window ("Article")');
      expect(text).not.toContain('gh pr create');
      expect(text).not.toContain('lody-lan lan machines');
      expect(text).not.toContain('File paths in your replies');
    });

    it('renders thread boundaries, remote directory tools, and omits empty optional sections', () => {
      const board = makeBoard({
        purpose: '   ',
        instructions: '',
        rules: { maxRoundsPerThread: 3, reportHumanTurns: false, executorConstraints: '' },
      });
      const text = buildBoardCompactReminder({
        board,
        role: undefined,
        directory: undefined,
      });

      expect(text).toContain('Role: thread of Board "Lody Lan".');
      expect(text).not.toContain('Goal:');
      expect(text).toContain('Own this task end to end and report directly to the user.');
      expect(text).toContain('quote reviewer conclusions verbatim');
      expect(text).toContain('session-coord');
      expect(text).toContain('REVERSE_CHAT_FORBIDDEN');
      expect(text).toContain('only the main session may replace notes');
      expect(text).toContain('lody_board_files_list');
      expect(text).toContain('The main session maintains MEMORY.md.');
      expect(text).not.toContain('Thread rules from the Board settings:');
      expect(text).not.toContain('Board instructions');
      expect(text).not.toContain('Project scope:');
    });
  });

  describe('createFileBoardCompactReinjectStore', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
      for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('persists pending markers across store restarts and removes them on clear', async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lody-board-compact-reinject-'));
      tempDirs.push(rootDir);
      const sessionId = 'session-persist-1' as SessionId;

      const store1 = createFileBoardCompactReinjectStore({ rootDir });
      expect(await store1.has(sessionId)).toBe(false);
      await store1.mark(sessionId);
      expect(await store1.has(sessionId)).toBe(true);

      // Fresh store instance simulates CLI daemon restart.
      const store2 = createFileBoardCompactReinjectStore({ rootDir });
      expect(await store2.has(sessionId)).toBe(true);
      await store2.clear(sessionId);
      expect(await store2.has(sessionId)).toBe(false);

      const store3 = createFileBoardCompactReinjectStore({ rootDir });
      expect(await store3.has(sessionId)).toBe(false);
    });

    it('treats corrupt marker files gracefully as not pending', async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lody-board-compact-reinject-'));
      tempDirs.push(rootDir);
      const sessionId = 'session-corrupt-1' as SessionId;

      const store1 = createFileBoardCompactReinjectStore({ rootDir });
      await store1.mark(sessionId);
      // Corrupt the written marker file directly.
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(rootDir);
      expect(files).toHaveLength(1);
      await writeFile(path.join(rootDir, files[0]!), '{invalid-json', 'utf8');

      const store2 = createFileBoardCompactReinjectStore({ rootDir });
      expect(await store2.has(sessionId)).toBe(false);
    });

    it('does not poison the negative cache on transient non-ENOENT read errors', async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lody-board-compact-reinject-'));
      tempDirs.push(rootDir);
      const sessionId = 'session-transient-read-1' as SessionId;
      const markerPath = path.join(
        rootDir,
        `${createHash('sha256').update(sessionId).digest('hex')}.json`
      );
      const warn = vi.fn();

      // A directory at the marker path produces EISDIR on readFile (non-ENOENT).
      await mkdir(markerPath, { recursive: true });

      const store = createFileBoardCompactReinjectStore({
        rootDir,
        logger: { warn } as never,
      });
      expect(await store.has(sessionId)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);

      // Once the transient read failure resolves and a valid marker is on disk,
      // the SAME store instance must observe `true` rather than a poisoned `false`.
      await rm(markerPath, { recursive: true, force: true });
      await writeFile(
        markerPath,
        JSON.stringify({ version: 1, sessionId, markedAt: Date.now() }),
        'utf8'
      );

      expect(await store.has(sessionId)).toBe(true);
    });
  });

  describe('BoardCompactReinjectTracker dispatch-source, latching, and idle compaction', () => {
    const silentLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      success: () => {},
      debug: () => {},
      trace: () => {},
      setLevel: () => {},
      child: () => silentLogger,
      close: async () => {},
    } as never;

    it('injects for inbox dispatch when pending, and skips maintenance and goal turns without consuming pending', async () => {
      const store = createMemoryBoardCompactReinjectStore();
      const tracker = new BoardCompactReinjectTracker(store, silentLogger);
      const sessionId = 'session-inbox-1' as SessionId;
      const board = makeBoard();
      const meta = { id: sessionId, boardId: board.id } as never;

      await store.mark(sessionId);

      const maintenance = await tracker.maybeAppendReminderToPromptBlocks({
        sessionId,
        meta,
        dispatchSource: 'maintenance',
        turnInputText: 'Lody maintenance.',
        promptBlocks: [{ type: 'text', text: 'Lody maintenance.' }],
        loadBoardContext: async () => ({ context: { board } }),
      });
      expect(maintenance.injected).toBe(false);
      expect(maintenance.promptBlocks).toHaveLength(1);

      const goalBySource = await tracker.maybeAppendReminderToPromptBlocks({
        sessionId,
        meta,
        dispatchSource: 'goal',
        turnInputText: 'Continue the goal loop',
        promptBlocks: [{ type: 'text', text: 'Continue the goal loop' }],
        loadBoardContext: async () => ({ context: { board } }),
      });
      expect(goalBySource.injected).toBe(false);
      expect(await tracker.hasPending(sessionId)).toBe(true);

      const goalByControl = await tracker.maybeAppendReminderToPromptBlocks({
        sessionId,
        meta,
        dispatchSource: 'rpc',
        hasGoalControl: true,
        turnInputText: 'Start goal',
        promptBlocks: [{ type: 'text', text: 'Start goal' }],
        loadBoardContext: async () => ({ context: { board } }),
      });
      expect(goalByControl.injected).toBe(false);
      expect(await tracker.hasPending(sessionId)).toBe(true);

      const inbox = await tracker.maybeAppendReminderToPromptBlocks({
        sessionId,
        meta,
        dispatchSource: 'inbox',
        turnInputText: 'The results returned by delegated work follow.',
        promptBlocks: [{ type: 'text', text: 'The results returned by delegated work follow.' }],
        loadBoardContext: async () => ({ context: { board } }),
      });
      expect(inbox.injected).toBe(true);
      expect(inbox.promptBlocks).toHaveLength(2);
      expect(inbox.promptBlocks[1]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('<board_context_reminder>'),
      });
    });

    it('latches mid-turn usage drop even when context grows back before turn end (115k -> 22k -> 80k)', async () => {
      const store = createMemoryBoardCompactReinjectStore();
      const tracker = new BoardCompactReinjectTracker(store, silentLogger);
      const sessionId = 'session-latch-1' as SessionId;
      const meta = {
        id: sessionId,
        boardId: 'bd_test' as BoardId,
        contextWindowUsage: { size: 1_000_000, used: 80_000 },
      } as SessionMeta;

      tracker.beginTurn(sessionId, 'turn-1', { seedBaselineUsed: 115_000 });
      tracker.noteContextWindowUsageUpdate(sessionId, { size: 1_000_000, used: 22_000 });
      tracker.noteContextWindowUsageUpdate(sessionId, { size: 1_000_000, used: 80_000 });

      const result = await tracker.completeTurn({
        sessionId,
        turnId: 'turn-1',
        assistantTurnIds: ['turn-1'],
        meta,
        promptFailed: false,
        promptCompletedNormally: true,
        producedOutput: true,
        injectedBoardReminder: false,
        explicitCompactTriggered: false,
        turnStartUsed: 115_000,
        ineligibleForUsageDrop: false,
        readAssistantTurn: async () => undefined,
      });

      expect(result).toEqual({ compacted: true, reason: 'usage_drop' });
      expect(await tracker.hasPending(sessionId)).toBe(true);
      tracker.endTurn(sessionId, 'turn-1');
    });

    it('records spontaneous idle compaction updates for Board sessions only', async () => {
      const store = createMemoryBoardCompactReinjectStore();
      const tracker = new BoardCompactReinjectTracker(store, silentLogger);
      const boardSessionId = 'session-idle-board' as SessionId;
      const plainSessionId = 'session-idle-plain' as SessionId;

      const boardMeta = { id: boardSessionId, boardId: 'bd_test' as BoardId } as SessionMeta;
      const plainMeta = { id: plainSessionId } as SessionMeta;

      // Tool-call compaction lifecycle while idle (Claude idle compaction).
      tracker.noteLiveAcpUpdate(
        boardSessionId,
        parseSessionNotification({
          sessionId: 'acp-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'idle-compact-1',
            title: 'Compacting context',
            status: 'in_progress',
            _meta: { lody: { activity: { kind: 'context_compaction' } } },
          },
        }),
        { isMaintenance: false, readSessionMeta: async () => boardMeta }
      );
      expect(await tracker.hasPending(boardSessionId)).toBe(false);

      tracker.noteLiveAcpUpdate(
        boardSessionId,
        parseSessionNotification({
          sessionId: 'acp-1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'idle-compact-1',
            status: 'completed',
          },
        }),
        { isMaintenance: false, readSessionMeta: async () => boardMeta }
      );
      expect(await tracker.hasPending(boardSessionId)).toBe(true);

      // Ordinary non-Board sessions do not mark Board reminder store, but DO
      // invoke the generalized `onIdleCompaction` observer callback (Phase 2).
      const observedIdleSessions: SessionId[] = [];
      tracker.noteLiveAcpUpdate(
        plainSessionId,
        parseSessionNotification({
          sessionId: 'acp-2',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'idle-compact-plain',
            title: 'Compacting context',
            status: 'completed',
            _meta: { lody: { activity: { kind: 'context_compaction' } } },
          },
        }),
        {
          isMaintenance: false,
          readSessionMeta: async () => plainMeta,
          onIdleCompaction: (sid) => {
            observedIdleSessions.push(sid);
          },
        }
      );
      expect(await tracker.hasPending(plainSessionId)).toBe(false);
      expect(observedIdleSessions).toEqual([plainSessionId]);
    });

    it('detects mid-turn usage drop (90k -> 520k -> 30k -> 60k) on ordinary non-Board sessions without arming Board reminder store (Hard Trap #3)', async () => {
      const store = createMemoryBoardCompactReinjectStore();
      const tracker = new BoardCompactReinjectTracker(store, silentLogger);
      const sessionId = 'session-plain-midturn' as SessionId;
      const meta = {
        id: sessionId,
        contextWindowUsage: { size: 1_000_000, used: 60_000 },
      } as SessionMeta;

      tracker.beginTurn(sessionId, 'turn-plain-1', { seedBaselineUsed: 90_000 });
      tracker.noteContextWindowUsageUpdate(sessionId, { size: 1_000_000, used: 520_000 });
      tracker.noteContextWindowUsageUpdate(sessionId, { size: 1_000_000, used: 30_000 });
      tracker.noteContextWindowUsageUpdate(sessionId, { size: 1_000_000, used: 60_000 });

      const result = await tracker.completeTurn({
        sessionId,
        turnId: 'turn-plain-1',
        assistantTurnIds: ['turn-plain-1'],
        meta,
        promptFailed: false,
        promptCompletedNormally: true,
        producedOutput: true,
        injectedBoardReminder: false,
        explicitCompactTriggered: false,
        turnStartUsed: 90_000,
        ineligibleForUsageDrop: false,
        readAssistantTurn: async () => undefined,
      });

      expect(result).toEqual({ compacted: true, reason: 'usage_drop' });
      expect(await tracker.hasPending(sessionId)).toBe(false);
      tracker.endTurn(sessionId, 'turn-plain-1');
    });
  });
});
