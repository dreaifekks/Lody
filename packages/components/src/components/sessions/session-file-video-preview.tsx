import * as stylex from '@stylexjs/stylex';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { space } from '@lody/ui/tokens/scales.stylex';
import type { SessionFileErrorActions } from '@/lib/session-file-actions';
import { getVideoMimeTypeForPath } from '@/lib/video-file-preview';
import { SessionFileNoticeCard } from './session-file-error-state';

interface SessionFileVideoPreviewProps {
  readonly path: string;
  readonly bytes?: Uint8Array;
  readonly url?: string;
  readonly active?: boolean;
  readonly compact?: boolean;
  readonly fileActions?: SessionFileErrorActions;
  readonly onError?: () => void;
}

const styles = stylex.create({
  frame: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    minHeight: 0,
    padding: space[3],
  },
  video: { width: '100%', maxHeight: '100%', objectFit: 'contain' },
  compactFrame: { width: '100%', height: 'auto', padding: 0, boxSizing: 'border-box' },
  compact: { display: 'block', height: 'auto', maxHeight: 'none' },
});

/** Only consumes provider-authorized sources; never resolves host file paths. */
export function SessionFileVideoPreview({
  path,
  bytes,
  url,
  active = true,
  compact = false,
  fileActions,
  onError,
}: SessionFileVideoPreviewProps) {
  const mimeType = getVideoMimeTypeForPath(path);
  const [source, setSource] = useState<{
    path: string;
    bytes?: Uint8Array;
    url?: string;
    src: string;
  }>();

  useEffect(() => {
    if (!active || (!mimeType && !url)) return undefined;
    const src =
      url ?? (bytes && URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: mimeType })));
    if (!src) return undefined;
    setSource({ path, bytes, url, src });
    return () => {
      setSource(undefined);
      if (!url) URL.revokeObjectURL(src);
    };
  }, [active, path, bytes, url, mimeType]);

  // Never mount a previous file's source while its replacement effect is pending.
  if (!active || !source || source.path !== path || source.bytes !== bytes || source.url !== url) {
    return null;
  }
  return (
    <VideoPlayback
      key={source.src}
      src={source.src}
      compact={compact}
      fileActions={fileActions}
      onError={onError}
    />
  );
}

function VideoPlayback({
  src,
  compact,
  fileActions,
  onError,
}: {
  readonly src: string;
  readonly compact: boolean;
  readonly fileActions?: SessionFileErrorActions;
  readonly onError?: () => void;
}) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    // Restore after React StrictMode replays setup/cleanup on the same element.
    video.setAttribute('src', src);
    const pauseWhenHidden = () => {
      if (document.hidden) video.pause();
    };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => {
      document.removeEventListener('visibilitychange', pauseWhenHidden);
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [failed, src]);

  if (failed) {
    return (
      <SessionFileNoticeCard
        compact={compact}
        presentation={{
          title: t('sessions.videoPreview.failedTitle', 'Video unavailable'),
          description: t(
            'sessions.videoPreview.failedMessage',
            'This video could not be played. Its format may not be supported on this device, or the file could not be read.'
          ),
        }}
        fileActions={fileActions}
      />
    );
  }

  return (
    <div {...stylex.props(styles.frame, compact && styles.compactFrame)}>
      <video
        ref={videoRef}
        {...stylex.props(styles.video, compact && styles.compact)}
        src={src}
        controls
        playsInline
        preload="metadata"
        aria-label={t('sessions.videoPreview.label', 'Video preview')}
        onError={() => {
          setFailed(true);
          onError?.();
        }}
      />
    </div>
  );
}
