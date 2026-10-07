// @vitest-environment jsdom

import { act, createElement, createRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/components/mentions/mention-session-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSessionMentionItems: () => [],
}));

vi.mock('../src/components/mentions/mention-agent-role-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgentRoleMentionItems: () => [],
}));

import { ChatComposer } from '../src/components/chat/chat-composer';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('ChatComposer focusOnContainerClick', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await initI18n('en');
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('focuses textarea when clicking container background with focusOnContainerClick=true', async () => {
    const promptRef = createRef<HTMLTextAreaElement>();
    await act(async () => {
      root.render(
        createElement(ChatComposer, {
          promptRef,
          promptValue: '',
          onPromptChange: () => undefined,
          focusOnContainerClick: true,
        })
      );
    });

    const boxContainer = container.querySelector('.group.relative') as HTMLElement;
    expect(boxContainer).not.toBeNull();
    expect(document.activeElement).not.toBe(promptRef.current);

    await act(async () => {
      boxContainer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.activeElement).toBe(promptRef.current);
  });

  it('does not focus textarea when focusOnContainerClick is false', async () => {
    const promptRef = createRef<HTMLTextAreaElement>();
    await act(async () => {
      root.render(
        createElement(ChatComposer, {
          promptRef,
          promptValue: '',
          onPromptChange: () => undefined,
          focusOnContainerClick: false,
        })
      );
    });

    const boxContainer = container.querySelector('.group.relative') as HTMLElement;
    await act(async () => {
      boxContainer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.activeElement).not.toBe(promptRef.current);
  });

  it('does not focus textarea when clicking a button, input, or portalled element', async () => {
    const promptRef = createRef<HTMLTextAreaElement>();
    const customInputRef = createRef<HTMLInputElement>();

    await act(async () => {
      root.render(
        createElement(ChatComposer, {
          promptRef,
          promptValue: '',
          onPromptChange: () => undefined,
          focusOnContainerClick: true,
          footerSelector: createElement('input', {
            ref: customInputRef,
            'aria-label': 'custom-input',
          }),
        })
      );
    });

    const input = customInputRef.current;
    expect(input).not.toBeNull();

    await act(async () => {
      input?.focus();
      input?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.activeElement).toBe(input);
    expect(document.activeElement).not.toBe(promptRef.current);
  });
});

describe('ChatComposer prompt suggestion', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await initI18n('en');
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  /** A composer whose Enter sends, as the session composer's does. */
  async function renderComposer(initialValue: string) {
    const promptRef = createRef<HTMLTextAreaElement>();
    const sent: string[] = [];
    function Harness() {
      const [value, setValue] = useState(initialValue);
      return createElement(ChatComposer, {
        promptRef,
        promptValue: value,
        onPromptChange: setValue,
        onPromptKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            sent.push(value);
            setValue('');
          }
        },
        promptSuggestion: 'run the tests',
      });
    }
    await act(async () => {
      root.render(createElement(Harness));
    });
    const textarea = promptRef.current!;
    const press = async (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      });
      await act(async () => {
        textarea.dispatchEvent(event);
      });
      return event;
    };
    return { textarea, sent, press };
  }

  it('shows the guess in the empty box and fills it in on Tab without sending', async () => {
    const { textarea, sent, press } = await renderComposer('');
    expect(textarea.placeholder).toBe('run the tests');

    const tab = await press('Tab');

    expect(tab.defaultPrevented).toBe(true);
    expect(textarea.value).toBe('run the tests');
    expect(sent).toEqual([]);
    expect(textarea.placeholder).not.toBe('run the tests');
  });

  it('leaves Tab alone once something is typed, and leaves Shift+Tab alone', async () => {
    const typed = await renderComposer('fix');
    expect(typed.textarea.placeholder).not.toBe('run the tests');
    expect((await typed.press('Tab')).defaultPrevented).toBe(false);
    expect(typed.textarea.value).toBe('fix');

    const empty = await renderComposer('');
    expect((await empty.press('Tab', { shiftKey: true })).defaultPrevented).toBe(false);
    expect(empty.textarea.value).toBe('');
  });
});

describe('ChatComposer image attachment peek', () => {
  let root: Root;
  let container: HTMLDivElement;

  const drainFrames = () =>
    act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

  const peekImage = () => document.body.querySelector<HTMLImageElement>('img[alt="Image preview"]');

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ChatComposer, {
          promptValue: '',
          onPromptChange: () => undefined,
          imageItems: [
            {
              id: 'image-1',
              name: 'mockup.png',
              previewUrl: 'blob:mockup',
              status: 'uploaded',
              progress: 100,
            },
          ],
        })
      );
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('opens a non-modal card beside the thumbnail and closes it on Escape', async () => {
    const thumbnail = container.querySelector<HTMLButtonElement>('button[aria-label="mockup.png"]');
    expect(thumbnail).not.toBeNull();
    expect(peekImage()).toBeNull();

    await act(async () => {
      thumbnail!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await drainFrames();

    const image = peekImage();
    expect(image?.getAttribute('src')).toBe('blob:mockup');
    expect(thumbnail!.getAttribute('aria-expanded')).toBe('true');
    // A peek, not a lightbox: nothing modal covers the draft.
    expect(document.body.querySelector('[aria-modal="true"]')).toBeNull();
    expect(image!.parentElement?.textContent).toContain('mockup.png');

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    await drainFrames();

    expect(thumbnail!.getAttribute('aria-expanded')).toBe('false');
  });
});
