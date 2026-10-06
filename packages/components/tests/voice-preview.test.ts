// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfigId, MachineId, MachineVoiceRequest } from '@lody/shared';
import { beginVoiceCall } from '../src/lib/voice-activity';
import { playVoicePreview, VoicePreviewError } from '../src/lib/voice-preview';

/** A WebRTC peer whose connection and remote audio level the test drives. */
class FakePeer {
  static all: FakePeer[] = [];
  connectionState = 'new';
  iceGatheringState = 'complete';
  localDescription: { sdp: string } | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: { track: unknown }) => void) | null = null;
  closed = false;
  level = 0;

  constructor() {
    FakePeer.all.push(this);
  }
  addTransceiver() {}
  createDataChannel() {
    return {};
  }
  async createOffer() {
    return { type: 'offer', sdp: 'offer-sdp' };
  }
  async setLocalDescription() {
    this.localDescription = { sdp: 'offer-sdp' };
  }
  async setRemoteDescription() {}
  getReceivers() {
    return [
      { track: { kind: 'audio' }, getSynchronizationSources: () => [{ audioLevel: this.level }] },
    ];
  }
  connect(state = 'connected') {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
  close() {
    this.closed = true;
  }
}

/** A machine that answers every preview call and holds polls open until the call stops. */
function createMachine() {
  const requests: MachineVoiceRequest[] = [];
  const openPolls = new Map<string, () => void>();
  let calls = 0;
  let startError: string | null = null;
  const request = async (_machineId: MachineId, body: MachineVoiceRequest) => {
    requests.push(body);
    switch (body.action) {
      case 'start':
        if (startError) return { success: false as const, error: startError };
        calls += 1;
        return {
          success: true as const,
          action: 'start' as const,
          voiceSessionId: `preview-${calls}`,
          sdp: 'answer-sdp',
        };
      case 'poll':
        return await new Promise<{
          success: true;
          action: 'poll';
          events: [];
          closed: boolean;
        }>((resolve) => {
          openPolls.set(body.voiceSessionId, () =>
            resolve({ success: true, action: 'poll', events: [], closed: true })
          );
        });
      case 'stop':
        openPolls.get(body.voiceSessionId)?.();
        return { success: true as const, action: 'stop' as const };
      default:
        return { success: true as const, action: 'append' as const };
    }
  };
  return {
    request,
    requests,
    failStarts: (error: string) => {
      startError = error;
    },
    stopped: () =>
      requests.flatMap((body) => (body.action === 'stop' ? [body.voiceSessionId] : [])),
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

function play(machine: ReturnType<typeof createMachine>, voice = 'maple') {
  const playing: string[] = [];
  const preview = playVoicePreview({
    machineId: 'machine-1' as MachineId,
    configId: 'config-1' as AgentConfigId,
    voice,
    sentence: '你好，我是这个声音，听起来怎么样？',
    request: machine.request,
    onPlaying: () => playing.push(voice),
  });
  let outcome: 'pending' | 'done' | VoicePreviewError = 'pending';
  preview.finished.then(
    () => {
      outcome = 'done';
    },
    (error: VoicePreviewError) => {
      outcome = error;
    }
  );
  return { preview, playing, outcome: () => outcome };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakePeer.all = [];
  vi.stubGlobal('RTCPeerConnection', FakePeer);
  vi.stubGlobal(
    'Audio',
    class {
      autoplay = false;
      srcObject: unknown = null;
      play() {
        return Promise.resolve();
      }
      pause() {}
    }
  );
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(readonly tracks: unknown[]) {}
    }
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('playVoicePreview', () => {
  it('asks the chosen voice for the sentence and hangs up once it falls silent', async () => {
    const machine = createMachine();
    const run = play(machine);
    await settle();
    const peer = FakePeer.all[0]!;

    expect(machine.requests[0]).toMatchObject({
      action: 'start',
      mode: 'preview',
      voice: 'maple',
      sdp: 'offer-sdp',
    });
    // Nothing is asked until audio can flow, or the start of the sentence is lost.
    expect(machine.requests.some((body) => body.action === 'append')).toBe(false);

    peer.connect();
    await settle();
    expect(run.playing).toEqual(['maple']);
    expect(machine.requests.find((body) => body.action === 'append')).toMatchObject({
      voiceSessionId: 'preview-1',
      text: expect.stringContaining('你好，我是这个声音，听起来怎么样？'),
    });

    peer.level = 0.3;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run.outcome()).toBe('pending');
    peer.level = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run.outcome()).toBe('pending');
    await vi.advanceTimersByTimeAsync(800);

    expect(run.outcome()).toBe('done');
    expect(peer.closed).toBe(true);
    expect(machine.stopped()).toEqual(['preview-1']);
  });

  it('plays one preview at a time: a second one ends the first', async () => {
    const machine = createMachine();
    const first = play(machine, 'maple');
    await settle();
    const second = play(machine, 'cove');
    await settle();

    expect(first.outcome()).toBe('done');
    expect(FakePeer.all[0]?.closed).toBe(true);
    expect(machine.stopped()).toEqual(['preview-1']);
    expect(second.outcome()).toBe('pending');
    expect(FakePeer.all[1]?.closed).toBe(false);

    second.preview.stop();
    await settle();
    expect(machine.stopped()).toEqual(['preview-1', 'preview-2']);
  });

  it('gives way to a voice call, and starts none while a call runs', async () => {
    const machine = createMachine();
    const run = play(machine);
    await settle();

    const releaseCall = beginVoiceCall();
    await settle();
    expect(run.outcome()).toBe('done');
    expect(FakePeer.all[0]?.closed).toBe(true);
    expect(machine.stopped()).toEqual(['preview-1']);

    const blocked = play(machine);
    await settle();
    expect(blocked.outcome()).toMatchObject({ failure: 'call-active' });
    expect(FakePeer.all).toHaveLength(1);

    releaseCall();
    const later = play(machine);
    await settle();
    expect(later.outcome()).toBe('pending');
    later.preview.stop();
  });

  it('reports a refused start and leaves nothing behind', async () => {
    const machine = createMachine();
    machine.failStarts('realtime voice is not available for this account');
    const run = play(machine);
    await settle();

    expect(run.outcome()).toMatchObject({
      failure: 'machine',
      message: 'realtime voice is not available for this account',
    });
    expect(FakePeer.all[0]?.closed).toBe(true);
    expect(machine.stopped()).toEqual([]);
    // The slot is free again.
    const next = play(createMachine());
    await settle();
    expect(next.outcome()).toBe('pending');
    next.preview.stop();
  });

  it('gives up when the voice never speaks, and hangs up', async () => {
    const machine = createMachine();
    const run = play(machine);
    await settle();
    FakePeer.all[0]!.connect();
    await settle();

    await vi.advanceTimersByTimeAsync(15_000);

    expect(run.outcome()).toMatchObject({ failure: 'no-speech' });
    expect(machine.stopped()).toEqual(['preview-1']);
  });

  it('gives up when the audio connection never comes up', async () => {
    const machine = createMachine();
    const run = play(machine);
    await settle();

    await vi.advanceTimersByTimeAsync(15_000);

    expect(run.outcome()).toMatchObject({ failure: 'no-connection' });
    expect(FakePeer.all[0]?.closed).toBe(true);
    expect(machine.stopped()).toEqual(['preview-1']);
    expect(machine.requests.some((body) => body.action === 'append')).toBe(false);
  });

  it('stops a preview the user ends while the machine is still answering', async () => {
    const machine = createMachine();
    let answer!: () => void;
    const slowRequest: typeof machine.request = async (machineId, body) => {
      if (body.action === 'start') await new Promise<void>((resolve) => (answer = resolve));
      return await machine.request(machineId, body);
    };
    const preview = playVoicePreview({
      machineId: 'machine-1' as MachineId,
      configId: 'config-1' as AgentConfigId,
      voice: 'maple',
      sentence: 'Hi',
      request: slowRequest,
    });
    await settle();

    preview.stop();
    await expect(preview.finished).resolves.toBeUndefined();
    answer();
    await settle();

    // The call the machine opened after the stop is ended too.
    expect(machine.stopped()).toEqual(['preview-1']);
  });
});
