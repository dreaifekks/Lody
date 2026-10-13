import { memo, useEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  frame: {
    display: 'flex',
    height: '100%',
    minHeight: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: '12px',
  },
  video: { maxWidth: '100%', maxHeight: '100%', backgroundColor: '#000' },
  audio: { width: '100%', maxWidth: '28rem' },
});

interface SessionFileMediaPreviewProps {
  readonly kind: 'audio' | 'video';
  readonly path: string;
  /** Bytes a bounded preview brought; played from an object URL. */
  readonly bytes?: Uint8Array;
  /** A resource URL, read in ranges as the player asks for them. */
  readonly url?: string;
  /** The player could not play it: a format or a file it cannot read. */
  readonly onError: () => void;
}

/**
 * Plays an audio or a video file with the platform's own controls. Nothing
 * plays until the user starts it; only what the player needs to show its
 * length and first frame is read before that.
 */
export const SessionFileMediaPreview = memo(function SessionFileMediaPreview({
  kind,
  path,
  bytes,
  url,
  onError,
}: SessionFileMediaPreviewProps) {
  const [objectUrl, setObjectUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (url || !bytes || bytes.byteLength === 0) {
      setObjectUrl(undefined);
      return undefined;
    }
    const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(bytes)]));
    setObjectUrl(blobUrl);
    return () => URL.revokeObjectURL(blobUrl);
  }, [bytes, url]);

  const source = url ?? objectUrl;
  if (!source) return null;
  return (
    <div {...stylex.props(styles.frame)}>
      {kind === 'video' ? (
        <video
          key={source}
          src={source}
          controls
          playsInline
          preload="metadata"
          aria-label={path}
          onError={onError}
          {...stylex.props(styles.video)}
        />
      ) : (
        <audio
          key={source}
          src={source}
          controls
          preload="metadata"
          aria-label={path}
          onError={onError}
          {...stylex.props(styles.audio)}
        />
      )}
    </div>
  );
});
