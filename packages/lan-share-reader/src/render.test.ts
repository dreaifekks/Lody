// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { projectLanShareHistory } from '../../shared/src/lan-share-visible';
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

/** What a reader sees of each message row: a closed step shows its summary only. */
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

const command = (id: string, line: string, status = 'completed') => ({
  type: 'tool_call',
  toolCallId: id,
  status,
  content: [{ type: 'terminal_command', command: line }],
});

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

    it('shows the answer and folds its work, earlier text however long, into one row', () => {
      const page = render([
        turn({ finished: true, endedAt: Date.parse('2026-10-09T08:01:44.000Z') }),
      ]);
      expect(shown(page)).toEqual(['Worked for 1m 44s', 'Fixed: fake timers']);

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
      expect(shown(page)).toHaveLength(2);
    });

    it('shows of a published turn exactly what it shows folded, and no row to open', () => {
      const finished = turn({ finished: true, endedAt: Date.parse('2026-10-09T08:01:44.000Z') });
      const published = render(projectLanShareHistory([finished]) as Json);
      expect(published.querySelector('.worked')).toBeNull();
      expect(published.querySelector('details')).toBeNull();
      // What a reader of the full history sees before opening the row.
      expect(shown(published)).toEqual(shown(render([finished])).slice(1));
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

    it('folds the answer a thin closing note follows, as the desktop does', () => {
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
      expect(shown(page)).toEqual(['Took 2 steps', 'The background task finished too.']);
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

  it('shows pictures in a row of their own, outside the text of the message', () => {
    const page = render([
      {
        id: 'u1',
        role: 'user',
        items: [
          { type: 'image', imageId: 'a1', fileName: 'chart.png' },
          { type: 'text', text: 'What is on this?' },
        ],
      },
      {
        id: 'a1',
        role: 'assistant',
        finished: true,
        items: [
          { type: 'image', imageId: 'a1' },
          { type: 'image', imageId: 'a1' },
          { type: 'text', text: 'The same chart, twice.' },
        ],
      },
    ]);
    const rows = (message: Element) =>
      [...message.children].map((node) => [node.className, node.querySelectorAll('img').length]);
    const [user, assistant] = [...page.querySelectorAll('.message')];
    expect(rows(user!)).toEqual([
      ['images', 1],
      ['bubble', 0],
    ]);
    expect(user!.querySelector('.bubble')?.textContent).toContain('What is on this?');
    expect(rows(assistant!)).toEqual([
      ['images', 2],
      ['md', 0],
    ]);
    // A click opens the whole picture.
    const link = page.querySelector<HTMLAnchorElement>('a.picture')!;
    expect([link.getAttribute('href'), link.target, link.rel]).toEqual([
      '/s/x/d/y/a1',
      '_blank',
      'noopener',
    ]);
  });

  it('says which agent, model and effort wrote a message, once per writer and without ids', () => {
    const agent = (fields: { [key: string]: Json }) => ({
      v: 1,
      kind: 'agent',
      sessionId: 'private-session',
      turnId: 'private-turn',
      agentConfigId: 'private-config',
      name: 'Claude Code',
      model: { id: 'opus', source: 'configured' },
      reasoningEffort: 'high',
      ...fields,
    });
    const answer = (id: string, text: string, author: Json) => ({
      id,
      role: 'assistant',
      finished: true,
      author,
      items: [{ type: 'text', text }],
    });
    const published = projectLanShareHistory([
      {
        id: 'u1',
        role: 'user',
        author: { v: 1, kind: 'human', userId: 'private-user' },
        items: [{ type: 'text', text: 'Why?' }],
      },
      // The model that ran and its effort, as the turn recorded them, are what is said.
      {
        ...answer('a1', 'First.', agent({})),
        modelInfo: {
          modelId: 'opus',
          name: 'Opus 5.5 (recommended)',
          _meta: { lodyThoughtLevel: 'High', other: 'private-meta' },
        },
      },
      answer('a2', 'Second.', agent({})),
      {
        id: 'u2',
        role: 'user',
        author: agent({ role: { id: 'private-role', revision: 3, name: 'Reviewer', emoji: '🔍' } }),
        items: [{ type: 'text', text: 'Check it.' }],
      },
      answer(
        'a3',
        'Third.',
        agent({ name: 'Codex', model: { id: 'gpt-x', name: 'GPT X', source: 'runtime' } })
      ),
    ]) as Json;
    expect(JSON.stringify(published)).not.toContain('private-');
    const page = render(published);
    expect(
      [...page.querySelectorAll('.message')].map(
        (message) => message.querySelector('.byline')?.textContent ?? null
      )
    ).toEqual([
      null,
      'Claude Code · Opus 5.5 · High',
      'Claude Code · opus · high',
      '🔍 Reviewer · opus · high',
      'Codex · GPT X · high',
    ]);
  });

  it('lists each conversation after the one that holds or opened it', () => {
    expect(orderConversations(manifest)).toEqual([
      { id: 'c1', depth: 0 },
      { id: 'c3', depth: 1 },
      { id: 'c2', depth: 2 },
    ]);
  });
});

describe('what a share publishes of a turn', () => {
  const long = `Findings so far: ${'the cache key ignores the locale. '.repeat(10)}`.trim();
  const structured = '## Next\n\n- read the cache\n- rebuild the key';
  const table = '| file | state |\n| --- | --- |\n| cache.ts | stale |';
  const answer = 'Fixed: the cache key now includes the locale.';
  const assistant = (id: string, items: Json[], fields: { [key: string]: Json } = {}) => ({
    id,
    role: 'assistant',
    timestamp: '2026-11-10T08:00:00.000Z',
    items,
    ...fields,
  });
  /** The history a share carries, as JSON, and the page a reader opens on it. */
  const publish = (history: Json[]) => {
    const published = projectLanShareHistory(history) as Json;
    return { json: JSON.stringify(published), page: render(published) };
  };
  const expectLeftOut = (json: string, texts: string[]) => {
    for (const text of texts) expect([text, json.includes(text)]).toEqual([text, false]);
  };

  it('publishes the closing text and no earlier text, however long or structured', () => {
    expect(long.length).toBeGreaterThanOrEqual(300);
    const { json, page } = publish([
      assistant(
        'a1',
        [
          { type: 'thought', text: 'Let me look.' },
          { type: 'text', text: long },
          command('t1', 'rg cacheKey'),
          { type: 'text', text: structured },
          command('t2', 'pnpm test'),
          { type: 'text', text: table },
          command('t3', 'pnpm test'),
          { type: 'text', text: answer },
          { type: 'text', text: 'All tests pass.' },
        ],
        { finished: true }
      ),
    ]);
    expectLeftOut(json, ['Findings so far', 'read the cache', 'cache.ts', 'Let me look.', 'rg ']);
    // The whole closing run is the answer.
    expect(shown(page)).toEqual([answer, 'All tests pass.']);
    expect(page.querySelector('.worked')).toBeNull();
  });

  it('publishes a thin closing note alone, not the text before it', () => {
    const { json, page } = publish([
      assistant(
        'a1',
        [
          { type: 'text', text: 'Starting the build.' },
          command('t1', 'pnpm build'),
          { type: 'text', text: 'The build is in dist/app.js.' },
          command('t2', 'cat task.log'),
          { type: 'text', text: 'Done.' },
        ],
        { finished: true }
      ),
    ]);
    expectLeftOut(json, ['Starting the build.', 'dist/app.js']);
    expect(shown(page)).toEqual(['Done.']);
  });

  it('publishes no text of a segment still running or showing no answer', () => {
    const { json, page } = publish([
      { id: 'u1', role: 'user', items: [{ type: 'text', text: 'Why is it stale?' }] },
      // Still running: what it said so far is the process, however long.
      assistant('a1', [{ type: 'text', text: long }, command('t1', 'rg cacheKey')]),
      assistant('a2', [command('t2', 'pnpm test'), { type: 'text', text: answer }]),
      // Over, but ending in work.
      assistant('a3', [{ type: 'text', text: structured }, command('t3', 'pnpm test')], {
        finished: true,
      }),
      // Cut off by a restart: the notice is no answer.
      assistant(
        'a4',
        [
          { type: 'text', text: table },
          command('t4', 'pnpm test'),
          { type: 'system_notice', name: 'chat_failed' },
        ],
        { finished: true }
      ),
      // The plan is answered; the work after its approval stopped mid-step.
      assistant(
        'a5',
        [
          { type: 'text', text: 'Plan: rebuild the key.' },
          { type: 'tool_call', toolCallId: 'p', kind: 'switch_mode', title: 'Exited Plan Mode' },
          command('t5', 'pnpm test'),
          { type: 'text', text: long },
          command('t6', 'pnpm build'),
        ],
        { finished: true }
      ),
    ]);
    expect((JSON.parse(json) as Array<{ id: string }>).map((entry) => entry.id)).toEqual([
      'u1',
      'a5',
    ]);
    expectLeftOut(json, ['Findings so far', answer, 'read the cache', 'cache.ts', 'Exited']);
    expect(shown(page)).toEqual(['Why is it stale?', 'Plan: rebuild the key.']);
  });

  describe('a plan-review or widget card', () => {
    const review = (fields: { [key: string]: Json } = {}) => ({
      type: 'tool_call',
      toolCallId: 'review',
      toolName: 'mcp__lody__lody_request_review',
      status: 'completed',
      rawInput: { title: 'Cache plan', markdown: '# Rebuild the cache key' },
      ...fields,
    });
    // Codex names the tool in its MCP envelope.
    const widget = {
      type: 'tool_call',
      toolCallId: 'widget',
      title: 'lody.lody_show_widget',
      status: 'completed',
      rawInput: {
        server: 'lody',
        tool: 'lody_show_widget',
        arguments: { title: 'Hit rate', widget_code: '<svg id="hit-rate"/>' },
      },
    };

    it('leaves the answer before it published, and is never published itself', () => {
      const closing = 'The hit rate is back to 98%.';
      const { json, page } = publish([
        assistant('a1', [{ type: 'text', text: answer }, review()], { finished: true }),
        assistant(
          'a2',
          [
            { type: 'text', text: long },
            command('t1', 'pnpm test'),
            { type: 'text', text: closing },
            widget,
          ],
          { finished: true }
        ),
      ]);
      expect((JSON.parse(json) as Array<{ items: Json[] }>).map((entry) => entry.items)).toEqual([
        [{ type: 'text', text: answer }],
        [{ type: 'text', text: closing }],
      ]);
      expectLeftOut(json, ['Findings so far', 'Cache plan', 'Rebuild', 'hit-rate', 'lody_']);
      expect(shown(page)).toEqual([answer, closing]);
    });

    it('closes no answer after work, and a failed call or a notification is a step', () => {
      const { json } = publish([
        assistant(
          'a1',
          [{ type: 'text', text: 'Drafting the plan.' }, command('t1', 'rg cacheKey'), review()],
          { finished: true }
        ),
        assistant('a2', [{ type: 'text', text: answer }, review({ status: 'failed' })], {
          finished: true,
        }),
        // A finished card whose input history did not keep has nothing to draw.
        assistant(
          'a3',
          [
            { type: 'text', text: answer },
            {
              type: 'tool_call',
              toolCallId: 'old',
              toolName: 'mcp__lody__lody_request_review',
              status: 'completed',
            },
          ],
          { finished: true }
        ),
        assistant(
          'a4',
          [
            { type: 'text', text: answer },
            {
              type: 'tool_call',
              toolCallId: 'notify',
              toolName: 'mcp__lody__lody_notify_user',
              status: 'completed',
              rawInput: { body: 'Done.' },
            },
          ],
          { finished: true }
        ),
      ]);
      expect(JSON.parse(json)).toEqual([]);
    });
  });

  it('shows a published turn as published, a picture between the answers of two segments too', () => {
    const plan = '## Plan\n\nRebuild the cache key.';
    const { json, page } = publish([
      assistant(
        'a1',
        [
          { type: 'text', text: plan },
          { type: 'image', imageId: 'a1', fileName: 'cache.png' },
          { type: 'tool_call', toolCallId: 'p', kind: 'switch_mode', title: 'Exited Plan Mode' },
          command('t1', 'pnpm test'),
          { type: 'text', text: 'Done.' },
        ],
        { finished: true, endedAt: Date.parse('2026-11-10T08:01:00.000Z') }
      ),
    ]);
    expectLeftOut(json, ['Exited', 'switch_mode', 'pnpm']);
    expect(page.querySelector('.worked')).toBeNull();
    const message = page.querySelector('.message')!;
    expect(
      [...message.children].map((node) => [node.className, (node as HTMLElement).hidden])
    ).toEqual([
      ['md', false],
      ['images', false],
      ['md', false],
    ]);
    expect(
      [...message.querySelectorAll('.md')].map((node) =>
        node.textContent?.replace(/\s+/g, ' ').trim()
      )
    ).toEqual(['Plan Rebuild the cache key.', 'Done.']);
    expect(message.querySelector('img')?.alt).toBe('cache.png');
  });

  it('publishes the pictures the desktop never folds, after the answer and between steps', () => {
    const { json, page } = publish([
      assistant(
        'a1',
        [
          { type: 'text', text: long },
          command('t1', 'pnpm screenshot'),
          { type: 'image', imageId: 'a1', fileName: 'before.png' },
          command('t2', 'pnpm build'),
          { type: 'text', text: answer },
          { type: 'image', imageId: 'a1', fileName: 'after.png' },
        ],
        { finished: true }
      ),
    ]);
    const [turn] = JSON.parse(json) as Array<{ items: Array<{ [key: string]: string }> }>;
    expect(turn?.items.map((item) => item.fileName ?? item.text)).toEqual([
      'before.png',
      answer,
      'after.png',
    ]);
    expectLeftOut(json, ['Findings so far', 'pnpm']);
    const message = page.querySelector('.message')!;
    expect([...message.children].map((node) => node.className)).toEqual(['images', 'md', 'images']);
    expect([...message.querySelectorAll('img')].map((node) => node.alt)).toEqual([
      'before.png',
      'after.png',
    ]);
    expect(message.querySelector('.md')?.textContent?.trim()).toBe(answer);
  });
});
