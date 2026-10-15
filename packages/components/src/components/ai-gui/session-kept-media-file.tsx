import { useEffect, useState, type ReactNode } from 'react';
import { SessionFileVideoPreview } from '../sessions/session-file-video-preview';
import { SessionFileAudioPreview } from '../sessions/session-file-media-preview';
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

export function SessionKeptMediaFile(props: Parameters<typeof KeptMediaResource>[0]) {
  return <KeptMediaResource key={resourceKey(props.file, props.sessionId)} {...props} />;
}

function KeptMediaResource({
  file,
  workspaceId,
  sessionId,
  renderCard,
}: {
  file: SessionFilePayload;
  workspaceId: string;
  sessionId: string;
  /** The file card owns the media, file information and download action. */
  renderCard: (media?: ReactNode) => ReactNode;
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

  if (!url || !kind) return renderCard();
  const forgetFailedUrl = () => {
    if (opened.get(key) === url) opened.delete(key);
  };
  return renderCard(
    kind === 'video' ? (
      <SessionFileVideoPreview path={file.fileName} url={url} compact onError={forgetFailedUrl} />
    ) : (
      <SessionFileAudioPreview path={file.fileName} url={url} compact onError={forgetFailedUrl} />
    )
  );
}
