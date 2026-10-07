import type { SessionId } from '@lody/shared';

/**
 * Side chats on their way, kept on this device in storage every window shares
 * (not `windowStorage()`: a session window's own storage ends with it). A side
 * chat's history arrives only after its fork, slowly over a weak link, and the
 * page or window that asked may be gone before then.
 */
const sharedStorage = (): Storage => globalThis.localStorage;

/** How long a side chat is waited for: the fork's deadline and a slow arrival. */
export const SIDE_CHAT_OPENING_TTL_MS = 10 * 60_000;

export type OpeningSideChat = {
  sessionId: SessionId;
  /** The widget question it was opened for (`widgetPromptKey`), if any. */
  key?: string;
  question?: string;
  startedAt: number;
};

const getOpeningStorageKey = (pageSessionId: SessionId): string =>
  `lody:side-chats-opening:${pageSessionId}`;

const readAllOpeningSideChats = (pageSessionId: SessionId): OpeningSideChat[] => {
  try {
    const value: unknown = JSON.parse(
      sharedStorage().getItem(getOpeningStorageKey(pageSessionId)) ?? '[]'
    );
    return Array.isArray(value)
      ? value.filter(
          (entry): entry is OpeningSideChat =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as OpeningSideChat).sessionId === 'string' &&
            typeof (entry as OpeningSideChat).startedAt === 'number'
        )
      : [];
  } catch {
    return [];
  }
};

const writeOpeningSideChats = (pageSessionId: SessionId, entries: OpeningSideChat[]): void => {
  try {
    if (entries.length === 0) sharedStorage().removeItem(getOpeningStorageKey(pageSessionId));
    else sharedStorage().setItem(getOpeningStorageKey(pageSessionId), JSON.stringify(entries));
  } catch {
    // ignore
  }
};

/** The side chats a conversation page opened that have not reached it yet. */
export const readOpeningSideChats = (
  pageSessionId: SessionId,
  now: number = Date.now()
): OpeningSideChat[] => {
  if (typeof window === 'undefined') return [];
  return readAllOpeningSideChats(pageSessionId).filter(
    (entry) => entry.startedAt <= now && now - entry.startedAt < SIDE_CHAT_OPENING_TTL_MS
  );
};

export const rememberOpeningSideChat = (
  pageSessionId: SessionId,
  opening: OpeningSideChat
): void => {
  if (typeof window === 'undefined') return;
  writeOpeningSideChats(pageSessionId, [
    ...readOpeningSideChats(pageSessionId, opening.startedAt).filter(
      (entry) => entry.sessionId !== opening.sessionId
    ),
    opening,
  ]);
};

/** Its fork failed, or it reached the page and is a side chat like any other. */
export const forgetOpeningSideChats = (
  pageSessionId: SessionId,
  sideSessionIds: readonly SessionId[]
): void => {
  if (typeof window === 'undefined') return;
  const entries = readAllOpeningSideChats(pageSessionId);
  const kept = entries.filter((entry) => !sideSessionIds.includes(entry.sessionId));
  if (kept.length !== entries.length) writeOpeningSideChats(pageSessionId, kept);
};

const getFirstPromptStorageKey = (sideSessionId: SessionId): string =>
  `lody:side-chat-first-prompt:${sideSessionId}`;

/**
 * The question a side chat was opened to ask, until the side chat itself sends
 * it (`useSideChatFirstPrompt`) from whichever window has it ready first.
 */
export const saveSideChatFirstPrompt = (sideSessionId: SessionId, text: string): void => {
  if (typeof window === 'undefined') return;
  try {
    sharedStorage().setItem(getFirstPromptStorageKey(sideSessionId), text);
  } catch {
    // ignore
  }
};

export const readSideChatFirstPrompt = (sideSessionId: SessionId): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    return sharedStorage().getItem(getFirstPromptStorageKey(sideSessionId));
  } catch {
    return null;
  }
};

export const forgetSideChatFirstPrompt = (sideSessionId: SessionId): void => {
  if (typeof window === 'undefined') return;
  try {
    sharedStorage().removeItem(getFirstPromptStorageKey(sideSessionId));
  } catch {
    // ignore
  }
};

/**
 * Removes and returns the question. Windows are separate renderers sharing the
 * storage, so the read and the removal hold a lock: one window sends it.
 */
export const claimSideChatFirstPrompt = async (
  sideSessionId: SessionId
): Promise<string | null> => {
  const take = () => {
    const text = readSideChatFirstPrompt(sideSessionId);
    if (text !== null) forgetSideChatFirstPrompt(sideSessionId);
    return text;
  };
  if (typeof navigator !== 'undefined' && navigator.locks)
    return await navigator.locks.request(getFirstPromptStorageKey(sideSessionId), take);
  return take();
};

/**
 * The side chat a widget question already went to: the one remembered for it
 * while it is in the panel, or one still opening for it. Asking again shows
 * that side chat instead of forking another.
 */
export const findWidgetSideChat = (input: {
  key: string;
  remembered: SessionId | null;
  shownSessionIds: readonly SessionId[];
  openings: readonly { sessionId: SessionId; key?: string }[];
}): SessionId | null => {
  if (input.remembered && input.shownSessionIds.includes(input.remembered)) {
    return input.remembered;
  }
  return input.openings.find((opening) => opening.key === input.key)?.sessionId ?? null;
};
