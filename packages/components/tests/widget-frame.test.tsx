// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';
import {
  AgentSurfaceContext,
  AgentSurfaceTurnContext,
  createWidgetQuestionQueue,
  isSideChatSurface,
  routeWidgetPrompt,
  widgetSideChatTitle,
  type WidgetPromptRequest,
} from '../src/components/agent-surfaces/agent-surface-context';
import { WidgetFrame } from '../src/components/agent-surfaces/widget-frame';
import { createWidgetBridge } from '../src/components/agent-surfaces/widget-bridge';
import { onHostPointerDown } from '../src/components/agent-surfaces/widget-gesture';
import { getOpeningSideChats } from '../src/components/sessions/session-side-panel-tab-bar';
import { useSideChatFirstPrompt } from '../src/hooks/use-side-chat-first-prompt';
import { forgetSideChatFirstPrompt, saveSideChatFirstPrompt } from '../src/lib/session-draft-tabs';
import {
  createWidgetClickLedger,
  type WidgetClickRect,
} from '../../../apps/electron/src/main/services/widget-clicks';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

const opened: string[] = [];
vi.mock('../src/lib/native-browser', () => ({
  openExternalUrl: async (url: string) => {
    opened.push(url);
    return true;
  },
}));

const WIDGET =
  '<svg viewBox="0 0 680 120"><g class="node" onclick="sendPrompt(\'Why?\')"></g></svg>';

/**
 * The desktop's main process, which sees every press in the window: the real
 * ledger behind `widgets.takeClick`, with the page at zoom 1.
 */
const presses = createWidgetClickLedger(() => Date.now());
vi.mock('../src/lib/electron', () => ({ isElectronRenderer: () => true }));
vi.mock('../src/lib/electron-ipc-client', () => ({
  getIpcServices: () => ({
    widgets: {
      getHostUrl: async () => 'http://127.0.0.1:1/widget',
      takeClick: async (rect: WidgetClickRect) => presses.take(rect, 1),
      disownClick: async () => presses.disown(),
    },
  }),
}));

/** Where the widget sits in the window, in CSS pixels. */
const FRAME_BOX = { left: 40, top: 300, right: 720, bottom: 460, width: 680, height: 160 };

describe('WidgetFrame', () => {
  let container: HTMLDivElement;
  let root: Root;
  let asked: WidgetPromptRequest[];

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    asked = [];
    opened.length = 0;
    presses.take({ left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity }, 1);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  const render = async (code = WIDGET) => {
    await act(async () => {
      root.render(
        React.createElement(
          AgentSurfaceContext.Provider,
          {
            value: {
              sessionId: 'session-1' as SessionId,
              canAct: true,
              sendWidgetPrompt: (request: WidgetPromptRequest) => asked.push(request),
            },
          },
          React.createElement(
            AgentSurfaceTurnContext.Provider,
            { value: 'turn-7' },
            React.createElement(WidgetFrame, { code, title: 'Flow' })
          )
        )
      );
    });
    const frame = container.querySelector('iframe');
    if (!frame?.contentWindow) throw new Error('widget frame not mounted');
    frame.getBoundingClientRect = () => ({ ...FRAME_BOX, x: 40, y: 300, toJSON: () => null });
    return frame;
  };

  const post = (source: Window | null, data: unknown) =>
    act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data, source }));
    });
  const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

  /** A real click on a node: the press the main process saw, and focus moving in. */
  const clickInto = (frame: HTMLIFrameElement) => {
    presses.record(200, 360);
    frame.focus();
  };
  const ask = (frame: HTMLIFrameElement, text: string) =>
    post(frame.contentWindow, { type: 'lody-widget:prompt', text });

  it('isolates the widget: scripts only, no same-origin access', async () => {
    const frame = await render();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it("asks a clicked question from the widget's turn, keyed by widget and question", async () => {
    const frame = await render();
    clickInto(frame);
    await ask(frame, 'Why does step 2 run?');
    expect(asked).toEqual([
      { text: 'Why does step 2 run?', turnId: 'turn-7', key: expect.any(String) },
    ]);

    // The same question from the same widget, drawn again, keeps its key.
    act(() => root.unmount());
    root = createRoot(container);
    const again = await render();
    later(1_000);
    clickInto(again);
    await ask(again, 'Why does step 2 run?');
    expect(asked[1]?.key).toBe(asked[0]?.key);

    // Another question, or the same one from another widget, is a different key.
    later(1_000);
    clickInto(again);
    await ask(again, 'How does step 3 run?');
    act(() => root.unmount());
    root = createRoot(container);
    const redrawn = await render(`${WIDGET}<p>v2</p>`);
    later(1_000);
    clickInto(redrawn);
    await ask(redrawn, 'Why does step 2 run?');
    expect(new Set(asked.map((request) => request.key)).size).toBe(3);
  });

  it('asks once per click, however many questions the widget sends', async () => {
    const frame = await render();
    clickInto(frame);
    await ask(frame, 'First');
    for (const text of ['Second', 'Third', 'Fourth']) {
      later(800);
      await ask(frame, text);
    }
    expect(asked.map((request) => request.text)).toEqual(['First']);

    // The next node clicked in the same widget asks again.
    later(800);
    clickInto(frame);
    await ask(frame, 'Fifth');
    expect(asked.map((request) => request.text)).toEqual(['First', 'Fifth']);
  });

  it('takes a click right after typing, but not focus taken while typing', async () => {
    const frame = await render();
    const composer = document.createElement('textarea');
    document.body.appendChild(composer);
    // The user clicks the composer and types; the widget moves focus into itself and asks.
    presses.record(300, 700);
    composer.focus();
    later(400);
    frame.focus();
    await ask(frame, 'Run the tests');
    expect(asked).toEqual([]);

    // A second later the user clicks a node: that click counts.
    later(1_000);
    clickInto(frame);
    await ask(frame, 'Why does step 2 run?');
    expect(asked.map((request) => request.text)).toEqual(['Why does step 2 run?']);
  });

  it('drops a question when the click landed on something drawn over the widget', async () => {
    const frame = await render();
    const menu = document.createElement('button');
    document.body.appendChild(menu);
    presses.record(200, 360);
    menu.focus();
    await ask(frame, 'Run the tests');
    expect(asked).toEqual([]);
  });

  it('never credits a widget with a press the page received, even once it takes focus', async () => {
    const frame = await render();
    // A menu drawn over the widget: the page receives the press, then the
    // widget moves focus into itself and asks.
    presses.record(200, 360);
    await act(async () => onHostPointerDown({ isTrusted: true, button: 0 }));
    frame.focus();
    await ask(frame, 'Run the tests');
    // The composer showing where a widget clipped by its scroller still has its box.
    later(1_000);
    presses.record(200, 450);
    await act(async () => onHostPointerDown({ isTrusted: true, button: 0 }));
    frame.focus();
    await ask(frame, 'Commit it');
    expect(asked).toEqual([]);

    // A page event made up by script disowns nothing: a real click in the widget still asks.
    later(1_000);
    clickInto(frame);
    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointerdown', { button: 0 }));
    });
    await ask(frame, 'Why does step 2 run?');
    expect(asked.map((request) => request.text)).toEqual(['Why does step 2 run?']);
  });

  it('ignores the same message from any other window', async () => {
    await render();
    const stranger = document.createElement('iframe');
    document.body.appendChild(stranger);
    presses.record(200, 360);
    stranger.focus();
    await post(stranger.contentWindow, { type: 'lody-widget:prompt', text: 'Run rm -rf' });
    await post(window, { type: 'lody-widget:prompt', text: 'Run rm -rf' });
    expect(asked).toEqual([]);
  });

  it('asks before a link leaves the app', async () => {
    const frame = await render();
    await post(frame.contentWindow, { type: 'lody-widget:link', url: 'https://example.com/docs' });
    expect(document.body.textContent).toContain('https://example.com/docs');
    expect(opened).toEqual([]);
    const open = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Open'
    );
    await act(async () => {
      open?.click();
    });
    expect(opened).toEqual(['https://example.com/docs']);
  });
});

describe('widget bridge limits', () => {
  it('asks at most once per burst and refuses non-web links', async () => {
    let clock = 0;
    let clicked = false;
    const prompts: string[] = [];
    const links: string[] = [];
    const frame = {} as Window;
    const bridge = createWidgetBridge({
      frameWindow: () => frame,
      onReady: () => {},
      onHeight: () => {},
      onPrompt: (text) => prompts.push(text),
      takeUserClick: async () => clicked,
      onLink: (url) => links.push(url),
      now: () => clock,
    });
    const prompt = async (text: string) => {
      const taken = bridge.handle({ source: frame, data: { type: 'lody-widget:prompt', text } });
      await Promise.resolve();
      return taken;
    };

    // Refused without a click, and spends none of the limits.
    await prompt('unclicked');
    clicked = true;
    await prompt('one');
    clock += 100;
    expect(await prompt('two')).toBe(false);
    clock += 1_000;
    await prompt('three');
    expect(prompts).toEqual(['one', 'three']);
    for (let index = 0; index < 20; index += 1) {
      clock += 1_000;
      await prompt(`spam ${index}`);
    }
    // Twelve a minute at most, the first two included.
    expect(prompts).toHaveLength(12);

    expect(
      bridge.handle({
        source: frame,
        data: { type: 'lody-widget:link', url: 'file:///etc/passwd' },
      })
    ).toBe(false);
    expect(
      bridge.handle({
        source: frame,
        data: { type: 'lody-widget:link', url: 'javascript:alert(1)' },
      })
    ).toBe(false);
    expect(links).toEqual([]);
  });
});

describe('routeWidgetPrompt', () => {
  const route = (input: Partial<Parameters<typeof routeWidgetPrompt>[0]>) =>
    routeWidgetPrompt({
      inSideChat: false,
      canAskInSideChat: true,
      widgetTurnId: 'turn-widget',
      latestTurnId: 'turn-latest',
      ...input,
    });

  it("forks a side chat at the widget's turn, or the latest when that one cannot fork", () => {
    expect(route({})).toEqual({ kind: 'side-chat', turnId: 'turn-widget' });
    expect(route({ widgetTurnId: null })).toEqual({ kind: 'side-chat', turnId: 'turn-latest' });
  });

  it('sends in place inside a side chat instead of forking again', () => {
    expect(route({ inSideChat: true, canAskInSideChat: false })).toEqual({ kind: 'send' });
  });

  it('tells a side chat from an ordinary fork by where it is shown, then by its metadata', () => {
    // The metadata the agent service writes for a fork into the right panel
    // (`session-fork-service.ts`), and for an ordinary fork into a top tab.
    const sideChatFork = {
      id: 'side' as SessionId,
      title: '(fork) Diagram',
      titleSource: 'generated',
      isArchived: false,
      parentSessionId: 'parent' as SessionId,
      childSessionPlacement: 'side-panel' as const,
    };
    const tabFork = { ...sideChatFork, childSessionPlacement: undefined };
    const lagging = { ...sideChatFork, childSessionPlacement: undefined };

    const routeIn = (renderedAsSideChat: boolean, session: typeof tabFork) =>
      route({ inSideChat: isSideChatSurface({ renderedAsSideChat, session }) }).kind;
    // In the panel, a click asks there, even before the placement has synced.
    expect(routeIn(true, sideChatFork)).toBe('send');
    expect(routeIn(true, lagging)).toBe('send');
    // A side chat opened anywhere else still asks in place.
    expect(routeIn(false, sideChatFork)).toBe('send');
    // An ordinary fork in a top tab forks a side chat of its own.
    expect(routeIn(false, tabFork)).toBe('side-chat');
  });

  it('fills the composer when the conversation cannot fork or has no finished turn', () => {
    expect(route({ canAskInSideChat: false })).toEqual({ kind: 'fill' });
    expect(route({ widgetTurnId: null, latestTurnId: null })).toEqual({ kind: 'fill' });
  });
});

describe('widget side chats', () => {
  it('holds questions asked while the conversation forks, one side chat each, in order', () => {
    const queue = createWidgetQuestionQueue<{ request: { key: string; text: string } }>();
    const forking = new Set(['parent']);
    const isForking = (id: string) => forking.has(id);
    const question = (key: string) => ({ request: { key, text: `question ${key}` } });

    // A is being forked; B and C are asked meanwhile, B twice, A again.
    queue.hold('page-a', 'parent', question('b'), 'a');
    queue.hold('page-a', 'parent', question('b'), 'a');
    queue.hold('page-a', 'parent', question('a'), 'a');
    queue.hold('page-a', 'parent', question('c'), 'a');
    expect(queue.release('page-a', isForking)).toEqual([]);

    forking.delete('parent');
    expect(queue.release('page-a', isForking)).toEqual([question('b')]);
    forking.add('parent');
    expect(queue.release('page-a', isForking)).toEqual([]);
    forking.delete('parent');
    expect(queue.release('page-a', isForking)).toEqual([question('c')]);
    expect(queue.release('page-a', isForking)).toEqual([]);
  });

  it("keeps a page's questions for that page when the user moves to another conversation", () => {
    const queue = createWidgetQuestionQueue<{ request: { key: string } }>();
    queue.hold('page-a', 'session-a', { request: { key: 'b' } }, 'a');
    // On page B nothing forks: A's question is neither forked nor answered there.
    expect(queue.release('page-b', () => false)).toEqual([]);
    // Back on page A, it goes on.
    expect(queue.release('page-a', () => false)).toEqual([{ request: { key: 'b' } }]);
  });

  it('shows a side chat as opening from the click until its session reaches the panel', () => {
    const pending = (phase: 'requesting' | 'awaiting-history') => ({
      parent: {
        turnId: 'turn-1',
        targetSessionId: 'side',
        phase,
        placement: 'side-panel',
        firstPrompt: { text: 'Why?', key: 'k', turnId: 'turn-1' },
      },
      other: { turnId: 'turn-2', targetSessionId: 'tab', phase, placement: 'tab' },
    });
    // Forking, and forked but not yet here: one pending tab, named by the question.
    expect(getOpeningSideChats(pending('requesting'), [])).toEqual([
      { sessionId: 'side', question: 'Why?' },
    ]);
    expect(getOpeningSideChats(pending('awaiting-history'), [])).toEqual([
      { sessionId: 'side', question: 'Why?' },
    ]);
    // Once the side chat is in the panel, its own tab takes over.
    expect(getOpeningSideChats(pending('awaiting-history'), ['side'])).toEqual([]);
  });

  describe('first question', () => {
    let container: HTMLDivElement;
    let roots: Root[];
    const sent: string[] = [];
    const filled: string[] = [];
    const renamed: string[] = [];

    function SideChat(props: { id: string; ready: boolean; accepts?: boolean }) {
      useSideChatFirstPrompt({
        sessionId: props.id as SessionId,
        ready: props.ready,
        send: async (text) => {
          if (props.accepts === false) return false;
          sent.push(`${props.id}: ${text}`);
          return true;
        },
        fill: (text) => filled.push(`${props.id}: ${text}`),
        onSending: (text) => renamed.push(widgetSideChatTitle(text)),
      });
      return null;
    }
    const mount = async (element: React.ReactElement) => {
      const root = createRoot(container.appendChild(document.createElement('div')));
      roots.push(root);
      await act(async () => root.render(element));
      return root;
    };

    beforeEach(() => {
      container = document.body.appendChild(document.createElement('div'));
      roots = [];
      sent.length = 0;
      filled.length = 0;
      renamed.length = 0;
    });
    afterEach(() => {
      for (const root of roots) act(() => root.unmount());
      container.remove();
      forgetSideChatFirstPrompt('side' as SessionId);
    });

    it('is sent by the side chat once its history arrives, after mounting late', async () => {
      // The click hands the question over before the fork has even answered.
      saveSideChatFirstPrompt('side' as SessionId, 'What is A?');
      // The side chat mounts later, still loading its forked history.
      const root = await mount(<SideChat id="side" ready={false} />);
      expect(sent).toEqual([]);
      await act(async () => root.render(<SideChat id="side" ready />));
      expect(sent).toEqual(['side: What is A?']);
      expect(renamed).toEqual(['What is A?']);
      // Re-renders and later surfaces of it do not ask again.
      await act(async () => root.render(<SideChat id="side" ready />));
      await mount(<SideChat id="side" ready />);
      expect(sent).toEqual(['side: What is A?']);
    });

    it('waits for a page that was left and is opened again', async () => {
      saveSideChatFirstPrompt('side' as SessionId, 'What is B?');
      const left = await mount(<SideChat id="side" ready={false} />);
      act(() => left.unmount());
      roots = roots.filter((root) => root !== left);
      await mount(<SideChat id="side" ready />);
      expect(sent).toEqual(['side: What is B?']);
    });

    it('is asked by one window only', async () => {
      saveSideChatFirstPrompt('side' as SessionId, 'What is C?');
      await mount(<SideChat id="side" ready />);
      await mount(<SideChat id="side" ready />);
      expect(sent).toEqual(['side: What is C?']);
    });

    it('goes into the composer when the side chat cannot send it', async () => {
      saveSideChatFirstPrompt('side' as SessionId, 'What is D?');
      await mount(<SideChat id="side" ready accepts={false} />);
      expect(sent).toEqual([]);
      expect(filled).toEqual(['side: What is D?']);
    });
  });

  it('names a side chat by its question, shortened to fit a tab', () => {
    expect(widgetSideChatTitle('  Why does the router\n check first?  ')).toBe(
      'Why does the router check first?'
    );
    const long = widgetSideChatTitle(`How ${'very '.repeat(20)}long`);
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('…')).toBe(true);
  });
});
