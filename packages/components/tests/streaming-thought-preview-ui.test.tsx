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
import type { SessionBackgroundTaskStatus } from '../src/components/ai-gui/background-task-status-row';
import { StreamingThoughtPreview } from '../src/components/ai-gui/streaming-thought-preview-row';
import { SessionChatStreamView } from '../src/components/ai-gui/view';
import { SessionRowStatusIndicator } from '../src/components/sidebar-row-shared';
import { SessionSearchProvider } from '../src/components/sessions/session-search-context';
import { ExperimentalFeaturesSection } from '../src/components/settings/experimental-features-setting';
import { initI18n } from '../src/i18n';
import { ForceMobileLayoutProvider } from '../src/hooks/use-mobile';
import { clearSavedScrollStates } from '../src/lib/conversation-scroll/saved-state';
import { createConversationViewFromHistory } from '../src/lib/conversation-view';
import { getThoughtSearchBlockId } from '../src/lib/session-chat-search';
import { createFrameHarness } from './support/scroll-frame-harness';

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

let turnIdCounter = 0;
const nextAssistantId = () => `assistant-${++turnIdCounter}`;

const buildTurnHistory = (items: unknown[], assistant: Record<string, unknown> = {}) => {
  const id = typeof assistant.id === 'string' ? assistant.id : nextAssistantId();
  return [
    {
      id: `user-${id}`,
      role: 'user',
      timestamp: '2026-11-21T00:00:00Z',
      items: [{ type: 'text', text: 'Inspect the build layout.' }],
    },
    {
      id,
      role: 'assistant',
      timestamp: '2026-11-21T00:00:01Z',
      items,
      fileDiff: [],
      finished: false,
      ...assistant,
    },
  ];
};

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

  it('retains the last valid preview and pending throttled candidate on unclosed bold chunks, and resets on group switch', async () => {
    const store = makeStore(false);
    const renderPreview = (groupKey: string, entries: AssistantActivityRenderItem[]) =>
      act(async () => {
        root.render(
          createElement(
            Provider,
            { store },
            createElement(StreamingThoughtPreview, {
              groupKey,
              entries,
            })
          )
        );
      });

    await renderPreview('g1', [makeThoughtEntry(0, 'Checking existing layout.')]);
    expect(previewNode()?.textContent).toBe('Checking existing layout.');

    // Queue a newer valid candidate inside the 1500ms hold window.
    await act(async () => vi.advanceTimersByTime(500));
    await renderPreview('g1', [makeThoughtEntry(0, 'Queued valid update.')]);
    expect(previewNode()?.textContent).toBe('Checking existing layout.');

    // A transient unclosed bold chunk (null candidate) must not cancel the pending update.
    await act(async () => vi.advanceTimersByTime(400));
    await renderPreview('g1', [makeThoughtEntry(0, '**Half typed heading')]);
    expect(previewNode()?.textContent).toBe('Checking existing layout.');

    await act(async () => vi.advanceTimersByTime(600));
    expect(previewNode()?.textContent).toBe('Queued valid update.');

    // Switching to another group resets immediately without carrying the prior group's text.
    await renderPreview('g2', [makeThoughtEntry(0, '**Half typed heading')]);
    expect(previewNode()).toBeNull();

    // Mounting a group whose newest thought is unclosed still falls back to an earlier valid thought.
    await renderPreview('g3', [
      makeThoughtEntry(0, 'Earlier valid thought.'),
      { itemIndex: 1, content: makeToolCall('view.tsx') },
      makeThoughtEntry(2, '**Half typed heading'),
    ]);
    expect(previewNode()?.textContent).toBe('Earlier valid thought.');
  });

  it('suppresses incremental agy placeholder prefixes without flashing or delaying real prose', async () => {
    const store = makeStore(false);
    const renderPreview = (text: string) =>
      act(async () => {
        root.render(
          createElement(
            Provider,
            { store },
            createElement(StreamingThoughtPreview, {
              groupKey: 'agy-prefix',
              entries: [makeThoughtEntry(0, text)],
            })
          )
        );
      });

    await renderPreview("I'm");
    expect(previewNode()).toBeNull();

    await act(async () => vi.advanceTimersByTime(300));
    await renderPreview("I'm thinking through how to approach this");
    expect(previewNode()).toBeNull();

    await act(async () => vi.advanceTimersByTime(300));
    await renderPreview("I'm thinking through how to approach this.");
    expect(previewNode()).toBeNull();

    // Real prose arriving next displays immediately without waiting 1500ms on a placeholder prefix.
    await act(async () => vi.advanceTimersByTime(200));
    await renderPreview("I'm thinking through how to approach this.\n\n\nChecking view.tsx next.");
    expect(previewNode()?.textContent).toBe('Checking view.tsx next.');

    // A queued valid update survives a transient trailing placeholder prefix and still commits at 1500ms.
    await act(async () => vi.advanceTimersByTime(400));
    await renderPreview('Queued follow-up thought.');
    await act(async () => vi.advanceTimersByTime(400));
    await renderPreview("I'm thinking through");
    expect(previewNode()?.textContent).toBe('Checking view.tsx next.');

    await act(async () => vi.advanceTimersByTime(700));
    expect(previewNode()?.textContent).toBe('Queued follow-up thought.');
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
      sessionId?: SessionId;
      experimental?: boolean;
      thoughtPreview?: boolean;
      lowStimulus?: boolean;
      agentActivityLabel?: string | null;
      agentActivityTone?: 'primary' | 'warning';
      agentActivityShimmer?: boolean;
      backgroundTaskStatus?: SessionBackgroundTaskStatus | null;
      activeSearchBlockId?: string | null;
      onFilePathClick?: (filePath: string) => void;
      onFork?: () => void;
    } = {}
  ) => {
    const targetSessionId = options.sessionId ?? sessionId;
    const store = createStore();
    store.set(experimentalFeaturesEnabledAtom, options.experimental ?? true);
    store.set(streamingThoughtPreviewExperimentEnabledAtom, options.thoughtPreview ?? true);
    store.set(lowStimulusExperimentEnabledAtom, options.lowStimulus ?? false);

    let current = history;
    let currentBgStatus = options.backgroundTaskStatus ?? null;
    let notify: () => void = () => {};
    const view = createConversationViewFromHistory({
      sessionId: targetSessionId,
      getHistory: () => current as never,
      subscribe: (listener) => {
        notify = listener;
        return () => {};
      },
    });

    const mountWith = async (
      nextHistory: unknown[],
      nextBgStatus: SessionBackgroundTaskStatus | null = currentBgStatus
    ) => {
      current = nextHistory;
      currentBgStatus = nextBgStatus;
      await act(async () => notify());
      const lastAssistant = [...nextHistory]
        .reverse()
        .find((entry): entry is { id: string; role: string; finished?: boolean } => {
          return (
            typeof entry === 'object' &&
            entry !== null &&
            (entry as { role?: unknown }).role === 'assistant' &&
            typeof (entry as { id?: unknown }).id === 'string'
          );
        });
      const { items } = buildChatStreamItems(view, targetSessionId);
      const streamNode = createElement(SessionChatStreamView, {
        items,
        sessionId: targetSessionId,
        conversationView: view,
        renderMessageRow: () => null,
        lastAssistantMessageId: lastAssistant?.id ?? 'assistant-1',
        lastCompletedAssistantMessageId:
          lastAssistant?.finished === true ? lastAssistant.id : undefined,
        agentActivityLabel:
          options.agentActivityLabel === undefined ? 'Working' : options.agentActivityLabel,
        agentActivityTone: options.agentActivityTone ?? 'primary',
        agentActivityShimmer: options.agentActivityShimmer,
        backgroundTaskStatus: currentBgStatus,
        onFilePathClick: options.onFilePathClick,
        onForkLastAssistant: options.onFork,
      });
      const activeSearchBlockId = options.activeSearchBlockId ?? null;
      const wrapped =
        options.activeSearchBlockId !== undefined
          ? createElement(
              SessionSearchProvider,
              {
                value: {
                  isOpen: true,
                  query: 'Needle',
                  activeBlockId: activeSearchBlockId,
                  activeResultId: activeSearchBlockId ? 'result-0' : null,
                  blockMatches: activeSearchBlockId
                    ? new Map([
                        [
                          activeSearchBlockId,
                          {
                            blockId: activeSearchBlockId,
                            resultIds: ['result-0'],
                            activeResultId: 'result-0',
                            activeOccurrenceIndex: 0,
                          },
                        ],
                      ])
                    : new Map(),
                  hasMatchedPrefix: (prefix: string) =>
                    Boolean(activeSearchBlockId?.startsWith(prefix)),
                  hasActivePrefix: (prefix: string) =>
                    Boolean(activeSearchBlockId?.startsWith(prefix)),
                },
              },
              streamNode
            )
          : streamNode;
      await act(async () => {
        root.render(createElement(Provider, { store }, wrapped));
      });
    };

    await mountWith(history, options.backgroundTaskStatus ?? null);
    return { store, rerenderHistory: mountWith };
  };

  it('preserves upstream layout with no compact header when the experiment switch is disabled', async () => {
    await renderStream(
      buildTurnHistory([
        {
          type: 'thought',
          text: "I'm thinking through how to approach this.\n\n\nChecking the virtual list.",
        },
        makeToolCall('view.tsx'),
      ]),
      { experimental: true, thoughtPreview: false }
    );
    expect(container.querySelector('[data-compact-work-header]')).toBeNull();
    expect(container.querySelector('[data-streaming-thought-preview]')).toBeNull();
    // Upstream renders the two-layer disclosure (WorkedGroupHeader + ActivityGroupHeader).
    expect(
      container.querySelectorAll('[data-conversation-disclosure="group"]').length
    ).toBeGreaterThanOrEqual(2);
  });

  it('renders Option C Stage 1 placeholder-only as Thinking (duration) with no second line and quiet expanded note', async () => {
    await renderStream(
      buildTurnHistory([
        {
          type: 'thought',
          text: "I'm thinking through how to approach this.",
        },
      ])
    );

    const header = container.querySelector<HTMLButtonElement>('[data-compact-work-header="live"]');
    expect(header).not.toBeNull();
    const primary = header!.querySelector<HTMLElement>('[data-compact-primary-line]');
    expect(primary?.querySelector('[data-compact-status-verb]')?.textContent).toBe('Thinking');
    expect(primary?.textContent).not.toContain('Thinking…');
    expect(primary?.querySelector('[data-compact-live-duration]')?.textContent).toBe('(30s)');
    expect(primary?.querySelector('[data-compact-tool-counts]')).toBeNull();
    expect(primary?.className).not.toContain('agent-shimmer');
    expect(primary?.parentElement?.className).toContain('agent-shimmer');
    expect(header!.querySelector('[data-compact-secondary-line]')).toBeNull();
    // No duplicate bottom AgentActivityStatus row while compact live header owns status.
    expect(container.querySelector('[data-agent-activity-status]')).toBeNull();

    // Expanding shows the quiet placeholder note directly (single-level, no nested group header).
    await act(async () => header!.click());
    expect(container.querySelector('[data-compact-thought-placeholder]')?.textContent).toBe(
      'Thinking…'
    );
    expect(container.querySelectorAll('[data-conversation-disclosure="group"]')).toHaveLength(1);
  });

  it('keeps fixed Row 1 (status + tool counts + duration) and Row 2 (full latest thought) without swapping across thinking and tool phases', async () => {
    const turnId = nextAssistantId();
    // Stage 2: valid multi-sentence thought without tools -> Row 1 Thinking (30s), Row 2 full paragraph.
    const { rerenderHistory } = await renderStream(
      buildTurnHistory(
        [
          {
            type: 'thought',
            text: "I'm thinking through how to approach this.\n\n\nChecking `view.tsx` first. More details later.\nSecond line stays intact.",
          },
        ],
        { id: turnId }
      )
    );
    const primaryStage2 = container.querySelector('[data-compact-primary-line]');
    const secondaryStage2 = container.querySelector('[data-compact-secondary-line]');
    expect(primaryStage2?.querySelector('[data-compact-status-verb]')?.textContent).toBe(
      'Thinking'
    );
    expect(primaryStage2?.querySelector('[data-compact-tool-counts]')).toBeNull();
    expect(primaryStage2?.querySelector('[data-compact-live-duration]')?.textContent).toBe('(30s)');
    expect(primaryStage2?.textContent).not.toContain('Checking view.tsx');
    expect(secondaryStage2?.textContent).toBe(
      'Checking view.tsx first. More details later.\nSecond line stays intact.'
    );

    // Stage 3: active non-background tool -> Row 1 keeps Running <target> · <toolCounts> (duration),
    // Row 2 retains full latest thought paragraph (never swaps positions).
    await rerenderHistory(
      buildTurnHistory(
        [
          {
            type: 'thought',
            text: "I'm thinking through how to approach this.\n\n\nChecking `view.tsx` first. More details later.\nSecond line stays intact.",
          },
          makeToolCall('view.tsx'),
          makeToolCall('surface.ts'),
          {
            type: 'tool_call',
            toolCallId: 'cmd-test',
            kind: 'execute',
            title: 'Run pnpm --filter @lody/components test',
            status: 'in_progress',
          },
        ],
        { id: turnId }
      )
    );
    const primaryTool = container.querySelector('[data-compact-primary-line]');
    const secondaryTool = container.querySelector('[data-compact-secondary-line]');
    expect(primaryTool?.querySelector('[data-compact-status-verb]')?.textContent).toBe('Running');
    expect(primaryTool?.querySelector('[data-compact-active-target]')?.textContent).toBe(
      'pnpm --filter @lody/components test'
    );
    expect(primaryTool?.querySelector('[data-compact-tool-counts]')?.textContent).toBe(
      'Read 2 files'
    );
    expect(primaryTool?.querySelector('[data-compact-live-duration]')?.textContent).toBe('(30s)');
    expect(secondaryTool?.textContent).toBe(
      'Checking view.tsx first. More details later.\nSecond line stays intact.'
    );

    // Stage 4: command completed + backgrounded tool + new thought -> Row 1 stays Thinking · <toolCounts> (duration),
    // Row 2 updates to the new full thought paragraph without swapping.
    await act(async () => vi.advanceTimersByTime(1_600));
    await rerenderHistory(
      buildTurnHistory(
        [
          {
            type: 'thought',
            text: 'Checking view.tsx first.',
          },
          makeToolCall('view.tsx'),
          makeToolCall('surface.ts'),
          {
            type: 'tool_call',
            toolCallId: 'cmd-test',
            kind: 'execute',
            title: 'Run pnpm --filter @lody/components test',
            status: 'completed',
            content: [{ type: 'terminal_output', output: '42 passed', stream: 'combined' }],
          },
          {
            type: 'tool_call',
            toolCallId: 'cmd-bg',
            kind: 'execute',
            title: 'Run gh run watch 2048 --exit-status',
            status: 'in_progress',
            backgroundTaskId: 'bg-gh-2048',
          },
          {
            type: 'thought',
            text: 'Summarizing findings while CI watches in background. Checking every test boundary.\nReady to compose the final answer.',
          },
        ],
        { id: turnId }
      )
    );
    const primaryStage4 = container.querySelector('[data-compact-primary-line]');
    const secondaryStage4 = container.querySelector('[data-compact-secondary-line]');
    expect(primaryStage4?.querySelector('[data-compact-status-verb]')?.textContent).toBe(
      'Thinking'
    );
    expect(primaryStage4?.querySelector('[data-compact-active-target]')).toBeNull();
    const countsStage4 = primaryStage4?.querySelector('[data-compact-tool-counts]')?.textContent;
    expect(countsStage4).toContain('Read 2 files');
    expect(countsStage4).toContain('Ran 1 command');
    expect(countsStage4).toContain('1 in background');
    expect(primaryStage4?.textContent).not.toContain('Summarizing findings');
    expect(secondaryStage4?.textContent).toBe(
      'Summarizing findings while CI watches in background. Checking every test boundary.\nReady to compose the final answer.'
    );
  });

  it('renders full multi-line long thought paragraphs (>8,500 chars / 33+ lines) with no clamping, retains across transient placeholders, and hides on expand or finish (including mobile settled header)', async () => {
    const turnId = nextAssistantId();
    const longLine = `${'Verifying dynamic height and full paragraph display without truncation. '.repeat(122)}Final path /workspace/lody-demo/packages/components/src/components/ai-gui/compact-native-directory-row.tsx and https://example.com/very/long/unbroken/path/for/wrap-check.`;
    expect(longLine.length).toBeGreaterThan(8_500);
    const extraLines = Array.from({ length: 33 }, (_, i) => `Detail line ${i + 1}.`).join('\n');
    const multiLineThought = `**Inspecting header layout**\n${longLine}\n${extraLines}\nFinal line confirms natural line breaks remain intact.`;

    const { rerenderHistory } = await renderStream(
      buildTurnHistory([{ type: 'thought', text: multiLineThought }], { id: turnId })
    );

    const secondary = container.querySelector<HTMLElement>('[data-compact-secondary-line]');
    expect(secondary).not.toBeNull();
    expect(secondary!.className).not.toContain('line-clamp');
    expect(secondary!.textContent).toBe(
      `Inspecting header layout\n${longLine}\n${extraLines}\nFinal line confirms natural line breaks remain intact.`
    );

    // Transient placeholder or unclosed bold heading keeps Row 2 stable without flashing blank.
    await act(async () => vi.advanceTimersByTime(2_000));
    await rerenderHistory(
      buildTurnHistory(
        [
          { type: 'thought', text: multiLineThought },
          { type: 'thought', text: "I'm thinking through how to approach this.\n\n**Unclosed" },
        ],
        { id: turnId }
      )
    );
    expect(container.querySelector('[data-compact-secondary-line]')?.textContent).toBe(
      `Inspecting header layout\n${longLine}\n${extraLines}\nFinal line confirms natural line breaks remain intact.`
    );

    // Expanding the live header hides Row 2; collapsing restores it.
    const liveHeader = container.querySelector<HTMLButtonElement>(
      '[data-compact-work-header="live"]'
    )!;
    await act(async () => liveHeader.click());
    expect(container.querySelector('[data-compact-secondary-line]')).toBeNull();
    await act(async () => liveHeader.click());
    expect(container.querySelector('[data-compact-secondary-line]')?.textContent).toContain(
      'Final line confirms natural line breaks remain intact.'
    );

    // Finishing the turn collapses Row 2 automatically and shows clean desktop settled label.
    await rerenderHistory(
      buildTurnHistory(
        [
          { type: 'thought', text: multiLineThought },
          { type: 'text', text: 'Done.' },
        ],
        {
          id: turnId,
          finished: true,
          endedAt: Date.parse('2026-11-21T00:00:30Z'),
        }
      )
    );
    expect(container.querySelector('[data-compact-secondary-line]')).toBeNull();
    expect(
      container.querySelector('[data-compact-work-header="finished"]')?.textContent?.trim()
    ).toBe('Worked for 29s');

    // On mobile, finished header omits duration (owned by footer per ai-gui/AGENTS.md).
    const mobileStore = createStore();
    mobileStore.set(experimentalFeaturesEnabledAtom, true);
    mobileStore.set(streamingThoughtPreviewExperimentEnabledAtom, true);
    const mobileHistory = buildTurnHistory(
      [
        { type: 'thought', text: multiLineThought },
        { type: 'text', text: 'Done.' },
      ],
      {
        id: nextAssistantId(),
        finished: true,
        endedAt: Date.parse('2026-11-21T00:00:30Z'),
      }
    );
    const mobileView = createConversationViewFromHistory({
      sessionId: 'mobile-settled-session' as SessionId,
      getHistory: () => mobileHistory as never,
      subscribe: () => () => {},
    });
    const { items: mobileItems } = buildChatStreamItems(
      mobileView,
      'mobile-settled-session' as SessionId
    );
    await act(async () => {
      root.render(
        createElement(
          Provider,
          { store: mobileStore },
          createElement(
            ForceMobileLayoutProvider,
            { force: true },
            createElement(SessionChatStreamView, {
              items: mobileItems,
              sessionId: 'mobile-settled-session' as SessionId,
              conversationView: mobileView,
              renderMessageRow: () => null,
              lastAssistantMessageId: (mobileHistory[1] as { id: string }).id,
              agentActivityLabel: null,
            })
          )
        )
      );
    });
    expect(
      container.querySelector('[data-compact-work-header="finished"]')?.textContent?.trim()
    ).toBe('Finished working');
    expect(container.querySelector('[data-compact-secondary-line]')).toBeNull();
  });

  it('opens a flat single-level directory on one click after finish, clustering reads, toggling thoughts, and stripping placeholders', async () => {
    const finishedItems = [
      {
        type: 'thought',
        text: "I'm thinking through how to approach this.\n\n\nChecking view.tsx layout.\n\nSecond paragraph detail.",
      },
      {
        type: 'tool_call',
        toolCallId: 'r1',
        kind: 'read',
        title: 'Read packages/components/src/components/ai-gui/view.tsx',
        locations: [{ path: 'packages/components/src/components/ai-gui/view.tsx' }],
        status: 'completed',
      },
      {
        type: 'tool_call',
        toolCallId: 'r2',
        kind: 'read',
        title: 'Read packages/components/src/components/ai-gui/surface.ts',
        locations: [{ path: 'packages/components/src/components/ai-gui/surface.ts' }],
        status: 'completed',
      },
      {
        type: 'thought',
        text: 'Running tests and starting CI watch.',
      },
      {
        type: 'tool_call',
        toolCallId: 'cmd-test',
        kind: 'execute',
        title: 'Run pnpm test',
        status: 'completed',
        content: [{ type: 'terminal_output', output: 'All 42 tests passed', stream: 'combined' }],
      },
      {
        type: 'tool_call',
        toolCallId: 'cmd-bg',
        kind: 'execute',
        title: 'Run gh run watch 2048 --exit-status',
        status: 'in_progress',
        backgroundTaskId: 'bg-gh-2048',
        content: [
          {
            type: 'terminal_output',
            output: 'Tool is running as a background task with task id: bg-gh-2048',
            stream: 'combined',
          },
        ],
      },
      {
        type: 'text',
        text: 'Final verified answer.',
      },
    ];

    const turnId = nextAssistantId();
    const { rerenderHistory } = await renderStream(
      buildTurnHistory(finishedItems, {
        id: turnId,
        finished: true,
        endedAt: Date.parse('2026-11-21T00:00:30Z'),
      }),
      {
        agentActivityLabel: null,
        backgroundTaskStatus: { mode: 'waiting', taskCount: 1 },
      }
    );

    // Finished turn keeps #2353 folding: native "Worked for 29s" header, no token chatter, answer visible.
    const workedHeader = container.querySelector<HTMLButtonElement>(
      '[data-compact-work-header="finished"]'
    );
    expect(workedHeader).not.toBeNull();
    expect(workedHeader!.textContent?.trim()).toBe('Worked for 29s');
    expect(container.textContent).toContain('Final verified answer.');
    expect(container.querySelector('[data-compact-thought-row]')).toBeNull();

    // ONE click opens flat single-level directory directly (no nested ActivityGroupHeader!).
    await act(async () => workedHeader!.click());
    expect(container.querySelectorAll('[data-conversation-disclosure="group"]')).toHaveLength(1);

    // >1 valid thoughts -> shows lightweight "Expand all thoughts" toggle (no verbose meta copy).
    const toggleAllBtn = container.querySelector<HTMLButtonElement>(
      '[data-compact-toggle-all-thoughts]'
    );
    expect(toggleAllBtn?.textContent).toBe('Expand all thoughts');

    // Placeholder sentence is stripped; thoughts start collapsed as single-line excerpts.
    expect(container.textContent).not.toContain("I'm thinking through how to approach this.");
    expect(container.querySelectorAll('[data-compact-thought-row]')).toHaveLength(2);
    expect(container.querySelector('[data-compact-thought-body]')).toBeNull();

    // Clicking a single thought expands its full Markdown in place.
    const firstThoughtToggle = container.querySelector<HTMLButtonElement>(
      '[data-compact-thought-row="0"] [data-compact-thought-toggle]'
    );
    await act(async () => firstThoughtToggle!.click());
    expect(container.querySelectorAll('[data-compact-thought-body]')).toHaveLength(1);
    expect(container.querySelector('[data-compact-thought-body]')?.textContent).toContain(
      'Second paragraph detail.'
    );

    // Clicking "Expand all thoughts" opens all thoughts and flips label to "Collapse all thoughts".
    await act(async () => toggleAllBtn!.click());
    expect(container.querySelectorAll('[data-compact-thought-body]')).toHaveLength(2);
    expect(container.querySelector('[data-compact-toggle-all-thoughts]')?.textContent).toBe(
      'Collapse all thoughts'
    );

    // Adjacent completed read tools clustered into one row; clicking reveals file paths.
    const clusterToggle = container.querySelector<HTMLButtonElement>(
      '[data-compact-read-cluster-toggle]'
    );
    expect(clusterToggle?.textContent).toContain('Read 2 files');
    expect(clusterToggle?.textContent).toContain('view.tsx, surface.ts');
    await act(async () => clusterToggle!.click());
    const clusterList = container.querySelector('[data-compact-read-cluster-list]');
    expect(clusterList?.textContent).toContain(
      'packages/components/src/components/ai-gui/view.tsx'
    );
    expect(clusterList?.textContent).toContain(
      'packages/components/src/components/ai-gui/surface.ts'
    );

    // Command row expands output on click with NO "View output" badge.
    const cmdRow = container.querySelector<HTMLElement>('[data-compact-tool-row="cmd-test"]');
    expect(cmdRow?.textContent).not.toContain('View output');
    expect(cmdRow?.textContent).not.toContain('查看输出');
    await act(async () =>
      cmdRow!.querySelector<HTMLButtonElement>('[data-compact-tool-toggle]')!.click()
    );
    expect(cmdRow?.querySelector('[data-compact-tool-detail]')?.textContent).toContain(
      'All 42 tests passed'
    );

    // Backgrounded command retains its neutral historical BG badge from tool_call.backgroundTaskId
    // independent of session-level live background presence.
    expect(
      container.querySelector('[data-compact-tool-row="cmd-bg"] [data-compact-bg-badge]')
        ?.textContent
    ).toBe('BG');

    await rerenderHistory(
      buildTurnHistory(finishedItems, {
        id: turnId,
        finished: true,
        endedAt: Date.parse('2026-11-21T00:00:30Z'),
      }),
      null
    );
    expect(
      container.querySelector('[data-compact-tool-row="cmd-bg"] [data-compact-bg-badge]')
        ?.textContent
    ).toBe('BG');
  });

  it('preserves read-cluster expansion when a 3rd adjacent read streams in and isolates expand cache across forked sessions', async () => {
    const sharedTurnId = nextAssistantId();
    const initialReads = [
      {
        type: 'tool_call',
        toolCallId: 'r1',
        kind: 'read',
        title: 'Read packages/components/src/a.ts',
        locations: [{ path: 'packages/components/src/a.ts' }],
        status: 'completed',
      },
      {
        type: 'tool_call',
        toolCallId: 'r2',
        kind: 'read',
        title: 'Read packages/components/src/b.ts',
        locations: [{ path: 'packages/components/src/b.ts' }],
        status: 'completed',
      },
    ];

    const sessionA = 'session-original-fork-a' as SessionId;
    const sessionB = 'session-forked-copy-b' as SessionId;

    const { rerenderHistory } = await renderStream(
      buildTurnHistory(initialReads, { id: sharedTurnId }),
      { sessionId: sessionA }
    );

    // Expand compact live header and the 2-file read cluster.
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-compact-work-header="live"]')!.click()
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-compact-read-cluster-toggle]')!.click()
    );
    expect(container.querySelector('[data-compact-read-cluster-list]')?.textContent).toContain(
      'packages/components/src/b.ts'
    );

    // Stream a 3rd adjacent completed read -> cluster stays expanded and includes the new file.
    await rerenderHistory(
      buildTurnHistory(
        [
          ...initialReads,
          {
            type: 'tool_call',
            toolCallId: 'r3',
            kind: 'read',
            title: 'Read packages/components/src/c.ts',
            locations: [{ path: 'packages/components/src/c.ts' }],
            status: 'completed',
          },
        ],
        { id: sharedTurnId }
      )
    );
    const expandedAfterThird = container.querySelector('[data-compact-read-cluster-list]');
    expect(expandedAfterThird).not.toBeNull();
    expect(expandedAfterThird?.textContent).toContain('packages/components/src/c.ts');

    // Mounting a forked session that reuses the exact same turnId must start collapsed (isolated cache).
    await renderStream(
      buildTurnHistory([...initialReads, { type: 'text', text: 'Done.' }], {
        id: sharedTurnId,
        finished: true,
        endedAt: Date.parse('2026-11-21T00:00:30Z'),
      }),
      { sessionId: sessionB, agentActivityLabel: null }
    );
    expect(
      container
        .querySelector('[data-compact-work-header="finished"]')
        ?.getAttribute('aria-expanded')
    ).toBe('false');
    expect(container.querySelector('[data-compact-read-cluster-list]')).toBeNull();
  });

  it('keeps independent open-file links on standalone Read and Edit rows that also expand outputs/diffs', async () => {
    const proto = globalThis.CSSStyleSheet?.prototype as
      | (CSSStyleSheet & { replaceSync?: (text: string) => void })
      | undefined;
    const originalReplaceSync = proto?.replaceSync;
    if (proto && typeof proto.replaceSync !== 'function') {
      proto.replaceSync = () => {};
    }
    try {
      const openedPaths: string[] = [];
      const turnId = nextAssistantId();
      await renderStream(
        buildTurnHistory(
          [
            {
              type: 'tool_call',
              toolCallId: 'read-with-output',
              kind: 'read',
              title: 'Read packages/components/src/alpha.ts',
              locations: [{ path: 'packages/components/src/alpha.ts' }],
              status: 'completed',
              content: [
                {
                  type: 'content',
                  content: { type: 'text', text: 'export const alpha = 1;' },
                },
              ],
            },
            {
              type: 'tool_call',
              toolCallId: 'edit-with-diff',
              kind: 'edit',
              title: 'Edit packages/components/src/beta.ts',
              locations: [{ path: 'packages/components/src/beta.ts' }],
              status: 'completed',
              content: [
                {
                  type: 'diff',
                  path: 'packages/components/src/beta.ts',
                  oldText: 'old',
                  newText: 'new',
                },
              ],
            },
            {
              type: 'tool_call',
              toolCallId: 'read-no-detail',
              kind: 'read',
              title: 'Read packages/components/src/gamma.ts',
              locations: [{ path: 'packages/components/src/gamma.ts' }],
              status: 'completed',
            },
            { type: 'text', text: 'Reviewed.' },
          ],
          {
            id: turnId,
            finished: true,
            endedAt: Date.parse('2026-11-21T00:00:30Z'),
          }
        ),
        {
          agentActivityLabel: null,
          onFilePathClick: (filePath) => openedPaths.push(filePath),
        }
      );

      await act(async () =>
        container.querySelector<HTMLButtonElement>('[data-compact-work-header="finished"]')!.click()
      );

      // Read with output: clicking filename opens file without expanding; clicking row expands output.
      const readRow = container.querySelector<HTMLElement>(
        '[data-compact-tool-row="read-with-output"]'
      );
      const readFileLink = readRow!.querySelector<HTMLButtonElement>(
        '[data-compact-tool-file-link]'
      );
      const readRowToggle = readRow!.querySelector<HTMLElement>('[data-compact-tool-toggle]');
      expect(readFileLink?.textContent).toBe('alpha.ts');
      await act(async () => readFileLink!.click());
      expect(openedPaths).toEqual(['packages/components/src/alpha.ts']);
      expect(readRow!.querySelector('[data-compact-tool-detail]')).toBeNull();

      await act(async () => readRowToggle!.click());
      expect(readRow!.querySelector('[data-compact-tool-detail]')?.textContent).toContain(
        'export const alpha = 1;'
      );
      expect(openedPaths).toEqual(['packages/components/src/alpha.ts']);

      // Edit with diff: clicking filename opens file; clicking row expands diff.
      const editRow = container.querySelector<HTMLElement>(
        '[data-compact-tool-row="edit-with-diff"]'
      );
      await act(async () =>
        editRow!.querySelector<HTMLButtonElement>('[data-compact-tool-file-link]')!.click()
      );
      expect(openedPaths).toEqual([
        'packages/components/src/alpha.ts',
        'packages/components/src/beta.ts',
      ]);
      expect(editRow!.querySelector('[data-compact-tool-detail]')).toBeNull();
      await act(async () =>
        editRow!.querySelector<HTMLElement>('[data-compact-tool-toggle]')!.click()
      );
      expect(editRow!.querySelector('[data-compact-tool-detail]')).not.toBeNull();

      // Read without detail: clicking row directly opens source file.
      const simpleReadRow = container.querySelector<HTMLElement>(
        '[data-compact-tool-row="read-no-detail"]'
      );
      await act(async () =>
        simpleReadRow!.querySelector<HTMLButtonElement>('[data-compact-tool-toggle]')!.click()
      );
      expect(openedPaths).toEqual([
        'packages/components/src/alpha.ts',
        'packages/components/src/beta.ts',
        'packages/components/src/gamma.ts',
      ]);
    } finally {
      if (proto && originalReplaceSync === undefined) {
        delete proto.replaceSync;
      }
    }
  });

  it('auto-expands the compact directory and matching thought when search hits a folded thought', async () => {
    const turnId = nextAssistantId();
    await renderStream(
      buildTurnHistory(
        [
          { type: 'thought', text: 'Needle inside hidden reasoning paragraph.' },
          { type: 'text', text: 'Final answer.' },
        ],
        {
          id: turnId,
          finished: true,
          endedAt: Date.parse('2026-11-21T00:00:30Z'),
        }
      ),
      {
        agentActivityLabel: null,
        activeSearchBlockId: getThoughtSearchBlockId(turnId, 0),
      }
    );

    expect(container.querySelector('[data-compact-thought-body]')?.textContent).toContain(
      'Needle inside hidden reasoning paragraph.'
    );
  });

  it('does not show the live thought preview on a work header followed by streamed final prose', async () => {
    await renderStream(
      buildTurnHistory([
        { type: 'thought', text: 'Inspecting before writing prose.' },
        { type: 'text', text: 'Streaming the answer now.' },
      ])
    );
    expect(container.querySelector('[data-streaming-thought-preview]')).toBeNull();
    expect(container.querySelector('[data-compact-work-header="finished"]')?.textContent).toContain(
      'Working'
    );
  });

  it('keeps the compact live summary visible when the same live turn has a trailing subagent task summary', async () => {
    await renderStream(
      buildTurnHistory([
        {
          type: 'subagent_task',
          taskId: 'worker-1',
          status: 'in_progress',
          taskType: 'subagent',
          subagentType: 'Explore',
          description: 'Trace layout boundaries',
          isBackgrounded: true,
        },
        {
          type: 'thought',
          text: 'Reviewing worker findings before patching the renderer.',
        },
      ])
    );

    expect(container.querySelector('[data-subagent-task-id="worker-1"]')).not.toBeNull();
    expect(container.querySelector('[data-streaming-thought-preview]')?.textContent).toBe(
      'Reviewing worker findings before patching the renderer.'
    );
  });

  it('hides the live preview when the turn has a numeric endedAt even if finished is false', async () => {
    await renderStream(
      buildTurnHistory([{ type: 'thought', text: 'Finalizing the response.' }], {
        finished: false,
        endedAt: Date.parse('2026-11-21T00:00:28Z'),
      })
    );
    expect(container.querySelector('[data-streaming-thought-preview]')).toBeNull();
  });

  it('respects low-stimulus mode in SessionChatStreamView with 4000ms hold, no shimmer, and transition-none disclosures', async () => {
    const turnId = nextAssistantId();
    const { rerenderHistory } = await renderStream(
      buildTurnHistory([{ type: 'thought', text: 'First streamed thought.' }], { id: turnId }),
      { lowStimulus: true }
    );

    const primary = container.querySelector<HTMLElement>('[data-compact-primary-line]');
    expect(primary?.className).not.toContain('agent-shimmer');
    expect(container.querySelector('.agent-shimmer')).toBeNull();
    // Header chevron uses transition-none in low-stimulus mode.
    const headerButton = container.querySelector<HTMLButtonElement>(
      '[data-compact-work-header="live"]'
    );
    expect(headerButton?.innerHTML).toContain('transition-none');
    expect(headerButton?.innerHTML).not.toContain('duration-150');
    expect(container.querySelector('[data-streaming-thought-preview]')?.textContent).toBe(
      'First streamed thought.'
    );

    await rerenderHistory(
      buildTurnHistory(
        [{ type: 'thought', text: 'First streamed thought.\n\n\nSecond streamed thought.' }],
        { id: turnId }
      )
    );
    await act(async () => vi.advanceTimersByTime(1_500));
    expect(container.querySelector('[data-streaming-thought-preview]')?.textContent).toBe(
      'First streamed thought.'
    );

    await act(async () => vi.advanceTimersByTime(2_500));
    expect(container.querySelector('[data-streaming-thought-preview]')?.textContent).toBe(
      'Second streamed thought.'
    );

    // Expanding directory keeps thought disclosure arrow transition-none in low-stimulus mode.
    await act(async () => headerButton!.click());
    const thoughtToggle = container.querySelector<HTMLButtonElement>(
      '[data-compact-thought-toggle]'
    );
    expect(thoughtToggle?.innerHTML).toContain('transition-none');
    expect(thoughtToggle?.innerHTML).not.toContain('duration-150');
  });

  it('keeps the shimmer wrapper separate from the primary flex truncation container with anti-squeeze slots', async () => {
    const turnId = nextAssistantId();
    await renderStream(
      buildTurnHistory(
        [
          makeToolCall('view.tsx'),
          makeToolCall('surface.ts'),
          {
            type: 'tool_call',
            toolCallId: 'edit-1',
            kind: 'edit',
            title:
              'Edit packages/components/src/components/ai-gui/compact-native-directory-row.tsx',
            locations: [
              {
                path: 'packages/components/src/components/ai-gui/compact-native-directory-row.tsx',
              },
            ],
            status: 'completed',
          },
          {
            type: 'tool_call',
            toolCallId: 'cmd-long',
            kind: 'execute',
            title:
              'Run pnpm --filter @lody/components test tests/streaming-thought-preview.test.ts tests/streaming-thought-preview-ui.test.tsx',
            status: 'in_progress',
          },
        ],
        { id: turnId }
      ),
      { lowStimulus: false, agentActivityShimmer: true }
    );

    const primaryFlex = container.querySelector<HTMLElement>('[data-compact-primary-line]');
    expect(primaryFlex).not.toBeNull();
    // `.agent-shimmer` (`display: inline-block`) must sit on an outer wrapper, never on
    // `[data-compact-primary-line]` itself, so flex truncation preserves the trailing duration.
    expect(primaryFlex!.className).not.toContain('agent-shimmer');
    expect(primaryFlex!.parentElement?.className).toContain('agent-shimmer');
    expect(primaryFlex!.querySelector('[data-compact-status-verb]')?.textContent).toBe('Running');
    expect(primaryFlex!.querySelector('[data-compact-active-target]')?.textContent).toContain(
      'pnpm --filter @lody/components test'
    );
    expect(primaryFlex!.querySelector('[data-compact-tool-counts]')?.textContent).toBe(
      'Read 2 files · Edited 1 file'
    );
    expect(primaryFlex!.querySelector('[data-compact-live-duration]')?.textContent).toBe('(30s)');
  });

  it('re-measures dynamic multi-line compact_work_header growth, throttled updates, shrinkage, and finish without overlapping following rows or breaking auto-follow', async () => {
    const dynamicSessionId = 'compact-dynamic-height-session' as SessionId;
    const VIEWPORT_HEIGHT = 400;
    const BASE_ROW_HEIGHT = 120;
    const FOOTER_HEIGHT = 40;
    const SUBAGENT_HEIGHT = 64;
    const px = (value: string | undefined) => parseFloat(value ?? '0') || 0;

    let attachedViewport: HTMLElement | null = null;
    const heightForRow = (rowEl: HTMLElement): number => {
      const header = rowEl.querySelector<HTMLElement>('[data-compact-work-header]');
      if (header) {
        const secondary = header.querySelector<HTMLElement>('[data-compact-secondary-line]');
        if (!secondary) return 36;
        // Model realistic wrapped height proportional to line breaks and text length.
        const lines = secondary.textContent
          ? secondary.textContent
              .split('\n')
              .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / 45)), 0)
          : 0;
        return 36 + lines * 18;
      }
      if (rowEl.querySelector('[data-subagent-task-id]')) return SUBAGENT_HEIGHT;
      if (rowEl.dataset.conversationRowKey?.endsWith(':footer')) return FOOTER_HEIGHT;
      return BASE_ROW_HEIGHT;
    };

    const harness = createFrameHarness({
      viewportHeight: () => VIEWPORT_HEIGHT,
      scrollHeightOf: (viewport) => {
        const rowsContainer = viewport.firstElementChild as HTMLElement | null;
        const spacer = rowsContainer?.nextElementSibling as HTMLElement | null;
        return (
          px(rowsContainer?.style.height) +
          px(rowsContainer?.style.marginTop) +
          px(spacer?.style.height)
        );
      },
      sizeOf: (element) => {
        const el = element as HTMLElement;
        if (el.hasAttribute('data-message-selection-scroll')) return VIEWPORT_HEIGHT;
        if (el.hasAttribute('data-virtual-index')) return heightForRow(el);
        return undefined;
      },
      rectOf: (element, scrollTop) => {
        const el = element as HTMLElement;
        if (el.hasAttribute('data-message-selection-scroll')) {
          return { top: 0, height: VIEWPORT_HEIGHT };
        }
        if (
          el.parentElement?.hasAttribute('data-message-selection-scroll') &&
          !el.hasAttribute('data-conversation-reply-room')
        ) {
          return { top: px(el.style.marginTop) - scrollTop, height: px(el.style.height) };
        }
        if (el.hasAttribute('data-virtual-index')) {
          return {
            top: px(el.parentElement?.style.marginTop) + px(el.style.top) - scrollTop,
            height: heightForRow(el),
          };
        }
        return undefined;
      },
    });

    const settleFrames = async () => {
      const viewport = container.querySelector<HTMLElement>('[data-message-selection-scroll]');
      if (viewport && viewport !== attachedViewport) {
        attachedViewport = viewport;
        harness.attachViewport(viewport);
      }
      for (let i = 0; i < 30; i += 1) {
        let delivered = false;
        await act(async () => {
          delivered = harness.frame();
          await Promise.resolve();
        });
        if (!delivered) return;
      }
      throw new Error('scroll frames did not settle');
    };

    try {
      const store = createStore();
      store.set(experimentalFeaturesEnabledAtom, true);
      store.set(streamingThoughtPreviewExperimentEnabledAtom, true);
      store.set(lowStimulusExperimentEnabledAtom, false);

      const priorTurns = Array.from({ length: 4 }, (_, index) => [
        {
          id: `prior-u-${index}`,
          role: 'user',
          timestamp: `2026-11-21T00:00:0${index}Z`,
          items: [{ type: 'text', text: `Earlier question ${index}` }],
        },
        {
          id: `prior-a-${index}`,
          role: 'assistant',
          timestamp: `2026-11-21T00:00:1${index}Z`,
          finished: true,
          endedAt: Date.parse(`2026-11-21T00:00:1${index}Z`) + 2_000,
          fileDiff: [],
          items: [{ type: 'text', text: `Earlier answer ${index}` }],
        },
      ]).flat();

      const liveTurnId = 'dynamic-live-turn';
      const buildHistory = (
        thoughtText: string,
        options: { finished?: boolean; finalText?: string } = {}
      ) => [
        ...priorTurns,
        {
          id: `user-${liveTurnId}`,
          role: 'user',
          timestamp: '2026-11-21T00:00:25Z',
          items: [{ type: 'text', text: 'Run checks and report progress.' }],
        },
        {
          id: liveTurnId,
          role: 'assistant',
          timestamp: '2026-11-21T00:00:26Z',
          fileDiff: [],
          finished: options.finished ?? false,
          ...(options.finished ? { endedAt: Date.parse('2026-11-21T00:00:30Z') } : {}),
          items: [
            {
              type: 'subagent_task',
              taskId: 'bg-worker-1',
              status: 'in_progress',
              taskType: 'subagent',
              subagentType: 'Explore',
              description: 'Verify virtual row offsets',
              isBackgrounded: true,
            },
            { type: 'thought', text: thoughtText },
            ...(options.finalText ? [{ type: 'text', text: options.finalText }] : []),
          ],
        },
      ];

      let currentHistory = buildHistory("I'm thinking through how to approach this.");
      let notify: () => void = () => {};
      const view = createConversationViewFromHistory({
        sessionId: dynamicSessionId,
        getHistory: () => currentHistory as never,
        subscribe: (listener) => {
          notify = listener;
          return () => {};
        },
      });
      let lastAtBottom = true;

      const renderCurrent = async (nextHistory: unknown[]) => {
        currentHistory = nextHistory as typeof currentHistory;
        await act(async () => notify());
        const { items } = buildChatStreamItems(view, dynamicSessionId);
        await act(async () => {
          root.render(
            createElement(
              Provider,
              { store },
              createElement(SessionChatStreamView, {
                items,
                sessionId: dynamicSessionId,
                conversationView: view,
                renderMessageRow: () => null,
                lastAssistantMessageId: liveTurnId,
                agentActivityLabel: 'Working',
                agentActivityTone: 'primary',
                agentActivityShimmer: true,
                onAtBottomChange: (atBottom) => {
                  lastAtBottom = atBottom;
                },
              })
            )
          );
        });
        await settleFrames();
      };

      const assertNoOverlapAndSticky = () => {
        const headerRow = container
          .querySelector('[data-compact-work-header]')
          ?.closest<HTMLElement>('[data-virtual-index]');
        const subagentRow = container
          .querySelector('[data-subagent-task-id="bg-worker-1"]')
          ?.closest<HTMLElement>('[data-virtual-index]');
        expect(headerRow).not.toBeNull();
        expect(subagentRow).not.toBeNull();

        const headerTop = px(headerRow!.style.top);
        const headerHeight = heightForRow(headerRow!);
        const subagentTop = px(subagentRow!.style.top);
        expect(subagentTop).toBeGreaterThanOrEqual(headerTop + headerHeight);

        const viewport = container.querySelector<HTMLElement>('[data-message-selection-scroll]')!;
        const maxTop = Math.max(0, viewport.scrollHeight - VIEWPORT_HEIGHT);
        expect(lastAtBottom).toBe(true);
        expect(Math.abs(harness.scrollTop - maxTop)).toBeLessThanOrEqual(1);
        return { headerHeight, subagentTop };
      };

      // Phase 1: 0-line placeholder only (height 36px).
      await renderCurrent(currentHistory);
      const phase1 = assertNoOverlapAndSticky();
      expect(phase1.headerHeight).toBe(36);

      // Phase 2: 1-line thought appears immediately (height 54px).
      await renderCurrent(buildHistory('Checking row offsets in view.tsx.'));
      const phase2 = assertNoOverlapAndSticky();
      expect(phase2.headerHeight).toBe(54);
      expect(phase2.subagentTop).toBe(
        phase1.subagentTop + (phase2.headerHeight - phase1.headerHeight)
      );

      // Phase 3: Multi-line long thought arrives within throttle window, then commits asynchronously on timer!
      const longMultiLine = [
        'Line 1 inspecting EngineConversationScroller and ResizeObserver callbacks in detail.',
        'Line 2 verifying that ScrollController.onRowsResized updates geometry offsets synchronously.',
        'Line 3 checking that subagent_tasks and footer rows never overlap a tall Row 2 thought.',
        'Line 4 confirming follow mode stays sticky when height grows from throttled setTimeout.',
      ].join('\n');
      await renderCurrent(buildHistory(longMultiLine));
      // Still holding phase 2 inside 1500ms hold window.
      expect(container.querySelector('[data-compact-secondary-line]')?.textContent).toBe(
        'Checking row offsets in view.tsx.'
      );
      // Advance timer to trigger async throttled state update inside CompactWorkHeaderRow alone!
      await act(async () => vi.advanceTimersByTime(1_600));
      await settleFrames();
      const phase3 = assertNoOverlapAndSticky();
      expect(phase3.headerHeight).toBeGreaterThan(150);
      expect(phase3.subagentTop).toBe(
        phase2.subagentTop + (phase3.headerHeight - phase2.headerHeight)
      );

      // Phase 4: Shrinking from long multi-line paragraph back to a short 1-line paragraph.
      await act(async () => vi.advanceTimersByTime(1_600));
      await renderCurrent(buildHistory('Short follow-up check.'));
      const phase4 = assertNoOverlapAndSticky();
      expect(phase4.headerHeight).toBe(54);
      expect(phase4.subagentTop).toBe(
        phase3.subagentTop + (phase4.headerHeight - phase3.headerHeight)
      );

      // Phase 5: Turn finishes -> Row 2 disappears (36px), final prose row mounts, still sticky at bottom.
      await renderCurrent(
        buildHistory('Short follow-up check.', {
          finished: true,
          finalText: 'All checks verified.',
        })
      );
      const headerAfterFinish = container
        .querySelector('[data-compact-work-header="finished"]')
        ?.closest<HTMLElement>('[data-virtual-index]');
      expect(headerAfterFinish).not.toBeNull();
      expect(heightForRow(headerAfterFinish!)).toBe(36);
      expect(lastAtBottom).toBe(true);
      const viewport = container.querySelector<HTMLElement>('[data-message-selection-scroll]')!;
      expect(
        Math.abs(harness.scrollTop - Math.max(0, viewport.scrollHeight - VIEWPORT_HEIGHT))
      ).toBeLessThanOrEqual(1);
    } finally {
      harness.restore();
    }
  });

  it('renders the native background task status row with only authoritative aggregate waiting/wakeup signals', async () => {
    const finishedWithBgTool = buildTurnHistory(
      [
        {
          type: 'tool_call',
          toolCallId: 'bg-1',
          kind: 'execute',
          title: 'Run gh run watch 20481937412 --exit-status',
          status: 'in_progress',
          backgroundTaskId: 'bg-gh-run-20481937412',
        },
        { type: 'text', text: 'Summary delivered.' },
      ],
      {
        finished: true,
        endedAt: Date.parse('2026-11-21T00:00:30Z'),
      }
    );

    // Even with streamingThoughtPreview disabled, the native background status row renders.
    const { rerenderHistory } = await renderStream(finishedWithBgTool, {
      thoughtPreview: false,
      agentActivityLabel: 'Thinking',
      backgroundTaskStatus: { mode: 'waiting', taskCount: 1 },
    });

    // Replaces the orphan "Thinking" row without claiming a historical command is the live task.
    expect(container.querySelector('[data-agent-activity-row]')).toBeNull();
    const bgRow = container.querySelector<HTMLElement>(
      '[data-background-task-status-row="waiting"]'
    );
    expect(bgRow).not.toBeNull();
    expect(bgRow!.textContent).toBe('1 background task running');
    expect(bgRow!.textContent).not.toContain('gh run watch');
    expect(bgRow!.querySelector('[data-background-task-toggle]')).toBeNull();
    expect(bgRow!.querySelector('[data-background-task-detail]')).toBeNull();
    expect(bgRow!.querySelector('[data-background-task-static]')).not.toBeNull();

    // Wakeup pulse shows "Handling background task" with shimmer, while preserving
    // upstream finished footer actions when Option C (thoughtPreview) is disabled.
    await rerenderHistory(finishedWithBgTool, { mode: 'wakeup', taskCount: 1 });
    const wakeupRow = container.querySelector<HTMLElement>(
      '[data-background-task-status-row="wakeup"]'
    );
    expect(wakeupRow?.textContent).toBe('Handling background task');
    expect(wakeupRow?.querySelector('.agent-shimmer')).not.toBeNull();
    expect(container.querySelector('[aria-label="Copy response"]')).not.toBeNull();

    // Without count: renders generic "Background task running".
    await rerenderHistory(
      buildTurnHistory([{ type: 'text', text: 'Done.' }], {
        finished: true,
        endedAt: Date.parse('2026-11-21T00:00:30Z'),
      }),
      { mode: 'waiting' }
    );
    expect(container.querySelector('[data-background-task-toggle]')).toBeNull();
    expect(container.querySelector('[data-background-task-static]')?.textContent).toBe(
      'Background task running'
    );
  });

  it('renders the sidebar background breathing ring via SessionRowStatusIndicator and freezes it in low-stimulus mode', async () => {
    const store = createStore();
    store.set(experimentalFeaturesEnabledAtom, false);
    store.set(lowStimulusExperimentEnabledAtom, false);

    await act(async () => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(SessionRowStatusIndicator, {
            isWorking: true,
            isBackgroundWorking: true,
          })
        )
      );
    });
    const bgMark = container.querySelector('[data-session-background-indicator]');
    expect(bgMark?.getAttribute('data-session-background-indicator')).toBe('');
    expect(container.querySelector('[data-session-working-indicator]')).toBeNull();

    // Low-stimulus freezes the background ring.
    await act(async () => {
      store.set(experimentalFeaturesEnabledAtom, true);
      store.set(lowStimulusExperimentEnabledAtom, true);
    });
    expect(
      container
        .querySelector('[data-session-background-indicator]')
        ?.getAttribute('data-session-background-indicator')
    ).toBe('still');

    // Wakeup (isBackgroundWorking: false, isWorking: true) switches back to WorkingGrid.
    await act(async () => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(SessionRowStatusIndicator, {
            isWorking: true,
            isBackgroundWorking: false,
          })
        )
      );
    });
    expect(container.querySelector('[data-session-background-indicator]')).toBeNull();
    expect(container.querySelector('[data-session-working-indicator]')).not.toBeNull();
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

  it('segments mid-turn progress prose above a live trailing Option C panel in a foreground turn and merges cleanly on finish', async () => {
    const turnId = nextAssistantId();
    const midTurnItems = [
      { type: 'thought', text: 'Inspecting notarization history and build scripts.' },
      makeToolCall('package_macos.sh'),
      {
        type: 'text',
        text: 'Found the signing secrets; checking SDK compatibility before writing Dockerfile.',
      },
      {
        type: 'thought',
        text: 'Creating the local CI script and preparing remote execution on mini.',
      },
      {
        type: 'tool_call',
        toolCallId: 'edit-script',
        kind: 'edit',
        title: 'Edit write_ci_docker.sh',
        locations: [{ path: 'write_ci_docker.sh' }],
        status: 'completed',
      },
      {
        type: 'tool_call',
        toolCallId: 'run-script',
        kind: 'execute',
        title: "Run lody-lan lan shell mini 'bash -s' < write_ci_docker.sh",
        status: 'in_progress',
      },
    ];

    const { rerenderHistory } = await renderStream(buildTurnHistory(midTurnItems, { id: turnId }), {
      agentActivityLabel: 'Working',
      agentActivityShimmer: true,
    });

    // Two headers in chronological order: preceding work A ("Finished working") -> visible mid-turn prose -> live panel B.
    const headers = [...container.querySelectorAll<HTMLButtonElement>('[data-compact-work-header]')];
    expect(headers).toHaveLength(2);
    expect(headers[0]?.getAttribute('data-compact-work-header')).toBe('finished');
    expect(headers[0]?.textContent).toContain('Finished working');
    expect(headers[1]?.getAttribute('data-compact-work-header')).toBe('live');
    expect(headers[1]?.querySelector('[data-compact-status-verb]')?.textContent).toBe('Running');
    expect(headers[1]?.querySelector('[data-compact-active-target]')?.textContent).toContain(
      'lody-lan lan shell mini'
    );
    // Live panel B counts ONLY B's completed tools (1 edit), not A's earlier read.
    expect(headers[1]?.querySelector('[data-compact-tool-counts]')?.textContent).toBe(
      'Edited 1 file'
    );
    expect(headers[1]?.querySelector('[data-compact-live-duration]')?.textContent).toBe('(30s)');
    expect(headers[1]?.querySelector('[data-compact-secondary-line]')?.textContent).toBe(
      'Creating the local CI script and preparing remote execution on mini.'
    );
    // Shimmer owns the bottom live panel; no duplicate AgentActivityRow below.
    expect(headers[1]?.querySelector('.agent-shimmer')).not.toBeNull();
    expect(container.querySelector('[data-agent-activity-row]')).toBeNull();

    // Mid-turn progress prose stays visible in place between header A and live header B.
    const fullText = container.textContent ?? '';
    const idxA = fullText.indexOf('Finished working');
    const idxProse = fullText.indexOf('Found the signing secrets');
    const idxB = fullText.indexOf('Creating the local CI script');
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxProse).toBeGreaterThan(idxA);
    expect(idxB).toBeGreaterThan(idxProse);

    // Expanding header A reveals ONLY A's entries while header B stays collapsed live.
    await act(async () => headers[0]!.click());
    expect(container.querySelectorAll('[data-compact-thought-row]')).toHaveLength(1);
    expect(container.querySelector('[data-compact-thought-row="0"]')).not.toBeNull();
    expect(container.querySelector('[data-compact-work-header="live"]')).not.toBeNull();
    expect(container.querySelector('[data-compact-secondary-line]')?.textContent).toBe(
      'Creating the local CI script and preparing remote execution on mini.'
    );

    // Collapse A back and finish the turn with final prose: merges into ONE "Worked for ..." header.
    await act(async () => headers[0]!.click());
    await rerenderHistory(
      buildTurnHistory(
        [
          ...midTurnItems.slice(0, -1),
          {
            type: 'tool_call',
            toolCallId: 'run-script',
            kind: 'execute',
            title: "Run lody-lan lan shell mini 'bash -s' < write_ci_docker.sh",
            status: 'completed',
          },
          { type: 'text', text: 'Docker and macOS DMG workflows are verified.' },
        ],
        {
          id: turnId,
          finished: true,
          endedAt: Date.parse('2026-11-21T00:02:58Z'),
        }
      )
    );
    const settledHeaders = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-compact-work-header]'),
    ];
    expect(settledHeaders).toHaveLength(1);
    expect(settledHeaders[0]?.getAttribute('data-compact-work-header')).toBe('finished');
    expect(container.textContent).toContain('Docker and macOS DMG workflows are verified.');
    expect(container.textContent).not.toContain('Found the signing secrets');
  });

  it('keeps post-end_turn background wakeup late streams folded into a live trailing Option C panel instead of exploding flat', async () => {
    const turnId = nextAssistantId();
    const initialEndedAt = Date.parse('2026-11-21T00:02:58Z');
    const preEndTurnItems = [
      { type: 'thought', text: 'Preparing release merge and checking disk space.' },
      {
        type: 'tool_call',
        toolCallId: 'bg-release',
        kind: 'execute',
        title: 'Run lody-lan lan shell mini release-build',
        status: 'completed',
      },
      {
        type: 'text',
        text: 'master merged and v0.2.0 tagged; finishing Release App build in background.',
      },
    ];
    const wakeupLateItems = [
      ...preEndTurnItems,
      { type: 'thought', text: 'BUILD succeeded; verifying bundle layout and health endpoint.' },
      {
        type: 'tool_call',
        toolCallId: 'late-zip',
        kind: 'execute',
        title: 'Run lody-lan lan cp mini:/tmp/TTSStudio-0.2.0.zip /tmp/',
        status: 'completed',
      },
      {
        type: 'tool_call',
        toolCallId: 'late-health',
        kind: 'execute',
        title: 'Run curl -s http://127.0.0.1:9880/health',
        status: 'in_progress',
      },
    ];

    // Stage 1: end_turn with background waiting — single Worked-for header + progress prose + waiting row.
    const { rerenderHistory } = await renderStream(
      buildTurnHistory(preEndTurnItems, { id: turnId, finished: true, endedAt: initialEndedAt }),
      {
        agentActivityLabel: null,
        backgroundTaskStatus: { mode: 'waiting', taskCount: 1 },
        onFork: () => {},
      }
    );
    expect(container.querySelectorAll('[data-compact-work-header="finished"]')).toHaveLength(1);
    expect(container.querySelector('[data-compact-work-header="finished"]')?.textContent).toContain(
      'Worked for'
    );
    expect(container.querySelector('[aria-label="Copy response"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Fork session"]')).not.toBeNull();
    expect(container.querySelectorAll('span.tabular-nums').length).toBeGreaterThan(0);
    expect(container.querySelector('[data-background-task-status-row="waiting"]')).not.toBeNull();

    // Stage 1.5: presence flips to wakeup BEFORE late thoughts/tools land in history —
    // must immediately suppress finished metadata (timestamp, Copy, Fork) and drop stale Worked-for duration.
    await rerenderHistory(
      buildTurnHistory(preEndTurnItems, { id: turnId, finished: true, endedAt: initialEndedAt }),
      { mode: 'wakeup', taskCount: 1 }
    );
    expect(container.querySelectorAll('[data-compact-work-header="finished"]')).toHaveLength(1);
    expect(container.querySelector('[data-compact-work-header="finished"]')?.textContent).toContain(
      'Finished working'
    );
    expect(container.querySelector('[aria-label="Copy response"]')).toBeNull();
    expect(container.querySelector('[aria-label="Fork session"]')).toBeNull();
    expect(container.querySelectorAll('span.tabular-nums')).toHaveLength(0);
    expect(container.querySelector('[data-background-task-status-row="wakeup"]')).not.toBeNull();

    // Stage 2: background wakeup appends late thought/tools into the ALREADY finished turn.
    await rerenderHistory(
      buildTurnHistory(wakeupLateItems, { id: turnId, finished: true, endedAt: initialEndedAt }),
      { mode: 'wakeup', taskCount: 1 }
    );

    // Must NOT explode flat (no uncollapsed directory rows or top-right toolbar).
    expect(container.querySelector('[data-compact-dir-toolbar]')).toBeNull();
    expect(container.querySelector('[data-compact-thought-row]')).toBeNull();
    expect(container.querySelector('[data-compact-tool-row]')).toBeNull();

    // Header A collapsed above progress prose; trailing wakeup work B is a live 2-tier Option C panel.
    const headers = [...container.querySelectorAll<HTMLButtonElement>('[data-compact-work-header]')];
    expect(headers).toHaveLength(2);
    expect(headers[0]?.getAttribute('data-compact-work-header')).toBe('finished');
    expect(headers[0]?.textContent).toContain('Finished working');
    expect(headers[1]?.getAttribute('data-compact-work-header')).toBe('live');
    expect(headers[1]?.querySelector('[data-compact-status-verb]')?.textContent).toBe('Running');
    expect(headers[1]?.querySelector('[data-compact-tool-counts]')?.textContent).toBe(
      'Ran 1 command'
    );
    // Wakeup live panel omits misleading wall-clock duration across idle wait time, keeps shimmer.
    expect(headers[1]?.querySelector('[data-compact-live-duration]')).toBeNull();
    expect(headers[1]?.querySelector('.agent-shimmer')).not.toBeNull();
    expect(headers[1]?.querySelector('[data-compact-secondary-line]')?.textContent).toBe(
      'BUILD succeeded; verifying bundle layout and health endpoint.'
    );
    // Progress prose stays visible in place and bottom wakeup row remains visible.
    expect(container.textContent).toContain('master merged and v0.2.0 tagged');
    expect(container.querySelector('[data-background-task-status-row="wakeup"]')).not.toBeNull();
    // Premature finished metadata (Copy response / Fork / endedAt) is suppressed during active wakeup work.
    expect(container.querySelector('[aria-label="Copy response"]')).toBeNull();
    expect(container.querySelector('[aria-label="Fork session"]')).toBeNull();
    expect(container.querySelectorAll('span.tabular-nums')).toHaveLength(0);

    // Stage 2b: wakeup launches another background command and returns to silent waiting — still folded!
    await rerenderHistory(
      buildTurnHistory(wakeupLateItems, { id: turnId, finished: true, endedAt: initialEndedAt }),
      { mode: 'waiting', taskCount: 2 }
    );
    expect(container.querySelector('[data-compact-dir-toolbar]')).toBeNull();
    expect(container.querySelector('[data-compact-tool-row]')).toBeNull();
    const waitingHeaders = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-compact-work-header]'),
    ];
    expect(waitingHeaders).toHaveLength(2);
    expect(waitingHeaders[1]?.getAttribute('data-compact-work-header')).toBe('finished');
    expect(waitingHeaders[1]?.textContent).toContain('Working');
    expect(container.querySelector('[data-background-task-status-row="waiting"]')?.textContent).toBe(
      '2 background tasks running'
    );

    // Stage 4: final answer arrives and background settles -> collapses cleanly into ONE Worked-for header.
    await rerenderHistory(
      buildTurnHistory(
        [
          ...wakeupLateItems.slice(0, -1),
          {
            type: 'tool_call',
            toolCallId: 'late-health',
            kind: 'execute',
            title: 'Run curl -s http://127.0.0.1:9880/health',
            status: 'completed',
          },
          { type: 'text', text: 'v0.2.0 release and cleanup are fully complete.' },
        ],
        { id: turnId, finished: true, endedAt: initialEndedAt }
      ),
      null
    );
    expect(container.querySelectorAll('[data-compact-work-header]')).toHaveLength(1);
    expect(container.querySelector('[data-compact-work-header="finished"]')?.textContent).toContain(
      'Worked for'
    );
    expect(container.textContent).toContain('v0.2.0 release and cleanup are fully complete.');
    expect(container.querySelector('[aria-label="Copy response"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Fork session"]')).not.toBeNull();
    expect(container.querySelectorAll('span.tabular-nums').length).toBeGreaterThan(0);
  });

  it('suppresses finished footer on prose-only turns during background wakeup', async () => {
    const turnId = nextAssistantId();
    const { rerenderHistory } = await renderStream(
      buildTurnHistory([{ type: 'text', text: 'Started watching build.' }], {
        id: turnId,
        finished: true,
        endedAt: Date.parse('2026-11-21T00:01:00Z'),
      }),
      {
        agentActivityLabel: null,
        backgroundTaskStatus: { mode: 'wakeup', taskCount: 1 },
        onFork: () => {},
      }
    );

    expect(container.querySelector('[aria-label="Copy response"]')).toBeNull();
    expect(container.querySelector('[aria-label="Fork session"]')).toBeNull();
    expect(container.querySelectorAll('span.tabular-nums')).toHaveLength(0);
    expect(container.querySelector('[data-background-task-status-row="wakeup"]')).not.toBeNull();

    await rerenderHistory(
      buildTurnHistory([{ type: 'text', text: 'Build finished cleanly.' }], {
        id: turnId,
        finished: true,
        endedAt: Date.parse('2026-11-21T00:01:00Z'),
      }),
      null
    );
    expect(container.querySelector('[aria-label="Copy response"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Fork session"]')).not.toBeNull();
    expect(container.querySelectorAll('span.tabular-nums').length).toBeGreaterThan(0);

    // [prose, lateWork] (single work run after prose, no backgroundTaskId yet) stays folded
    // when transitioning from wakeup to waiting rather than exploding flat.
    const proseThenLateWork: MessageContent[] = [
      { type: 'text', text: 'Started monitoring remote job.' },
      { type: 'thought', text: 'Checking remote build logs.' },
      {
        type: 'tool_call',
        toolCallId: 'prose-late-cmd',
        kind: 'execute',
        title: 'Run ./scripts/check-status.sh',
        status: 'in_progress',
      },
    ];
    await rerenderHistory(
      buildTurnHistory(proseThenLateWork, {
        id: turnId,
        finished: true,
        endedAt: Date.parse('2026-11-21T00:01:00Z'),
      }),
      { mode: 'waiting', taskCount: 1 }
    );
    expect(container.querySelectorAll('[data-compact-work-header]')).toHaveLength(1);
    expect(container.querySelector('[data-compact-work-header]')?.textContent).toContain('Working');
    expect(container.querySelector('[data-compact-tool-row]')).toBeNull();
    expect(container.querySelector('[aria-label="Copy response"]')).toBeNull();
  });

  it('keeps a cancelled follow-up turn expanded even while an earlier turn holds session-level waiting status', async () => {
    const turnId = nextAssistantId();
    // Silent cancellation (no chat_failed notice, no final text, no own backgroundTaskId):
    const { rerenderHistory } = await renderStream(
      buildTurnHistory(
        [
          { type: 'thought', text: 'Inspecting files before user pressed Stop.' },
          {
            type: 'tool_call',
            toolCallId: 'cancelled-read',
            kind: 'read',
            title: 'Read README.md',
            status: 'completed',
          },
        ],
        {
          id: turnId,
          finished: true,
          endedAt: Date.parse('2026-11-21T00:01:00Z'),
        }
      ),
      {
        agentActivityLabel: null,
        backgroundTaskStatus: { mode: 'waiting', taskCount: 1 },
      }
    );

    expect(container.querySelector('[data-compact-work-header]')).toBeNull();
    expect(container.querySelector('[data-compact-thought-row="0"]')).not.toBeNull();
    expect(container.querySelector('[data-compact-tool-row="cancelled-read"]')).not.toBeNull();
    expect(container.querySelector('[data-background-task-status-row="waiting"]')).not.toBeNull();

    // Explicit chat_failed(acp_request_cancelled) after mid-turn prose must also stay expanded.
    await rerenderHistory(
      buildTurnHistory(
        [
          { type: 'thought', text: 'First pass.' },
          { type: 'text', text: 'Interim note.' },
          { type: 'thought', text: 'Second pass cut off.' },
          {
            type: 'system_notice',
            name: 'chat_failed',
            meta: { reason: 'acp_request_cancelled' },
          },
        ],
        {
          id: turnId,
          finished: true,
          endedAt: Date.parse('2026-11-21T00:01:05Z'),
        }
      ),
      { mode: 'waiting', taskCount: 1 }
    );
    expect(container.querySelector('[data-compact-work-header]')).toBeNull();
    expect(container.querySelector('[data-compact-thought-row="0"]')).not.toBeNull();
    expect(container.querySelector('[data-compact-thought-row="2"]')).not.toBeNull();

    // Disconnected turn ending with Codex commentary + chat_failed must stay expanded
    // instead of treating commentary as a final answer under Worked-for folding.
    await rerenderHistory(
      buildTurnHistory(
        [
          { type: 'thought', text: 'Checking config before disconnect.' },
          {
            type: 'tool_call',
            toolCallId: 'before-disconnect-read',
            kind: 'read',
            title: 'Read config.json',
            status: 'completed',
          },
          {
            type: 'text',
            messagePhase: 'commentary',
            text: 'Config looks fine; applying update now.',
          },
          {
            type: 'system_notice',
            name: 'chat_failed',
            meta: { reason: 'agent_disconnected' },
          },
        ],
        {
          id: turnId,
          finished: true,
          endedAt: Date.parse('2026-11-21T00:01:10Z'),
        }
      ),
      { mode: 'waiting', taskCount: 1 }
    );
    expect(container.querySelector('[data-compact-work-header]')).toBeNull();
    expect(container.querySelector('[data-compact-thought-row="0"]')).not.toBeNull();
    expect(container.querySelector('[data-compact-tool-row="before-disconnect-read"]')).not.toBeNull();
  });

  it('spans system notices without splitting live compact work runs, stripping shimmer, or reordering expanded rows', async () => {
    const turnId = nextAssistantId();
    const { rerenderHistory } = await renderStream(
      buildTurnHistory(
        [
          { type: 'thought', text: 'Checking build targets across platforms.' },
          {
            type: 'system_notice',
            name: 'chat_failed',
            meta: { reason: 'rate_limit_retry', message: 'Rate limited, retrying' },
          },
          {
            type: 'tool_call',
            toolCallId: 'after-notice-run',
            kind: 'execute',
            title: 'Run pnpm test',
            status: 'in_progress',
          },
        ],
        { id: turnId }
      ),
      { agentActivityLabel: 'Running', agentActivityShimmer: true }
    );

    // Must remain a SINGLE live panel (no bogus Finished working) with the earlier thought retained.
    const headers = [...container.querySelectorAll<HTMLButtonElement>('[data-compact-work-header]')];
    expect(headers).toHaveLength(1);
    expect(headers[0]?.getAttribute('data-compact-work-header')).toBe('live');
    expect(headers[0]?.querySelector('[data-compact-secondary-line]')?.textContent).toBe(
      'Checking build targets across platforms.'
    );
    expect(headers[0]?.querySelector('.agent-shimmer')).not.toBeNull();

    // Expanding the spanned run preserves chronological order: [thought, notice, tool], not [thought, tool, notice].
    await act(async () => {
      headers[0]!.click();
    });
    const thoughtRow = container.querySelector<HTMLElement>('[data-compact-thought-row="0"]');
    const toolRow = container.querySelector<HTMLElement>(
      '[data-compact-tool-row="after-notice-run"]'
    );
    const noticeNode = [...container.querySelectorAll<HTMLElement>('*')].find(
      (el) => el.childElementCount === 0 && el.textContent?.includes('Rate limited, retrying')
    );
    expect(thoughtRow).not.toBeNull();
    expect(noticeNode).toBeInstanceOf(HTMLElement);
    expect(toolRow).not.toBeNull();
    expect(
      thoughtRow!.compareDocumentPosition(noticeNode!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      noticeNode!.compareDocumentPosition(toolRow!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      container.querySelector('[data-compact-work-header="live"] .agent-shimmer')
    ).not.toBeNull();

    // Trailing system notice at end of live turn must also keep shimmer on the live header.
    await rerenderHistory(
      buildTurnHistory(
        [
          { type: 'thought', text: 'Running final verification step.' },
          {
            type: 'tool_call',
            toolCallId: 'before-trailing-notice',
            kind: 'execute',
            title: 'Run pnpm typecheck',
            status: 'in_progress',
          },
          {
            type: 'system_notice',
            name: 'chat_failed',
            meta: { reason: 'rate_limit_retry', message: 'Rate limited, retrying' },
          },
        ],
        { id: turnId }
      ),
      null
    );
    const trailingHeaders = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-compact-work-header]'),
    ];
    expect(trailingHeaders).toHaveLength(1);
    expect(trailingHeaders[0]?.getAttribute('data-compact-work-header')).toBe('live');
    expect(trailingHeaders[0]?.querySelector('.agent-shimmer')).not.toBeNull();
  });

  it('keeps Codex commentary visible to segment live runs and folds it on final_answer completion', async () => {
    const turnId = nextAssistantId();
    const liveItems: MessageContent[] = [
      { type: 'thought', text: 'Reading search index files.' },
      {
        type: 'tool_call',
        toolCallId: 'codex-read',
        kind: 'read',
        title: 'Read search-index.ts',
        status: 'completed',
      },
      {
        type: 'text',
        messagePhase: 'commentary',
        text: 'I inspected the search index and am checking the tests next.',
      },
      { type: 'thought', text: 'Running targeted test file now.' },
      {
        type: 'tool_call',
        toolCallId: 'codex-test',
        kind: 'execute',
        title: 'Run vitest search-index.test.ts',
        status: 'in_progress',
      },
    ];

    const { rerenderHistory } = await renderStream(buildTurnHistory(liveItems, { id: turnId }), {
      agentActivityLabel: 'Running',
      agentActivityShimmer: true,
    });

    const headers = [...container.querySelectorAll<HTMLButtonElement>('[data-compact-work-header]')];
    expect(headers).toHaveLength(2);
    expect(headers[0]?.getAttribute('data-compact-work-header')).toBe('finished');
    expect(headers[0]?.textContent).toContain('Finished working');
    expect(headers[1]?.getAttribute('data-compact-work-header')).toBe('live');
    expect(container.textContent).toContain(
      'I inspected the search index and am checking the tests next.'
    );

    // Once final_answer settles, #2353 folds commentary + both work runs into a single Worked-for header.
    await rerenderHistory(
      buildTurnHistory(
        [
          ...liveItems.slice(0, -1),
          {
            type: 'tool_call',
            toolCallId: 'codex-test',
            kind: 'execute',
            title: 'Run vitest search-index.test.ts',
            status: 'completed',
          },
          {
            type: 'text',
            messagePhase: 'final_answer',
            text: 'All search index tests pass.',
          },
        ],
        {
          id: turnId,
          finished: true,
          endedAt: Date.parse('2026-11-21T00:02:00Z'),
        }
      ),
      null
    );
    expect(container.querySelectorAll('[data-compact-work-header]')).toHaveLength(1);
    expect(container.querySelector('[data-compact-work-header="finished"]')?.textContent).toContain(
      'Worked for'
    );
    expect(container.textContent).toContain('All search index tests pass.');
    expect(container.textContent).not.toContain(
      'I inspected the search index and am checking the tests next.'
    );
  });

  it('keeps a genuinely interrupted finished turn with no background task expanded', async () => {
    const turnId = nextAssistantId();
    await renderStream(
      buildTurnHistory(
        [
          { type: 'thought', text: 'Running command before disconnect.' },
          {
            type: 'tool_call',
            toolCallId: 'interrupted-cmd',
            kind: 'execute',
            title: 'Run pnpm build',
            status: 'completed',
          },
          { type: 'text', text: 'Progress before disconnect.' },
          { type: 'thought', text: 'Checking output before crash.' },
        ],
        {
          id: turnId,
          finished: true,
          endedAt: Date.parse('2026-11-21T00:01:00Z'),
        }
      ),
      {
        agentActivityLabel: null,
        backgroundTaskStatus: null,
      }
    );

    // No background task + finished without final text => stays expanded per AGENTS.md invariant.
    expect(container.querySelector('[data-compact-work-header]')).toBeNull();
    expect(container.querySelector('[data-compact-thought-row="0"]')).not.toBeNull();
    expect(container.querySelector('[data-compact-thought-row="3"]')).not.toBeNull();
    expect(container.textContent).toContain('Progress before disconnect.');
  });

  it('auto-expands only the matching work run for search hits in segmented live mode', async () => {
    const turnId = nextAssistantId();
    await renderStream(
      buildTurnHistory(
        [
          { type: 'thought', text: 'Needle inside first work phase.' },
          { type: 'text', text: 'Progress update between phases.' },
          { type: 'thought', text: 'Working on second phase without match.' },
        ],
        { id: turnId }
      ),
      { activeSearchBlockId: getThoughtSearchBlockId(turnId, 0) }
    );

    const headers = [...container.querySelectorAll<HTMLButtonElement>('[data-compact-work-header]')];
    expect(headers).toHaveLength(2);
    expect(headers[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(headers[1]?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-compact-thought-body]')?.textContent).toContain(
      'Needle inside first work phase.'
    );
  });

  it('handles post-turn late streams cleanly without backgroundTaskStatus and re-folds once final text arrives', async () => {
    const turnId = nextAssistantId();
    const endedAt = Date.parse('2026-11-21T00:02:00Z');
    const initialItems: MessageContent[] = [
      { type: 'thought', text: 'Starting long build command.' },
      {
        type: 'tool_call',
        toolCallId: 'agy-bg-cmd',
        kind: 'execute',
        title: 'Run pnpm build',
        status: 'in_progress',
      },
      { type: 'text', text: 'Started the build; waiting for completion.' },
    ];

    const { rerenderHistory } = await renderStream(
      buildTurnHistory(initialItems, { id: turnId, finished: true, endedAt }),
      {
        agentActivityLabel: null,
        backgroundTaskStatus: null,
        onFork: () => {},
      }
    );

    // Without authoritative backgroundTaskStatus (e.g. Antigravity ACP v1), finished turn folds normally with no background status row.
    expect(container.querySelectorAll('[data-compact-work-header="finished"]')).toHaveLength(1);
    expect(container.querySelector('[data-background-task-status-row]')).toBeNull();
    expect(container.querySelector('[aria-label="Copy response"]')).not.toBeNull();

    // Post-turn late tool completion + follow-up thought arrives without backgroundTaskStatus:
    // stays safely expanded (no crash, no fake background header/row).
    const lateWorkItems: MessageContent[] = [
      initialItems[0]!,
      {
        type: 'tool_call',
        toolCallId: 'agy-bg-cmd',
        kind: 'execute',
        title: 'Run pnpm build',
        status: 'completed',
      },
      initialItems[2]!,
      { type: 'thought', text: 'Build exited cleanly; summarizing artifacts.' },
      {
        type: 'tool_call',
        toolCallId: 'agy-verify',
        kind: 'execute',
        title: 'Run ls dist',
        status: 'completed',
      },
    ];
    await rerenderHistory(
      buildTurnHistory(lateWorkItems, { id: turnId, finished: true, endedAt }),
      null
    );
    expect(container.querySelector('[data-compact-work-header]')).toBeNull();
    expect(container.querySelector('[data-background-task-status-row]')).toBeNull();
    expect(container.querySelector('[data-compact-thought-row="3"]')).not.toBeNull();
    expect(container.textContent).toContain('Started the build; waiting for completion.');

    // Once the wakeup finishes with final prose, #2353 folds everything back under ONE Worked-for header.
    await rerenderHistory(
      buildTurnHistory(
        [...lateWorkItems, { type: 'text', text: 'Build succeeded and dist artifacts are ready.' }],
        { id: turnId, finished: true, endedAt }
      ),
      null
    );
    expect(container.querySelectorAll('[data-compact-work-header]')).toHaveLength(1);
    expect(container.querySelector('[data-compact-work-header="finished"]')?.textContent).toContain(
      'Worked for'
    );
    expect(container.textContent).toContain('Build succeeded and dist artifacts are ready.');
    expect(container.querySelector('[aria-label="Copy response"]')).not.toBeNull();
  });
});
