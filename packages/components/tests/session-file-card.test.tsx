// @vitest-environment jsdom

// The card's second action exists for exactly one gap: an HTML attachment's
// click opens the RENDERED page, so without it the uploaded source bytes have
// no route at all. Every other previewable file downloads from inside the
// preview dialog and must NOT grow a duplicate control.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerNow, type SessionFilePayload } from '@lody/shared';

import { SessionFileCard } from '../src/components/ai-gui/session-file-card';
import {
  isKeptImageFile,
  SessionKeptImageFile,
} from '../src/components/ai-gui/session-local-image-file';
import { SESSION_FILE_RETENTION_MS } from '../src/lib/session-file-presentation';
import { initI18n } from '../src/i18n';

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
vi.mock('../src/lib/electron-ipc-client', () => ({
  getIpcServices: () => ({
    localProjects: { readSessionFileLocal: (input: ReadInput) => readKeptFile(input) },
  }),
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
