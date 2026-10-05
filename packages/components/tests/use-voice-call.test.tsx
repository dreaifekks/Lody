// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { atom } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestMachineVoice = vi.hoisted(() => vi.fn());

vi.mock('@/atoms/runtime', () => ({
  activeWorkspaceRuntimeAtom: atom({ requestMachineVoice }),
}));
vi.mock('@/hooks/use-voice-agent-selection', () => ({
  useVoiceAgentSelection: () => ({ configId: 'config-1', machineId: 'machine-1' }),
}));

const { useVoiceCall } = await import('../src/hooks/use-voice-call');

type VoiceCall = ReturnType<typeof useVoiceCall>;

/** A microphone grant the test settles by hand, as a permission prompt would. */
function pendingMicrophone() {
  const track = {
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  let grant!: () => void;
  const promise = new Promise<MediaStream>((resolve) => {
    grant = () => resolve(stream);
  });
  return { promise, grant, track };
}

let root: Root;
let container: HTMLDivElement;
let latest: VoiceCall;
let peers: number;
let getUserMedia: ReturnType<typeof vi.fn>;
const errors: string[] = [];

function Probe() {
  latest = useVoiceCall({ onError: (message) => errors.push(message) });
  return null;
}

beforeEach(() => {
  peers = 0;
  errors.length = 0;
  requestMachineVoice.mockReset();
  getUserMedia = vi.fn();
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  vi.stubGlobal(
    'RTCPeerConnection',
    class {
      constructor() {
        peers += 1;
        throw new Error('a voice connection was opened');
      }
    }
  );
  container = document.createElement('div');
  root = createRoot(container);
  act(() => root.render(createElement(Probe)));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('useVoiceCall while microphone permission is pending', () => {
  it('stop cancels the start: the late grant is released and nothing connects', async () => {
    const microphone = pendingMicrophone();
    getUserMedia.mockReturnValueOnce(microphone.promise);

    act(() => void latest.start('dictation'));
    expect(latest.state).toBe('connecting');
    await act(async () => {
      await latest.stop();
    });
    expect(latest.state).toBe('idle');

    await act(async () => {
      microphone.grant();
      await microphone.promise;
    });

    expect(microphone.track.stopped).toBe(true);
    expect(peers).toBe(0);
    expect(requestMachineVoice).not.toHaveBeenCalled();
    expect(latest.state).toBe('idle');
    expect(errors).toEqual([]);
  });

  it('a stopped start does not disturb the next one', async () => {
    const first = pendingMicrophone();
    const second = pendingMicrophone();
    getUserMedia.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    act(() => void latest.start('dictation'));
    await act(async () => {
      await latest.stop();
    });
    act(() => void latest.start('conversation'));
    expect(latest.state).toBe('connecting');
    expect(latest.mode).toBe('conversation');

    await act(async () => {
      first.grant();
      await first.promise;
    });

    expect(first.track.stopped).toBe(true);
    expect(second.track.stopped).toBe(false);
    expect(latest.state).toBe('connecting');
    expect(latest.mode).toBe('conversation');
    expect(peers).toBe(0);
  });

  it('unmounting cancels the start the same way', async () => {
    const microphone = pendingMicrophone();
    getUserMedia.mockReturnValueOnce(microphone.promise);

    act(() => void latest.start('conversation'));
    act(() => root.unmount());
    await act(async () => {
      microphone.grant();
      await microphone.promise;
    });

    expect(microphone.track.stopped).toBe(true);
    expect(peers).toBe(0);
    expect(requestMachineVoice).not.toHaveBeenCalled();
    root = createRoot(container);
  });
});

describe('useVoiceCall conversation', () => {
  it('starts with the given background and reports both sides of the call in order', async () => {
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        localDescription: { sdp: string } | null = null;
        iceGatheringState = 'complete';
        addTrack() {}
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
        close() {}
      }
    );
    const microphone = pendingMicrophone();
    getUserMedia.mockReturnValueOnce(microphone.promise);
    const reported: string[] = [];
    requestMachineVoice.mockImplementation(async (_machineId: string, body: { action: string }) => {
      if (body.action === 'start') {
        return { success: true, action: 'start', voiceSessionId: 'voice-1', sdp: 'answer-sdp' };
      }
      if (body.action === 'poll') {
        return {
          success: true,
          action: 'poll',
          closed: true,
          events: [
            { seq: 1, event: { type: 'transcript', role: 'user', text: '跑一下测试' } },
            { seq: 2, event: { type: 'transcript', role: 'assistant', text: '好的' } },
            { seq: 3, event: { type: 'request', requestId: 'h1', text: 'Run the tests.' } },
            { seq: 4, event: { type: 'closed', reason: null } },
          ],
        };
      }
      return { success: true, action: 'stop' };
    });
    function ConversationProbe() {
      latest = useVoiceCall({
        onTranscript: ({ role, text }) => reported.push(`${role}: ${text}`),
        onRequest: (text) => reported.push(`request: ${text}`),
      });
      return null;
    }
    act(() => root.render(createElement(ConversationProbe)));

    await act(async () => {
      const started = latest.start('conversation', {
        instructions: 'Hand work off.',
        context: 'User: fix the build',
      });
      microphone.grant();
      await started;
    });

    expect(requestMachineVoice.mock.calls[0]![1]).toMatchObject({
      action: 'start',
      mode: 'conversation',
      instructions: 'Hand work off.',
      context: 'User: fix the build',
    });
    expect(reported).toEqual(['user: 跑一下测试', 'assistant: 好的', 'request: Run the tests.']);
  });
});
