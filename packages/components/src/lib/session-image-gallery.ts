import type { SessionFilePayload, SessionHistoryParsed, SessionId } from '@lody/shared';

type SessionImageLike =
  | Extract<SessionHistoryParsed['items'][number], { type: 'image' }>
  | Extract<
      Extract<SessionHistoryParsed['items'][number], { type: 'image_group' }>['images'][number],
      {
        imageId: string;
      }
    >;

export type SessionImageGalleryEntry = {
  key: string;
  sessionId: SessionId;
  messageId: string;
  galleryGroupId: string;
  imageId: string;
  mimeType: string;
  fileName?: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  alt?: string;
};

type ToolCallContentBlock = NonNullable<
  Extract<SessionHistoryParsed['items'][number], { type: 'tool_call' }>['content']
>[number];

/** A picture a tool call returned inline. */
export type SessionToolImage = Extract<
  Extract<ToolCallContentBlock, { type: 'content' }>['content'],
  { type: 'image' }
>;

/** A file block shown as a picture, read from the machine that keeps it. */
export type SessionFileGalleryEntry = {
  key: string;
  sessionId: SessionId;
  messageId: string;
  galleryGroupId: string;
  file: SessionFilePayload;
};

export type SessionToolImageGalleryEntry = {
  key: string;
  messageId: string;
  galleryGroupId: string;
  toolImage: SessionToolImage;
};

/** Every picture of a turn the viewer steps through, whatever it is stored as. */
export type SessionGalleryEntry =
  | SessionImageGalleryEntry
  | SessionFileGalleryEntry
  | SessionToolImageGalleryEntry;

export const getSessionFileGalleryKey = (
  messageId: string,
  file: Pick<SessionFilePayload, 'fileId' | 'sha256'>
): string => `${messageId}:file:${file.fileId}:${file.sha256}`;

export const getSessionToolImageGalleryKey = (toolCallId: string, blockIndex: number): string =>
  `tool:${toolCallId}:${blockIndex}`;

type CreateSessionImageGalleryEntryArgs = {
  sessionId: SessionId;
  messageId: string;
  galleryGroupId?: string;
  itemIndex: number;
  imageIndex: number;
  image: SessionImageLike;
};

export const createSessionImageGalleryEntry = ({
  sessionId,
  messageId,
  galleryGroupId = messageId,
  itemIndex,
  imageIndex,
  image,
}: CreateSessionImageGalleryEntryArgs): SessionImageGalleryEntry => ({
  key: `${messageId}:${itemIndex}:${imageIndex}:${image.imageId}`,
  sessionId: image.storageSessionId ?? sessionId,
  messageId,
  galleryGroupId,
  imageId: image.imageId,
  mimeType: image.mimeType,
  fileName: image.fileName,
  sizeBytes: image.sizeBytes,
  width: image.width,
  height: image.height,
  alt: image.fileName,
});

const resolveGalleryGroupId = (message: SessionHistoryParsed): string => {
  if (message.role === 'user') {
    return message.id;
  }

  const userTurnId = message.userTurnId?.trim();
  return userTurnId || message.id;
};

/**
 * The pictures of a conversation in the order it shows them. `isImageFile` says
 * which file blocks this client shows as pictures; without it none are.
 */
export const collectSessionImageGalleryEntries = (
  messages: ReadonlyArray<SessionHistoryParsed>,
  sessionId: SessionId,
  isImageFile?: (file: SessionFilePayload) => boolean
): SessionGalleryEntry[] => {
  const entries: SessionGalleryEntry[] = [];

  for (const message of messages) {
    const galleryGroupId = resolveGalleryGroupId(message);

    message.items.forEach((item, itemIndex) => {
      if (item.type === 'image') {
        entries.push(
          createSessionImageGalleryEntry({
            sessionId,
            messageId: message.id,
            galleryGroupId,
            itemIndex,
            imageIndex: 0,
            image: item,
          })
        );
        return;
      }

      if (item.type === 'file') {
        if (isImageFile?.(item)) {
          entries.push({
            key: getSessionFileGalleryKey(message.id, item),
            sessionId: item.storageSessionId ?? sessionId,
            messageId: message.id,
            galleryGroupId,
            file: item,
          });
        }
        return;
      }

      if (item.type === 'tool_call') {
        item.content?.forEach((block, blockIndex) => {
          if (block.type === 'content' && block.content.type === 'image') {
            entries.push({
              key: getSessionToolImageGalleryKey(item.toolCallId, blockIndex),
              messageId: message.id,
              galleryGroupId,
              toolImage: block.content,
            });
          }
        });
        return;
      }

      if (item.type !== 'image_group') {
        return;
      }

      item.images.forEach((image, imageIndex) => {
        entries.push(
          createSessionImageGalleryEntry({
            sessionId,
            messageId: message.id,
            galleryGroupId,
            itemIndex,
            imageIndex,
            image,
          })
        );
      });
    });
  }

  return entries;
};

export const findSessionImageGalleryEntryIndex = (
  entries: ReadonlyArray<SessionGalleryEntry>,
  key: string | null
): number => {
  if (!key) {
    return -1;
  }
  return entries.findIndex((entry) => entry.key === key);
};
