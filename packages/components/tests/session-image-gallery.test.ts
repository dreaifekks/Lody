import { describe, expect, it } from 'vitest';
import type { SessionFilePayload, SessionHistoryParsed, SessionId } from '@lody/shared';
import {
  collectSessionImageGalleryEntries,
  createSessionImageGalleryEntry,
  findSessionImageGalleryEntryIndex,
  getSessionFileGalleryKey,
  getSessionToolImageGalleryKey,
} from '../src/lib/session-image-gallery';

const sessionId = 'session-1' as SessionId;

const buildMessage = (
  overrides: Partial<SessionHistoryParsed> & Pick<SessionHistoryParsed, 'id' | 'items'>
): SessionHistoryParsed => ({
  id: overrides.id,
  role: overrides.role ?? 'user',
  timestamp: overrides.timestamp ?? '2026-04-03T00:00:00.000Z',
  read: overrides.read ?? true,
  userId: overrides.userId,
  userTurnId: overrides.userTurnId,
  items: overrides.items,
  fileDiff: overrides.fileDiff,
  finished: overrides.finished,
  modelInfo: overrides.modelInfo,
  plan: overrides.plan,
  endedAt: overrides.endedAt,
});

describe('collectSessionImageGalleryEntries', () => {
  it('preserves conversation order across image items and image groups', () => {
    const messages: SessionHistoryParsed[] = [
      buildMessage({
        id: 'm-1',
        items: [
          {
            type: 'text',
            text: 'before',
          },
          {
            type: 'image',
            imageId: 'img-1',
            mimeType: 'image/png',
            fileName: 'first.png',
            sizeBytes: 128,
          },
        ],
      }),
      buildMessage({
        id: 'm-2',
        role: 'assistant',
        items: [
          {
            type: 'image_group',
            images: [
              {
                imageId: 'img-2',
                mimeType: 'image/jpeg',
                fileName: 'second.jpg',
                sizeBytes: 256,
              },
              {
                imageId: 'img-3',
                mimeType: 'image/webp',
                sizeBytes: 512,
              },
            ],
          },
        ],
      }),
    ];

    expect(collectSessionImageGalleryEntries(messages, sessionId)).toEqual([
      {
        key: 'm-1:1:0:img-1',
        sessionId,
        messageId: 'm-1',
        galleryGroupId: 'm-1',
        imageId: 'img-1',
        mimeType: 'image/png',
        fileName: 'first.png',
        sizeBytes: 128,
        width: undefined,
        height: undefined,
        alt: 'first.png',
      },
      {
        key: 'm-2:0:0:img-2',
        sessionId,
        messageId: 'm-2',
        galleryGroupId: 'm-2',
        imageId: 'img-2',
        mimeType: 'image/jpeg',
        fileName: 'second.jpg',
        sizeBytes: 256,
        width: undefined,
        height: undefined,
        alt: 'second.jpg',
      },
      {
        key: 'm-2:0:1:img-3',
        sessionId,
        messageId: 'm-2',
        galleryGroupId: 'm-2',
        imageId: 'img-3',
        mimeType: 'image/webp',
        fileName: undefined,
        sizeBytes: 512,
        width: undefined,
        height: undefined,
        alt: undefined,
      },
    ]);
  });

  it('groups assistant images under their originating user turn', () => {
    const messages: SessionHistoryParsed[] = [
      buildMessage({
        id: 'user-1',
        role: 'user',
        items: [
          {
            type: 'image',
            imageId: 'img-user',
            mimeType: 'image/png',
            sizeBytes: 128,
          },
        ],
      }),
      buildMessage({
        id: 'assistant-1',
        role: 'assistant',
        userTurnId: 'user-1',
        items: [
          {
            type: 'image_group',
            images: [
              {
                imageId: 'img-assistant-1',
                mimeType: 'image/jpeg',
                sizeBytes: 256,
              },
              {
                imageId: 'img-assistant-2',
                mimeType: 'image/webp',
                sizeBytes: 512,
              },
            ],
          },
        ],
      }),
    ];

    expect(collectSessionImageGalleryEntries(messages, sessionId)).toEqual([
      expect.objectContaining({
        key: 'user-1:0:0:img-user',
        galleryGroupId: 'user-1',
      }),
      expect.objectContaining({
        key: 'assistant-1:0:0:img-assistant-1',
        galleryGroupId: 'user-1',
      }),
      expect.objectContaining({
        key: 'assistant-1:0:1:img-assistant-2',
        galleryGroupId: 'user-1',
      }),
    ]);
  });

  it('falls back to the message id when assistant turn linkage is missing', () => {
    const messages: SessionHistoryParsed[] = [
      buildMessage({
        id: 'assistant-legacy',
        role: 'assistant',
        items: [
          {
            type: 'image',
            imageId: 'img-legacy',
            mimeType: 'image/png',
            sizeBytes: 64,
          },
        ],
      }),
    ];

    expect(collectSessionImageGalleryEntries(messages, sessionId)).toEqual([
      expect.objectContaining({
        key: 'assistant-legacy:0:0:img-legacy',
        galleryGroupId: 'assistant-legacy',
      }),
    ]);
  });
});

describe('a turn whose pictures are stored in different ways', () => {
  const picture = (fileId: string, mimeType = 'image/png'): SessionFilePayload => ({
    type: 'file',
    fileId,
    fileName: `${fileId}.png`,
    mimeType,
    sizeBytes: 2048,
    sha256: fileId.padEnd(64, '0'),
    textPreview: false,
    transport: 'local',
    machineId: 'devnuc',
  });
  const shownAsPicture = (file: SessionFilePayload) => file.mimeType === 'image/png';
  const returned = { type: 'image' as const, data: 'QUJD', mimeType: 'image/png' };

  const messages: SessionHistoryParsed[] = [
    buildMessage({
      id: 'user-1',
      items: [picture('asked'), { type: 'text', text: 'What is this?' }],
    }),
    buildMessage({
      id: 'assistant-1',
      role: 'assistant',
      userTurnId: 'user-1',
      items: [
        { type: 'thought', text: 'Looking.' },
        picture('drawn'),
        {
          type: 'tool_call',
          toolCallId: 'shot',
          title: 'Take a screenshot',
          kind: 'other',
          status: 'completed',
          content: [
            { type: 'content', content: { type: 'text', text: 'done' } },
            { type: 'content', content: returned },
          ],
        },
        { type: 'image', imageId: 'img-1', mimeType: 'image/png', sizeBytes: 64 },
        picture('notes', 'application/pdf'),
        { type: 'text', text: 'Here.' },
      ],
    }),
    buildMessage({ id: 'user-2', items: [{ type: 'text', text: 'Again.' }] }),
    buildMessage({
      id: 'assistant-2',
      role: 'assistant',
      userTurnId: 'user-2',
      items: [picture('later')],
    }),
  ];

  it('lists them in the order the conversation shows them, one group per turn', () => {
    const entries = collectSessionImageGalleryEntries(messages, sessionId, shownAsPicture);

    expect(entries.map((entry) => [entry.galleryGroupId, entry.key])).toEqual([
      ['user-1', getSessionFileGalleryKey('user-1', picture('asked'))],
      ['user-1', getSessionFileGalleryKey('assistant-1', picture('drawn'))],
      ['user-1', getSessionToolImageGalleryKey('shot', 1)],
      ['user-1', 'assistant-1:3:0:img-1'],
      ['user-2', getSessionFileGalleryKey('assistant-2', picture('later'))],
    ]);
    expect(entries[1]).toEqual(
      expect.objectContaining({ sessionId, messageId: 'assistant-1', file: picture('drawn') })
    );
    expect(entries[2]).toEqual(
      expect.objectContaining({ messageId: 'assistant-1', toolImage: returned })
    );
  });

  it('reads a file from the session that stores it', () => {
    const copied = { ...picture('copied'), storageSessionId: 'session-origin' as SessionId };

    expect(
      collectSessionImageGalleryEntries(
        [buildMessage({ id: 'user-1', items: [copied] })],
        sessionId,
        shownAsPicture
      )
    ).toEqual([expect.objectContaining({ sessionId: 'session-origin', file: copied })]);
  });

  it('leaves file blocks out where no client shows them as pictures', () => {
    expect(
      collectSessionImageGalleryEntries(messages, sessionId).map((entry) => entry.key)
    ).toEqual([getSessionToolImageGalleryKey('shot', 1), 'assistant-1:3:0:img-1']);
  });
});

describe('findSessionImageGalleryEntryIndex', () => {
  it('returns the matching index and falls back to -1', () => {
    const entries = [
      createSessionImageGalleryEntry({
        sessionId,
        messageId: 'm-1',
        itemIndex: 0,
        imageIndex: 0,
        image: {
          type: 'image',
          imageId: 'img-1',
          mimeType: 'image/png',
          sizeBytes: 128,
        },
      }),
      createSessionImageGalleryEntry({
        sessionId,
        messageId: 'm-2',
        itemIndex: 1,
        imageIndex: 0,
        image: {
          type: 'image',
          imageId: 'img-2',
          mimeType: 'image/png',
          sizeBytes: 256,
        },
      }),
    ];

    expect(entries).toEqual([
      expect.objectContaining({
        key: 'm-1:0:0:img-1',
        galleryGroupId: 'm-1',
      }),
      expect.objectContaining({
        key: 'm-2:1:0:img-2',
        galleryGroupId: 'm-2',
      }),
    ]);
    expect(findSessionImageGalleryEntryIndex(entries, entries[1]?.key ?? null)).toBe(1);
    expect(findSessionImageGalleryEntryIndex(entries, null)).toBe(-1);
    expect(findSessionImageGalleryEntryIndex(entries, 'missing')).toBe(-1);
  });
});
