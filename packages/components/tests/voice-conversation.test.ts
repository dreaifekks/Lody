import { describe, expect, it } from 'vitest';
import type { SessionHistory } from '@lody/shared';
import {
  appendVoiceTranscript,
  buildVoiceRelay,
  buildVoiceSessionContext,
  buildVoiceTurnMessage,
  extractVoiceSay,
  looksUnfinished,
  parseVoiceTurn,
  resolveVoiceLatestReply,
  stripVoiceSay,
  VOICE_MERGE_WINDOW_MS,
  VOICE_MERGE_WINDOW_UNFINISHED_MS,
  VOICE_RELAY_MAX_CHARS,
  voiceMergeWindowMs,
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

    expect(reply).toEqual({
      key: 'a1',
      text: 'There are three files.',
      answersVoiceTurn: false,
      voiceTurns: [],
    });
  });

  it('skips a reply that is still running', () => {
    const reply = resolveVoiceLatestReply([
      replyTurn('a1', 'Old.'),
      turn({ id: 'u2', role: 'user' }),
      replyTurn('a2', 'Partial', false),
    ]);

    expect(reply).toEqual({ key: 'a1', text: 'Old.', answersVoiceTurn: false, voiceTurns: [] });
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

    expect(reply).toEqual({ key: 'a1', text: '', answersVoiceTurn: false, voiceTurns: [] });
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

  it('lists the spoken messages the reply answers, back to the previous reply', () => {
    const first = buildVoiceTurnMessage({ spoken: [], understanding: ['Run CI.'] });
    const second = buildVoiceTurnMessage({ spoken: [], understanding: ['Open a PR.'] });
    const third = buildVoiceTurnMessage({ spoken: [], understanding: ['Merge it.'] });

    expect(
      resolveVoiceLatestReply([
        userTurn('u1', first),
        replyTurn('a1', 'Green.'),
        userTurn('u2', second),
        userTurn('u3', 'typed aside'),
        userTurn('u4', third),
        replyTurn('a2', 'Done.'),
      ])?.voiceTurns
    ).toEqual([second, third]);
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
      replyTurn('a2', 'CI passed on all jobs.\n\n<lody-voice-say>CI 全部通过了。</lody-voice-say>'),
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
    expect(context).not.toContain('<lody-voice-turn>');
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
    expect(sections[0]).toBe('<lody-voice-turn>');
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
    expect(sections.at(-1)).toBe('</lody-voice-turn>');
    expect(message).toMatch(
      /<reply_instructions>\n.*<lody-voice-say>…<\/lody-voice-say>.*\n<\/reply_instructions>/s
    );
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

  it('still reads voice turns recorded before the rename', () => {
    const legacy = buildVoiceTurnMessage({
      spoken: [{ role: 'user', text: '跑一下测试' }],
      understanding: ['Run the tests.'],
    })
      .replace('<lody-voice-turn>', '<voice_turn>')
      .replace('</lody-voice-turn>', '</voice_turn>');

    expect(voiceTurnDisplayText(legacy)).toBe('跑一下测试');
    expect(
      resolveVoiceLatestReply([userTurn('u1', legacy), replyTurn('a1', 'Done.')])?.answersVoiceTurn
    ).toBe(true);
  });

  it('leaves ordinary messages alone', () => {
    expect(parseVoiceTurn('please fix <voice_turn> handling')).toBeNull();
    expect(parseVoiceTurn('please fix <lody-voice-turn> handling')).toBeNull();
    expect(voiceTurnDisplayText('hello')).toBeNull();
  });
});

describe('talking points', () => {
  const say = (body: string) => `<lody-voice-say>${body}</lody-voice-say>`;

  it('takes the last block and hides every one from the reply', () => {
    const reply = `Draft.\n${say('old')}\nDone: 3 files changed.\n\n${say('\n改好了，三个文件。需要你确认要不要推送。\n')}`;

    expect(extractVoiceSay(reply)).toEqual({
      say: '改好了，三个文件。需要你确认要不要推送。',
      rest: 'Draft.\n\nDone: 3 files changed.',
    });
    expect(extractVoiceSay(`Fixed. ${say('修好了。')}`)).toEqual({
      say: '修好了。',
      rest: 'Fixed.',
    });
  });

  it('has none when the reply wrote none', () => {
    expect(extractVoiceSay('Just text.')).toEqual({ say: null, rest: 'Just text.' });
  });

  it('hides a block still streaming, a half-written opening tag and the tail of a split block', () => {
    expect(stripVoiceSay('Answer.\n\n<lody-voice-say>改好')).toBe('Answer.');
    expect(stripVoiceSay('Answer. <lody-voi')).toBe('Answer.');
    expect(stripVoiceSay('Answer.\n<')).toBe('Answer.');
    expect(stripVoiceSay('了。</lody-voice-say>')).toBe('');
    expect(stripVoiceSay('No points here.')).toBe('No points here.');
  });

  it('leaves the tags alone inside code', () => {
    const reply = [
      '主模型回复里的 `<lody-voice-say>` 会交给语音念出来，用 `</lody-voice-say>` 收尾。',
      '',
      '```xml',
      say('代码块里的讲稿示例'),
      '<lody-voice-say>',
      '```',
      '',
      '后面还有好几段。',
    ].join('\n');

    expect(stripVoiceSay(reply)).toBe(reply);
    expect(extractVoiceSay(reply)).toEqual({ say: null, rest: reply });
    expect(stripVoiceSay('示例：\n```\n<lody-voi')).toBe('示例：\n```\n<lody-voi');
    expect(stripVoiceSay(`用 \`<lody-voice-say>\` 写讲稿。\n\n${say('讲稿。')}`)).toBe(
      '用 `<lody-voice-say>` 写讲稿。'
    );
  });

  it('hides a legacy <say> block only when it starts a line and ends the reply', () => {
    expect(stripVoiceSay('CI passed.\n\n<say>CI 全部通过了。</say>\n')).toBe('CI passed.');
    expect(stripVoiceSay('Done.\n  <say>\n改好了。\n</say>')).toBe('Done.');

    for (const text of [
      'Fixed. <say>修好了。</say>',
      'Draft.\n<say>old</say>\nDone: 3 files changed.',
      'Answer.\n\n<say>改好',
      '了。</say>',
      '回复里的 <say> 会交给语音念出来，最后用 </say> 收尾。',
    ]) {
      expect(stripVoiceSay(text), text).toBe(text);
    }
  });

  it('keeps the reply that only mentions <say>, whole', () => {
    const reply = [
      '- **语音对话**：带上 session 的上下文、你的原话会传给主模型、主模型回复里的 `<say>` 会交给语音念出来、结束时再用 `</say>` 收尾。',
      '- 正文里也可以直接写 <say> 和 </say> 这两个词。',
      '',
      '```xml',
      '<say>',
      '代码块里的讲稿示例',
      '</say>',
      '```',
      '',
      '后面还有好几段。',
    ].join('\n');

    expect(stripVoiceSay(reply)).toBe(reply);
  });

  it('never hands a legacy <say> block to the voice', () => {
    expect(extractVoiceSay('CI passed.\n<say>CI 全部通过了。</say>')).toEqual({
      say: null,
      rest: 'CI passed.',
    });
  });
});

describe('buildVoiceRelay', () => {
  it('relays the talking points, not the written reply, naming the requests it answers', () => {
    const relay = buildVoiceRelay(
      {
        key: 'a1',
        text: 'Long diff summary with `src/a.ts`.\n<lody-voice-say>改好了。</lody-voice-say>',
        answersVoiceTurn: true,
        voiceTurns: [],
      },
      ['Fix the test.', 'Run CI.']
    );

    expect(relay).toContain('"Fix the test." and "Run CI."');
    expect(relay).toContain('改好了。');
    expect(relay).not.toContain('src/a.ts');
  });

  it('falls back to the shortened written reply without talking points', () => {
    const relay = buildVoiceRelay(
      {
        key: 'a1',
        text: '字'.repeat(VOICE_RELAY_MAX_CHARS + 50),
        answersVoiceTurn: true,
        voiceTurns: [],
      },
      ['Fix it.']
    );

    expect(relay).toContain('wrote no talking points');
    expect(relay.match(/字+/)?.[0].length).toBe(VOICE_RELAY_MAX_CHARS);
  });

  it('frames a typed turn as a background update and an empty reply as such', () => {
    expect(
      buildVoiceRelay(
        {
          key: 'a1',
          text: '<lody-voice-say>好了</lody-voice-say>',
          answersVoiceTurn: false,
          voiceTurns: [],
        },
        []
      )
    ).toMatch(/^The background agent finished a turn the user typed/);
    expect(
      buildVoiceRelay({ key: 'a1', text: '', answersVoiceTurn: true, voiceTurns: [] }, ['Do it.'])
    ).toContain('finished without a written reply');
  });
});

describe('merge window', () => {
  it('reads trailing dashes, commas, ellipses and filler or connective words as unfinished', () => {
    for (const text of [
      '那么对于我们现在这个实践而言，它是如何',
      '我想看一下 -',
      '就是—',
      '先这样，',
      '然后……',
      '这个问题就是',
      '如果可以的话',
      'check the build and',
    ]) {
      expect(looksUnfinished(text), text).toBe(true);
    }
    for (const text of ['跑一下测试', '它是如何实现的？', '好的。', 'Run it', '', '  ']) {
      expect(looksUnfinished(text), text).toBe(false);
    }
  });

  it('is judged by the last thing the user said, not by the voice', () => {
    expect(voiceMergeWindowMs([])).toBe(VOICE_MERGE_WINDOW_MS);
    expect(
      voiceMergeWindowMs([
        { role: 'user', text: '它是如何' },
        { role: 'assistant', text: '嗯，' },
      ])
    ).toBe(VOICE_MERGE_WINDOW_UNFINISHED_MS);
    expect(
      voiceMergeWindowMs([
        { role: 'user', text: '它是如何' },
        { role: 'user', text: '落地的' },
      ])
    ).toBe(VOICE_MERGE_WINDOW_MS);
  });
});

describe('voice understanding that repeats the user', () => {
  const spoken = [
    { role: 'user' as const, text: '帮我看一下邮件，' },
    { role: 'assistant' as const, text: '好，我看一下。' },
    { role: 'user' as const, text: '顺便  回复一下 Alice' },
  ];

  it('is left out when every paraphrase is already in the user words', () => {
    const message = buildVoiceTurnMessage({
      spoken,
      understanding: [' 帮我看一下邮件。', '顺便回复一下alice!'],
    });

    expect(message).not.toContain('<voice_understanding>');
    expect(parseVoiceTurn(message)).toEqual({
      userWords: ['帮我看一下邮件，', '顺便 回复一下 Alice'],
      understanding: [],
    });
  });

  it('is kept whole when any paraphrase says something else', () => {
    const message = buildVoiceTurnMessage({
      spoken,
      understanding: ['帮我看一下邮件', 'Reply to Alice.'],
    });

    expect(parseVoiceTurn(message)?.understanding).toEqual(['帮我看一下邮件', 'Reply to Alice.']);
  });
});
