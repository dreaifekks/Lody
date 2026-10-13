import { useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import type { ZoomableImageViewerItem } from '@/components/shared/zoomable-image-viewer';
import type { SessionGalleryEntry, SessionToolImage } from '@/lib/session-image-gallery';
import { loadsKeptImageOnSight, readKeptImage } from './session-local-image-file';

type KeptImage = { src?: string; error?: string };

const NO_KEPT_IMAGES: ReadonlyMap<string, KeptImage> = new Map();

/**
 * The file blocks of an open gallery, read as the viewer reaches them: the one
 * shown, and a neighbour when the conversation would read it unasked. A read
 * that failed is tried again only when the viewer stops on that image again.
 */
function useKeptGalleryImages(
  entries: ReadonlyArray<SessionGalleryEntry>,
  activeIndex: number,
  open: boolean
): ReadonlyMap<string, KeptImage> {
  const { t } = useTranslation();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const [images, setImages] = useState(NO_KEPT_IMAGES);
  const opened = useRef<{
    urls: Map<string, string>;
    index: number;
    asked: Set<string>;
    failed: Set<string>;
  } | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const own = {
      urls: new Map<string, string>(),
      index: -1,
      asked: new Set<string>(),
      failed: new Set<string>(),
    };
    opened.current = own;
    return () => {
      opened.current = null;
      for (const url of own.urls.values()) URL.revokeObjectURL(url);
      setImages(NO_KEPT_IMAGES);
    };
  }, [open]);

  useEffect(() => {
    const own = opened.current;
    if (!own || activeIndex === -1 || !workspaceId) return;
    // A turn still running hands over a new list on every change: one read per
    // image for each place the viewer stops at, not one per list.
    if (own.index !== activeIndex) {
      own.index = activeIndex;
      own.asked.clear();
    }
    const show = (key: string, image: KeptImage | undefined) =>
      setImages((shown) => {
        if (!image && !shown.has(key)) return shown;
        const next = new Map(shown);
        if (image) next.set(key, image);
        else next.delete(key);
        return next;
      });
    for (const index of [activeIndex - 1, activeIndex, activeIndex + 1]) {
      const entry = entries[index];
      if (!entry || !('file' in entry)) continue;
      const { key, file } = entry;
      if (own.urls.has(key) || own.asked.has(key)) continue;
      if (index !== activeIndex && (own.failed.has(key) || !loadsKeptImageOnSight(file))) continue;
      own.asked.add(key);
      show(key, undefined);
      readKeptImage(file, workspaceId, entry.sessionId).then(
        (blob) => {
          if (opened.current !== own || own.urls.has(key)) return;
          const url = URL.createObjectURL(blob);
          own.failed.delete(key);
          own.urls.set(key, url);
          show(key, { src: url });
        },
        (error: unknown) => {
          if (opened.current !== own) return;
          own.failed.add(key);
          const failed = t('sessions.markdownImage.failed', 'Image could not be loaded');
          const reason = error instanceof Error ? error.message : '';
          show(key, { error: reason ? `${failed}: ${reason}` : failed });
        }
      );
    }
  }, [activeIndex, entries, open, t, workspaceId]);

  return images;
}

/**
 * What the viewer shows for a turn's gallery. Uploaded images arrive in
 * `uploadedUrls`; file blocks are read here; a tool call's picture is its own
 * source, spelled out only within reach of the one shown.
 */
export function useSessionGalleryViewerImages(
  entries: ReadonlyArray<SessionGalleryEntry>,
  activeIndex: number,
  open: boolean,
  uploadedUrls: ReadonlyMap<string, string>,
  toolImageSrc: (image: SessionToolImage) => string | undefined
): ZoomableImageViewerItem[] {
  const { t } = useTranslation();
  const keptImages = useKeptGalleryImages(entries, activeIndex, open);

  return useMemo(
    () =>
      entries.map((entry, index): ZoomableImageViewerItem => {
        if ('file' in entry) {
          const kept = keptImages.get(entry.key);
          return {
            key: entry.key,
            src: kept?.src,
            error: kept?.error,
            fileName: entry.file.fileName,
          };
        }
        if ('toolImage' in entry) {
          if (Math.abs(index - activeIndex) > 1) return { key: entry.key, src: undefined };
          const src = toolImageSrc(entry.toolImage);
          return {
            key: entry.key,
            src,
            error: src
              ? undefined
              : t('sessions.markdownImage.failed', 'Image could not be loaded'),
          };
        }
        return { key: entry.key, src: uploadedUrls.get(entry.key), fileName: entry.fileName };
      }),
    [activeIndex, entries, keptImages, t, toolImageSrc, uploadedUrls]
  );
}
