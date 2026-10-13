// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

import { SessionFileBinaryPreview } from '../src/components/sessions/session-file-binary-preview';
import {
  getOfficePreviewKind,
  MAX_OFFICE_PREVIEW_BYTES,
  OfficePreviewTooLargeError,
  readOfficePreviewBytes,
} from '../src/lib/session-file-office-source';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('SessionFileBinaryPreview', () => {
  it('opens PDFs in the paged document viewer', () => {
    const markup = renderToStaticMarkup(
      createElement(SessionFileBinaryPreview, {
        path: '/workspace/Report.PDF',
        bytes: Uint8Array.of(1),
      })
    );

    expect(markup).toContain('aria-label="PDF viewer"');
    expect(markup).toContain('aria-label="Previous page"');
    expect(markup).toContain('aria-label="Pages sidebar"');
    expect(markup).toContain('aria-label="Search document"');
    expect(markup).not.toContain('This binary file cannot be previewed.');
  });

  it('keeps other binary files on the existing notice path', () => {
    const markup = renderToStaticMarkup(
      createElement(SessionFileBinaryPreview, {
        path: '/workspace/archive.zip',
        url: 'lody-resource://file/archive',
      })
    );

    expect(markup).toContain('This binary file cannot be previewed.');
  });

  it.each([
    ['video', 'recordings/demo.MP4', '<video'],
    ['audio', 'recordings/voice.m4a', '<audio'],
  ])(
    'plays a %s file from its resource with the player controls, not by itself',
    (_k, path, tag) => {
      const markup = renderToStaticMarkup(
        createElement(SessionFileBinaryPreview, { path, url: 'lody-resource://member/clip' })
      );

      expect(markup).toContain(tag);
      expect(markup).toContain('src="lody-resource://member/clip"');
      expect(markup).toContain('controls=""');
      expect(markup).toContain('preload="metadata"');
      expect(markup).not.toContain('autoplay');
      expect(markup).not.toContain('This binary file cannot be previewed.');
    }
  );

  it('pauses a player whose panel leaves the screen, and keeps what it was playing', async () => {
    const paused = new Set<Element>();
    const pause = vi
      .spyOn(HTMLMediaElement.prototype, 'pause')
      .mockImplementation(function (this: HTMLMediaElement) {
        paused.add(this);
      });
    const container = document.createElement('div');
    const root = createRoot(container);
    const show = async (active: boolean) => {
      await act(async () => {
        root.render(
          createElement(SessionFileBinaryPreview, {
            path: 'recordings/demo.mp4',
            url: 'lody-resource://member/clip',
            active,
          })
        );
      });
      return container.querySelector('video');
    };

    const video = await show(true);
    expect(video).not.toBeNull();
    expect(paused.size).toBe(0);
    const hidden = await show(false);

    // The same player with the same source: its place in the file is kept.
    expect(hidden).toBe(video);
    expect(hidden?.getAttribute('src')).toBe('lody-resource://member/clip');
    expect(video && paused.has(video)).toBe(true);
    await act(async () => root.unmount());
    pause.mockRestore();
  });

  it('keeps a media file nothing was read of on the notice, with a download where one is offered', () => {
    const markup = renderToStaticMarkup(
      createElement(SessionFileBinaryPreview, {
        path: 'recordings/demo.mp4',
        fileActions: { onCopyPath: () => {}, onDownload: () => {} },
      })
    );

    expect(markup).not.toContain('<video');
    expect(markup).toContain('This binary file cannot be previewed.');
    expect(markup).toContain('Download file');
    expect(
      renderToStaticMarkup(
        createElement(SessionFileBinaryPreview, {
          path: 'archive.zip',
          fileActions: { onCopyPath: () => {} },
        })
      )
    ).not.toContain('Download file');
  });

  it.each(['docx', 'xlsx', 'pptx'])('routes %s files into the lazy office preview', (extension) => {
    const markup = renderToStaticMarkup(
      createElement(SessionFileBinaryPreview, {
        path: `/workspace/report.${extension}`,
        bytes: Uint8Array.of(1),
      })
    );

    expect(markup).toContain('Loading document…');
    expect(markup).not.toContain('This binary file cannot be previewed.');
  });
});

describe('office preview source', () => {
  it('recognizes supported extensions without promoting legacy or unrelated files', () => {
    expect(getOfficePreviewKind('/workspace/Report.XLSX')).toBe('xlsx');
    expect(getOfficePreviewKind('presentation.pptx?version=1')).toBe('pptx');
    expect(getOfficePreviewKind('archive.zip')).toBeNull();
    expect(getOfficePreviewKind('legacy.doc')).toBeNull();
  });

  it('reads only complete bounded preview bytes', async () => {
    const fetched = await readOfficePreviewBytes({
      url: 'lody-resource://file/workbook',
      signal: new AbortController().signal,
      fetcher: async () => new Response(Uint8Array.of(80, 75, 3, 4)),
    });
    expect(new Uint8Array(fetched)).toEqual(Uint8Array.of(80, 75, 3, 4));

    await expect(
      readOfficePreviewBytes({
        url: 'lody-resource://file/oversized',
        signal: new AbortController().signal,
        fetcher: async () =>
          new Response(Uint8Array.of(1), {
            headers: { 'Content-Length': String(MAX_OFFICE_PREVIEW_BYTES + 1) },
          }),
      })
    ).rejects.toBeInstanceOf(OfficePreviewTooLargeError);
  });

  it('rejects a cancelled read before it opens a resource', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readOfficePreviewBytes({
        url: 'lody-resource://file/cancelled',
        signal: controller.signal,
        fetcher: async () => {
          throw new Error('A cancelled preview must not open a resource.');
        },
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
