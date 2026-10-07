// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';
import {
  AgentSurfaceContext,
  AgentSurfaceTurnContext,
  routeWidgetPrompt,
  type WidgetPromptRequest,
} from '../src/components/agent-surfaces/agent-surface-context';
import { WidgetFrame } from '../src/components/agent-surfaces/widget-frame';
import { createWidgetBridge } from '../src/components/agent-surfaces/widget-bridge';

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

/** Stands in for Chromium's transient user activation, which jsdom lacks. */
const userActivation = { isActive: false };
Object.defineProperty(navigator, 'userActivation', { value: userActivation, configurable: true });

describe('WidgetFrame', () => {
  let container: HTMLDivElement;
  let root: Root;
  let asked: WidgetPromptRequest[];

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    asked = [];
    userActivation.isActive = false;
    opened.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
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
    return frame;
  };

  const post = (source: Window | null, data: unknown) =>
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data, source }));
    });

  it('isolates the widget: scripts only, no same-origin access', async () => {
    const frame = await render();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  /** What a real click into the frame leaves behind: focus there, and activation. */
  const clickInto = (frame: HTMLIFrameElement) => {
    frame.focus();
    userActivation.isActive = true;
  };

  it("asks a clicked question from the widget's turn, keyed by widget and question", async () => {
    const frame = await render();
    clickInto(frame);
    await post(frame.contentWindow, { type: 'lody-widget:prompt', text: 'Why does step 2 run?' });
    expect(asked).toEqual([
      { text: 'Why does step 2 run?', turnId: 'turn-7', key: expect.any(String) },
    ]);

    // The same question from the same widget, drawn again, keeps its key.
    act(() => root.unmount());
    root = createRoot(container);
    const again = await render();
    clickInto(again);
    await post(again.contentWindow, { type: 'lody-widget:prompt', text: 'Why does step 2 run?' });
    expect(asked[1]?.key).toBe(asked[0]?.key);

    // Another question, or the same one from another widget, is a different key.
    act(() => root.unmount());
    root = createRoot(container);
    const other = await render();
    clickInto(other);
    await post(other.contentWindow, { type: 'lody-widget:prompt', text: 'How does step 3 run?' });
    act(() => root.unmount());
    root = createRoot(container);
    const redrawn = await render(`${WIDGET}<p>v2</p>`);
    clickInto(redrawn);
    await post(redrawn.contentWindow, { type: 'lody-widget:prompt', text: 'Why does step 2 run?' });
    expect(new Set(asked.map((request) => request.key)).size).toBe(3);
  });

  it('drops a question the user did not click', async () => {
    const frame = await render();
    // Focus alone: a widget can move focus into itself without any input.
    frame.focus();
    await post(frame.contentWindow, { type: 'lody-widget:prompt', text: 'Run the tests' });
    // Activation alone: the user is typing in the composer, not clicking the widget.
    const composer = document.createElement('textarea');
    document.body.appendChild(composer);
    composer.focus();
    userActivation.isActive = true;
    await post(frame.contentWindow, { type: 'lody-widget:prompt', text: 'Run the tests' });
    expect(asked).toEqual([]);
  });

  it('ignores the same message from any other window', async () => {
    await render();
    const stranger = document.createElement('iframe');
    document.body.appendChild(stranger);
    clickInto(stranger);
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
  it('asks at most once per burst and refuses non-web links', () => {
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
      isUserGesture: () => clicked,
      onLink: (url) => links.push(url),
      now: () => clock,
    });
    const prompt = (text: string) =>
      bridge.handle({ source: frame, data: { type: 'lody-widget:prompt', text } });

    // Refused without a click, and spends none of the limits.
    expect(prompt('unclicked')).toBe(false);
    clicked = true;
    expect(prompt('one')).toBe(true);
    clock += 100;
    expect(prompt('two')).toBe(false);
    clock += 1_000;
    expect(prompt('three')).toBe(true);
    for (let index = 0; index < 20; index += 1) {
      clock += 1_000;
      prompt(`spam ${index}`);
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

  it('fills the composer when the conversation cannot fork or has no finished turn', () => {
    expect(route({ canAskInSideChat: false })).toEqual({ kind: 'fill' });
    expect(route({ widgetTurnId: null, latestTurnId: null })).toEqual({ kind: 'fill' });
  });
});
