// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginVoiceCall, claimVoicePreview } from '../src/lib/voice-activity';
import {
  playVoicePreview,
  VoicePreviewError,
  type VoicePreviewAudio,
} from '../src/lib/voice-preview';
import { voicePreviewClip } from '../src/lib/voice-preview-clips';

const selection = vi.hoisted(() => ({ voice: 'maple' }));
vi.mock('@/hooks/use-voice-agent-selection', () => ({
  useVoiceAgentSelection: () => ({
    configId: 'config-1',
    machineId: 'machine-1',
    voice: selection.voice,
  }),
}));
vi.mock('@/hooks/use-workspace-catalog', () => ({ useWorkspaceCatalog: () => ({ voice: null }) }));
vi.mock('@/hooks/use-voice-preview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/hooks/use-voice-preview')>()),
  // `aurora` stands for a voice Codex adds after this build.
  useVoiceList: () => ({
    status: 'ready',
    list: { voices: ['cove', 'maple', 'aurora'], defaultVoice: 'cove' },
  }),
}));

const { VoiceNameRow } = await import('../src/components/settings/voice-agent-select');

/** An audio element whose playback the test drives. */
class FakeAudio implements VoicePreviewAudio {
  static all: FakeAudio[] = [];
  playing = false;
  error: { message?: string } | null = null;
  private readonly listeners = new Map<string, Set<() => void>>();
  private rejectPlay: ((error: Error) => void) | null = null;

  constructor(readonly url: string) {
    FakeAudio.all.push(this);
  }
  play() {
    this.playing = true;
    return new Promise<void>((_, reject) => {
      this.rejectPlay = reject;
    });
  }
  pause() {
    this.playing = false;
    // A browser rejects a pending play() that a pause interrupts.
    this.rejectPlay?.(new DOMException('The play() request was interrupted', 'AbortError'));
  }
  addEventListener(type: string, listener: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: 'ended' | 'error') {
    if (type === 'ended') this.playing = false;
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
  failPlay(message: string) {
    this.rejectPlay?.(new Error(message));
  }
}

const audioFor = (url: string) => new FakeAudio(url);

function play(url = 'maple.webm') {
  const preview = playVoicePreview(url, audioFor);
  let outcome: 'pending' | 'done' | VoicePreviewError = 'pending';
  preview.finished.then(
    () => {
      outcome = 'done';
    },
    (error: VoicePreviewError) => {
      outcome = error;
    }
  );
  return { preview, outcome: () => outcome };
}

const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

afterEach(() => {
  FakeAudio.all = [];
});

describe('playVoicePreview', () => {
  it('plays the sample to its end and then frees the speakers', async () => {
    const run = play('cove.webm');
    expect(FakeAudio.all[0]?.url).toBe('cove.webm');
    expect(FakeAudio.all[0]?.playing).toBe(true);

    FakeAudio.all[0]?.fire('ended');
    await settle();

    expect(run.outcome()).toBe('done');
    // The slot is free again: a new preview may take it.
    const release = claimVoicePreview(() => {});
    expect(release).not.toBeNull();
    release?.();
  });

  it('plays one preview at a time', async () => {
    const first = play('maple.webm');
    const second = play('sol.webm');
    await settle();

    expect(first.outcome()).toBe('done');
    expect(FakeAudio.all[0]?.playing).toBe(false);
    expect(FakeAudio.all[1]?.playing).toBe(true);

    second.preview.stop();
    await settle();
    expect(second.outcome()).toBe('done');
    expect(FakeAudio.all[1]?.playing).toBe(false);
  });

  it('stops when a voice call starts, and does not start during one', async () => {
    const run = play();
    const endCall = beginVoiceCall();
    await settle();

    expect(run.outcome()).toBe('done');
    expect(FakeAudio.all[0]?.playing).toBe(false);

    const refused = play();
    await settle();
    expect(refused.outcome()).toMatchObject({ failure: 'call-active' });
    expect(FakeAudio.all).toHaveLength(1);

    endCall();
  });

  it('reports a sample that cannot be played', async () => {
    const broken = play();
    FakeAudio.all[0]!.error = { message: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
    FakeAudio.all[0]?.fire('error');
    await settle();
    expect(broken.outcome()).toMatchObject({
      failure: 'playback',
      message: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
    });

    const refused = play();
    FakeAudio.all[1]?.failPlay('NotAllowedError');
    await settle();
    expect(refused.outcome()).toMatchObject({ failure: 'playback', message: 'NotAllowedError' });
  });
});

describe('voicePreviewClip', () => {
  it('bundles a sample of every realtime v3 voice and none of a voice it does not know', () => {
    for (const voice of [
      'juniper',
      'maple',
      'spruce',
      'ember',
      'vale',
      'breeze',
      'arbor',
      'sol',
      'cove',
    ]) {
      expect(voicePreviewClip(voice)).toMatch(new RegExp(`${voice}\\.webm`));
    }
    expect(voicePreviewClip('aurora')).toBeNull();
    expect(voicePreviewClip('toString')).toBeNull();
  });
});

describe('Speaking voice row', () => {
  let root: Root | null = null;
  let container: HTMLElement;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.restoreAllMocks();
  });

  function render(voice: string) {
    selection.voice = voice;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(createElement(Provider, { store: createStore() }, createElement(VoiceNameRow)))
    );
    const button = container.querySelector<HTMLButtonElement>('button[aria-pressed]');
    if (!button) throw new Error('No preview button');
    return button;
  }

  it('keeps a voice without a sample selectable but cannot play it', () => {
    const button = render('aurora');

    expect(container.textContent).toContain('Aurora');
    expect(button.disabled).toBe(true);
  });

  it('plays the bundled sample of the chosen voice', async () => {
    const played: string[] = [];
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(
      function (this: HTMLMediaElement) {
        played.push(this.src);
        return Promise.resolve();
      }
    );
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const button = render('maple');
    expect(button.disabled).toBe(false);

    await act(async () => button.click());

    expect(played).toHaveLength(1);
    expect(played[0]).toMatch(/maple\.webm/);
    expect(button.getAttribute('aria-pressed')).toBe('true');

    // Pressing again stops it.
    await act(async () => button.click());
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });
});
