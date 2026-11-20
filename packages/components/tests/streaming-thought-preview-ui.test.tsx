// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import type { SessionId } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  experimentalFeaturesEnabledAtom,
  lowStimulusExperimentEnabledAtom,
  streamingThoughtPreviewExperimentEnabledAtom,
  streamingThoughtPreviewFeatureEnabledAtom,
} from '../src/atoms/settings';
import type { AssistantActivityRenderItem } from '../src/components/ai-gui/assistant-turn-render-blocks';
import { buildChatStreamItems } from '../src/components/ai-gui/build-chat-stream-items';
import { StreamingThoughtPreview } from '../src/components/ai-gui/streaming-thought-preview-row';
import { SessionChatStreamView } from '../src/components/ai-gui/view';
import { ExperimentalFeaturesSection } from '../src/components/settings/experimental-features-setting';
import { initI18n } from '../src/i18n';
import { clearSavedScrollStates } from '../src/lib/conversation-scroll/saved-state';
import { createConversationViewFromHistory } from '../src/lib/conversation-view';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sessionId = 'thought-preview-session' as SessionId;

const makeThoughtEntry = (itemIndex: number, text: string): AssistantActivityRenderItem => ({
  itemIndex,
  content: { type: 'thought', text },
});

const makeToolCall = (id: string) => ({
  type: 'tool_call' as const,
  toolCallId: id,
  title: `Read ${id}`,
  kind: 'read' as const,
  status: 'completed' as const,
});

const buildTurnHistory = (items: unknown[], assistant: Record<string, unknown> = {}) => [
  {
    id: 'user-1',
    role: 'user',
    timestamp: '2026-11-21T00:00:00Z',
    items: [{ type: 'text', text: 'Inspect the build layout.' }],
  },
  {
    id: 'assistant-1',
    role: 'assistant',
    timestamp: '2026-11-21T00:00:01Z',
    items,
    fileDiff: [],
    finished: false,
    ...assistant,
  },
];

describe('StreamingThoughtPreview throttling and low-stimulus behavior', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T00:00:00Z'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const makeStore = (lowStimulus = false) => {
    const store = createStore();
    store.set(experimentalFeaturesEnabledAtom, true);
    store.set(streamingThoughtPreviewExperimentEnabledAtom, true);
    store.set(lowStimulusExperimentEnabledAtom, lowStimulus);
    return store;
  };

  const previewNode = () =>
    container.querySelector<HTMLElement>('[data-streaming-thought-preview]');

  it('holds each sentence for 1500ms, coalesces intermediate updates, and deduplicates identical text', async () => {
    const store = makeStore(false);
    const renderPreview = (groupKey: string, text: string) =>
      act(async () => {
        root.render(
          createElement(
            Provider,
            { store },
            createElement(StreamingThoughtPreview, {
              groupKey,
              entries: [makeThoughtEntry(0, text)],
            })
          )
        );
      });

    await renderPreview('g1', 'First sentence.');
    expect(previewNode()?.textContent).toBe('First sentence.');

    // Duplicate text must not reset the hold clock.
    await act(async () => vi.advanceTimersByTime(1_000));
    await renderPreview('g1', 'First sentence.');
    expect(previewNode()?.textContent).toBe('First sentence.');

    // Rapid updates within the remaining 500ms hold window coalesce to the latest one.
    await renderPreview('g1', 'Second sentence.');
    await act(async () => vi.advanceTimersByTime(200));
    await renderPreview('g1', 'Third sentence.');
    expect(previewNode()?.textContent).toBe('First sentence.');

    // At 1500ms total since First sentence was shown, Third sentence commits.
    await act(async () => vi.advanceTimersByTime(300));
    expect(previewNode()?.textContent).toBe('Third sentence.');
  });

  it('retains the last valid preview on unclosed bold chunks and resets on group switch', async () => {
    const store = makeStore(false);
    const renderPreview = (groupKey: string, text: string) =>
      act(async () => {
        root.render(
          createElement(
            Provider,
            { store },
            createElement(StreamingThoughtPreview, {
              groupKey,
              entries: [makeThoughtEntry(0, text)],
            })
          )
        );
      });

    await renderPreview('g1', 'Checking existing layout.');
    expect(previewNode()?.textContent).toBe('Checking existing layout.');

    // Unclosed leading bold parses to null -> retains previous valid preview in the same group.
    await renderPreview('g1', '**Half typed heading');
    expect(previewNode()?.textContent).toBe('Checking existing layout.');

    // Switching to another group resets immediately without carrying the prior group's text.
    await renderPreview('g2', '**Half typed heading');
    expect(previewNode()).toBeNull();

    await renderPreview('g2', 'Fresh group thought.');
    expect(previewNode()?.textContent).toBe('Fresh group thought.');
  });

  it('stretches the hold window to 4000ms in low-stimulus mode without adding animation', async () => {
    const store = makeStore(true);
    const renderPreview = (text: string) =>
      act(async () => {
        root.render(
          createElement(
            Provider,
            { store },
            createElement(StreamingThoughtPreview, {
              groupKey: 'g1',
              entries: [makeThoughtEntry(0, text)],
            })
          )
        );
      });

    await renderPreview('Initial thought.');
    const node = previewNode();
    expect(node?.textContent).toBe('Initial thought.');
    expect(node?.className).not.toContain('agent-shimmer');
    expect(node?.className).not.toContain('animate-');

    await renderPreview('Updated thought.');
    await act(async () => vi.advanceTimersByTime(1_500));
    expect(previewNode()?.textContent).toBe('Initial thought.');

    await act(async () => vi.advanceTimersByTime(2_499));
    expect(previewNode()?.textContent).toBe('Initial thought.');

    await act(async () => vi.advanceTimersByTime(1));
    expect(previewNode()?.textContent).toBe('Updated thought.');
  });
});

describe('SessionChatStreamView streaming thought preview integration', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await initI18n('en');
    clearSavedScrollStates();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-11-21T00:00:31Z'));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    clearSavedScrollStates();
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const renderStream = async (
    history: unknown[],
    options: {
      experimental?: boolean;
      thoughtPreview?: boolean;
      lowStimulus?: boolean;
      agentActivityLabel?: string | null;
      agentActivityTone?: 'primary' | 'warning';
      agentActivityShimmer?: boolean;
    } = {}
  ) => {
    const store = createStore();
    store.set(experimentalFeaturesEnabledAtom, options.experimental ?? true);
    store.set(streamingThoughtPreviewExperimentEnabledAtom, options.thoughtPreview ?? true);
    store.set(lowStimulusExperimentEnabledAtom, options.lowStimulus ?? false);

    let current = history;
    let notify: () => void = () => {};
    const view = createConversationViewFromHistory({
      sessionId,
      getHistory: () => current as never,
      subscribe: (listener) => {
        notify = listener;
        return () => {};
      },
    });

    const mountWith = async (nextHistory: unknown[]) => {
      current = nextHistory;
      await act(async () => notify());
      const { items } = buildChatStreamItems(view, sessionId);
      await act(async () => {
        root.render(
          createElement(
            Provider,
            { store },
            createElement(SessionChatStreamView, {
              items,
              sessionId,
              conversationView: view,
              renderMessageRow: () => null,
              lastAssistantMessageId: 'assistant-1',
              agentActivityLabel:
                options.agentActivityLabel === undefined ? 'Working' : options.agentActivityLabel,
              agentActivityTone: options.agentActivityTone ?? 'primary',
              agentActivityShimmer: options.agentActivityShimmer,
            })
          )
        );
      });
    };

    await mountWith(history);
    return { store, rerenderHistory: mountWith };
  };

  it('hides the preview when the experiment switch is disabled', async () => {
    await renderStream(
      buildTurnHistory([
        {
          type: 'thought',
          text: "I'm thinking through how to approach this.\n\n\nChecking the virtual list.",
        },
      ]),
      { experimental: true, thoughtPreview: false }
    );
    expect(container.querySelector('[data-streaming-thought-preview]')).toBeNull();
  });

  it('renders a non-selectable preview in the same virtual row as a collapsed thought-only group', async () => {
    await renderStream(
      buildTurnHistory([
        {
          type: 'thought',
          text: "I'm thinking through how to approach this.\n\n\nChecking the virtual list.",
        },
      ])
    );

    const preview = container.querySelector<HTMLElement>('[data-streaming-thought-preview]');
    const disclosures = container.querySelectorAll<HTMLButtonElement>(
      '[data-conversation-disclosure="group"]'
    );
    const groupHeader = disclosures[disclosures.length - 1]!;

    expect(preview).not.toBeNull();
    expect(preview!.textContent).toBe('Checking the virtual list.');
    expect(preview!.className).toContain('line-clamp-2');
    expect(preview!.className).toContain('select-none');
    expect(preview!.className).not.toContain('agent-shimmer');
    expect(preview!.closest('[data-virtual-index]')).toBe(
      groupHeader.closest('[data-virtual-index]')
    );
  });

  it('retains the latest thought preview while tools run and hides it on manual expand or finish', async () => {
    const liveItems = [
      {
        type: 'thought',
        text: 'Step one.\n\n\nTracing activity group expansion state.',
      },
      makeToolCall('view.tsx'),
      makeToolCall('surface.ts'),
    ];
    const { rerenderHistory } = await renderStream(buildTurnHistory(liveItems), {
      // Also confirm non-shimmer states (e.g. awaiting permission) still show the preview.
      agentActivityTone: 'warning',
      agentActivityShimmer: false,
    });

    expect(container.querySelector('[data-streaming-thought-preview]')?.textContent).toBe(
      'Tracing activity group expansion state.'
    );

    // Expanding the group immediately hides the preview.
    const disclosures = container.querySelectorAll<HTMLButtonElement>(
      '[data-conversation-disclosure="group"]'
    );
    const groupHeader = disclosures[disclosures.length - 1]!;
    await act(async () => groupHeader.click());
    expect(container.querySelector('[data-streaming-thought-preview]')).toBeNull();

    // Collapsing again restores it while the turn is still live.
    await act(async () => groupHeader.click());
    expect(container.querySelector('[data-streaming-thought-preview]')?.textContent).toBe(
      'Tracing activity group expansion state.'
    );

    // Finishing the turn removes the preview completely.
    await rerenderHistory(
      buildTurnHistory([...liveItems, { type: 'text', text: 'Done inspecting.' }], {
        finished: true,
        endedAt: Date.parse('2026-11-21T00:00:30Z'),
      })
    );
    expect(container.querySelector('[data-streaming-thought-preview]')).toBeNull();
  });

  it('does not show the preview on an activity group followed by streamed prose', async () => {
    await renderStream(
      buildTurnHistory([
        { type: 'thought', text: 'Inspecting before writing prose.' },
        { type: 'text', text: 'Streaming the answer now.' },
      ])
    );
    expect(container.querySelector('[data-streaming-thought-preview]')).toBeNull();
  });

  it('respects low-stimulus mode in SessionChatStreamView with 4000ms hold and no added animation', async () => {
    const { rerenderHistory } = await renderStream(
      buildTurnHistory([{ type: 'thought', text: 'First streamed thought.' }]),
      { lowStimulus: true }
    );

    const preview = container.querySelector<HTMLElement>('[data-streaming-thought-preview]');
    expect(preview?.textContent).toBe('First streamed thought.');
    expect(preview?.className).not.toContain('agent-shimmer');
    expect(preview?.className).not.toContain('animate-');

    await rerenderHistory(
      buildTurnHistory([
        { type: 'thought', text: 'First streamed thought.\n\n\nSecond streamed thought.' },
      ])
    );
    await act(async () => vi.advanceTimersByTime(1_500));
    expect(container.querySelector('[data-streaming-thought-preview]')?.textContent).toBe(
      'First streamed thought.'
    );

    await act(async () => vi.advanceTimersByTime(2_500));
    expect(container.querySelector('[data-streaming-thought-preview]')?.textContent).toBe(
      'Second streamed thought.'
    );
  });

  it('wires the device-level switch in ExperimentalFeaturesSection', async () => {
    const store = createStore();
    store.set(experimentalFeaturesEnabledAtom, true);
    store.set(streamingThoughtPreviewExperimentEnabledAtom, false);

    await act(async () => {
      root.render(createElement(Provider, { store }, createElement(ExperimentalFeaturesSection)));
    });

    const toggle = container.querySelector<HTMLElement>(
      '[role="switch"][aria-label="Streaming thought preview"]'
    );
    expect(toggle).not.toBeNull();
    expect(store.get(streamingThoughtPreviewFeatureEnabledAtom)).toBe(false);

    await act(async () => toggle!.click());
    expect(store.get(streamingThoughtPreviewFeatureEnabledAtom)).toBe(true);

    // Turning off the master switch disables the feature while keeping the per-device preference.
    await act(async () => store.set(experimentalFeaturesEnabledAtom, false));
    expect(store.get(streamingThoughtPreviewFeatureEnabledAtom)).toBe(false);
    expect(store.get(streamingThoughtPreviewExperimentEnabledAtom)).toBe(true);
  });
});
