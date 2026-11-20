import { describe, expect, it } from 'vitest';

import type { AssistantActivityRenderItem } from '../src/components/ai-gui/assistant-turn-render-blocks';
import {
  extractLatestStreamingThoughtPreview,
  extractStreamingThoughtPreviewFromText,
  inspectStreamingThoughtPreview,
  resolveLiveThoughtPreviewRowKey,
  STREAMING_THOUGHT_PREVIEW_INLINE_CLEANUP_CAP,
  STREAMING_THOUGHT_PREVIEW_MAX_CHARS,
} from '../src/components/ai-gui/streaming-thought-preview';

const thoughtEntry = (itemIndex: number, text: string): AssistantActivityRenderItem => ({
  itemIndex,
  content: { type: 'thought', text },
});

const toolEntry = (itemIndex: number, id: string): AssistantActivityRenderItem => ({
  itemIndex,
  content: {
    type: 'tool_call',
    toolCallId: id,
    title: `Run ${id}`,
    kind: 'execute',
    status: 'completed',
  },
});

describe('extractStreamingThoughtPreviewFromText', () => {
  it('strips the agy placeholder across casing, whitespace, and paragraph breaks', () => {
    expect(
      extractStreamingThoughtPreviewFromText("I'm thinking through how to approach this.")
    ).toBeNull();
    expect(
      extractStreamingThoughtPreviewFromText(
        "   i'm thinking through how to approach this.  \n\n\n"
      )
    ).toBeNull();
    expect(
      extractStreamingThoughtPreviewFromText(
        "I'm thinking through how to approach this.\n\n\nChecking view.tsx to locate the activity group."
      )
    ).toBe('Checking view.tsx to locate the activity group.');
    expect(
      extractStreamingThoughtPreviewFromText(
        "I'm thinking through how to approach this.\nInspecting the settings atoms next."
      )
    ).toBe('Inspecting the settings atoms next.');
    expect(
      extractStreamingThoughtPreviewFromText(
        "Earlier real thought.\n\n\nI'm thinking through how to approach this."
      )
    ).toBe('Earlier real thought.');
  });

  it('picks the latest non-empty paragraph across triple and double blank lines', () => {
    expect(
      extractStreamingThoughtPreviewFromText(
        'First paragraph about architecture.\n\n\nSecond paragraph about layout.\n\n\nThird paragraph verifying tests.\n\n'
      )
    ).toBe('Third paragraph verifying tests.');
    expect(
      extractStreamingThoughtPreviewFromText('First paragraph.\r\n  \r\nSecond paragraph.')
    ).toBe('Second paragraph.');
  });

  it('extracts Codex bold summary titles while ignoring unclosed streaming bold prefixes', () => {
    expect(
      extractStreamingThoughtPreviewFromText(
        '**Inspecting renderer layout**\nChecking how virtual rows measure headers.'
      )
    ).toBe('Inspecting renderer layout');

    expect(extractStreamingThoughtPreviewFromText('**Inspecting renderer')).toBeNull();
    expect(extractStreamingThoughtPreviewFromText('- **Inspecting renderer')).toBeNull();
    expect(extractStreamingThoughtPreviewFromText('> **Inspecting renderer')).toBeNull();

    expect(
      extractStreamingThoughtPreviewFromText(
        '**Checking previous step**\nBody text.\n\n**Inspecting rend'
      )
    ).toBe('Checking previous step');

    expect(
      extractStreamingThoughtPreviewFromText('**Inspecting renderer** with extra context')
    ).toBe('Inspecting renderer with extra context');
  });

  it('skips single-line, multi-line, and cross-paragraph HTML comments', () => {
    expect(
      extractStreamingThoughtPreviewFromText('<!-- internal marker -->\nVisible thought line.')
    ).toBe('Visible thought line.');

    expect(
      extractStreamingThoughtPreviewFromText(
        '<!--\nmultiline comment\n-->\n- 1. Checking `streaming_thought_preview` behavior'
      )
    ).toBe('Checking streaming_thought_preview behavior');

    expect(
      extractStreamingThoughtPreviewFromText('Fallback line.\n\n<!-- only a comment -->')
    ).toBe('Fallback line.');

    expect(extractStreamingThoughtPreviewFromText('<!-- Start\n\nHidden end.\n-->')).toBeNull();

    expect(
      extractStreamingThoughtPreviewFromText('Earlier visible.\n\n<!-- Start\n\nHidden end.\n-->')
    ).toBe('Earlier visible.');

    expect(
      extractStreamingThoughtPreviewFromText(
        'Earlier visible.\n\n<!-- Start\n\nStill streaming hidden text'
      )
    ).toBe('Earlier visible.');
  });

  it('cleans inline Markdown while protecting inline code literals and balanced-paren links', () => {
    expect(
      extractStreamingThoughtPreviewFromText(
        '> ### **Check** `view.tsx` and [AI GUI docs](https://example.com/docs) with _emphasis_, *italics*, and `activity_group_header` for 2 * 3 cases'
      )
    ).toBe(
      'Check view.tsx and AI GUI docs with emphasis, italics, and activity_group_header for 2 * 3 cases'
    );

    expect(
      extractStreamingThoughtPreviewFromText(
        'Inspecting `__init__`, `*ptr*`, `**literal**`, and ``code with `tick` `` with _real emphasis_'
      )
    ).toBe('Inspecting __init__, *ptr*, **literal**, and code with `tick` with real emphasis');

    expect(
      extractStreamingThoughtPreviewFromText(
        '[Read](https://example.com/a_(b)) and [Nested](https://example.com/a_(b_(c))) plus ![Graph](https://example.com/g_(1).png)'
      )
    ).toBe('Read and Nested plus Graph');
  });

  it('deterministically bounds cleanup on 138k+ thoughts, long unclosed bold, long comments, and middle paragraphs', () => {
    const fillerParagraph = 'Evaluating repository structure and test contracts in detail. '.repeat(
      14
    );
    const largeMultiParagraph = `${Array.from({ length: 170 }, () => fillerParagraph).join('\n\n\n')}\n\n\nFinal check on the trailing collapsed group.`;
    expect(largeMultiParagraph.length).toBeGreaterThan(138_000);

    const multiResult = inspectStreamingThoughtPreview(largeMultiParagraph);
    expect(multiResult.preview).toBe('Final check on the trailing collapsed group.');
    expect(multiResult.cleanedLineCount).toBe(1);
    expect(multiResult.cleanedCharCount).toBeLessThanOrEqual(
      STREAMING_THOUGHT_PREVIEW_INLINE_CLEANUP_CAP
    );

    const singleGiantParagraph = `Leading sentence for a massive unbroken thought. ${'word '.repeat(30_000)}`;
    expect(singleGiantParagraph.length).toBeGreaterThan(138_000);
    const giantResult = inspectStreamingThoughtPreview(singleGiantParagraph);
    expect(giantResult.preview).not.toBeNull();
    expect(
      giantResult.preview!.startsWith('Leading sentence for a massive unbroken thought.')
    ).toBe(true);
    expect(giantResult.preview!.length).toBeLessThanOrEqual(STREAMING_THOUGHT_PREVIEW_MAX_CHARS);
    expect(giantResult.preview!.endsWith('…')).toBe(true);
    expect(giantResult.cleanedLineCount).toBe(1);
    expect(giantResult.cleanedCharCount).toBe(STREAMING_THOUGHT_PREVIEW_INLINE_CLEANUP_CAP);

    // 138k single-line unclosed bold must never be sliced mid-line into a valid preview.
    const giantUnclosedBold = `**${'a'.repeat(138_000)}`;
    const unclosedBoldResult = inspectStreamingThoughtPreview(giantUnclosedBold);
    expect(unclosedBoldResult.preview).toBeNull();
    expect(unclosedBoldResult.cleanedCharCount).toBe(0);

    const giantQuotedUnclosedBold = `> **${'a'.repeat(138_000)}`;
    expect(inspectStreamingThoughtPreview(giantQuotedUnclosedBold).preview).toBeNull();

    // 138k single-line HTML comments (unclosed and closed) must never leak their tails.
    const giantUnclosedComment = `<!-- ${'c'.repeat(138_000)}`;
    const unclosedCommentResult = inspectStreamingThoughtPreview(giantUnclosedComment);
    expect(unclosedCommentResult.preview).toBeNull();
    expect(unclosedCommentResult.cleanedCharCount).toBe(0);

    const giantClosedComment = `<!-- ${'c'.repeat(138_000)} -->`;
    const closedCommentResult = inspectStreamingThoughtPreview(giantClosedComment);
    expect(closedCommentResult.preview).toBeNull();
    expect(closedCommentResult.cleanedCharCount).toBe(0);

    // Head and tail >8KB comment padding must not hide a valid middle paragraph.
    const commentPad = '<!-- comment line -->\n'.repeat(500);
    const middleValid = `${commentPad}\nMiddle valid reasoning paragraph.\n\n${commentPad}`;
    const middleResult = inspectStreamingThoughtPreview(middleValid);
    expect(middleResult.preview).toBe('Middle valid reasoning paragraph.');
    expect(middleResult.cleanedLineCount).toBe(1);
  });
});

describe('extractLatestStreamingThoughtPreview', () => {
  it('retains the latest thought when the group currently ends with tool calls', () => {
    const entries: AssistantActivityRenderItem[] = [
      thoughtEntry(0, 'First thought before reading files.'),
      toolEntry(1, 'tool-1'),
      thoughtEntry(
        2,
        "I'm thinking through how to approach this.\n\n\nComparing virtual row keys."
      ),
      toolEntry(3, 'tool-2'),
      toolEntry(4, 'tool-3'),
    ];
    expect(extractLatestStreamingThoughtPreview(entries)).toBe('Comparing virtual row keys.');
  });

  it('falls back to an earlier valid thought in the same group when the newest thought parses to null', () => {
    expect(
      extractLatestStreamingThoughtPreview([
        thoughtEntry(0, 'Earlier valid thought in group.'),
        toolEntry(1, 'tool-1'),
        thoughtEntry(2, '**Half typed heading'),
      ])
    ).toBe('Earlier valid thought in group.');

    expect(
      extractLatestStreamingThoughtPreview([
        thoughtEntry(0, 'Earlier valid thought in group.'),
        toolEntry(1, 'tool-1'),
        thoughtEntry(2, "I'm thinking through how to approach this."),
      ])
    ).toBe('Earlier valid thought in group.');
  });

  it('returns null for tool-only groups', () => {
    expect(extractLatestStreamingThoughtPreview([toolEntry(0, 'tool-1')])).toBeNull();
  });
});

describe('resolveLiveThoughtPreviewRowKey', () => {
  const collapsedThoughtRow = (
    key: string,
    id = 'turn-1',
    options: { finished?: boolean; endedAt?: number } = {}
  ) => ({
    type: 'assistant' as const,
    key,
    item: { message: { id, finished: options.finished ?? false, endedAt: options.endedAt } },
    content: {
      kind: 'activity_group_header' as const,
      expanded: false,
      block: { summary: { hasThought: true } },
    },
  });

  const footerRow = (id = 'turn-1', finished = false) => ({
    type: 'assistant' as const,
    key: `${id}:footer`,
    item: { message: { id, finished } },
    content: { kind: 'footer' as const },
  });

  const subagentTasksRow = (id = 'turn-1', finished = false) => ({
    type: 'assistant' as const,
    key: `${id}:subagent_tasks`,
    item: { message: { id, finished } },
    content: { kind: 'subagent_tasks' as const },
  });

  it('matches the trailing collapsed thought group across same-turn footer and subagent_tasks', () => {
    expect(resolveLiveThoughtPreviewRowKey([collapsedThoughtRow('row-1'), footerRow()], true)).toBe(
      'row-1'
    );

    expect(
      resolveLiveThoughtPreviewRowKey(
        [collapsedThoughtRow('row-1'), subagentTasksRow(), footerRow()],
        true
      )
    ).toBe('row-1');

    expect(
      resolveLiveThoughtPreviewRowKey([collapsedThoughtRow('row-1'), subagentTasksRow()], true)
    ).toBe('row-1');

    expect(
      resolveLiveThoughtPreviewRowKey([collapsedThoughtRow('row-1'), footerRow()], false)
    ).toBeNull();
  });

  it('rejects finished turns, turns with numeric endedAt, non-trailing groups, and cross-turn tails', () => {
    expect(
      resolveLiveThoughtPreviewRowKey(
        [collapsedThoughtRow('row-1', 'turn-1', { finished: true })],
        true
      )
    ).toBeNull();

    expect(
      resolveLiveThoughtPreviewRowKey(
        [collapsedThoughtRow('row-1', 'turn-1', { finished: false, endedAt: 1_700_000_000_000 })],
        true
      )
    ).toBeNull();

    // Expanded group never qualifies.
    expect(
      resolveLiveThoughtPreviewRowKey(
        [
          {
            ...collapsedThoughtRow('row-1'),
            content: {
              kind: 'activity_group_header',
              expanded: true,
              block: { summary: { hasThought: true } },
            },
          },
        ],
        true
      )
    ).toBeNull();

    // Group followed by prose (even before subagent_tasks/footer) does not qualify.
    expect(
      resolveLiveThoughtPreviewRowKey(
        [
          collapsedThoughtRow('row-1'),
          {
            type: 'assistant',
            key: 'row-prose',
            item: { message: { id: 'turn-1', finished: false } },
            content: { kind: 'content' },
          },
          subagentTasksRow(),
          footerRow(),
        ],
        true
      )
    ).toBeNull();

    // Earlier unfinished turn followed by a later user row or newer turn rows does not qualify.
    expect(
      resolveLiveThoughtPreviewRowKey([collapsedThoughtRow('row-1'), { type: 'user' }], true)
    ).toBeNull();
    expect(
      resolveLiveThoughtPreviewRowKey(
        [collapsedThoughtRow('row-1', 'turn-1'), subagentTasksRow('turn-2', false)],
        true
      )
    ).toBeNull();
    expect(
      resolveLiveThoughtPreviewRowKey(
        [collapsedThoughtRow('row-1', 'turn-1'), footerRow('turn-2', true)],
        true
      )
    ).toBeNull();
  });
});
