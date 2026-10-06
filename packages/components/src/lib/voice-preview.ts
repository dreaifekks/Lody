import { claimVoicePreview } from '@/lib/voice-activity';

export type VoicePreviewFailure =
  /** A voice call holds the speakers. */
  | 'call-active'
  /** The sample could not be played; `message` says why. */
  | 'playback';

export class VoicePreviewError extends Error {
  constructor(
    readonly failure: VoicePreviewFailure,
    message: string = failure
  ) {
    super(message);
    this.name = 'VoicePreviewError';
  }
}

/** The part of an audio element a preview uses. */
export type VoicePreviewAudio = {
  play: () => Promise<void> | undefined;
  pause: () => void;
  addEventListener: (type: 'ended' | 'error', listener: () => void) => void;
  removeEventListener: (type: 'ended' | 'error', listener: () => void) => void;
  readonly error?: { message?: string } | null;
};

export type VoicePreview = {
  /** Ends the preview at once; `finished` then resolves. */
  stop: () => void;
  /** Resolves when the sample played to its end or the preview stopped; rejects with a VoicePreviewError. */
  finished: Promise<void>;
};

const createAudio = (url: string): VoicePreviewAudio => new Audio(url);

/**
 * Plays a bundled voice sample in this window. One preview plays at a time,
 * none starts during a voice call, and a call starting ends it.
 */
export function playVoicePreview(
  url: string,
  audioFor: (url: string) => VoicePreviewAudio = createAudio
): VoicePreview {
  let settled = false;
  let resolveFinished!: () => void;
  let rejectFinished!: (error: VoicePreviewError) => void;
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  // Never an unhandled rejection: a caller that stops early may not await it.
  finished.catch(() => {});

  let audio: VoicePreviewAudio | null = null;
  const onEnded = () => end();
  const onError = () =>
    end(new VoicePreviewError('playback', audio?.error?.message || 'The sample did not play.'));

  function end(error?: VoicePreviewError) {
    if (settled) return;
    settled = true;
    if (audio) {
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      audio.pause();
    }
    release?.();
    if (error) rejectFinished(error);
    else resolveFinished();
  }
  const stop = () => end();

  const release = claimVoicePreview(stop);
  if (!release) {
    end(new VoicePreviewError('call-active'));
    return { stop, finished };
  }

  audio = audioFor(url);
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('error', onError);
  audio.play()?.catch((error: unknown) => {
    // A stop pauses the element, which rejects the pending play; that is no failure.
    if (settled) return;
    end(new VoicePreviewError('playback', error instanceof Error ? error.message : String(error)));
  });

  return { stop, finished };
}
