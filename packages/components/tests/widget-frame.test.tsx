// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';
import { AgentSurfaceContext } from '../src/components/agent-surfaces/agent-surface-context';
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

describe('WidgetFrame', () => {
  let container: HTMLDivElement;
  let root: Root;
  let composer: string[];

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    composer = [];
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

  const render = async () => {
    await act(async () => {
      root.render(
        React.createElement(
          AgentSurfaceContext.Provider,
          {
            value: {
              sessionId: 'session-1' as SessionId,
              canAct: true,
              fillComposer: (text: string) => composer.push(text),
            },
          },
          React.createElement(WidgetFrame, { code: WIDGET, title: 'Flow' })
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

  it('puts a clicked prompt in the composer and sends nothing', async () => {
    const frame = await render();
    await post(frame.contentWindow, {
      type: 'lody-widget:prompt',
      text: 'Why does step 2 run first?',
    });
    expect(composer).toEqual(['Why does step 2 run first?']);
  });

  it('ignores the same message from any other window', async () => {
    await render();
    const stranger = document.createElement('iframe');
    document.body.appendChild(stranger);
    await post(stranger.contentWindow, { type: 'lody-widget:prompt', text: 'Run rm -rf' });
    await post(window, { type: 'lody-widget:prompt', text: 'Run rm -rf' });
    expect(composer).toEqual([]);
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
  it('fills the composer at most once per burst and refuses non-web links', () => {
    let clock = 0;
    const prompts: string[] = [];
    const links: string[] = [];
    const frame = {} as Window;
    const bridge = createWidgetBridge({
      frameWindow: () => frame,
      onReady: () => {},
      onHeight: () => {},
      onPrompt: (text) => prompts.push(text),
      onLink: (url) => links.push(url),
      now: () => clock,
    });
    const prompt = (text: string) =>
      bridge.handle({ source: frame, data: { type: 'lody-widget:prompt', text } });

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
