import { describe, expect, it, vi } from 'vitest';
import type { SessionHistoryInput } from '@lody/shared';
import {
  BTW_MAIN_HISTORY_MAX_CHARS,
  buildBtwFollowUpPrompt,
  buildBtwInitialPrompt,
  formatMainConversationTail,
  readRecentMainHistoryEntries,
  selectRecentMainHistoryPositions,
} from './btw-context';

const makeEntry = (
  id: string,
  role: 'user' | 'assistant' | 'system',
  text: string,
  extraItems: NonNullable<SessionHistoryInput['items']> = []
): SessionHistoryInput => ({
  id,
  role,
  timestamp: '2026-11-22T00:00:00.000Z',
  items: [{ type: 'text', text }, ...extraItems],
});

describe('btw-context', () => {
  it('selects at most the last 8 user/assistant rounds and skips system entries', () => {
    const rows: Array<{ role: string }> = [];
    for (let i = 1; i <= 12; i += 1) {
      rows.push({ role: 'user' });
      rows.push({ role: 'system' });
      rows.push({ role: 'assistant' });
    }

    const positions = selectRecentMainHistoryPositions(rows, 8);
    expect(positions).toHaveLength(16);
    // Oldest kept round should be round 5 (index 4 * 3 = 12)
    expect(positions[0]).toBe(12);
    expect(positions.at(-1)).toBe(rows.length - 1);
    for (const pos of positions) {
      expect(rows[pos]?.role).not.toBe('system');
    }
  });

  it('prefers readHistorySelection when available on SessionBackend', async () => {
    const all = [
      makeEntry('u1', 'user', 'first'),
      makeEntry('a1', 'assistant', 'first reply'),
      makeEntry('u2', 'user', 'second'),
      makeEntry('a2', 'assistant', 'second reply'),
    ];
    const readHistory = vi.fn(async () => all);
    const readHistorySelection = vi.fn(
      async (select: (rows: readonly { role: unknown }[]) => readonly number[]) =>
        select(all).map((idx) => all[idx]!)
    );

    const entries = await readRecentMainHistoryEntries({
      readHistory,
      readHistorySelection: readHistorySelection as never,
    });
    expect(readHistorySelection).toHaveBeenCalledTimes(1);
    expect(readHistory).not.toHaveBeenCalled();
    expect(entries.map((e) => e.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('strips thinking blocks, redacts sensitive tokens, and bounds length to 16k chars', () => {
    const entries: SessionHistoryInput[] = [
      makeEntry('u1', 'user', 'Check token ghp_1234567890abcdefghij1234567890'),
      {
        id: 'a1',
        role: 'assistant',
        timestamp: '2026-11-22T00:00:01.000Z',
        items: [
          { type: 'thought', text: 'secret internal chain of thought should be omitted' },
          { type: 'text', text: 'Answer referencing Bearer abcdefghijklmnopqrstuvwxyz123456' },
          {
            type: 'tool_call',
            toolCallId: 'tc-1',
            title: 'Run tests',
            kind: 'execute',
            status: 'completed',
            content: [
              {
                type: 'terminal_output',
                output: `${'x'.repeat(1000)}TAIL_MARKER`,
              },
            ],
          },
        ],
      },
    ];

    const formatted = formatMainConversationTail(entries);
    expect(formatted).not.toContain('secret internal chain of thought');
    expect(formatted).not.toContain('<thinking>');
    expect(formatted).toContain('ghp_***');
    expect(formatted).toContain('Bearer ***');
    expect(formatted).toContain('TAIL_MARKER');
    expect(formatted.length).toBeLessThanOrEqual(BTW_MAIN_HISTORY_MAX_CHARS);

    // Oversized history gets bounded to BTW_MAIN_HISTORY_MAX_CHARS
    const hugeEntries: SessionHistoryInput[] = Array.from({ length: 10 }, (_, idx) =>
      makeEntry(
        `m-${idx}`,
        idx % 2 === 0 ? 'user' : 'assistant',
        `chunk-${idx}-${'z'.repeat(4000)}`
      )
    );
    const bounded = formatMainConversationTail(hugeEntries);
    expect(bounded.length).toBeLessThanOrEqual(BTW_MAIN_HISTORY_MAX_CHARS);
  });

  it('builds initial prompts with text-only hint, article context, and prior turns', () => {
    const textOnly = buildBtwInitialPrompt({
      question: '这段设计为什么去掉了 --process-per-session？',
      mainHistoryText: '=== Previous Conversation Context ===\n[User]\nDiscuss btw',
      articleContext: {
        path: 'files/btw-drawer/design.md',
        selection: '去掉 --process-per-session',
        excerpt: 'Full excerpt text',
        truncated: true,
      },
      readOnlyTools: false,
      priorTurns: [
        { role: 'user', text: 'earlier q' },
        { role: 'assistant', text: 'earlier a' },
      ],
    });

    expect(textOnly).toContain('开启只读查代码');
    expect(textOnly).toContain('Previous Conversation Context');
    expect(textOnly).toContain('Path: files/btw-drawer/design.md');
    expect(textOnly).toContain('<article_selection>');
    expect(textOnly).toContain('<article_excerpt truncated="true">');
    expect(textOnly).toContain('=== Prior /btw Conversation ===');
    expect(textOnly).toContain('<btw_question>');

    const readOnly = buildBtwInitialPrompt({
      question: 'Check acp-runner.ts',
      readOnlyTools: true,
    });
    expect(readOnly).toContain('Read-only repository inspection is enabled');
    expect(readOnly).not.toContain('开启只读查代码');
  });

  it('builds minimal follow-up prompts and only attaches changed selection or article path', () => {
    const baseArticle = {
      path: 'docs/a.md',
      selection: 'line 10',
      excerpt: 'full a',
    };

    // Unchanged article -> question only
    expect(
      buildBtwFollowUpPrompt({
        question: 'Can you clarify?',
        articleContext: baseArticle,
        previousArticleContext: baseArticle,
      })
    ).toBe('Can you clarify?');

    // Same path, new selection -> selection delta only (no full excerpt)
    const selectionDelta = buildBtwFollowUpPrompt({
      question: 'What about this line?',
      articleContext: { ...baseArticle, selection: 'line 42' },
      previousArticleContext: baseArticle,
    });
    expect(selectionDelta).toContain('=== Updated Article Selection ===');
    expect(selectionDelta).toContain('line 42');
    expect(selectionDelta).not.toContain('<article_excerpt');
    expect(selectionDelta).toContain('What about this line?');

    // Different path -> full new article context
    const newPath = buildBtwFollowUpPrompt({
      question: 'Compare with b.md',
      articleContext: { path: 'docs/b.md', excerpt: 'full b' },
      previousArticleContext: baseArticle,
    });
    expect(newPath).toContain('=== Current Article Context ===');
    expect(newPath).toContain('Path: docs/b.md');
    expect(newPath).toContain('full b');
  });
});
