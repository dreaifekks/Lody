// @vitest-environment jsdom

// The card's second action exists for exactly one gap: an HTML attachment's
// click opens the RENDERED page, so without it the uploaded source bytes have
// no route at all. Every other previewable file downloads from inside the
// preview dialog and must NOT grow a duplicate control.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getServerNow,
  type SessionFilePayload,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';

import { Provider, createStore } from 'jotai';
import { PlatformContext } from '@lody/platform/react';

import { buildChatStreamItems } from '../src/components/ai-gui/build-chat-stream-items';
import { SessionFileCard } from '../src/components/ai-gui/session-file-card';
import {
  MessageRowView,
  SessionChatStreamView,
  SessionFileGroup,
} from '../src/components/ai-gui/view';
import { createConversationViewFromHistory } from '../src/lib/conversation-view';
import { currentWorkspaceIdAtom } from '../src/atoms/workspace-context';
import {
  isKeptImageFile,
  SessionKeptImageFile,
} from '../src/components/ai-gui/session-local-image-file';
import { SESSION_FILE_RETENTION_MS } from '../src/lib/session-file-presentation';
import { initI18n } from '../src/i18n';
import { TEST_CLOUD_PLATFORM } from './test-platform';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ReadInput = { machineId: string; fileId: string; sizeBytes: number; sha256: string };
type ReadResult = { ok: true; bytes: ArrayBuffer } | { ok: false; error: string };
/** The agent service of this machine, as the desktop's main process answers for it. */
let readKeptFile: (input: ReadInput) => Promise<ReadResult> = async () => ({
  ok: false,
  error: 'not wired',
});
type OpenInput = {
  workspaceId: string;
  machineId: string;
  sessionId: string;
  fileId: string;
  mimeType: string;
};
type OpenResult = { ok: true; url: string; sizeBytes: number } | { ok: false; error: string };
/** The desktop's shell, asked for a resource URL that reads a kept file in ranges. */
let openMemberFile: (input: OpenInput) => Promise<OpenResult> = async () => ({
  ok: false,
  error: 'not wired',
});
vi.mock('../src/lib/electron-ipc-client', () => ({
  getIpcServices: () => ({
    localProjects: { readSessionFileLocal: (input: ReadInput) => readKeptFile(input) },
    machineRpc: { openMemberFile: (input: OpenInput) => openMemberFile(input) },
    app: { getFullscreen: async () => false },
    // The viewer's right-click menu; nothing here opens it.
    image: {
      showPreviewMenu: async () => null,
      copyToClipboard: async () => ({ ok: true }),
      saveAs: async () => ({ ok: true }),
    },
  }),
  onIpcEvent: () => () => {},
}));

const file = (overrides: Partial<SessionFilePayload> = {}): SessionFilePayload => ({
  type: 'file',
  fileId: 'file-1',
  fileName: 'lody-one-flyer.html',
  mimeType: 'text/html',
  sizeBytes: 16_300,
  sha256: 'a'.repeat(64),
  textPreview: true,
  transport: 'r2',
  uploadedAt: getServerNow(),
  ...overrides,
});

describe('SessionFileCard download action', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  const onPreview = vi.fn();
  const onDownload = vi.fn();

  beforeEach(async () => {
    await initI18n('en');
    onPreview.mockClear();
    onDownload.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = undefined;
    }
    container?.remove();
    container = undefined;
  });

  const render = async (props: Partial<Parameters<typeof SessionFileCard>[0]>) => {
    await act(async () => {
      root?.render(
        createElement(SessionFileCard, {
          file: file(),
          onPreview,
          onDownload,
          ...props,
        })
      );
    });
    return container as HTMLDivElement;
  };

  const downloadButton = (view: HTMLElement) =>
    view.querySelector<HTMLButtonElement>('button[aria-label="Download file"]');

  it('offers preview and download side by side on an HTML attachment', async () => {
    const view = await render({});

    const preview = view.querySelector<HTMLButtonElement>(
      'button[aria-label="lody-one-flyer.html"]'
    );
    expect(preview).not.toBeNull();
    expect(downloadButton(view)).not.toBeNull();

    await act(async () => {
      preview?.click();
    });
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onDownload).not.toHaveBeenCalled();

    await act(async () => {
      downloadButton(view)?.click();
    });
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'file-1' }));
    // Downloading the source must not also open the preview it exists to avoid.
    expect(onPreview).toHaveBeenCalledTimes(1);
  });

  it('keeps a published attachment available independently of source retention', async () => {
    const published = file({ uploadedAt: 0 });
    const view = await render({ file: published, retention: 'publication' });
    const preview = view.querySelector<HTMLButtonElement>(
      'button[aria-label="lody-one-flyer.html"]'
    );
    expect(preview?.disabled).toBe(false);
    await act(async () => {
      preview?.click();
    });
    expect(onPreview).toHaveBeenCalledWith(published);
    expect(view.textContent).not.toContain('expired');
  });

  it('recognizes an HTML attachment by extension when the MIME type is generic', async () => {
    const view = await render({
      file: file({ fileName: 'report.htm', mimeType: 'application/octet-stream' }),
    });

    expect(downloadButton(view)).not.toBeNull();
  });

  it('does not duplicate the control on a previewable file whose dialog downloads', async () => {
    const view = await render({
      file: file({ fileName: 'README.md', mimeType: 'text/markdown' }),
    });

    expect(downloadButton(view)).toBeNull();
    const preview = view.querySelector<HTMLButtonElement>('button[aria-label="README.md"]');
    await act(async () => {
      preview?.click();
    });
    expect(onPreview).toHaveBeenCalledTimes(1);
  });

  it('keeps download as the card itself when the file has no preview', async () => {
    const view = await render({
      file: file({ fileName: 'mockups.zip', mimeType: 'application/zip', textPreview: false }),
    });

    expect(downloadButton(view)).toBeNull();
    await act(async () => {
      view.querySelector<HTMLButtonElement>('button[aria-label="mockups.zip"]')?.click();
    });
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onPreview).not.toHaveBeenCalled();
  });

  it('disables the download button while its own download is in flight', async () => {
    const view = await render({ isDownloading: true });

    expect(downloadButton(view)?.disabled).toBe(true);
    await act(async () => {
      downloadButton(view)?.click();
    });
    expect(onDownload).not.toHaveBeenCalled();
    // The primary action still reads as preview, not as a second spinner.
    expect(
      view.querySelector<HTMLButtonElement>('button[aria-label="lody-one-flyer.html"]')?.disabled
    ).toBe(false);
  });

  it('offers no download for bytes the client cannot fetch', async () => {
    const pending = await render({
      file: file({ transport: 'local', machineId: 'machine-abc' }),
    });
    expect(downloadButton(pending)).toBeNull();
    expect(
      pending.querySelector<HTMLButtonElement>('button[aria-label="lody-one-flyer.html"]')?.disabled
    ).toBe(true);

    const expired = await render({
      file: file({ uploadedAt: getServerNow() - SESSION_FILE_RETENTION_MS - 1000 }),
    });
    expect(downloadButton(expired)).toBeNull();
  });

  it('offers no download button when the caller wires no download handler', async () => {
    const view = await render({ onDownload: undefined });

    expect(downloadButton(view)).toBeNull();
  });

  it('says where a file is kept when nothing uploads it, and promises an upload otherwise', async () => {
    const held = file({
      fileName: 'screenshot.png',
      mimeType: 'image/png',
      textPreview: false,
      transport: 'local',
      machineId: 'machine-1',
    });

    const kept = await render({
      file: held,
      pendingMachineName: 'devbox',
      uploads: false,
      onDownload: undefined,
    });
    expect(kept.textContent).toContain('On devbox · 15.9 KB');
    expect(kept.textContent).not.toContain('Uploading');
    // The machine holds the bytes; a window that cannot read them has nothing to offer.
    expect(
      kept.querySelector<HTMLButtonElement>('button[aria-label="screenshot.png"]')?.disabled
    ).toBe(true);

    // A window that can read them from that machine downloads them on a click.
    const readable = await render({ file: held, pendingMachineName: 'devbox', uploads: false });
    expect(readable.textContent).toContain('On devbox · 15.9 KB');
    const card = readable.querySelector<HTMLButtonElement>('button[aria-label="screenshot.png"]');
    expect(card?.disabled).toBe(false);
    await act(async () => {
      card?.click();
    });
    expect(onDownload).toHaveBeenCalledWith(held);
    expect(onPreview).not.toHaveBeenCalled();

    const pending = await render({ file: held, pendingMachineName: 'devbox' });
    expect(pending.textContent).toContain('Uploading from devbox');
  });

  it('previews a kept text file it can read, and still says where it is', async () => {
    const notes = file({
      fileName: 'notes.md',
      mimeType: 'text/markdown',
      transport: 'local',
      machineId: 'machine-1',
    });

    const readable = await render({ file: notes, pendingMachineName: 'devbox', uploads: false });
    expect(readable.textContent).toContain('On devbox · 15.9 KB');
    await act(async () => {
      readable.querySelector<HTMLButtonElement>('button[aria-label="notes.md"]')?.click();
    });
    expect(onPreview).toHaveBeenCalledWith(notes);
    expect(onDownload).not.toHaveBeenCalled();

    // A window that cannot read it from that machine opens nothing.
    const unreadable = await render({
      file: notes,
      pendingMachineName: 'devbox',
      uploads: false,
      onDownload: undefined,
    });
    expect(
      unreadable.querySelector<HTMLButtonElement>('button[aria-label="notes.md"]')?.disabled
    ).toBe(true);
  });
});

describe('an image a machine keeps', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let nextUrl = 0;
  const liveUrls = new Set<string>();

  beforeEach(async () => {
    await initI18n('en');
    (window as Window & { __LODY_ELECTRON__?: boolean }).__LODY_ELECTRON__ = true;
    URL.createObjectURL = () => {
      const url = `blob:kept-${(nextUrl += 1)}`;
      liveUrls.add(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      liveUrls.delete(url);
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = undefined;
    }
    container?.remove();
    container = undefined;
    delete (window as Window & { __LODY_ELECTRON__?: boolean }).__LODY_ELECTRON__;
  });

  // Each test names its own file: what a page read once it keeps.
  const kept = (fileId: string, overrides: Partial<SessionFilePayload> = {}) =>
    file({
      fileId,
      fileName: 'shinku_birthday.png',
      mimeType: 'image/png',
      sizeBytes: 1_997_038,
      sha256: 'b'.repeat(64),
      textPreview: false,
      transport: 'local',
      machineId: 'homenucserver',
      ...overrides,
    });

  const render = async (shown: SessionFilePayload) => {
    await act(async () => {
      root?.render(
        createElement(SessionKeptImageFile, {
          file: shown,
          workspaceId: 'lan-home',
          sessionId: 'session-1',
          card: createElement('div', { 'data-testid': 'card' }, 'the file card'),
        })
      );
    });
    return container as HTMLDivElement;
  };

  const image = (view: HTMLElement) => view.querySelector<HTMLImageElement>('img');
  const decode = async (view: HTMLElement) => {
    await act(async () => {
      image(view)?.dispatchEvent(new Event('load'));
    });
  };
  const button = (view: HTMLElement, label: string) =>
    Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) => candidate.textContent === label
    );

  it('is an image only when a machine keeps it and this desktop can ask for it', () => {
    expect(isKeptImageFile(kept('a'))).toBe(true);
    expect(isKeptImageFile(kept('a', { transport: 'r2', machineId: undefined }))).toBe(false);
    expect(isKeptImageFile(kept('a', { mimeType: 'image/svg+xml' }))).toBe(false);
    delete (window as Window & { __LODY_ELECTRON__?: boolean }).__LODY_ELECTRON__;
    expect(isKeptImageFile(kept('a'))).toBe(false);
  });

  it('shows a small image as itself, read from the machine that keeps it', async () => {
    const asked: ReadInput[] = [];
    readKeptFile = async (input) => {
      asked.push(input);
      return { ok: true, bytes: new Uint8Array([1, 2, 3]).buffer };
    };

    const view = await render(kept('small'));
    await decode(view);

    expect(asked).toEqual([
      expect.objectContaining({
        machineId: 'homenucserver',
        fileId: 'small',
        sizeBytes: 1_997_038,
        sha256: 'b'.repeat(64),
      }),
    ]);
    expect(image(view)?.getAttribute('src')).toMatch(/^blob:kept-/);
    expect(view.querySelector('[data-testid="card"]')).toBeNull();
  });

  it('waits for a click before reading an image over ten megabytes', async () => {
    let reads = 0;
    readKeptFile = async () => {
      reads += 1;
      return { ok: true, bytes: new Uint8Array([1]).buffer };
    };

    const view = await render(kept('large', { sizeBytes: 12 * 1024 * 1024 }));

    expect(reads).toBe(0);
    expect(image(view)).toBeNull();
    expect(view.querySelector('[data-testid="card"]')).not.toBeNull();

    await act(async () => {
      button(view, 'Load image')?.click();
    });
    await decode(view);

    expect(image(view)).not.toBeNull();
    expect(view.querySelector('[data-testid="card"]')).toBeNull();
  });

  it('keeps the card and says why when the image cannot be read, and reads again on retry', async () => {
    readKeptFile = async () => ({ ok: false, error: 'homenucserver: file_not_found' });

    const view = await render(kept('missing'));

    expect(image(view)).toBeNull();
    expect(view.querySelector('[data-testid="card"]')).not.toBeNull();
    expect(view.textContent).toContain('homenucserver: file_not_found');

    readKeptFile = async () => ({ ok: true, bytes: new Uint8Array([1]).buffer });
    await act(async () => {
      button(view, 'Retry')?.click();
    });
    await decode(view);

    expect(image(view)).not.toBeNull();
  });

  it('releases its object URL when the row goes away', async () => {
    readKeptFile = async () => ({ ok: true, bytes: new Uint8Array([1]).buffer });
    const view = await render(kept('released'));
    await decode(view);
    const url = image(view)?.getAttribute('src');
    expect(url && liveUrls.has(url)).toBe(true);

    await act(async () => {
      root?.unmount();
    });
    root = undefined;

    expect(url && liveUrls.has(url)).toBe(false);
  });
});

describe('previewing a file a machine keeps', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    (window as Window & { __LODY_ELECTRON__?: boolean }).__LODY_ELECTRON__ = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = undefined;
    }
    container?.remove();
    container = undefined;
    delete (window as Window & { __LODY_ELECTRON__?: boolean }).__LODY_ELECTRON__;
  });

  const text = '# Notes\n\nkept on devnuc';
  const notes = file({
    fileId: 'notes',
    fileName: 'notes.txt',
    mimeType: 'text/plain',
    sizeBytes: new TextEncoder().encode(text).byteLength,
    transport: 'local',
    machineId: 'devnuc',
  });

  // The local platform: nothing uploads a file, and there is no hosted token.
  const open = async (shown: SessionFilePayload) => {
    const store = createStore();
    store.set(currentWorkspaceIdAtom, 'lan-home' as WorkspaceId);
    await act(async () => {
      root?.render(
        createElement(
          PlatformContext.Provider,
          { value: { ...TEST_CLOUD_PLATFORM, kind: 'local', capabilities: new Set() } },
          createElement(
            Provider,
            { store },
            createElement(SessionFileGroup, {
              files: [shown],
              sessionId: 'session-1' as SessionId,
            })
          )
        )
      );
    });
    await act(async () => {
      container
        ?.querySelector<HTMLButtonElement>(`button[aria-label="${shown.fileName}"]`)
        ?.click();
    });
    return document.body;
  };

  it('reads the text from the machine that keeps it', async () => {
    const asked: ReadInput[] = [];
    readKeptFile = async (input) => {
      asked.push(input);
      return { ok: true, bytes: new TextEncoder().encode(text).buffer as ArrayBuffer };
    };

    const page = await open(notes);

    expect(asked).toEqual([
      expect.objectContaining({ machineId: 'devnuc', fileId: 'notes', sha256: notes.sha256 }),
    ]);
    expect(page.querySelector('pre')?.textContent).toBe(text);
  });

  it('says why when that machine cannot be reached', async () => {
    readKeptFile = async () => ({ ok: false, error: 'devnuc: connect ECONNREFUSED' });

    const page = await open(notes);

    expect(page.textContent).toContain('Could not load preview: devnuc: connect ECONNREFUSED');
    expect(page.querySelector('pre')).toBeNull();
  });
});

describe('audio and video a machine keeps', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(
      function (this: HTMLMediaElement) {
        Object.defineProperty(this, 'paused', { configurable: true, value: true });
      }
    );
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    (window as Window & { __LODY_ELECTRON__?: boolean }).__LODY_ELECTRON__ = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    vi.restoreAllMocks();
    delete (window as Window & { __LODY_ELECTRON__?: boolean }).__LODY_ELECTRON__;
  });

  const kept = (fileId: string, overrides: Partial<SessionFilePayload> = {}) =>
    file({
      fileId,
      fileName: `${fileId}.mp4`,
      mimeType: 'video/mp4',
      sizeBytes: 80_000_000,
      sha256: fileId.padEnd(64, '0'),
      textPreview: false,
      transport: 'local',
      machineId: 'devnuc',
      ...overrides,
    });

  /** Shows the files of a message; `uploads` is the hosted product, where a store has them. */
  const show = async (files: SessionFilePayload[], uploads = false) => {
    const store = createStore();
    store.set(currentWorkspaceIdAtom, 'lan-home' as WorkspaceId);
    await act(async () => {
      root?.render(
        createElement(
          PlatformContext.Provider,
          {
            value: uploads
              ? TEST_CLOUD_PLATFORM
              : { ...TEST_CLOUD_PLATFORM, kind: 'local', capabilities: new Set() },
          },
          createElement(
            Provider,
            { store },
            createElement(SessionFileGroup, { files, sessionId: 'session-1' as SessionId })
          )
        )
      );
    });
    return container as HTMLDivElement;
  };

  it('plays where the message shows them, from a resource the desktop opens for the block', async () => {
    const asked: OpenInput[] = [];
    openMemberFile = async (input) => {
      asked.push(input);
      return { ok: true, url: `lody-resource://member/${input.fileId}`, sizeBytes: 1 };
    };

    const view = await show([
      kept('clip'),
      kept('voice', { fileName: 'voice.m4a', mimeType: 'audio/mp4' }),
      kept('notes', { fileName: 'notes.bin', mimeType: 'application/octet-stream' }),
    ]);

    expect(asked).toEqual([
      {
        workspaceId: 'lan-home',
        machineId: 'devnuc',
        sessionId: 'session-1',
        fileId: 'clip',
        mimeType: 'video/mp4',
      },
      expect.objectContaining({ fileId: 'voice', mimeType: 'audio/mp4' }),
    ]);
    const video = view.querySelector('video');
    const audio = view.querySelector('audio');
    expect(video?.getAttribute('src')).toBe('lody-resource://member/clip');
    expect(audio?.getAttribute('src')).toBe('lody-resource://member/voice');
    for (const player of [video, audio]) {
      expect(player?.controls).toBe(true);
      expect(player?.autoplay).toBe(false);
      expect(player?.preload).toBe('metadata');
    }
    for (const [player, name] of [
      [video, 'clip.mp4'],
      [audio, 'voice.m4a'],
    ] as const) {
      const card = player?.closest('[data-testid="session-media-card"]');
      expect(card?.textContent).toContain(name);
      expect(card?.querySelectorAll('button')).toHaveLength(1);
    }
    // The same card names the file, says where it is kept, and downloads it.
    expect(view.textContent?.split('clip.mp4')).toHaveLength(2);
    expect(video?.getAttribute('aria-label')).toBe('Video preview');
    expect(audio?.getAttribute('aria-label')).toBe('Audio preview');
    expect(view.textContent).toContain('voice.m4a');
    expect(view.textContent).toContain('On devnuc');
  });

  it('leaves the card alone when no resource opens, and where a store has the file', async () => {
    const asked: string[] = [];
    openMemberFile = async (input) => {
      asked.push(input.fileId);
      return { ok: false, error: 'devnuc gives no part of a file' };
    };

    const view = await show([kept('old-member')]);
    expect(view.querySelector('video')).toBeNull();
    expect(view.textContent).toContain('old-member.mp4');

    await show([kept('uploading')], true);
    await show([kept('uploaded', { transport: 'r2', machineId: undefined })]);
    expect(asked).toEqual(['old-member']);
  });

  it.each([
    ['video', 'mkv', 'Video'],
    ['audio', 'wav', 'Audio'],
  ])('keeps one downloadable card after %s playback fails', async (kind, ext, label) => {
    openMemberFile = async (input) => ({
      ok: true,
      url: `lody-resource://member/${input.fileId}`,
      sizeBytes: 1,
    });
    const view = await show([kept(`odd-codec-${ext}`, { fileName: `odd-codec.${ext}` })]);
    const player = view.querySelector<HTMLMediaElement>(kind)!;
    expect(player).not.toBeNull();
    const card = player.closest('[data-testid="session-media-card"]');

    await act(async () => {
      player.dispatchEvent(new Event('error'));
    });

    expect(view.querySelector('video')).toBeNull();
    expect(view.textContent?.split(`odd-codec.${ext}`)).toHaveLength(2);
    expect(card?.textContent).toContain(`${label} unavailable`);
    expect(card?.textContent).toContain(`odd-codec.${ext}`);
    expect(player.hasAttribute('src')).toBe(false);
    expect(view.querySelectorAll('button')).toHaveLength(1);
    const downloaded: string[] = [];
    readKeptFile = async (input) => {
      downloaded.push(input.fileId);
      return { ok: false, error: 'synthetic download boundary' };
    };
    await act(async () => view.querySelector('button')!.click());
    expect(downloaded).toEqual([`odd-codec-${ext}`]);
  });
  it.each([
    ['video', 'webm'],
    ['audio', 'wav'],
  ])('reopens a failed member %s URL after the attachment remounts', async (kind, extension) => {
    const urls = ['lody-resource://member/expired', 'lody-resource://member/renewed'];
    openMemberFile = async () => ({ ok: true, url: urls.shift()!, sizeBytes: 1 });
    const attachment = kept(`renew-${extension}`, { fileName: `renew.${extension}` });
    const view = await show([attachment]);
    expect(view.querySelector(kind)?.getAttribute('src')).toBe('lody-resource://member/expired');
    // A healthy virtualized remount reuses the URL.
    await show([]);
    await show([attachment]);
    const player = view.querySelector(kind)!;
    expect(player.getAttribute('src')).toBe('lody-resource://member/expired');
    await act(async () => player.dispatchEvent(new Event('error')));
    expect(view.querySelector(kind)).toBeNull();
    expect(view.querySelector('[data-testid="session-file-error-state"]')).not.toBeNull();
    await show([]);
    await show([attachment]);
    expect(view.querySelector(kind)?.getAttribute('src')).toBe('lody-resource://member/renewed');
    expect(view.querySelector('[data-testid="session-file-error-state"]')).toBeNull();
  });
});

describe('the images of one turn in the viewer', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let nextUrl = 0;
  const sessionId = 'gallery-session' as SessionId;

  beforeEach(async () => {
    await initI18n('en');
    (window as Window & { __LODY_ELECTRON__?: boolean }).__LODY_ELECTRON__ = true;
    URL.createObjectURL = () => `blob:gallery-${(nextUrl += 1)}`;
    URL.revokeObjectURL = () => {};
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
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = undefined;
    }
    container?.remove();
    container = undefined;
    vi.unstubAllGlobals();
    delete (window as Window & { __LODY_ELECTRON__?: boolean }).__LODY_ELECTRON__;
  });

  const picture = (fileId: string, overrides: Partial<SessionFilePayload> = {}) =>
    file({
      fileId,
      fileName: `${fileId}.png`,
      mimeType: 'image/png',
      sizeBytes: 2048,
      sha256: fileId.padEnd(64, '0'),
      textPreview: false,
      transport: 'local',
      machineId: 'devnuc',
      ...overrides,
    });

  // One turn: the user's picture, then an answer whose work holds a picture, a
  // tool call that returned one, and a large one. A second turn has its own.
  // What a row has expanded outlives a test by message id, so each history names its own.
  const history = (prefix: string) => [
    {
      id: `${prefix}-user-1`,
      role: 'user',
      timestamp: '2026-10-13T00:00:00Z',
      items: [picture(`${prefix}-asked`), { type: 'text', text: 'What is on this?' }],
    },
    {
      id: `${prefix}-assistant-1`,
      role: 'assistant',
      userTurnId: `${prefix}-user-1`,
      timestamp: '2026-10-13T00:00:01Z',
      items: [
        picture(`${prefix}-first`),
        {
          type: 'tool_call',
          toolCallId: `${prefix}-shot`,
          title: 'Take a screenshot',
          kind: 'other',
          status: 'completed',
          content: [
            { type: 'content', content: { type: 'text', text: 'done' } },
            { type: 'content', content: { type: 'image', data: 'QUJD', mimeType: 'image/png' } },
          ],
        },
        picture(`${prefix}-second`),
        picture(`${prefix}-large`, { sizeBytes: 12 * 1024 * 1024 }),
        { type: 'text', text: 'Here they are.' },
      ],
      fileDiff: [],
      finished: true,
    },
    {
      id: `${prefix}-user-2`,
      role: 'user',
      timestamp: '2026-10-13T00:01:00Z',
      items: [{ type: 'text', text: 'One more.' }],
    },
    {
      id: `${prefix}-assistant-2`,
      role: 'assistant',
      userTurnId: `${prefix}-user-2`,
      timestamp: '2026-10-13T00:01:01Z',
      items: [picture(`${prefix}-later`), { type: 'text', text: 'Done.' }],
      fileDiff: [],
      finished: true,
    },
  ];

  const show = async (turns: Array<{ id: string }>) => {
    const store = createStore();
    store.set(currentWorkspaceIdAtom, 'lan-home' as WorkspaceId);
    const view = createConversationViewFromHistory({
      sessionId,
      getHistory: () => turns as never,
      subscribe: () => () => {},
    });
    const { items } = buildChatStreamItems(view, sessionId);
    view.dispose();
    await act(async () => {
      root?.render(
        createElement(
          PlatformContext.Provider,
          { value: { ...TEST_CLOUD_PLATFORM, kind: 'local', capabilities: new Set() } },
          createElement(
            Provider,
            { store },
            createElement(SessionChatStreamView, {
              items,
              sessionId,
              lastAssistantMessageId: turns[turns.length - 1]!.id,
              renderMessageRow: ({ message, sessionId: id }) =>
                createElement(MessageRowView, { message, sessionId: id }),
            })
          )
        )
      );
    });
    // Each thumbnail on the page decodes, which turns its placeholder into a button.
    await act(async () => {
      container
        ?.querySelectorAll('img')
        .forEach((thumbnail) => thumbnail.dispatchEvent(new Event('load')));
    });
  };

  const thumbnail = (name: string) =>
    container?.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  const viewer = () => document.body.querySelector<HTMLElement>('[role="dialog"][aria-modal]');
  const counter = () => viewer()?.querySelector('.PhotoView-Slider__Counter')?.textContent;
  const photos = () =>
    Array.from(
      viewer()?.querySelectorAll<HTMLImageElement>('img.lody-photo-slider-image') ?? []
    ).map((photo) => photo.getAttribute('src'));
  const press = async (key: string) => {
    await act(async () => {
      viewer()?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  };

  const reads = (answer: (fileId: string) => ReadResult = () => ok) => {
    const asked: string[] = [];
    readKeptFile = async (input) => {
      asked.push(input.fileId);
      return answer(input.fileId);
    };
    return asked;
  };
  const ok: ReadResult = { ok: true, bytes: new Uint8Array([1]).buffer };
  const open = async (name: string) => {
    await act(async () => {
      thumbnail(name)?.click();
    });
  };

  it('steps through them in the order the conversation shows them, reading as it goes', async () => {
    const asked = reads();
    await show(history('order'));
    await open('order-second.png');

    // The user's picture, the first of the answer, the tool call's, this one, the large one.
    expect(counter()).toBe('4 / 5');
    // Beside it: the tool call's picture, and the large one, which waits to be reached.
    expect(photos()).toEqual(['data:image/png;base64,QUJD', expect.stringMatching(/^blob:/)]);
    expect(asked).not.toContain('order-large');

    await press('ArrowRight');
    expect(counter()).toBe('5 / 5');
    expect(asked.filter((fileId) => fileId === 'order-large')).toEqual(['order-large']);
    expect(photos()).toHaveLength(2);

    await press('ArrowLeft');
    await press('ArrowLeft');
    await press('ArrowLeft');
    expect(counter()).toBe('2 / 5');
    expect(photos()).toHaveLength(3);
    // Every picture was read once, however often the viewer passed it.
    expect([...asked].sort()).toEqual(
      ['order-asked', 'order-first', 'order-large', 'order-later', 'order-second'].sort()
    );
  });

  const click = async (find: () => HTMLElement | null | undefined) => {
    await act(async () => {
      find()?.click();
    });
  };
  const labelled = (text: string) =>
    Array.from(container?.querySelectorAll<HTMLElement>('button, [role="button"]') ?? []).find(
      (candidate) => candidate.textContent?.includes(text)
    );
  const toolPictures = () =>
    Array.from(container?.querySelectorAll<HTMLElement>('img[alt="Generated image"]') ?? []);

  it('opens a picture a tool call returned among the others of its turn', async () => {
    reads();
    const turns = history('tool');
    // Still running, so the work of the turn is laid out rather than folded.
    turns[1] = { ...turns[1], finished: false };
    await show(turns);

    await click(() => labelled('Called 1 tool'));
    await click(() => labelled('Take a screenshot'));
    await click(() => toolPictures()[0]?.closest('button'));

    expect(counter()).toBe('3 / 5');
    expect(photos()).toContain('data:image/png;base64,QUJD');
  });

  it('stays on a tool call picture when the call puts a block ahead of it', async () => {
    reads();
    const capture = (type: string, value: string) =>
      type === 'text'
        ? { type: 'content', content: { type: 'text', text: value } }
        : { type: 'content', content: { type: 'image', data: value, mimeType: 'image/png' } };
    // The running call's content is a list the agent replaces as it goes.
    const turns = (content: unknown[]) => {
      const all = history('moved');
      const answer = all[1] as { items: unknown[] };
      all[1] = {
        ...answer,
        finished: false,
        items: answer.items.map((item) =>
          (item as { type: string }).type === 'tool_call' ? { ...(item as object), content } : item
        ),
      } as (typeof all)[number];
      return all;
    };
    await show(turns([capture('image', 'QUJD'), capture('image', 'REVG')]));

    await click(() => labelled('Called 1 tool'));
    await click(() => labelled('Take a screenshot'));
    await click(() => toolPictures()[1]?.closest('button'));
    expect(counter()).toBe('4 / 6');

    await show(
      turns([capture('text', 'Two captures.'), capture('image', 'QUJD'), capture('image', 'REVG')])
    );

    // Still the second capture, with the first one before it.
    expect(counter()).toBe('4 / 6');
    expect(photos()).toEqual([
      'data:image/png;base64,QUJD',
      'data:image/png;base64,REVG',
      expect.stringMatching(/^blob:/),
    ]);
  });

  it('keeps the pictures of another turn out', async () => {
    reads();
    await show(history('apart'));

    await open('apart-later.png');

    expect(counter()).toBe('1 / 1');
    expect(viewer()?.querySelector('button[aria-label="Next image"]')).toBeNull();
    expect(photos()).toEqual([expect.stringMatching(/^blob:/)]);
  });

  it('says why a picture could not be read, and still steps on', async () => {
    const asked = reads((fileId) =>
      fileId === 'lost-large' ? { ok: false, error: 'devnuc: file_not_found' } : ok
    );
    await show(history('lost'));

    await open('lost-second.png');
    await press('ArrowRight');

    expect(counter()).toBe('5 / 5');
    expect(viewer()?.textContent).toContain('Image could not be loaded: devnuc: file_not_found');

    await press('ArrowRight');
    expect(counter()).toBe('1 / 5');
    expect(viewer()?.textContent).not.toContain('Image could not be loaded');

    // Passing beside it asks nothing; stopping on it again does.
    await press('ArrowRight');
    await press('ArrowRight');
    await press('ArrowRight');
    expect(counter()).toBe('4 / 5');
    expect(asked.filter((fileId) => fileId === 'lost-large')).toHaveLength(1);
    await press('ArrowRight');
    expect(asked.filter((fileId) => fileId === 'lost-large')).toHaveLength(2);
  });
});
