import { describe, expect, it } from 'vitest';
import type { MessageContent } from '@lody/shared';
import { buildAssistantTurnRenderLayout } from '../src/components/ai-gui/assistant-turn-render-blocks';

const tool = (
  toolCallId: string,
  kind: Extract<MessageContent, { type: 'tool_call' }>['kind'],
  overrides: Partial<Extract<MessageContent, { type: 'tool_call' }>> = {}
): Extract<MessageContent, { type: 'tool_call' }> => ({
  type: 'tool_call',
  toolCallId,
  kind,
  status: 'completed',
  ...overrides,
});

describe('buildAssistantTurnRenderLayout', () => {
  it('folds earlier text and activity while keeping the final text run visible', () => {
    const layout = buildAssistantTurnRenderLayout(
      'assistant-1',
      [
        { type: 'thought', text: 'Inspect the renderer.' },
        tool('command-1', 'execute'),
        { type: 'text', text: 'I found the relevant component.' },
        tool('edit-1', 'edit'),
        { type: 'text', text: 'The renderer now collapses completed work.' },
      ],
      true
    );

    expect(layout.blocks.map((block) => block.kind)).toEqual([
      'activity_group',
      'content',
      'activity_group',
      'content',
    ]);
    expect(layout.segments[0]?.firstWorkBlockIndex).toBe(0);
    expect(layout.blocks.map((block) => layout.workBlockKeys.has(block.key))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('keeps the final text and trailing generated images outside the work group', () => {
    const layout = buildAssistantTurnRenderLayout(
      'assistant-1',
      [
        { type: 'thought', text: 'Generate the requested image.' },
        { type: 'text', text: 'Here is the finished image.' },
        {
          type: 'image_group',
          images: [{ imageId: 'image-1', mimeType: 'image/png', sizeBytes: 123 }],
        },
      ],
      true
    );

    expect(layout.blocks.map((block) => layout.workBlockKeys.has(block.key))).toEqual([
      true,
      false,
      false,
    ]);
  });

  it.each(['The bug is in the parser.', 'x'.repeat(300), '# Earlier finding'])(
    'folds earlier text before a later answer: %s',
    (earlier) => {
      const layout = buildAssistantTurnRenderLayout(
        'assistant-1',
        [
          { type: 'text', text: earlier },
          tool('command-1', 'execute'),
          { type: 'text', text: 'Confirmed by the reproduction.' },
        ],
        true
      );

      expect(layout.blocks.map((block) => layout.workBlockKeys.has(block.key))).toEqual([
        true,
        true,
        false,
      ]);
    }
  );

  it('keeps every adjacent trailing text block regardless of phase', () => {
    const layout = buildAssistantTurnRenderLayout(
      'tail',
      [
        { type: 'text', text: 'Earlier' },
        tool('read', 'read'),
        { type: 'text', text: 'First answer part' },
        { type: 'text', text: 'Second answer part', messagePhase: 'commentary' },
        {
          type: 'image_group',
          images: [{ imageId: 'generated', mimeType: 'image/png', sizeBytes: 123 }],
        },
      ],
      true
    );
    expect(layout.blocks.map((block) => layout.workBlockKeys.has(block.key))).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it('treats a finished activity-only turn as work even without a final text reply', () => {
    const layout = buildAssistantTurnRenderLayout(
      'assistant-1',
      [tool('command-1', 'execute')],
      true
    );

    expect(layout.workBlockKeys.size).toBe(1);
    expect(layout.segments[0]?.firstWorkBlockIndex).toBe(0);
  });
});

it('keeps independent agent surfaces visible while earlier prose folds', () => {
  const items: MessageContent[] = [
    { type: 'text', text: 'Short answer.' },
    tool('run', 'execute'),
    tool('review', 'other'),
    { type: 'text', text: 'Ready for review.' },
  ];
  const layout = buildAssistantTurnRenderLayout(
    'turn',
    items,
    true,
    false,
    (call) => call.toolCallId === 'review'
  );
  expect(layout.blocks.map((block) => [block.kind, layout.workBlockKeys.has(block.key)])).toEqual([
    ['content', true],
    ['activity_group', true],
    ['content', false],
    ['content', false],
  ]);
  const withoutSurface = buildAssistantTurnRenderLayout('turn', items, true);
  expect(withoutSurface.blocks.map((block) => block.kind)).toEqual([
    'content',
    'activity_group',
    'content',
  ]);
});

it('keeps the final answer visible before a trailing independent review card', () => {
  const items: MessageContent[] = [
    { type: 'text', text: 'Earlier progress.' },
    tool('read', 'read'),
    { type: 'text', text: 'Final answer.' },
    tool('review', 'other'),
  ];
  const layout = buildAssistantTurnRenderLayout(
    'review-tail',
    items,
    true,
    false,
    (call) => call.toolCallId === 'review'
  );
  expect(layout.blocks.map((block) => [block.kind, layout.workBlockKeys.has(block.key)])).toEqual([
    ['content', true],
    ['activity_group', true],
    ['content', false],
    ['content', false],
  ]);
});
