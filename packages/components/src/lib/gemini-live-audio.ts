/**
 * Browser audio for Gemini Live calls: the microphone as 16 kHz mono PCM16
 * through an AudioWorklet, and the voice's PCM16 replies played back to back
 * through WebAudio, with a way to drop what is still queued when the user
 * talks over it.
 */

// Emitted as its own same-origin file: a small asset would otherwise be inlined
// as a `data:` URL, which the desktop renderer's CSP refuses to run.
import captureWorkletUrl from './gemini-pcm-capture.worklet.js?worker&url';

const CAPTURE_RATE = 16_000;
/** About 100 ms per message, the chunk size the Live docs suggest. */
const CAPTURE_CHUNK_SAMPLES = 1_600;

/** Starts feeding `onChunk`; the returned function stops capture and releases the context. */
export async function startGeminiPcmCapture(
  microphone: MediaStream,
  onChunk: (pcm: Int16Array) => void
): Promise<() => void> {
  const context = new AudioContext({ sampleRate: CAPTURE_RATE });
  try {
    await context.audioWorklet.addModule(captureWorkletUrl);
    const source = context.createMediaStreamSource(microphone);
    const node = new AudioWorkletNode(context, 'gemini-pcm-capture');
    let pending = new Int16Array(CAPTURE_CHUNK_SAMPLES);
    let filled = 0;
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      for (const sample of event.data) {
        const clamped = Math.max(-1, Math.min(1, sample));
        pending[filled] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
        filled += 1;
        if (filled === pending.length) {
          onChunk(pending);
          pending = new Int16Array(CAPTURE_CHUNK_SAMPLES);
          filled = 0;
        }
      }
    };
    source.connect(node);
    return () => {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      void context.close();
    };
  } catch (error) {
    void context.close();
    throw error;
  }
}

/** How long a reply the user talks over takes to fade out, instead of stopping mid-wave. */
const FADE_SECONDS = 0.03;
/**
 * The echo canceller learns the speakers only by hearing them. Measured in
 * Electron 44, the voice's first 0.5-2 s come back into the microphone at
 * nearly the level played, whatever plays them (WebAudio, an audio element, a
 * WebRTC track); Gemini takes that for the user talking over it, interrupts,
 * and the cut-off syllable is the "beep" users hear. The canceller loses the
 * speakers again over the silence between replies (users heard the beep when
 * the second reply began), so every reply that starts after the queue ran dry
 * holds the microphone for this long from its first sound.
 */
const ECHO_SETTLE_SECONDS = 2.5;

export type GeminiPcmPlayer = {
  play(pcm: Int16Array, sampleRate: number): void;
  /** Fades out and forgets everything queued. */
  clear(): void;
  close(): void;
  /** The voice is in the first seconds of a reply, before the echo canceller has caught up: send silence instead of the microphone. */
  holdsMicrophone(): boolean;
};

export function createGeminiPcmPlayer(): GeminiPcmPlayer {
  const context = new AudioContext();
  void context.resume().catch(() => {});
  /** Every reply plays through one gain, so a cut can fade it; a new reply gets a fresh one. */
  let output = context.createGain();
  output.connect(context.destination);
  const playing = new Set<AudioBufferSourceNode>();
  let nextStart = 0;
  /** When the reply now playing began: the first chunk after the queue ran dry. */
  let replyStart = 0;
  const queued = () => Math.max(0, nextStart - context.currentTime);
  return {
    play(pcm, sampleRate) {
      if (pcm.length === 0) return;
      const buffer = context.createBuffer(1, pcm.length, sampleRate);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i += 1) samples[i] = (pcm[i] ?? 0) / 0x8000;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(output);
      const now = context.currentTime;
      // Nothing left to play: this chunk opens a new reply.
      if (nextStart <= now) replyStart = now;
      const startAt = Math.max(now, nextStart);
      source.start(startAt);
      nextStart = startAt + buffer.duration;
      playing.add(source);
      source.onended = () => playing.delete(source);
    },
    clear() {
      const now = context.currentTime;
      const fading = output;
      fading.gain.setValueAtTime(fading.gain.value, now);
      fading.gain.linearRampToValueAtTime(0, now + FADE_SECONDS);
      for (const source of playing) source.stop(now + FADE_SECONDS);
      playing.clear();
      setTimeout(() => fading.disconnect(), (FADE_SECONDS + 0.1) * 1000);
      output = context.createGain();
      output.connect(context.destination);
      nextStart = 0;
    },
    close() {
      this.clear();
      void context.close();
    },
    holdsMicrophone() {
      return queued() > 0 && context.currentTime - replyStart < ECHO_SETTLE_SECONDS;
    },
  };
}
