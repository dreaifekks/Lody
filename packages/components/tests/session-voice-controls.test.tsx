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
const { parseVoiceTurn } = await import('../src/lib/voice-conversation');

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
      replyTurn('a1', 'Fixed. <say>修好了。</say>'),
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
        replyTurn('a2', '42 passed, 0 failed in `pkg/a`.\n<say>测试全过了。</say>'),
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
      turns: [...props.turns, userTurn('u3', sent[0]!), replyTurn('a3', '<say>都过了。</say>')],
      isAgentBusy: false,
    };
    render();
    expect(call.append.mock.calls[1]![0]).toContain('"Run the tests."');
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
