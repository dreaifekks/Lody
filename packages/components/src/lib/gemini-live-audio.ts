/**
 * Browser audio for Gemini Live calls: the microphone as 16 kHz mono PCM16
 * through an AudioWorklet, and the voice's PCM16 replies played back to back
 * through WebAudio, with a way to drop what is still queued when the user
 * talks over it.
 */

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
    await context.audioWorklet.addModule(
      new URL('./gemini-pcm-capture.worklet.js', import.meta.url).href
    );
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

export type GeminiPcmPlayer = {
  play(pcm: Int16Array, sampleRate: number): void;
  /** Silences and forgets everything queued. */
  clear(): void;
  close(): void;
};

export function createGeminiPcmPlayer(): GeminiPcmPlayer {
  const context = new AudioContext();
  void context.resume().catch(() => {});
  const playing = new Set<AudioBufferSourceNode>();
  let nextStart = 0;
  return {
    play(pcm, sampleRate) {
      if (pcm.length === 0) return;
      const buffer = context.createBuffer(1, pcm.length, sampleRate);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i += 1) samples[i] = (pcm[i] ?? 0) / 0x8000;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const startAt = Math.max(context.currentTime, nextStart);
      source.start(startAt);
      nextStart = startAt + buffer.duration;
      playing.add(source);
      source.onended = () => playing.delete(source);
    },
    clear() {
      for (const source of playing) source.stop();
      playing.clear();
      nextStart = 0;
    },
    close() {
      this.clear();
      void context.close();
    },
  };
}
