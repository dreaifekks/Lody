import { useEffect, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius } from '@lody/ui/tokens/scales.stylex';
import type { SessionFilePayload } from '@lody/shared';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { getSessionFileKind } from '@/lib/session-file-presentation';
import { isReadableKeptFile } from './session-local-image-file';

/**
 * An audio or a video file a machine keeps is played where the message shows
 * it. The desktop gets a resource URL for the block from its shell, and the
 * player reads the file through it in ranges, from the agent service of this
 * machine or, through it, from the member of a LAN that keeps the file. Only
 * what the player needs for the length and the first frame is read before the
 * user starts it.
 */
const styles = stylex.create({
  video: {
    display: 'block',
    // One height whatever the video's shape, so the row does not move once
    // its first frame is there.
    height: '13.5rem',
    width: 'min(100%, 24rem)',
    borderRadius: radius.large,
    cornerShape: corner.shape,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    backgroundColor: '#000',
    objectFit: 'contain',
  },
  audio: { display: 'block', width: 'min(100%, 24rem)' },
});

const mediaKindOf = (file: SessionFilePayload): 'audio' | 'video' | null => {
  const kind = getSessionFileKind(file.fileName, file.mimeType);
  return kind === 'audio' || kind === 'video' ? kind : null;
};

/** Whether a file block is audio or video this desktop can read from the machine that keeps it. */
export const isKeptMediaFile = (file: SessionFilePayload): boolean =>
  isReadableKeptFile(file) && mediaKindOf(file) !== null;

/** Resource URLs this page was given, so a remounted row shows its player at once. */
const opened = new Map<string, string>();

const resourceKey = (file: SessionFilePayload, sessionId: string) =>
  `${file.machineId}\0${sessionId}\0${file.fileId}\0${file.sha256}`;

export function SessionKeptMediaFile({
  file,
  workspaceId,
  sessionId,
  card,
}: {
  file: SessionFilePayload;
  workspaceId: string;
  sessionId: string;
  /** The file card: it names the file and downloads it, beside the player. */
  card: ReactNode;
}) {
  const key = resourceKey(file, sessionId);
  const kind = mediaKindOf(file);
  const [url, setUrl] = useState(() => opened.get(key));

  useEffect(() => {
    const known = opened.get(key);
    setUrl(known);
    if (known || !file.machineId) return undefined;
    let cancelled = false;
    // A machine that gives no part of a file, or cannot be reached, leaves the card as it was.
    void getIpcServices()
      ?.machineRpc.openMemberFile({
        workspaceId,
        machineId: file.machineId,
        sessionId,
        fileId: file.fileId,
        mimeType: file.mimeType,
      })
      .then((resource) => {
        if (!resource.ok) return;
        opened.set(key, resource.url);
        if (!cancelled) setUrl(resource.url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // The block's identity is its key; a new object for the same file opens nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, workspaceId]);

  if (!url || !kind) return card;
  // A format the player cannot play, or a resource that ended, leaves the card.
  const drop = () => {
    if (opened.get(key) === url) opened.delete(key);
    setUrl(undefined);
  };
  return (
    <>
      {kind === 'video' ? (
        <video
          src={url}
          controls
          playsInline
          preload="metadata"
          aria-label={file.fileName}
          onError={drop}
          {...stylex.props(styles.video)}
        />
      ) : (
        <audio
          src={url}
          controls
          preload="metadata"
          aria-label={file.fileName}
          onError={drop}
          {...stylex.props(styles.audio)}
        />
      )}
      {card}
    </>
  );
}
