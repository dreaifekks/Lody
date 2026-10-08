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

  it('groups a run of steps under what it did and leaves thinking out', () => {
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
    const group = page.querySelector<HTMLDetailsElement>('details.group')!;
    expect(group.open).toBe(false);
    expect(group.querySelector(':scope > summary')?.textContent).toBe('Ran 1 command');
    // The step inside restores its title from the first command.
    expect(group.querySelector('details.tool > summary')?.textContent).toBe('ls -la');
    expect(page.textContent).not.toContain('Let me look.');
    expect(page.querySelector('img')?.getAttribute('src')).toBe('/s/x/d/y/a1');
    expect(page.textContent).not.toContain('not shown');
    expect(page.textContent).not.toContain('ignored');
  });

  describe('a finished turn', () => {
    const command = (id: string, line: string, status = 'completed') => ({
      type: 'tool_call',
      toolCallId: id,
      status,
      content: [{ type: 'terminal_command', command: line }],
    });
    const report = `The cause: ${'the test waits on a real timer. '.repeat(10)}`.trim();
    const turn = (fields: { [key: string]: Json }) => ({
      id: 'a1',
      role: 'assistant',
      timestamp: '2026-10-09T08:00:00.000Z',
      items: [
        { type: 'thought', text: 'Let me look.' },
        { type: 'text', text: 'Running the tests first.' },
        command('t1', 'pnpm test'),
        command('t2', 'vitest --repeat 200', 'failed'),
        { type: 'text', text: report },
        command('t3', 'pnpm test'),
        { type: 'text', text: 'Fixed:\n\n- fake timers' },
      ],
      ...fields,
    });
    /** What a reader sees of each assistant row: a closed step shows its summary only. */
    const shown = (page: HTMLElement) =>
      [...page.querySelectorAll<HTMLElement>('.message > *')]
        .filter((node) => !node.hidden)
        .map((node) =>
          (node instanceof HTMLDetailsElement && !node.open
            ? node.querySelector('summary')
            : node
          )?.textContent
            ?.replace(/\s+/g, ' ')
            .trim()
        );

    it('shows the answer and folds its work into one row with the duration', () => {
      const page = render([
        turn({ finished: true, endedAt: Date.parse('2026-10-09T08:01:44.000Z') }),
      ]);
      expect(shown(page)).toEqual(['Worked for 1m 44s', report, 'Fixed: fake timers']);

      const row = page.querySelector<HTMLButtonElement>('button.worked')!;
      expect(row.getAttribute('aria-expanded')).toBe('false');
      row.click();
      expect(row.getAttribute('aria-expanded')).toBe('true');
      // Expanded, the work is back in its place: each run of steps one folded row.
      expect(shown(page)).toEqual([
        'Worked for 1m 44s',
        'Running the tests first.',
        'Ran 2 commands',
        report,
        'Ran 1 command',
        'Fixed: fake timers',
      ]);
      expect([...page.querySelectorAll('details')].every((node) => !node.open)).toBe(true);
      const group = page.querySelector<HTMLDetailsElement>('details.group')!;
      group.open = true;
      expect(
        [...group.querySelectorAll('details.tool > summary')].map((node) => node.textContent)
      ).toEqual(['pnpm test', 'vitest --repeat 200']);
      expect(group.querySelector('details.failed')?.textContent).toContain('vitest --repeat 200');
      expect(page.textContent).not.toContain('Let me look.');
      row.click();
      expect(shown(page)).toHaveLength(3);
    });

    it('counts the steps when the history holds no duration, less any permission wait', () => {
      expect(render([turn({ finished: true })]).querySelector('.worked')?.textContent).toBe(
        'Took 3 steps'
      );
      const waited = render([
        turn({ endedAt: Date.parse('2026-10-09T08:01:00.000Z'), permissionWaitMs: 50_000 }),
      ]);
      expect(waited.querySelector('.worked')?.textContent).toBe('Worked for 10s');
    });

    it('folds nothing while the turn runs or when it ends in work', () => {
      const running = render([turn({})]);
      expect(running.querySelector('.worked')).toBeNull();
      expect(shown(running)).toEqual([
        'Running the tests first.',
        'Ran 2 commands',
        report,
        'Ran 1 command',
        'Fixed: fake timers',
      ]);

      const endsInWork = render([
        {
          id: 'a1',
          role: 'assistant',
          finished: true,
          items: [{ type: 'text', text: 'Checking.' }, command('t1', 'pnpm test')],
        },
      ]);
      expect(endsInWork.querySelector('.worked')).toBeNull();
      expect(shown(endsInWork)).toEqual(['Checking.', 'Ran 1 command']);
    });

    it('keeps the answer a thin closing note follows', () => {
      const page = render([
        {
          id: 'a1',
          role: 'assistant',
          finished: true,
          items: [
            { type: 'text', text: 'Starting.' },
            command('t1', 'pnpm build'),
            { type: 'text', text: 'The build is in dist/app.js.' },
            command('t2', 'cat task.log'),
            { type: 'text', text: 'The background task finished too.' },
          ],
        },
      ]);
      expect(shown(page)).toEqual([
        'Took 2 steps',
        'The build is in dist/app.js.',
        'The background task finished too.',
      ]);
    });

    it('folds a plan and the work after its approval each on its own', () => {
      const page = render([
        turn({
          finished: true,
          endedAt: Date.parse('2026-10-09T08:00:30.000Z'),
          items: [
            { type: 'thought', text: 'Planning.' },
            { type: 'text', text: 'Plan:\n\n1. fix the timer' },
            { type: 'tool_call', toolCallId: 'p', kind: 'switch_mode', title: 'Exited Plan Mode' },
            command('t1', 'pnpm test'),
            { type: 'text', text: 'Done.' },
          ],
        }),
      ]);
      expect([...page.querySelectorAll('.worked')].map((row) => row.textContent)).toEqual([
        'Finished working',
        'Worked for 30s',
      ]);
      expect(shown(page)).toContain('Exited Plan Mode');
    });
  });

  it('counts what a group did as the desktop does, in the reader language', () => {
    const tool = (kind: string, fields: { [key: string]: Json } = {}) => ({
      type: 'tool_call',
      toolCallId: kind,
      kind,
      status: 'completed',
      title: kind,
      ...fields,
    });
    const items = [
      tool('read', { locations: [{ path: 'a.ts' }] }),
      tool('read', { locations: [{ path: 'a.ts' }] }),
      tool('edit', { content: [{ type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y' }] }),
      tool('write', { locations: [{ path: 'b.ts' }] }),
      tool('search'),
      tool('fetch'),
      tool('other'),
      tool('other', { content: [{ type: 'terminal_command', command: 'make' }] }),
      tool('think'),
    ];
    const history = [{ id: 'a1', role: 'assistant', items }];
    expect(render(history).querySelector('.group > summary')?.textContent).toBe(
      'Ran 1 command · Read 1 file · Edited 2 files · Ran 1 search · Fetched 1 resource · Called 1 tool'
    );
    const zh = renderHistory(
      { document, strings: STRINGS.zh, manifest, objectUrl: (id) => id },
      history
    );
    expect(zh.querySelector('.group > summary')?.textContent).toBe(
      '调用了 1 个命令 · 阅读了 1 个文件 · 编辑了 2 个文件 · 进行了 1 次搜索 · 获取了 1 项内容 · 调用了 1 个工具'
    );
    // Eight steps are shown; the `think` call is thinking.
    expect(render(history).querySelectorAll('.group details.tool')).toHaveLength(8);
  });

  it('times a turn that only thought, with nothing to show inside', () => {
    const page = render([
      {
        id: 'a1',
        role: 'assistant',
        timestamp: '2026-10-09T08:00:00.000Z',
        endedAt: Date.parse('2026-10-09T08:00:05.000Z'),
        items: [
          { type: 'thought', text: 'Private reasoning.' },
          { type: 'text', text: 'Yes.' },
        ],
      },
    ]);
    expect(page.querySelector('.worked')?.textContent).toBe('Worked for 5s');
    expect(page.querySelector('.group')).toBeNull();
    expect(page.textContent).not.toContain('Private reasoning.');
  });

  it('lists each conversation after the one that holds or opened it', () => {
    expect(orderConversations(manifest)).toEqual([
      { id: 'c1', depth: 0 },
      { id: 'c3', depth: 1 },
      { id: 'c2', depth: 2 },
    ]);
  });
});
