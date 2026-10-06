/**
 * Who may use the speakers for realtime voice in this window. A voice call
 * (dictation or conversation) always wins: starting one ends any preview, and
 * no preview starts while a call runs. At most one preview plays at a time.
 */
type Listener = () => void;

let calls = 0;
let preview: { stop: () => void } | null = null;
const listeners = new Set<Listener>();

const notify = () => {
  for (const listener of [...listeners]) listener();
};

/** Marks a call as running until the returned release; ends any preview first. */
export function beginVoiceCall(): () => void {
  calls += 1;
  preview?.stop();
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    calls -= 1;
    notify();
  };
}

export function isVoiceCallActive(): boolean {
  return calls > 0;
}

/**
 * Takes the preview slot, ending the preview that held it. Returns the release,
 * or null while a call runs. `stop` must end the preview and then release.
 */
export function claimVoicePreview(stop: () => void): (() => void) | null {
  if (calls > 0) return null;
  preview?.stop();
  const entry = { stop };
  preview = entry;
  notify();
  return () => {
    if (preview !== entry) return;
    preview = null;
    notify();
  };
}

export function subscribeVoiceActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
