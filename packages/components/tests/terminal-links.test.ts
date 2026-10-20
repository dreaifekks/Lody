// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  findTerminalLineLinks,
  findTerminalLinks,
  isLoopbackUrl,
  isSidePanelLinkModifier,
  resolveTerminalLinkAction,
} from '../src/components/terminal/terminal-links';
import { __resetPlatformCacheForTests } from '../src/lib/commands/platform';

function stubPlatform(os: 'win32' | 'darwin' | 'linux'): void {
  vi.stubGlobal('__LODY_PLATFORM__', { os });
  __resetPlatformCacheForTests();
}

const urls = (text: string) => findTerminalLinks(text, { paths: false }).map((link) => link.text);

// A buffer row as xterm stores it: one cell per column, a wide character
// followed by a zero-width continuation cell, trailing cells empty.
function bufferLine(text: string, columns = text.length + 4) {
  const cells: Array<{ chars: string; width: number }> = [];
  for (const char of text) {
    const wide = /\p{Script=Han}/u.test(char);
    cells.push({ chars: char, width: wide ? 2 : 1 });
    if (wide) cells.push({ chars: '', width: 0 });
  }
  while (cells.length < columns) cells.push({ chars: '', width: 1 });
  return {
    length: cells.length,
    getCell: (x: number) => {
      const cell = cells[x];
      return cell && { getChars: () => cell.chars, getWidth: () => cell.width };
    },
  } as unknown as Parameters<typeof findTerminalLineLinks>[0];
}

describe('findTerminalLinks', () => {
  it('keeps ports, paths, queries and fragments', () => {
    expect(urls('Local: http://localhost:5173/app/?q=1&x=2#top')).toEqual([
      'http://localhost:5173/app/?q=1&x=2#top',
    ]);
    expect(urls('see https://[::1]:8080/health')).toEqual(['https://[::1]:8080/health']);
  });

  it('drops trailing sentence punctuation and brackets the URL never opened', () => {
    expect(urls('Open http://localhost:3000.')).toEqual(['http://localhost:3000']);
    expect(urls('(docs: https://example.com/a)')).toEqual(['https://example.com/a']);
    expect(urls('[https://example.com/b]: done')).toEqual(['https://example.com/b']);
    expect(urls('https://en.wikipedia.org/wiki/Foo_(bar), next')).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]);
    expect(urls('"https://example.com/q"')).toEqual(['https://example.com/q']);
  });

  it('ends a URL at full-width punctuation in Chinese output', () => {
    expect(urls('打开 http://localhost:3000，然后刷新')).toEqual(['http://localhost:3000']);
  });

  it('finds every URL on the line with its offsets', () => {
    const text = 'a http://a.test/x b https://b.test/y';
    expect(findTerminalLinks(text, { paths: false })).toEqual([
      { kind: 'url', text: 'http://a.test/x', start: 2, end: 17 },
      { kind: 'url', text: 'https://b.test/y', start: 20, end: 36 },
    ]);
  });

  it('ignores a scheme with no host', () => {
    expect(urls('http:// and https://. only')).toEqual([]);
  });

  it('finds file paths between URLs only when asked, never inside a URL', () => {
    const text = 'error in src/app.ts:12:5 see http://localhost:3000/main.js';
    expect(findTerminalLinks(text, { paths: true })).toEqual([
      { kind: 'path', text: 'src/app.ts:12:5', start: 9, end: 24 },
      { kind: 'url', text: 'http://localhost:3000/main.js', start: 29, end: 58 },
    ]);
    expect(findTerminalLinks(text, { paths: false }).map((link) => link.kind)).toEqual(['url']);
  });
});

describe('findTerminalLineLinks', () => {
  it('maps links to 1-based inclusive cell columns', () => {
    expect(findTerminalLineLinks(bufferLine('go http://x.test now'), { paths: false })).toEqual([
      { kind: 'url', text: 'http://x.test', startX: 4, endX: 16 },
    ]);
  });

  it('counts wide characters as two cells', () => {
    // 打开 takes four cells, so the URL starts in column 6.
    expect(findTerminalLineLinks(bufferLine('打开 http://x.test'), { paths: false })).toEqual([
      { kind: 'url', text: 'http://x.test', startX: 6, endX: 18 },
    ]);
    // 准备 inside the path ends it on its second cell.
    expect(findTerminalLineLinks(bufferLine('docs/准备.md'), { paths: true })).toEqual([
      { kind: 'path', text: 'docs/准备.md', startX: 1, endX: 12 },
    ]);
  });
});

describe('isLoopbackUrl', () => {
  it('accepts the loopback hosts dev servers print', () => {
    expect(isLoopbackUrl('http://localhost:3000/')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:8000')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:5173/')).toBe(true);
    expect(isLoopbackUrl('http://0.0.0.0:4000/x')).toBe(true);
    expect(isLoopbackUrl('http://LOCALHOST')).toBe(true);
  });

  it('rejects LAN and public hosts', () => {
    expect(isLoopbackUrl('http://192.168.1.4:3000')).toBe(false);
    expect(isLoopbackUrl('https://localhost.example.com')).toBe(false);
    expect(isLoopbackUrl('https://example.com/localhost')).toBe(false);
  });
});

describe('isSidePanelLinkModifier', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetPlatformCacheForTests();
  });

  it('is Cmd on macOS and Ctrl elsewhere', () => {
    stubPlatform('darwin');
    expect(isSidePanelLinkModifier({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(isSidePanelLinkModifier({ metaKey: false, ctrlKey: true })).toBe(false);
    stubPlatform('linux');
    expect(isSidePanelLinkModifier({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(isSidePanelLinkModifier({ metaKey: true, ctrlKey: false })).toBe(false);
  });
});

describe('resolveTerminalLinkAction', () => {
  const local = { sidePanelModifier: false, sessionIsRemote: false, canOpenUrlInSidePanel: true };

  it('opens a URL in the system browser on a plain click', () => {
    expect(
      resolveTerminalLinkAction({ kind: 'url', text: 'http://localhost:3000' }, local)
    ).toEqual({ target: 'system-browser', url: 'http://localhost:3000' });
  });

  it('opens a URL in the side panel with the modifier', () => {
    expect(
      resolveTerminalLinkAction(
        { kind: 'url', text: 'https://example.com' },
        { ...local, sidePanelModifier: true }
      )
    ).toEqual({ target: 'side-browser', url: 'https://example.com' });
  });

  it("sends a remote session's loopback URL to the side panel even on a plain click", () => {
    const remote = { ...local, sessionIsRemote: true };
    expect(
      resolveTerminalLinkAction({ kind: 'url', text: 'http://0.0.0.0:3000/a' }, remote)
    ).toEqual({ target: 'side-browser', url: 'http://localhost:3000/a' });
    expect(resolveTerminalLinkAction({ kind: 'url', text: 'https://example.com' }, remote)).toEqual(
      {
        target: 'system-browser',
        url: 'https://example.com',
      }
    );
  });

  it('falls back to the system browser where there is no side panel', () => {
    expect(
      resolveTerminalLinkAction(
        { kind: 'url', text: 'http://localhost:3000' },
        { sidePanelModifier: true, sessionIsRemote: true, canOpenUrlInSidePanel: false }
      )
    ).toEqual({ target: 'system-browser', url: 'http://localhost:3000' });
  });

  it('opens a path only with the modifier', () => {
    expect(resolveTerminalLinkAction({ kind: 'path', text: 'src/a.ts:3' }, local)).toBeNull();
    expect(
      resolveTerminalLinkAction(
        { kind: 'path', text: 'src/a.ts:3' },
        { ...local, sidePanelModifier: true }
      )
    ).toEqual({ target: 'side-file', path: 'src/a.ts:3' });
  });
});
