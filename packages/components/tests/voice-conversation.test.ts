import { describe, expect, it } from 'vitest';
import type { SessionHistory } from '@lody/shared';
import {
  appendVoiceTranscript,
  buildVoiceRelay,
  buildVoiceSessionContext,
  buildVoiceTurnMessage,
  extractVoiceSay,
  parseVoiceTurn,
  resolveVoiceLatestReply,
  stripVoiceSay,
  VOICE_RELAY_MAX_CHARS,
  voiceTurnDisplayText,
} from '../src/lib/voice-conversation';

const turn = (fields: Partial<SessionHistory> & Pick<SessionHistory, 'id' | 'role'>) =>
  ({ items: [], ...fields }) as unknown as SessionHistory;
const userTurn = (id: string, text: string) =>
  turn({ id, role: 'user', items: [{ type: 'text', text }] as never });
const replyTurn = (id: string, text: string, finished = true) =>
  turn({ id, role: 'assistant', finished, items: [{ type: 'text', text }] as never });

describe('resolveVoiceLatestReply', () => {
  it('reads the final message after the last tool call of the last finished reply', () => {
    const reply = resolveVoiceLatestReply([
      userTurn('u1', 'list files'),
      turn({
        id: 'a1',
        role: 'assistant',
        finished: true,
        items: [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_call', toolCallId: 't1' },
          { type: 'thought', text: 'three files' },
          { type: 'text', text: 'There are ' },
          { type: 'text', text: 'three files.' },
        ] as never,
      }),
    ]);

    expect(reply).toEqual({ key: 'a1', text: 'There are three files.', answersVoiceTurn: false });
  });

  it('skips a reply that is still running', () => {
    const reply = resolveVoiceLatestReply([
      replyTurn('a1', 'Old.'),
      turn({ id: 'u2', role: 'user' }),
      replyTurn('a2', 'Partial', false),
    ]);

    expect(reply).toEqual({ key: 'a1', text: 'Old.', answersVoiceTurn: false });
  });

  it('reports a finished reply that ends in a tool call as having no text', () => {
    const reply = resolveVoiceLatestReply([
      turn({
        id: 'a1',
        role: 'assistant',
        finished: true,
        items: [
          { type: 'text', text: 'Running it.' },
          { type: 'tool_call', toolCallId: 't1' },
        ] as never,
      }),
    ]);

    expect(reply).toEqual({ key: 'a1', text: '', answersVoiceTurn: false });
  });

  it('says whether the reply follows a spoken or a typed message', () => {
    const spoken = buildVoiceTurnMessage({ spoken: [], understanding: ['Run CI.'] });

    expect(
      resolveVoiceLatestReply([userTurn('u1', spoken), replyTurn('a1', 'Green.')])?.answersVoiceTurn
    ).toBe(true);
    expect(
      resolveVoiceLatestReply([
        userTurn('u1', spoken),
        replyTurn('a1', 'Green.'),
        userTurn('u2', 'typed'),
        replyTurn('a2', 'Ok.'),
      ])?.answersVoiceTurn
    ).toBe(false);
  });

  it('tells a reopened reply that finished again from its first finish', () => {
    const first = resolveVoiceLatestReply([
      turn({ ...replyTurn('a1', 'One.'), endedAt: 100 } as never),
    ]);
    const again = resolveVoiceLatestReply([
      turn({ ...replyTurn('a1', 'One. Two.'), endedAt: 200 } as never),
    ]);

    expect(first?.key).not.toBe(again?.key);
  });
});

describe('buildVoiceSessionContext', () => {
  it('has nothing to say about a session without text', () => {
    expect(buildVoiceSessionContext([])).toBeNull();
    expect(buildVoiceSessionContext([turn({ id: 'u1', role: 'user' })])).toBeNull();
  });

  it('lists the turns oldest first, voice turns as the user said them and replies by their talking points', () => {
    const spoken = buildVoiceTurnMessage({
      spoken: [{ role: 'user', text: '嗯，那个 CI 挂了没' }],
      understanding: ['Check whether CI failed.'],
    });
    const context = buildVoiceSessionContext([
      userTurn('u1', 'Fix the flaky test in   auth.ts'),
      replyTurn('a1', 'Fixed it by awaiting the token refresh.'),
      userTurn('u2', spoken),
      replyTurn('a2', 'CI passed on all jobs.\n\n<say>CI 全部通过了。</say>'),
      userTurn('u3', 'Now open a PR'),
      replyTurn('a3', 'Pushing the branch', false),
    ]);

    expect(context?.split('\n').slice(1)).toEqual([
      'User: Fix the flaky test in auth.ts',
      'Agent: Fixed it by awaiting the token refresh.',
      'User: 嗯，那个 CI 挂了没',
      'Agent: CI 全部通过了。',
      'User: Now open a PR',
      'Agent (still working): Pushing the branch',
    ]);
    expect(context).not.toContain('<voice_turn>');
  });

  it('shortens long messages and keeps the newest turns within the limit', () => {
    const turns = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0
        ? userTurn(`u${i}`, `request ${i} ${'x'.repeat(900)}`)
        : replyTurn(`a${i}`, `answer ${i} ${'y'.repeat(2_000)}`)
    );

    const context = buildVoiceSessionContext(turns, 3_000)!;

    expect(context.length).toBeLessThanOrEqual(3_000);
    const lines = context.split('\n').slice(1);
    expect(lines.at(-1)).toMatch(/^Agent: answer 39 y+…$/);
    expect(lines.at(-1)!.length).toBeLessThanOrEqual('Agent: '.length + 1_200);
    expect(lines.some((line) => line.startsWith('User: request 0 '))).toBe(false);
  });
});

describe('appendVoiceTranscript', () => {
  it('keeps the newest utterances within the limit and ignores silence', () => {
    let lines = appendVoiceTranscript([], { role: 'user', text: '  first\nline ' });
    lines = appendVoiceTranscript(lines, { role: 'assistant', text: '   ' });
    expect(lines).toEqual([{ role: 'user', text: 'first line' }]);

    lines = appendVoiceTranscript(lines, { role: 'assistant', text: 'a'.repeat(30) }, 40);
    lines = appendVoiceTranscript(lines, { role: 'user', text: 'b'.repeat(30) }, 40);

    expect(lines).toEqual([{ role: 'user', text: 'b'.repeat(30) }]);
  });
});

describe('voice turn messages', () => {
  it('carries the user words verbatim, what the voice said and its paraphrase marked as reference', () => {
    const message = buildVoiceTurnMessage({
      spoken: [
        { role: 'user', text: '进展到哪了' },
        { role: 'assistant', text: '测试已经修好，正在等 CI。' },
        { role: 'user', text: '嗯……帮我看一下那个 PR，啊不对，是十二号那个' },
        { role: 'assistant', text: '好，我看一下。' },
        { role: 'user', text: '顺便看下 CI' },
      ],
      understanding: ['Look at PR #12.', 'Also check its CI.'],
    });

    const sections = message.split('\n\n');
    expect(sections[0]).toBe('<voice_turn>');
    expect(sections[2]).toBe(
      [
        '<conversation>',
        'User: 进展到哪了',
        'Voice: 测试已经修好，正在等 CI。',
        'User: 嗯……帮我看一下那个 PR，啊不对，是十二号那个',
        'Voice: 好，我看一下。',
        'User: 顺便看下 CI',
        '</conversation>',
      ].join('\n')
    );
    expect(sections[3]).toBe(
      [
        '<voice_understanding>',
        "How the voice assistant understood the request. For reference only: where it differs from the user's words above, the user's words win.",
        '- Look at PR #12.',
        '- Also check its CI.',
        '</voice_understanding>',
      ].join('\n')
    );
    expect(sections.at(-1)).toBe('</voice_turn>');
    expect(message).toMatch(/<reply_instructions>\n.*<say>…<\/say>.*\n<\/reply_instructions>/s);
    expect(parseVoiceTurn(message)).toEqual({
      userWords: ['进展到哪了', '嗯……帮我看一下那个 PR，啊不对，是十二号那个', '顺便看下 CI'],
      understanding: ['Look at PR #12.', 'Also check its CI.'],
    });
    expect(voiceTurnDisplayText(message)).toBe(
      '进展到哪了\n嗯……帮我看一下那个 PR，啊不对，是十二号那个\n顺便看下 CI'
    );
  });

  it('falls back to the paraphrase when the user words were not transcribed', () => {
    const message = buildVoiceTurnMessage({ spoken: [], understanding: ['List the files.'] });

    expect(message).not.toContain('<conversation>');
    expect(voiceTurnDisplayText(message)).toBe('List the files.');
  });

  it('leaves ordinary messages alone', () => {
    expect(parseVoiceTurn('please fix <voice_turn> handling')).toBeNull();
    expect(voiceTurnDisplayText('hello')).toBeNull();
  });
});

describe('talking points', () => {
  it('takes the last <say> block and hides every one from the reply', () => {
    const reply =
      'Draft.\n<say>old</say>\nDone: 3 files changed.\n\n<say>\n改好了，三个文件。需要你确认要不要推送。\n</say>';

    expect(extractVoiceSay(reply)).toEqual({
      say: '改好了，三个文件。需要你确认要不要推送。',
      rest: 'Draft.\n\nDone: 3 files changed.',
    });
  });

  it('has none when the reply wrote none', () => {
    expect(extractVoiceSay('Just text.')).toEqual({ say: null, rest: 'Just text.' });
  });

  it('hides a block that is still streaming and the tail of a block split across items', () => {
    expect(stripVoiceSay('Answer.\n\n<say>改好')).toBe('Answer.');
    expect(stripVoiceSay('了。</say>')).toBe('');
    expect(stripVoiceSay('No points here.')).toBe('No points here.');
  });
});

describe('buildVoiceRelay', () => {
  it('relays the talking points, not the written reply, naming the requests it answers', () => {
    const relay = buildVoiceRelay(
      {
        key: 'a1',
        text: 'Long diff summary with `src/a.ts`.\n<say>改好了。</say>',
        answersVoiceTurn: true,
      },
      ['Fix the test.', 'Run CI.']
    );

    expect(relay).toContain('"Fix the test." and "Run CI."');
    expect(relay).toContain('改好了。');
    expect(relay).not.toContain('src/a.ts');
  });

  it('falls back to the shortened written reply without talking points', () => {
    const relay = buildVoiceRelay(
      { key: 'a1', text: '字'.repeat(VOICE_RELAY_MAX_CHARS + 50), answersVoiceTurn: true },
      ['Fix it.']
    );

    expect(relay).toContain('wrote no talking points');
    expect(relay.match(/字+/)?.[0].length).toBe(VOICE_RELAY_MAX_CHARS);
  });

  it('frames a typed turn as a background update and an empty reply as such', () => {
    expect(
      buildVoiceRelay({ key: 'a1', text: '<say>好了</say>', answersVoiceTurn: false }, [])
    ).toMatch(/^The background agent finished a turn the user typed/);
    expect(buildVoiceRelay({ key: 'a1', text: '', answersVoiceTurn: true }, ['Do it.'])).toContain(
      'finished without a written reply'
    );
  });
});
