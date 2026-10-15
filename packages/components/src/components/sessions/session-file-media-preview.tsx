import * as stylex from '@stylexjs/stylex';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { space } from '@lody/ui/tokens/scales.stylex';
import type { SessionFileErrorActions } from '@/lib/session-file-actions';
import { getAudioMimeTypeForPath } from '@/lib/video-file-preview';
import { SessionFileNoticeCard } from './session-file-error-state';

interface SessionFileAudioPreviewProps {
  readonly path: string;
  readonly bytes?: Uint8Array;
  readonly url?: string;
  readonly active?: boolean;
  readonly fileActions?: SessionFileErrorActions;
}

const styles = stylex.create({
  frame: {
    display: 'flex',
    width: '100%',
    boxSizing: 'border-box',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    minHeight: 0,
    padding: space[3],
  },
  audio: { width: '100%' },
});

/** Only consumes provider-authorized sources; never resolves host file paths. */
export function SessionFileAudioPreview({
  path,
  bytes,
  url,
  active = true,
  fileActions,
}: SessionFileAudioPreviewProps) {
  const mimeType = getAudioMimeTypeForPath(path);
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
  return <AudioPlayback key={source.src} src={source.src} fileActions={fileActions} />;
}

function AudioPlayback({
  src,
  fileActions,
}: {
  readonly src: string;
  readonly fileActions?: SessionFileErrorActions;
}) {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    // Restore after React StrictMode replays setup/cleanup on the same element.
    audio.setAttribute('src', src);
    const pauseWhenHidden = () => {
      if (document.hidden) audio.pause();
    };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => {
      document.removeEventListener('visibilitychange', pauseWhenHidden);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    };
  }, [failed, src]);

  if (failed) {
    return (
      <SessionFileNoticeCard
        presentation={{
          title: t('sessions.audioPreview.failedTitle', 'Audio unavailable'),
          description: t(
            'sessions.audioPreview.failedMessage',
            'This audio could not be played. Its format may not be supported on this device, or the file could not be read.'
          ),
        }}
        fileActions={fileActions}
      />
    );
  }

  return (
    <div {...stylex.props(styles.frame)}>
      <audio
        ref={audioRef}
        {...stylex.props(styles.audio)}
        src={src}
        controls
        preload="metadata"
        aria-label={t('sessions.audioPreview.label', 'Audio preview')}
        onError={() => setFailed(true)}
      />
    </div>
  );
}
