import {
  LODY_MAX_CHAIN_DEPTH,
  normalizeBoardMeta,
  type BoardId,
  type BoardMeta,
  type LocalProjectId,
  type MachineId,
  type SessionHistoryInput,
  type SessionId,
} from '@lody/shared';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOARD_COMPACT_USAGE_DROP_MIN_BASELINE,
  BoardCompactReinjectTracker,
  buildBoardCompactReminder,
  createFileBoardCompactReinjectStore,
  createMemoryBoardCompactReinjectStore,
  detectContextUsageDropCompaction,
  extractTurnPromptText,
  hasCompletedCompactionMarker,
  isExplicitCompactCommand,
  isSlashCommandInput,
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

    it('identifies slash commands while ignoring filesystem paths and normal text', () => {
      expect(isSlashCommandInput('/compact')).toBe(true);
      expect(isSlashCommandInput('/compact focus on tests')).toBe(true);
      expect(isSlashCommandInput('/status')).toBe(true);
      expect(isSlashCommandInput('/review-pr 123')).toBe(true);
      expect(isSlashCommandInput('/foo_bar')).toBe(true);

      expect(isSlashCommandInput('/home/dreaife/Lody/README.md check this')).toBe(false);
      expect(isSlashCommandInput('/etc/hosts')).toBe(false);
      expect(isSlashCommandInput('continue fixing the bug')).toBe(false);
      expect(isSlashCommandInput('')).toBe(false);
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
  });

  describe('BoardCompactReinjectTracker dispatch-source handling', () => {
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

    it('injects for inbox dispatch when pending, and skips maintenance turns', async () => {
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
        usedHistoryReplay: false,
        turnInputText: 'Lody maintenance.',
        promptBlocks: [{ type: 'text', text: 'Lody maintenance.' }],
        loadBoardContext: async () => ({ board }),
      });
      expect(maintenance.injected).toBe(false);
      expect(maintenance.promptBlocks).toHaveLength(1);

      const inbox = await tracker.maybeAppendReminderToPromptBlocks({
        sessionId,
        meta,
        dispatchSource: 'inbox',
        usedHistoryReplay: false,
        turnInputText: 'The results returned by delegated work follow.',
        promptBlocks: [{ type: 'text', text: 'The results returned by delegated work follow.' }],
        loadBoardContext: async () => ({ board }),
      });
      expect(inbox.injected).toBe(true);
      expect(inbox.promptBlocks).toHaveLength(2);
      expect(inbox.promptBlocks[1]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('<board_context_reminder>'),
      });
    });
  });
});
