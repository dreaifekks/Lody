import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space } from '@lody/ui/tokens/scales.stylex';
import { SESSION_IMAGE_ALLOWED_MIME_TYPES, type SessionFilePayload } from '@lody/shared';
import { ZoomableImageViewer } from '@/components/shared/zoomable-image-viewer';
import { canUseElectronLocalFileSend } from '@/lib/electron-session-file-sender';
import { getIpcServices } from '@/lib/electron-ipc-client';

/**
 * Without a store every device reads from, an image a message carries is a
 * file block that one machine keeps: this desktop's, or another member of a
 * LAN. It is still shown as an image, read through the agent service of this
 * machine, which fetches it from the member that keeps it. Up to
 * `AUTO_LOAD_MAX_BYTES` that happens on sight; a larger one waits for a click.
 */
const AUTO_LOAD_MAX_BYTES = 10 * 1024 * 1024;
/** What the page keeps of read images, so a remounted row does not read again. */
const CACHE_MAX_BYTES = 256 * 1024 * 1024;
/** The box an image is shown in, as the image blocks of a message are. */
const IMAGE_MAX_WIDTH_PX = 320;
const IMAGE_MAX_HEIGHT_PX = 168;

type Size = { width: number; height: number };

const shownSize = (size: Size): Size => {
  const scale = Math.min(1, IMAGE_MAX_WIDTH_PX / size.width, IMAGE_MAX_HEIGHT_PX / size.height);
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
};

const styles = stylex.create({
  frame: {
    display: 'inline-flex',
    maxWidth: '100%',
    overflow: 'hidden',
    borderRadius: radius.large,
    cornerShape: corner.shape,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    padding: 0,
    backgroundColor: 'transparent',
    cursor: 'zoom-in',
  },
  image: {
    display: 'block',
    // IMAGE_MAX_HEIGHT_PX and IMAGE_MAX_WIDTH_PX, spelled out for the compiler.
    maxHeight: 168,
    maxWidth: 'min(100%, 320px)',
    objectFit: 'contain',
  },
  pending: { display: 'none' },
  placeholder: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '14rem',
    maxWidth: '100%',
    height: '9rem',
    borderRadius: radius.large,
    cornerShape: corner.shape,
    backgroundColor: colors.wellBackground,
  },
  column: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: space[1] },
  actions: { display: 'flex', alignItems: 'center', gap: space[2], maxWidth: '24rem' },
  error: {
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    color: colors.destructive,
    fontSize: '0.8em',
  },
});

type Cached = { bytes: number; size?: Size };
const cache = new Map<string, Cached & { promise: Promise<Blob> }>();

const cacheKey = (file: SessionFilePayload) => `${file.machineId}\0${file.fileId}\0${file.sha256}`;

function readImage(file: SessionFilePayload, workspaceId: string, sessionId: string) {
  const key = cacheKey(file);
  const hit = cache.get(key);
  if (hit) {
    // Most recently used last, so eviction takes the oldest first.
    cache.delete(key);
    cache.set(key, hit);
    return hit.promise;
  }
  const entry: Cached & { promise: Promise<Blob> } = {
    bytes: file.sizeBytes,
    promise: (async () => {
      const ipc = getIpcServices();
      if (!ipc) throw new Error('unavailable');
      const result = await ipc.localProjects.readSessionFileLocal({
        workspaceId,
        sessionId,
        machineId: file.machineId!,
        fileId: file.fileId,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
      });
      if (!result.ok) throw new Error(result.error);
      return new Blob([result.bytes], { type: file.mimeType });
    })(),
  };
  entry.promise.catch(() => {
    // A failure is not kept: the next attempt reads again.
    if (cache.get(key) === entry) cache.delete(key);
  });
  cache.set(key, entry);
  let total = 0;
  for (const cached of cache.values()) total += cached.bytes;
  for (const [oldKey, oldest] of cache) {
    if (total <= CACHE_MAX_BYTES || oldKey === key) break;
    cache.delete(oldKey);
    total -= oldest.bytes;
  }
  return entry.promise;
}

/** Whether a file block is an image this desktop can read from the machine that keeps it. */
export const isKeptImageFile = (file: SessionFilePayload): boolean =>
  file.transport === 'local' &&
  !!file.machineId &&
  (SESSION_IMAGE_ALLOWED_MIME_TYPES as readonly string[]).includes(file.mimeType) &&
  canUseElectronLocalFileSend();

type State =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error'; message: string };

export function SessionKeptImageFile({
  file,
  workspaceId,
  sessionId,
  card,
}: {
  file: SessionFilePayload;
  workspaceId: string;
  sessionId: string;
  /** The file card, shown until the image is there. */
  card: ReactNode;
}) {
  const { t } = useTranslation();
  const key = cacheKey(file);
  const cached = cache.get(key);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>({ status: 'idle' });
  const [decoded, setDecoded] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const automatic = file.sizeBytes <= AUTO_LOAD_MAX_BYTES || cached !== undefined;

  useEffect(() => {
    if (!automatic && attempt === 0) return undefined;
    let cancelled = false;
    let objectUrl: string | undefined;
    setDecoded(false);
    setState({ status: 'loading' });
    readImage(file, workspaceId, sessionId).then(
      (blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ status: 'ready', url: objectUrl });
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: error instanceof Error ? error.message : '' });
      }
    );
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // The block's identity is its key; a new object for the same file reads nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, workspaceId, sessionId, automatic, attempt]);

  // Known once the image was shown on this page: a remounted row keeps its height.
  const size = cached?.size ? shownSize(cached.size) : undefined;
  if (state.status === 'ready') {
    return (
      <div ref={anchorRef}>
        {!decoded ? <div {...stylex.props(styles.placeholder)} style={size} /> : null}
        <button
          type="button"
          aria-label={file.fileName}
          title={file.fileName}
          onClick={() => setViewerOpen(true)}
          {...stylex.props(styles.frame, !decoded && styles.pending)}
        >
          <img
            src={state.url}
            alt={file.fileName}
            {...(size ? { width: size.width, height: size.height } : {})}
            {...stylex.props(styles.image)}
            onLoad={(event) => {
              const entry = cache.get(key);
              if (entry) {
                const image = event.currentTarget;
                entry.size = { width: image.naturalWidth, height: image.naturalHeight };
              }
              setDecoded(true);
            }}
            onError={() =>
              setState({
                status: 'error',
                message: t('sessions.markdownImage.unsupported', 'Unsupported image format'),
              })
            }
          />
        </button>
        <ZoomableImageViewer
          open={viewerOpen}
          onClose={() => setViewerOpen(false)}
          images={[{ key, src: state.url, fileName: file.fileName }]}
          index={0}
          portalAnchorRef={anchorRef}
        />
      </div>
    );
  }

  if (state.status === 'loading' || (automatic && state.status === 'idle')) {
    return (
      <div aria-busy {...stylex.props(styles.placeholder)} style={size}>
        <Spinner size="small" label={t('sessions.markdownImage.loading', 'Loading image…')} />
      </div>
    );
  }

  return (
    <div {...stylex.props(styles.column)}>
      {card}
      <div {...stylex.props(styles.actions)}>
        {state.status === 'error' ? (
          <span role="status" title={state.message} {...stylex.props(styles.error)}>
            {t('sessions.markdownImage.failed', 'Image could not be loaded')}
            {state.message ? `: ${state.message}` : ''}
          </span>
        ) : null}
        <Button size="small" variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
          {state.status === 'error'
            ? t('sessions.markdownImage.retry', 'Retry')
            : t('sessions.markdownImage.load', 'Load image')}
        </Button>
      </div>
    </div>
  );
}
