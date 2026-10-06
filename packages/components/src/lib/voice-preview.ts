import type {
  AgentConfigId,
  MachineId,
  MachineVoiceRequest,
  MachineVoiceResponse,
} from '@lody/shared';
import { claimVoicePreview } from '@/lib/voice-activity';

/** A slow network still finishes ICE gathering well inside this; send what exists after. */
const ICE_GATHERING_LIMIT_MS = 4_000;
/** From the machine's answer until audio can flow. */
const CONNECT_LIMIT_MS = 15_000;
/** From asking for the sentence until the voice is heard. */
const SPEECH_START_LIMIT_MS = 15_000;
/** Ends a preview that keeps talking; one sentence takes a few seconds. */
const SPEECH_LIMIT_MS = 20_000;
/** Silence this long after speech ends the preview. */
const SILENCE_END_MS = 1_500;
const LEVEL_SAMPLE_MS = 200;
/** WebRTC audio level, 0..1; comfort noise stays well below this. */
const AUDIBLE_LEVEL = 0.01;
const POLL_WAIT_MS = 12_000;

export type VoicePreviewFailure =
  /** A voice call holds the speakers. */
  | 'call-active'
  /** The audio connection never came up. */
  | 'no-connection'
  /** Connected, but the voice never spoke. */
  | 'no-speech'
  /** The machine or Codex refused; `message` says why. */
  | 'machine';

export class VoicePreviewError extends Error {
  constructor(
    readonly failure: VoicePreviewFailure,
    message: string = failure
  ) {
    super(message);
    this.name = 'VoicePreviewError';
  }
}

export type VoicePreviewOptions = {
  machineId: MachineId;
  configId: AgentConfigId;
  /** A name from the agent's voice list. */
  voice: string;
  /** What the voice says, in the user's language. */
  sentence: string;
  request: (machineId: MachineId, body: MachineVoiceRequest) => Promise<MachineVoiceResponse>;
  /** `playing` once the call is up and the sentence is asked for. */
  onPlaying?: () => void;
};

export type VoicePreview = {
  /** Ends the preview at once; `finished` then resolves. */
  stop: () => void;
  /** Resolves when the sentence was played or the preview stopped; rejects with a VoicePreviewError. */
  finished: Promise<void>;
};

/**
 * Lets the user hear a voice: a short realtime call in `preview` mode that says
 * one sentence and hangs up when the voice falls silent. It sends no microphone
 * audio, touches no session and writes no chat history. A voice call starting
 * meanwhile ends it.
 */
export function playVoicePreview(options: VoicePreviewOptions): VoicePreview {
  let settled = false;
  let resolveFinished!: () => void;
  let rejectFinished!: (error: VoicePreviewError) => void;
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  // Never an unhandled rejection: a caller that stops early may not await it.
  finished.catch(() => {});

  let peer: RTCPeerConnection | null = null;
  let audio: HTMLAudioElement | null = null;
  let voiceSessionId: string | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let sampler: ReturnType<typeof setInterval> | null = null;

  const end = (error?: VoicePreviewError) => {
    if (settled) return;
    settled = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (sampler) clearInterval(sampler);
    peer?.close();
    if (audio) {
      audio.pause();
      audio.srcObject = null;
    }
    if (voiceSessionId) {
      void options.request(options.machineId, { action: 'stop', voiceSessionId }).catch(() => {});
    }
    release?.();
    if (error) rejectFinished(error);
    else resolveFinished();
  };
  const stop = () => end();
  const after = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
    return timer;
  };

  const release = claimVoicePreview(stop);
  if (!release) {
    end(new VoicePreviewError('call-active'));
    return { stop, finished };
  }

  void (async () => {
    try {
      const connection = new RTCPeerConnection();
      peer = connection;
      // Receives the voice and sends nothing: no microphone is opened.
      connection.addTransceiver('audio', { direction: 'sendrecv' });
      connection.createDataChannel('oai-events');
      connection.ontrack = (event) => {
        if (settled) return;
        const element = new Audio();
        element.autoplay = true;
        element.srcObject = new MediaStream([event.track]);
        void element.play()?.catch(() => {});
        audio = element;
      };
      const connected = new Promise<void>((resolve, reject) => {
        const check = () => {
          if (connection.connectionState === 'connected') resolve();
          if (connection.connectionState === 'failed') {
            reject(new VoicePreviewError('no-connection'));
          }
        };
        connection.onconnectionstatechange = check;
      });
      connected.catch(() => {});

      await connection.setLocalDescription(await connection.createOffer());
      await waitForIceGathering(connection);
      const offer = connection.localDescription?.sdp;
      if (!offer) throw new VoicePreviewError('no-connection');
      if (settled) return;

      const response = await options.request(options.machineId, {
        action: 'start',
        configId: options.configId,
        mode: 'preview',
        sdp: offer,
        voice: options.voice,
      });
      if (!response.success) throw new VoicePreviewError('machine', response.error);
      if (response.action !== 'start') throw new VoicePreviewError('machine', 'No voice call');
      voiceSessionId = response.voiceSessionId;
      if (settled) {
        // Stopped while the machine answered: `end` ran before the call existed.
        void options.request(options.machineId, {
          action: 'stop',
          voiceSessionId: response.voiceSessionId,
        });
        return;
      }
      void watchCall(response.voiceSessionId);
      await connection.setRemoteDescription({ type: 'answer', sdp: response.sdp });

      await Promise.race([
        connected,
        new Promise<never>((_, reject) => {
          after(CONNECT_LIMIT_MS, () => reject(new VoicePreviewError('no-connection')));
        }),
      ]);
      if (settled) return;
      options.onPlaying?.();
      const appended = await options.request(options.machineId, {
        action: 'append',
        voiceSessionId: response.voiceSessionId,
        text: `Say this sentence now, exactly once, then stay silent: "${options.sentence}"`,
      });
      if (!appended.success) throw new VoicePreviewError('machine', appended.error);
      if (settled) return;
      listenUntilSilent(connection);
    } catch (error) {
      end(
        error instanceof VoicePreviewError
          ? error
          : new VoicePreviewError('machine', error instanceof Error ? error.message : String(error))
      );
    }
  })();

  /** Ends the preview once the voice has spoken and fallen silent, or never speaks. */
  function listenUntilSilent(connection: RTCPeerConnection) {
    let heard = false;
    let silentSince: number | null = null;
    let elapsed = 0;
    after(SPEECH_LIMIT_MS, () => end());
    sampler = setInterval(() => {
      elapsed += LEVEL_SAMPLE_MS;
      const level = remoteAudioLevel(connection);
      if (level >= AUDIBLE_LEVEL) {
        heard = true;
        silentSince = null;
        return;
      }
      if (!heard) {
        if (elapsed >= SPEECH_START_LIMIT_MS) end(new VoicePreviewError('no-speech'));
        return;
      }
      silentSince ??= elapsed;
      if (elapsed - silentSince >= SILENCE_END_MS) end();
    }, LEVEL_SAMPLE_MS);
  }

  /** Reports the machine ending the call or Codex failing it. */
  async function watchCall(id: string) {
    let afterSeq = 0;
    for (;;) {
      if (settled) return;
      const response = await options
        .request(options.machineId, {
          action: 'poll',
          voiceSessionId: id,
          after: afterSeq,
          waitMs: POLL_WAIT_MS,
        })
        .catch((error: unknown) => ({
          success: false as const,
          error: error instanceof Error ? error.message : String(error),
        }));
      if (settled) return;
      if (!response.success) {
        end(new VoicePreviewError('machine', response.error));
        return;
      }
      if (response.action !== 'poll') return;
      for (const { seq, event } of response.events) {
        afterSeq = seq;
        if (event.type === 'error') {
          end(new VoicePreviewError('machine', event.message));
          return;
        }
      }
      if (response.closed) {
        // Codex hung up; whatever played has played.
        end();
        return;
      }
    }
  }

  return { stop, finished };
}

function remoteAudioLevel(peer: RTCPeerConnection): number {
  let level = 0;
  for (const receiver of peer.getReceivers()) {
    if (receiver.track?.kind !== 'audio') continue;
    for (const source of receiver.getSynchronizationSources?.() ?? []) {
      level = Math.max(level, source.audioLevel ?? 0);
    }
  }
  return level;
}

export function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (peer.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, ICE_GATHERING_LIMIT_MS);
    peer.addEventListener('icegatheringstatechange', onChange);
  });
}
