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
import { clearSavedScrollStates } from '../src/lib/conversation-scroll/saved-state';
import { createConversationViewFromHistory } from '../src/lib/conversation-view';
import { getThoughtSearchBlockId } from '../src/lib/session-chat-search';

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
        .find((entry): entry is { id: string; role: string } => {
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
        agentActivityLabel:
          options.agentActivityLabel === undefined ? 'Working' : options.agentActivityLabel,
        agentActivityTone: options.agentActivityTone ?? 'primary',
        agentActivityShimmer: options.agentActivityShimmer,
        backgroundTaskStatus: currentBgStatus,
        onFilePathClick: options.onFilePathClick,
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

  it('renders Option C Stage 1 placeholder-only as Thinking… (duration) with no second line and quiet expanded note', async () => {
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
    expect(primary?.textContent).toContain('Thinking…');
    expect(primary?.textContent).toContain('(30s)');
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

  it('renders Option C 2-line streaming division for thinking-only, running tool, and thinking after tools', async () => {
    const turnId = nextAssistantId();
    // Stage 2: valid thought without tools -> Line 1 only (Thinking · excerpt (30s)), no Line 2.
    const { rerenderHistory } = await renderStream(
      buildTurnHistory(
        [
          {
            type: 'thought',
            text: "I'm thinking through how to approach this.\n\n\nChecking view.tsx first. More details later.",
          },
        ],
        { id: turnId }
      )
    );
    expect(container.querySelector('[data-compact-primary-line]')?.textContent).toContain(
      'Checking view.tsx first.'
    );
    expect(container.querySelector('[data-compact-secondary-line]')).toBeNull();

    // Stage 3: active non-background tool -> Line 1 Running <target>, Line 2 retained thought excerpt (no prefix).
    await rerenderHistory(
      buildTurnHistory(
        [
          {
            type: 'thought',
            text: "I'm thinking through how to approach this.\n\n\nChecking view.tsx first. More details later.",
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
    const primaryTool = container.querySelector('[data-compact-primary-line]')?.textContent ?? '';
    const secondaryTool =
      container.querySelector('[data-compact-secondary-line]')?.textContent ?? '';
    expect(primaryTool).toContain('Running');
    expect(primaryTool).toContain('pnpm --filter @lody/components test');
    expect(secondaryTool).toBe('Checking view.tsx first.');

    // Stage 4: command completed + backgrounded tool + new thought -> backgrounded tool does NOT hijack Line 1.
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
            text: 'Summarizing findings while CI watches in background.',
          },
        ],
        { id: turnId }
      )
    );
    const primaryStage4 = container.querySelector('[data-compact-primary-line]')?.textContent ?? '';
    const secondaryStage4 =
      container.querySelector('[data-compact-secondary-line]')?.textContent ?? '';
    expect(primaryStage4).toContain('Thinking');
    expect(primaryStage4).toContain('Summarizing findings while CI watches in background.');
    expect(secondaryStage4).toContain('Read 2 files');
    expect(secondaryStage4).toContain('Ran 1 command');
    expect(secondaryStage4).toContain('1 in background');
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

  it('keeps the shimmer wrapper separate from the primary flex truncation container', async () => {
    const turnId = nextAssistantId();
    await renderStream(
      buildTurnHistory(
        [
          {
            type: 'tool_call',
            toolCallId: 'cmd-long',
            kind: 'execute',
            title:
              'Run pnpm --filter @lody/components test tests/streaming-thought-preview.test.ts',
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
    expect(primaryFlex!.textContent).toContain('Running');
    expect(primaryFlex!.textContent).toContain('(30s)');
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

    // Wakeup pulse shows "Handling background task" with shimmer.
    await rerenderHistory(finishedWithBgTool, { mode: 'wakeup', taskCount: 1 });
    const wakeupRow = container.querySelector<HTMLElement>(
      '[data-background-task-status-row="wakeup"]'
    );
    expect(wakeupRow?.textContent).toBe('Handling background task');
    expect(wakeupRow?.querySelector('.agent-shimmer')).not.toBeNull();

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
});
