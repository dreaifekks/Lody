import { describe, expect, it } from 'vitest';
import {
  GeminiLiveCall,
  type GeminiLiveCallHandlers,
  type GeminiLiveSocket,
  type GeminiLiveToken,
} from '../src/lib/gemini-live-call';

/** A Live WebSocket the test plays the server side of. */
class FakeSocket implements GeminiLiveSocket {
  readonly sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.closed = { ...(code === undefined ? {} : { code }), ...(reason ? { reason } : {}) };
  }

  receive(message: unknown, binary = false): void {
    const text = JSON.stringify(message);
    this.onmessage?.({ data: binary ? new TextEncoder().encode(text).buffer : text });
  }

  serverClose(code: number, reason: string): void {
    this.onclose?.({ code, reason });
  }

  sentOf(kind: string): Record<string, unknown>[] {
    return this.sent.filter((message) => kind in message).map((message) => message[kind] as Record<string, unknown>);
  }
}

/** Lets the call's ordered inbox (a promise chain) handle what the fake server sent. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

const firstToken: GeminiLiveToken = {
  token: 'auth_tokens/first',
  model: 'gemini-3.8-live',
  expireTime: '2026-11-07T12:30:00.000Z',
};
const START = Date.parse('2026-11-07T12:00:00.000Z');

function setUp(options: { mode?: 'conversation' | 'dictation'; context?: string } = {}) {
  const sockets: FakeSocket[] = [];
  const events: { kind: string; value: unknown }[] = [];
  const tokens: GeminiLiveToken[] = [];
  let now = START;
  const record =
    (kind: string) =>
    (...args: unknown[]) =>
      events.push({ kind, value: args.length === 1 ? args[0] : args });
  const handlers: GeminiLiveCallHandlers = {
    onUserTranscript: record('dictated'),
    onTranscript: record('line'),
    onRequest: record('request'),
    onAudio: record('audio'),
    onInterrupted: record('interrupted'),
    onClosed: record('closed'),
  };
  const call = new GeminiLiveCall({
    mode: options.mode ?? 'conversation',
    token: firstToken,
    issueToken: async () => {
      const token = {
        token: `auth_tokens/renewed-${tokens.length + 1}`,
        model: firstToken.model,
        expireTime: '2026-11-07T13:30:00.000Z',
      };
      tokens.push(token);
      return token;
    },
    openSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    now: () => now,
    instructions: 'Be the voice.',
    ...(options.context ? { context: options.context } : {}),
    voice: 'puck',
    handlers,
  });
  const latest = () => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error('no socket opened');
    return socket;
  };
  /** Opens the newest socket and has the server accept its setup. */
  const accept = async () => {
    latest().onopen?.();
    latest().receive({ setupComplete: {} });
    await settle();
  };
  return {
    call,
    sockets,
    events,
    tokens,
    latest,
    accept,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('GeminiLiveCall setup', () => {
  it('connects with the token, sets up the voice and seeds the session context once', async () => {
    const { call, latest, accept } = setUp({ context: 'User: fix the build' });
    const started = call.start();
    expect(latest().url).toBe(
      'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens%2Ffirst'
    );
    await accept();
    await started;

    const [setup] = latest().sentOf('setup');
    expect(setup).toMatchObject({
      model: 'models/gemini-3.8-live',
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
      },
      systemInstruction: { parts: [{ text: 'Be the voice.' }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: {},
      contextWindowCompression: { slidingWindow: {} },
    });
    expect(setup?.['tools']).toEqual([
      {
        functionDeclarations: [
          expect.objectContaining({ name: 'hand_off_to_agent', behavior: 'NON_BLOCKING' }),
        ],
      },
    ]);
    expect(latest().sentOf('clientContent')).toEqual([
      { turns: [{ role: 'user', parts: [{ text: 'User: fix the build' }] }], turnComplete: false },
    ]);
  });

  it('fails the start with the reason the server gave for refusing it', async () => {
    const { call, latest } = setUp();
    const started = call.start();
    latest().onopen?.();
    latest().serverClose(1008, 'Token has expired');

    await expect(started).rejects.toThrow('Gemini Live refused the call: Token has expired');
  });

  it('sends microphone audio only once the setup is accepted', async () => {
    const { call, latest, accept } = setUp();
    void call.start();
    call.sendAudio(new Int16Array([1, 2]));
    await accept();
    call.sendAudio(new Int16Array([1, -1]));

    expect(latest().sentOf('realtimeInput')).toEqual([
      { audio: { data: btoa('\x01\x00\xff\xff'), mimeType: 'audio/pcm;rate=16000' } },
    ]);
  });
});

describe('GeminiLiveCall conversation', () => {
  it('reports whole utterances in order, the request after what led to it', async () => {
    const { call, latest, accept, events } = setUp();
    void call.start();
    await accept();
    latest().receive({ serverContent: { inputTranscription: { text: '帮我看看' } } });
    latest().receive({ serverContent: { inputTranscription: { text: '构建为什么挂了' } } });
    latest().receive({
      toolCall: {
        functionCalls: [{ id: 'call-1', name: 'hand_off_to_agent', args: { request: '查构建失败原因' } }],
      },
    });
    latest().receive({ serverContent: { outputTranscription: { text: '好的，' } } });
    // Binary frames carry the same JSON.
    latest().receive({ serverContent: { outputTranscription: { text: '我看一下。' } } }, true);
    latest().receive({ serverContent: { generationComplete: true } });
    latest().receive({ serverContent: { turnComplete: true } });
    await settle();

    expect(events).toEqual([
      { kind: 'line', value: { role: 'user', text: '帮我看看构建为什么挂了' } },
      { kind: 'request', value: ['查构建失败原因', 'call-1'] },
      { kind: 'line', value: { role: 'assistant', text: '好的，我看一下。' } },
    ]);
  });

  it('plays the voice and drops what is queued when the user talks over it', async () => {
    const { call, latest, accept, events } = setUp();
    void call.start();
    await accept();
    latest().receive({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: btoa('\x10\x00\x20\x00') } }],
        },
        outputTranscription: { text: '我先说' },
      },
    });
    latest().receive({ serverContent: { interrupted: true } });
    await settle();

    expect(events).toEqual([
      { kind: 'audio', value: [new Int16Array([16, 32]), 24_000] },
      { kind: 'interrupted', value: [] },
      { kind: 'line', value: { role: 'assistant', text: '我先说' } },
    ]);
  });

  it('answers the hand-offs a reply settles, and anything else as a new turn', async () => {
    const { call, latest, accept } = setUp();
    void call.start();
    await accept();
    latest().receive({
      toolCall: {
        functionCalls: [
          { id: 'call-1', name: 'hand_off_to_agent', args: { request: '查构建' } },
          { id: 'call-2', name: 'hand_off_to_agent', args: { request: '顺便看测试' } },
        ],
      },
    });
    await settle();

    call.reply('Build fixed.', ['call-1', 'call-2']);
    // Both were answered; a second relay for them is a plain turn.
    call.reply('A typed turn finished.', ['call-1']);

    expect(latest().sentOf('toolResponse')).toEqual([
      {
        functionResponses: [
          {
            id: 'call-1',
            name: 'hand_off_to_agent',
            response: { result: 'Build fixed.', scheduling: 'WHEN_IDLE' },
            scheduling: 'WHEN_IDLE',
          },
          {
            id: 'call-2',
            name: 'hand_off_to_agent',
            response: {
              result: 'Answered together with the first of these requests.',
              scheduling: 'SILENT',
            },
            scheduling: 'SILENT',
          },
        ],
      },
    ]);
    expect(latest().sentOf('clientContent')).toEqual([
      { turns: [{ role: 'user', parts: [{ text: 'A typed turn finished.' }] }], turnComplete: true },
    ]);
  });

  it('forgets a hand-off the server cancelled, so its answer arrives as a turn', async () => {
    const { call, latest, accept } = setUp();
    void call.start();
    await accept();
    latest().receive({
      toolCall: { functionCalls: [{ id: 'call-1', name: 'hand_off_to_agent', args: { request: '查' } }] },
    });
    latest().receive({ toolCallCancellation: { ids: ['call-1'] } });
    await settle();

    call.reply('Done.', ['call-1']);

    expect(latest().sentOf('toolResponse')).toEqual([]);
    expect(latest().sentOf('clientContent')).toEqual([
      { turns: [{ role: 'user', parts: [{ text: 'Done.' }] }], turnComplete: true },
    ]);
  });
});

describe('GeminiLiveCall reconnection', () => {
  it('moves to a new connection on GoAway, resuming with the same token and holding replies', async () => {
    const { call, sockets, latest, accept, tokens, events } = setUp({ context: 'background' });
    void call.start();
    await accept();
    latest().receive({ sessionResumptionUpdate: { newHandle: 'handle-1', resumable: true } });
    latest().receive({
      toolCall: { functionCalls: [{ id: 'call-1', name: 'hand_off_to_agent', args: { request: '查' } }] },
    });
    latest().receive({ goAway: { timeLeft: '10s' } });
    await settle();

    expect(sockets).toHaveLength(2);
    expect(sockets[0]?.closed).toEqual({ code: 1000, reason: 'reconnecting' });
    // A reply that finishes while the new connection is set up is not lost.
    call.reply('Found it.', ['call-1']);
    await accept();

    const resumed = latest();
    expect(resumed.url).toContain('access_token=auth_tokens%2Ffirst');
    expect(tokens).toHaveLength(0);
    expect(resumed.sentOf('setup')[0]?.['sessionResumption']).toEqual({ handle: 'handle-1' });
    // The background was given once; the resumed session still has it.
    expect(resumed.sentOf('clientContent')).toEqual([]);
    expect(resumed.sentOf('toolResponse')).toEqual([
      expect.objectContaining({
        functionResponses: [expect.objectContaining({ id: 'call-1', scheduling: 'WHEN_IDLE' })],
      }),
    ]);
    expect(events.filter((event) => event.kind === 'closed')).toEqual([]);
  });

  it('asks the machine for a new token when the connection drops after the first one ran out', async () => {
    const { call, sockets, latest, accept, tokens, advance } = setUp();
    void call.start();
    await accept();
    latest().receive({ sessionResumptionUpdate: { newHandle: 'handle-2', resumable: true } });
    await settle();

    advance(30 * 60_000);
    latest().serverClose(1011, 'session expired');
    await settle();

    expect(tokens).toHaveLength(1);
    expect(sockets).toHaveLength(2);
    expect(latest().url).toContain('access_token=auth_tokens%2Frenewed-1');
    await accept();
    expect(latest().sentOf('setup')[0]?.['sessionResumption']).toEqual({ handle: 'handle-2' });
  });

  it('ends the call with the reason when there is nothing to resume', async () => {
    const { call, sockets, latest, accept, events } = setUp();
    void call.start();
    await accept();
    latest().serverClose(1011, 'internal error');
    await settle();

    expect(sockets).toHaveLength(1);
    expect(events).toEqual([{ kind: 'closed', value: 'Gemini Live ended the call: internal error' }]);
  });

  it('ignores the old connection once stopped', async () => {
    const { call, latest, accept, events } = setUp();
    void call.start();
    await accept();
    call.stop();
    latest().serverClose(1000, 'stopped');
    await settle();

    expect(latest().closed).toEqual({ code: 1000, reason: 'stopped' });
    expect(events).toEqual([]);
  });
});

describe('GeminiLiveCall dictation', () => {
  it('transcribes without a voice: finished speech turns plus what is still being heard', async () => {
    const { call, latest, accept, events } = setUp({ mode: 'dictation' });
    void call.start();
    await accept();
    expect(latest().sentOf('setup')[0]).toEqual({
      model: 'models/gemini-3.8-live',
      generationConfig: { responseModalities: ['TEXT'] },
      inputAudioTranscription: { languageCodes: [] },
    });
    latest().receive({ serverContent: { interimInputTranscription: { text: '今天' } } });
    latest().receive({ serverContent: { inputTranscription: { text: '今天天气不错。' } } });
    latest().receive({ serverContent: { interimInputTranscription: { text: '明天' } } });
    await settle();

    expect(events).toEqual([
      { kind: 'dictated', value: '今天' },
      { kind: 'dictated', value: '今天天气不错。' },
      { kind: 'dictated', value: '今天天气不错。明天' },
    ]);
  });
});
