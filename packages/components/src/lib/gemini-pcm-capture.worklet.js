// AudioWorklet processor for Gemini Live calls: hands the microphone's mono
// float samples to the page, which converts and batches them. It runs in an
// AudioContext created at 16 kHz, so the browser has already resampled.
class GeminiPcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) this.port.postMessage(channel.slice(0));
    return true;
  }
}

registerProcessor('gemini-pcm-capture', GeminiPcmCapture);
