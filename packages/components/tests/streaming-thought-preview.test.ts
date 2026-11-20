import { describe, expect, it } from 'vitest';

import type { AssistantActivityRenderItem } from '../src/components/ai-gui/assistant-turn-render-blocks';
import {
  extractLatestStreamingThoughtPreview,
  extractStreamingThoughtPreviewFromText,
  resolveLiveThoughtPreviewRowKey,
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

  it('skips HTML comment lines and cleans inline Markdown while preserving identifiers', () => {
    expect(
      extractStreamingThoughtPreviewFromText(
        '<!-- internal marker -->\n> ### **Check** `view.tsx` and [AI GUI docs](https://example.com/docs) with _emphasis_, *italics*, and `activity_group_header` for 2 * 3 cases'
      )
    ).toBe(
      'Check view.tsx and AI GUI docs with emphasis, italics, and activity_group_header for 2 * 3 cases'
    );

    expect(
      extractStreamingThoughtPreviewFromText(
        '<!--\nmultiline comment\n-->\n- 1. Checking `streaming_thought_preview` behavior'
      )
    ).toBe('Checking streaming_thought_preview behavior');

    expect(
      extractStreamingThoughtPreviewFromText('Fallback line.\n\n<!-- only a comment -->')
    ).toBe('Fallback line.');
  });

  it('bounds long previews and handles 138k+ thoughts without full-text stalls', () => {
    const fillerParagraph = 'Evaluating repository structure and test contracts in detail. '.repeat(
      14
    );
    const largeMultiParagraph = `${Array.from({ length: 170 }, () => fillerParagraph).join('\n\n\n')}\n\n\nFinal check on the trailing collapsed group.`;
    expect(largeMultiParagraph.length).toBeGreaterThan(138_000);

    const start = performance.now();
    const extracted = extractStreamingThoughtPreviewFromText(largeMultiParagraph);
    const elapsedMs = performance.now() - start;

    expect(extracted).toBe('Final check on the trailing collapsed group.');
    expect(elapsedMs).toBeLessThan(50);

    const singleGiantParagraph = `Leading sentence for a massive unbroken thought. ${'word '.repeat(30_000)}`;
    expect(singleGiantParagraph.length).toBeGreaterThan(138_000);
    const giantPreview = extractStreamingThoughtPreviewFromText(singleGiantParagraph);
    expect(giantPreview).not.toBeNull();
    expect(giantPreview!.startsWith('Leading sentence for a massive unbroken thought.')).toBe(true);
    expect(giantPreview!.length).toBeLessThanOrEqual(STREAMING_THOUGHT_PREVIEW_MAX_CHARS);
    expect(giantPreview!.endsWith('…')).toBe(true);

    const commentTail = `Earlier valid reasoning.\n\n\n${'<!-- comment -->\n'.repeat(600)}`;
    expect(extractStreamingThoughtPreviewFromText(commentTail)).toBe('Earlier valid reasoning.');
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

  it('returns null for tool-only groups', () => {
    expect(extractLatestStreamingThoughtPreview([toolEntry(0, 'tool-1')])).toBeNull();
  });
});

describe('resolveLiveThoughtPreviewRowKey', () => {
  const collapsedThoughtRow = (key: string, id = 'turn-1', finished = false) => ({
    type: 'assistant' as const,
    key,
    item: { message: { id, finished } },
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

  it('matches only the trailing collapsed thought group of an unfinished turn', () => {
    expect(resolveLiveThoughtPreviewRowKey([collapsedThoughtRow('row-1'), footerRow()], true)).toBe(
      'row-1'
    );

    expect(
      resolveLiveThoughtPreviewRowKey([collapsedThoughtRow('row-1'), footerRow()], false)
    ).toBeNull();

    expect(
      resolveLiveThoughtPreviewRowKey([collapsedThoughtRow('row-1', 'turn-1', true)], true)
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

    // Group followed by prose does not qualify.
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
        ],
        true
      )
    ).toBeNull();

    // Earlier unfinished turn followed by a later user row or newer turn footer does not qualify.
    expect(
      resolveLiveThoughtPreviewRowKey([collapsedThoughtRow('row-1'), { type: 'user' }], true)
    ).toBeNull();
    expect(
      resolveLiveThoughtPreviewRowKey(
        [collapsedThoughtRow('row-1', 'turn-1'), footerRow('turn-2', true)],
        true
      )
    ).toBeNull();
  });
});
