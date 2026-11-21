import { describe, expect, it } from 'vitest';

import type { AssistantActivityRenderItem } from '../src/components/ai-gui/assistant-turn-render-blocks';
import {
  extractFirstThoughtPreviewFromText,
  extractLatestStreamingThoughtPreview,
  extractStreamingThoughtPreviewFromText,
  inspectStreamingThoughtPreview,
  resolveLiveThoughtPreviewRowKey,
  stripAgyPlaceholderFromMarkdown,
  STREAMING_THOUGHT_PREVIEW_INLINE_CLEANUP_CAP,
  STREAMING_THOUGHT_PREVIEW_MAX_CHARS,
  STREAMING_THOUGHT_PREVIEW_MAX_CLEANED_CHARS,
  STREAMING_THOUGHT_PREVIEW_MAX_CLEANED_LINES,
} from '../src/components/ai-gui/streaming-thought-preview';
import {
  buildCompactDirectoryEntries,
  extractFirstSentence,
  findActiveNonBackgroundTool,
  summarizeCompactTools,
} from '../src/components/ai-gui/compact-native-directory';
import { resolveBackgroundTaskStatus } from '../src/components/ai-gui/background-task-status-row';

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

    // Streaming incomplete prefixes of the agy placeholder at the trailing line are suppressed,
    // including when followed by skipped invalid lines, while genuine sentences starting with
    // "I'm" or later valid paragraphs remain visible.
    expect(extractStreamingThoughtPreviewFromText("I'm")).toBeNull();
    expect(
      extractStreamingThoughtPreviewFromText("I'm thinking through how to approach this")
    ).toBeNull();
    expect(
      extractStreamingThoughtPreviewFromText("I'm thinking through how\n\n**Half typed")
    ).toBeNull();
    expect(
      extractStreamingThoughtPreviewFromText(
        "Earlier real thought.\n\nI'm thinking through how\n\n**Half typed"
      )
    ).toBe('Earlier real thought.');
    expect(extractStreamingThoughtPreviewFromText("I'm\n\nReal paragraph.")).toBe(
      'Real paragraph.'
    );
    expect(
      extractStreamingThoughtPreviewFromText("Earlier real thought.\n\n\nI'm thinking through how")
    ).toBe('Earlier real thought.');
    expect(extractStreamingThoughtPreviewFromText("I'm checking the files.")).toBe(
      "I'm checking the files."
    );
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

    // Inline code containing `**` must not prematurely close a leading bold heading.
    expect(extractStreamingThoughtPreviewFromText('**Checking `**` in parser')).toBeNull();
    expect(extractStreamingThoughtPreviewFromText('**Checking `**` in parser**')).toBe(
      'Checking ** in parser'
    );
  });

  it('skips single-line, multi-line, and cross-paragraph HTML comments without misreading inline code', () => {
    expect(
      extractStreamingThoughtPreviewFromText('<!-- internal marker -->\nVisible thought line.')
    ).toBe('Visible thought line.');

    expect(
      extractStreamingThoughtPreviewFromText('Checking the `<!--` marker.\n\nRunning tests.')
    ).toBe('Running tests.');

    expect(extractStreamingThoughtPreviewFromText('Checking the `<!--` marker.')).toBe(
      'Checking the <!-- marker.'
    );

    // Backslash-escaped backtick does not open a code span, so the following HTML comment is stripped.
    expect(extractStreamingThoughtPreviewFromText('Checking \\`<!-- hidden -->` visible.')).toBe(
      'Checking ` visible.'
    );

    // Same-paragraph multiline inline code spans protect `<!--` across line breaks,
    // whereas a blank line ends the paragraph and lets a real HTML comment open.
    expect(
      extractStreamingThoughtPreviewFromText(
        'Inspecting `first line\n<!-- not a comment`\n\nRunning tests.'
      )
    ).toBe('Running tests.');
    expect(
      extractStreamingThoughtPreviewFromText(
        'Earlier visible.\n\nStart `unclosed\n\n<!-- real comment -->'
      )
    ).toBe('Start unclosed');

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

    // Quoted link titles with unbalanced parens, angle-bracket destinations, and nested image links.
    expect(
      extractStreamingThoughtPreviewFromText(
        '[the docs](https://example.org "Read this (first") and [![alt](logo.png)](https://example.org) and [Read](<https://example.org/a(b>) plus [Spec]( <https://example.org/x(y> "Title (1)" )'
      )
    ).toBe('the docs and alt and Read plus Spec');

    // Private-use characters such as U+E000 must pass through intact (no sentinel collision),
    // and oversized inline code spans crossing the cleanup cap must retain literal identifiers.
    expect(extractStreamingThoughtPreviewFromText('Keep \uE0000\uE001 and `__init__` intact')).toBe(
      'Keep \uE0000\uE001 and __init__ intact'
    );

    const longCodeSpan = `\`__init__ ${'a'.repeat(2_000)}\``;
    const longCodePreview = extractStreamingThoughtPreviewFromText(longCodeSpan);
    expect(longCodePreview).not.toBeNull();
    expect(longCodePreview!.startsWith('__init__ ')).toBe(true);
    expect(longCodePreview!.length).toBeLessThanOrEqual(STREAMING_THOUGHT_PREVIEW_MAX_CHARS);
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

    // 139k trailing formatting-only blank strikethrough lines must not trigger quadratic
    // backtracking or unbounded line-by-line cleanup, and must still fall back to valid prose.
    const trailingStrikethroughPad = `Valid earlier paragraph.\n\n${`~~${' '.repeat(1020)}~~\n`.repeat(136)}`;
    expect(trailingStrikethroughPad.length).toBeGreaterThan(139_000);
    const strikethroughResult = inspectStreamingThoughtPreview(trailingStrikethroughPad);
    expect(strikethroughResult.preview).toBe('Valid earlier paragraph.');
    expect(strikethroughResult.cleanedLineCount).toBe(1);
    expect(strikethroughResult.cleanedCharCount).toBe('Valid earlier paragraph.'.length);

    // Empty-label links/images are skipped cheaply and still fall back to earlier valid prose.
    const emptyLinkFlood = `Valid earlier paragraph.\n\n${`[](https://example.com/${'a'.repeat(1000)})\n`.repeat(136)}`;
    const emptyLinkResult = inspectStreamingThoughtPreview(emptyLinkFlood);
    expect(emptyLinkResult.preview).toBe('Valid earlier paragraph.');
    expect(emptyLinkResult.cleanedLineCount).toBe(1);
    expect(emptyLinkResult.cleanedCharCount).toBe('Valid earlier paragraph.'.length);

    // 9 lines of 1001-char empty-output links (with formatting-only labels) must never exceed
    // STREAMING_THOUGHT_PREVIEW_MAX_CLEANED_CHARS due to pre-deducted cleanup budgets.
    const nineEmptyOutputLinks = `Valid earlier paragraph.\n\n${`[** **](https://example.com/${'a'.repeat(972)})\n`.repeat(9)}`;
    const budgetResult = inspectStreamingThoughtPreview(nineEmptyOutputLinks);
    expect(budgetResult.cleanedLineCount).toBeLessThanOrEqual(
      STREAMING_THOUGHT_PREVIEW_MAX_CLEANED_LINES
    );
    expect(budgetResult.cleanedCharCount).toBeLessThanOrEqual(
      STREAMING_THOUGHT_PREVIEW_MAX_CLEANED_CHARS
    );

    // Dense HTML comments (552k) with no backticks and 524 distinct unclosed backtick lengths (~138k)
    // must remain strictly linear and deterministically bounded.
    const denseComments = `${'<!-- -->'.repeat(69_000)}\n\nVisible after dense comments.`;
    const denseCommentResult = inspectStreamingThoughtPreview(denseComments);
    expect(denseCommentResult.preview).toBe('Visible after dense comments.');
    expect(denseCommentResult.cleanedLineCount).toBe(1);

    const distinctTicks = Array.from({ length: 524 }, (_, idx) => '`'.repeat(idx + 1)).join(' ');
    expect(distinctTicks.length).toBeGreaterThan(138_000);
    const distinctTickBoldResult = inspectStreamingThoughtPreview(
      `Earlier valid line.\n\n**${distinctTicks} <!-- hidden -->`
    );
    expect(distinctTickBoldResult.preview).toBe('Earlier valid line.');
    expect(distinctTickBoldResult.cleanedLineCount).toBe(1);

    const distinctTickClosedBold = inspectStreamingThoughtPreview(
      `**Visible prefix ${distinctTicks} <!-- hidden -->**`
    );
    expect(distinctTickClosedBold.preview).toBe('Visible prefix');
    expect(distinctTickClosedBold.cleanedLineCount).toBe(1);
    expect(distinctTickClosedBold.cleanedCharCount).toBeLessThanOrEqual(
      STREAMING_THOUGHT_PREVIEW_INLINE_CLEANUP_CAP
    );

    // 110k+ repeated `****` formatting-only lines and 100k+ unclosed `**a` lines without backticks
    // must never scan past each line's `[start, end)` bounds and must fall back cleanly.
    const repeatedStars = `Valid earlier paragraph.\n\n${'****\n'.repeat(110_400)}`;
    const repeatedStarsResult = inspectStreamingThoughtPreview(repeatedStars);
    expect(repeatedStarsResult.preview).toBe('Valid earlier paragraph.');
    expect(repeatedStarsResult.cleanedLineCount).toBe(1);
    expect(repeatedStarsResult.cleanedCharCount).toBe('Valid earlier paragraph.'.length);

    const repeatedUnclosedBold = `Valid earlier paragraph.\n\n${'**a\n'.repeat(100_000)}`;
    const repeatedUnclosedBoldResult = inspectStreamingThoughtPreview(repeatedUnclosedBold);
    expect(repeatedUnclosedBoldResult.preview).toBe('Valid earlier paragraph.');
    expect(repeatedUnclosedBoldResult.cleanedLineCount).toBe(1);
    expect(repeatedUnclosedBoldResult.cleanedCharCount).toBe('Valid earlier paragraph.'.length);
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

describe('Option C compact-native directory & background task helpers', () => {
  it('extracts first sentences without splitting on filenames or version numbers', () => {
    expect(
      extractFirstSentence(
        'Checking assistant-turn-render-blocks.ts and view.tsx for v0.113.1. Next sentence.'
      )
    ).toBe('Checking assistant-turn-render-blocks.ts and view.tsx for v0.113.1.');
    expect(extractFirstSentence('先检查 view.tsx 的行界。再验证展开态。')).toBe(
      '先检查 view.tsx 的行界。'
    );
  });

  it('strips Antigravity placeholder paragraphs from Markdown and extracts the first real paragraph excerpt', () => {
    const raw =
      "I'm thinking through how to approach this.\n\n\nChecking `view.tsx` first. Then checking `surface.ts`.\n\n\nSecond paragraph.";
    expect(stripAgyPlaceholderFromMarkdown(raw)).toBe(
      'Checking `view.tsx` first. Then checking `surface.ts`.\n\nSecond paragraph.'
    );
    expect(extractFirstThoughtPreviewFromText(raw)).toBe(
      'Checking view.tsx first. Then checking surface.ts.'
    );
    expect(stripAgyPlaceholderFromMarkdown("I'm thinking through how to approach this.")).toBe('');
  });

  it('clusters adjacent completed read tools, skips placeholder-only thoughts, and excludes backgrounded tools from active running header', () => {
    const entries: AssistantActivityRenderItem[] = [
      thoughtEntry(0, "I'm thinking through how to approach this."),
      thoughtEntry(1, "I'm thinking through how to approach this.\n\n\nInspecting files."),
      {
        itemIndex: 2,
        content: {
          type: 'tool_call',
          toolCallId: 'r1',
          kind: 'read',
          title: 'Read packages/components/src/a.ts',
          locations: [{ path: 'packages/components/src/a.ts' }],
          status: 'completed',
        },
      },
      {
        itemIndex: 3,
        content: {
          type: 'tool_call',
          toolCallId: 'r2',
          kind: 'read',
          title: 'Read packages/components/src/b.ts',
          locations: [{ path: 'packages/components/src/b.ts' }],
          status: 'completed',
        },
      },
      {
        itemIndex: 4,
        content: {
          type: 'tool_call',
          toolCallId: 'bg-cmd',
          kind: 'execute',
          title: 'Run gh run watch 123',
          status: 'in_progress',
          backgroundTaskId: 'bg-123',
        },
      },
    ];

    expect(findActiveNonBackgroundTool(entries)).toBeNull();
    expect(summarizeCompactTools(entries)).toEqual({
      readFileCount: 2,
      editFileCount: 0,
      searchCount: 0,
      commandCount: 0,
      fetchCount: 0,
      otherCount: 0,
      backgroundCount: 1,
    });

    const dir = buildCompactDirectoryEntries(entries, { isLive: true });
    expect(dir.map((d) => d.kind)).toEqual(['thought', 'read_cluster', 'tool']);
    expect(dir[0]?.kind === 'thought' && dir[0].excerpt).toBe('Inspecting files.');
    expect(dir[1]?.kind === 'read_cluster' && dir[1].id).toBe('read-cluster:r1');
    expect(dir[1]?.kind === 'read_cluster' && dir[1].files.map((f) => f.fileName)).toEqual([
      'a.ts',
      'b.ts',
    ]);
    expect(dir[2]?.kind === 'tool' && dir[2].isBackgrounded).toBe(true);

    // Appending a 3rd adjacent read preserves the read cluster's stable identity.
    const withThirdRead: AssistantActivityRenderItem[] = [
      ...entries.slice(0, 4),
      {
        itemIndex: 4,
        content: {
          type: 'tool_call',
          toolCallId: 'r3',
          kind: 'read',
          title: 'Read packages/components/src/c.ts',
          locations: [{ path: 'packages/components/src/c.ts' }],
          status: 'completed',
        },
      },
      { ...entries[4]!, itemIndex: 5 },
    ];
    const dirWithThird = buildCompactDirectoryEntries(withThirdRead, { isLive: true });
    expect(dirWithThird[1]?.kind === 'read_cluster' && dirWithThird[1].id).toBe('read-cluster:r1');
    expect(
      dirWithThird[1]?.kind === 'read_cluster' && dirWithThird[1].files.map((f) => f.fileName)
    ).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('resolves silent background waiting vs wakeup pulse from backgroundTaskState and count', () => {
    expect(
      resolveBackgroundTaskStatus({
        liveStatus: { type: 'running', backgroundTaskState: 'background', backgroundTaskCount: 2 },
        hasUnfinishedAssistantTurn: false,
        hasPendingDispatch: false,
        isAwaitingQuestion: false,
      })
    ).toEqual({ mode: 'waiting', taskCount: 2 });

    expect(
      resolveBackgroundTaskStatus({
        liveStatus: { type: 'running', backgroundTaskState: 'running', backgroundTaskCount: 1 },
        hasUnfinishedAssistantTurn: false,
        hasPendingDispatch: false,
        isAwaitingQuestion: false,
      })
    ).toEqual({ mode: 'wakeup', taskCount: 1 });

    // Active main turn, pending dispatch, finalizing, or running without backgroundTaskState/count return null.
    expect(
      resolveBackgroundTaskStatus({
        liveStatus: { type: 'running', backgroundTaskState: 'background', backgroundTaskCount: 1 },
        hasUnfinishedAssistantTurn: true,
        hasPendingDispatch: false,
        isAwaitingQuestion: false,
      })
    ).toBeNull();
    expect(
      resolveBackgroundTaskStatus({
        liveStatus: { type: 'running', phase: 'finalizing' },
        hasUnfinishedAssistantTurn: false,
        hasPendingDispatch: false,
        isAwaitingQuestion: false,
      })
    ).toBeNull();
    expect(
      resolveBackgroundTaskStatus({
        liveStatus: { type: 'running' },
        hasUnfinishedAssistantTurn: false,
        hasPendingDispatch: false,
        isAwaitingQuestion: false,
      })
    ).toBeNull();
  });
});
