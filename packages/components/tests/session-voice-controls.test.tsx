// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { atom } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionHistory } from '@lody/shared';
import type { VoiceCallHandlers } from '../src/hooks/use-voice-call';

/** A voice call the test drives by hand: it reports what the machine would. */
const call = vi.hoisted(() => ({
  handlers: null as VoiceCallHandlers | null,
  state: 'idle' as 'idle' | 'connecting' | 'active',
  mode: null as 'conversation' | 'dictation' | null,
  start: vi.fn(),
  stop: vi.fn(),
  append: vi.fn(async (_text: string) => {}),
}));

vi.mock('@/atoms/settings', () => ({ voiceFeatureEnabledAtom: atom(true) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/hooks/use-voice-call', () => ({
  useVoiceCall: (handlers: VoiceCallHandlers) => {
    call.handlers = handlers;
    return {
      state: call.state,
      mode: call.mode,
      available: true,
      start: call.start,
      stop: call.stop,
      append: call.append,
    };
  },
}));

const { SessionVoiceControls } = await import('../src/components/sessions/session-voice-controls');
const { parseVoiceTurn, VOICE_MERGE_WINDOW_MS, VOICE_MERGE_WINDOW_UNFINISHED_MS } =
  await import('../src/lib/voice-conversation');

const userTurn = (id: string, text: string) =>
  ({ id, role: 'user', items: [{ type: 'text', text }] }) as unknown as SessionHistory;
const replyTurn = (id: string, text: string) =>
  ({
    id,
    role: 'assistant',
    finished: true,
    items: [{ type: 'text', text }],
  }) as unknown as SessionHistory;

let root: Root;
let container: HTMLDivElement;
let sent: string[];
let props: { turns: readonly SessionHistory[]; isAgentBusy: boolean };

function render() {
  act(() =>
    root.render(
      createElement(SessionVoiceControls, {
        disabled: false,
        turns: props.turns,
        isAgentBusy: props.isAgentBusy,
        buttonClassName: '',
        iconClassName: '',
        onDictationStart: () => {},
        onDictationText: () => {},
        onVoiceRequest: async (text: string) => {
          sent.push(text);
          return true;
        },
      })
    )
  );
}

/** Starts a conversation the way the button does, then lets the call connect. */
function startConversation() {
  const button = container.querySelectorAll('button')[1]!;
  act(() => button.click());
  call.state = 'active';
  call.mode = 'conversation';
  render();
}

const heard = (role: 'user' | 'assistant', text: string) =>
  act(() => call.handlers!.onTranscript!({ role, text }));
const handedOff = (text: string) => act(() => call.handlers!.onRequest!(text));
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  call.state = 'idle';
  call.mode = null;
  call.start.mockReset();
  call.append.mockClear();
  sent = [];
  props = {
    turns: [
      userTurn('u1', 'Fix the flaky auth test'),
      replyTurn('a1', 'Fixed. <lody-voice-say>修好了。</lody-voice-say>'),
    ],
    isAgentBusy: false,
  };
  container = document.createElement('div');
  root = createRoot(container);
  render();
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('SessionVoiceControls conversation', () => {
  it('starts the voice from the session so far, without relaying the reply it already knows', () => {
    startConversation();

    const [mode, options] = call.start.mock.calls[0]!;
    expect(mode).toBe('conversation');
    expect(options.instructions).toContain('background agent');
    // Until a result is back, the voice may only stall, never answer for the agent.
    expect(options.instructions).toContain('until a handed-off request reports back');
    expect(options.context).toContain('User: Fix the flaky auth test');
    expect(options.context).toContain('Agent: 修好了。');
    expect(call.append).not.toHaveBeenCalled();
  });

  it('merges hand-offs said in one breath into one voice turn with everything said before them', () => {
    startConversation();
    heard('user', '进展到哪了');
    heard('assistant', '测试修好了。');
    heard('user', '嗯……那帮我开个 PR，不对，先跑一下 CI');
    handedOff('Run CI first.');
    wait(1_500);
    handedOff('Then open a PR.');
    heard('assistant', '好，我让它先跑 CI。');
    wait(1_999);
    expect(sent).toEqual([]);
    wait(1);

    expect(sent).toHaveLength(1);
    expect(parseVoiceTurn(sent[0]!)).toEqual({
      userWords: ['进展到哪了', '嗯……那帮我开个 PR，不对，先跑一下 CI'],
      understanding: ['Run CI first.', 'Then open a PR.'],
    });
    expect(sent[0]).toContain('Voice: 测试修好了。');
    expect(sent[0]).toContain('Voice: 好，我让它先跑 CI。');

    // The next turn starts from what is said after this one.
    heard('user', '算了，不用了');
    handedOff('Cancel it.');
    wait(2_000);
    expect(parseVoiceTurn(sent[1]!)?.userWords).toEqual(['算了，不用了']);
  });

  it('waits a little longer for the user words that are transcribed after the hand-off', () => {
    startConversation();
    handedOff('List the files.');
    wait(2_000);
    expect(sent).toEqual([]);
    heard('user', '列一下文件');
    wait(1_500);

    expect(parseVoiceTurn(sent[0]!)?.userWords).toEqual(['列一下文件']);
  });

  it('holds the window open while the user trails off and closes it soon after they finish', () => {
    startConversation();
    heard('user', '那么对于我们现在这个实践而言，它是如何');
    handedOff('How does this apply to our practice?');
    wait(3_000);
    expect(sent).toEqual([]);

    // The rest of the sentence restarts the window, now the ordinary length.
    heard('user', '落地的');
    wait(1_999);
    expect(sent).toEqual([]);
    wait(1);

    expect(sent).toHaveLength(1);
    expect(parseVoiceTurn(sent[0]!)?.userWords).toEqual([
      '那么对于我们现在这个实践而言，它是如何',
      '落地的',
    ]);
  });

  it('sends an unfinished sentence after the longer window when nothing follows', () => {
    startConversation();
    heard('user', '就是 -');
    handedOff('Something about this.');
    wait(VOICE_MERGE_WINDOW_UNFINISHED_MS - 1);
    expect(sent).toEqual([]);
    wait(1);

    expect(parseVoiceTurn(sent[0]!)?.userWords).toEqual(['就是 -']);
  });

  it('judges a new hand-off by the words said just before it', () => {
    startConversation();
    heard('user', '帮我查一下，');
    handedOff('Look something up.');
    wait(1_000);
    heard('user', '昨天的构建为什么失败');
    handedOff("Why did yesterday's build fail?");
    wait(VOICE_MERGE_WINDOW_MS);

    expect(sent).toHaveLength(1);
  });

  it('sends the paraphrase alone when the user words never arrive', () => {
    startConversation();
    handedOff('List the files.');
    wait(3_500);

    expect(parseVoiceTurn(sent[0]!)).toEqual({ userWords: [], understanding: ['List the files.'] });
  });

  it('relays the talking points of the reply that answers a voice turn', async () => {
    startConversation();
    heard('user', '跑一下测试');
    handedOff('Run the tests.');
    wait(2_000);
    props = { turns: [...props.turns, userTurn('u2', sent[0]!)], isAgentBusy: true };
    render();
    props = {
      turns: [
        ...props.turns,
        replyTurn(
          'a2',
          '42 passed, 0 failed in `pkg/a`.\n<lody-voice-say>测试全过了。</lody-voice-say>'
        ),
      ],
      isAgentBusy: false,
    };
    render();

    expect(call.append).toHaveBeenCalledTimes(1);
    const relay = call.append.mock.calls[0]![0];
    expect(relay).toContain('"Run the tests."');
    expect(relay).toContain('测试全过了。');
    expect(relay).not.toContain('pkg/a');

    // A typed turn finishing later is relayed as an update, not as that request's answer.
    props = {
      turns: [...props.turns, userTurn('u3', 'typed'), replyTurn('a3', 'Done typing.')],
      isAgentBusy: false,
    };
    render();
    expect(call.append.mock.calls[1]![0]).toMatch(/turn the user typed/);
  });

  it('keeps a spoken request waiting while a typed turn queued before it finishes', () => {
    startConversation();
    heard('user', '顺便跑下测试');
    handedOff('Run the tests.');
    wait(2_000);
    props = {
      turns: [...props.turns, userTurn('u2', 'typed first'), replyTurn('a2', 'Typed answer.')],
      isAgentBusy: false,
    };
    render();
    expect(call.append.mock.calls[0]![0]).toMatch(/turn the user typed/);
    expect(call.append.mock.calls[0]![0]).not.toContain('Run the tests.');

    props = {
      turns: [
        ...props.turns,
        userTurn('u3', sent[0]!),
        replyTurn('a3', '<lody-voice-say>都过了。</lody-voice-say>'),
      ],
      isAgentBusy: false,
    };
    render();
    expect(call.append.mock.calls[1]![0]).toContain('"Run the tests."');
  });

  it('marks only the request a reply answers as done while a queued one keeps waiting', () => {
    startConversation();
    heard('user', '检查一下测试');
    handedOff('Check the tests.');
    wait(2_000);
    heard('user', '再更新一下 README');
    handedOff('Update the README.');
    wait(2_000);
    expect(sent).toHaveLength(2);

    // The second message is queued behind the first turn, which finishes alone.
    props = {
      turns: [
        ...props.turns,
        userTurn('u2', sent[0]!),
        replyTurn('a2', '<lody-voice-say>测试都过了。</lody-voice-say>'),
        userTurn('u3', sent[1]!),
      ],
      isAgentBusy: false,
    };
    render();
    const first = call.append.mock.calls[0]![0];
    expect(first).toContain('"Check the tests."');
    expect(first).not.toContain('README');

    props = {
      turns: [
        ...props.turns,
        replyTurn('a3', '<lody-voice-say>README 更新好了。</lody-voice-say>'),
      ],
      isAgentBusy: false,
    };
    render();
    const second = call.append.mock.calls[1]![0];
    expect(second).toContain('"Update the README."');
    expect(second).not.toContain('Check the tests.');
  });

  it('settles a request said twice one reply at a time', () => {
    startConversation();
    heard('user', '检查一下测试');
    handedOff('Check the tests.');
    wait(2_000);
    heard('user', '检查一下测试');
    handedOff('Check the tests.');
    wait(2_000);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);

    props = {
      turns: [
        ...props.turns,
        userTurn('u2', sent[0]!),
        replyTurn('a2', '<lody-voice-say>测试都过了。</lody-voice-say>'),
        userTurn('u3', sent[1]!),
      ],
      isAgentBusy: false,
    };
    render();
    expect(call.append.mock.calls[0]![0]).toContain(
      'finished the spoken request "Check the tests.".'
    );

    props = {
      turns: [...props.turns, replyTurn('a3', '<lody-voice-say>还是都过了。</lody-voice-say>')],
      isAgentBusy: false,
    };
    render();
    expect(call.append.mock.calls[1]![0]).toContain(
      'finished the spoken request "Check the tests.".'
    );
  });

  it('sends what was said when the user hangs up inside the merge window', () => {
    startConversation();
    heard('user', '最后帮我提交一下');
    handedOff('Commit the changes.');
    call.state = 'idle';
    call.mode = null;
    render();

    expect(parseVoiceTurn(sent[0]!)?.userWords).toEqual(['最后帮我提交一下']);
  });
});
