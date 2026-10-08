// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { STRINGS, orderConversations, renderHistory, type Json, type Manifest } from './render';

const manifest: Manifest = {
  rootConversationId: 'c1',
  conversations: [
    { id: 'c1', title: 'Root', historyObjectId: 'h1' },
    { id: 'c2', title: 'Opened', historyObjectId: 'h2', openedByConversationId: 'c3' },
    { id: 'c3', title: 'Child', historyObjectId: 'h3', parentConversationId: 'c1' },
  ],
  attachments: [{ id: 'a1', kind: 'image', objectId: 'a1' }],
};

const render = (history: Json) =>
  renderHistory(
    { document, strings: STRINGS.en, manifest, objectUrl: (id) => `/s/x/d/y/${id}` },
    history
  );

describe('the reader page', () => {
  it('renders Markdown without letting a conversation run anything', () => {
    const page = render([
      {
        id: 'u1',
        role: 'user',
        items: [
          {
            type: 'text',
            text: '**bold** <img src=x onerror=alert(1)> [link](javascript:alert(1)) <script>alert(1)</script>',
          },
        ],
      },
    ]);
    expect(page.querySelector('strong')?.textContent).toBe('bold');
    expect(page.querySelector('img')).toBeNull();
    expect(page.querySelector('script')).toBeNull();
    expect(page.querySelector('a')?.getAttribute('href') ?? '').not.toContain('javascript');
    expect(page.textContent).toContain('<script>alert(1)</script>');
  });

  it('folds thinking and tool calls, restoring a title from the first command', () => {
    const page = render([
      {
        id: 'a1',
        role: 'assistant',
        items: [
          { type: 'thought', text: 'Let me look.' },
          {
            type: 'tool_call',
            toolCallId: 't1',
            status: 'completed',
            content: [{ type: 'terminal_command', command: 'ls -la' }],
          },
          { type: 'text', text: 'Done.' },
          { type: 'image', imageId: 'a1' },
          { type: 'unknown_future_item', text: 'ignored' },
        ],
      },
      { id: 's1', role: 'system', items: [{ type: 'text', text: 'not shown' }] },
    ]);
    const folds = [...page.querySelectorAll('details')];
    expect(folds.map((node) => node.open)).toEqual([false, false]);
    expect(folds.map((node) => node.querySelector('summary')?.textContent)).toEqual([
      'Thinking',
      'ls -la',
    ]);
    expect(page.querySelector('img')?.getAttribute('src')).toBe('/s/x/d/y/a1');
    expect(page.textContent).not.toContain('not shown');
    expect(page.textContent).not.toContain('ignored');
  });

  it('lists each conversation after the one that holds or opened it', () => {
    expect(orderConversations(manifest)).toEqual([
      { id: 'c1', depth: 0 },
      { id: 'c3', depth: 1 },
      { id: 'c2', depth: 2 },
    ]);
  });
});
