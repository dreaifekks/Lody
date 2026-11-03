// @vitest-environment jsdom

import { createStore } from 'jotai';
import { beforeEach, describe, expect, it } from 'vitest';

import { archiveMachineIdAtom, archiveScopeAtom, chatScopeAtom } from '../src/atoms/sidebar-state';

const CHAT_SCOPE_STORAGE_KEY = 'lody-sidebar-chat-scope';
const ARCHIVE_SCOPE_STORAGE_KEY = 'lody-archive-scope';

function mountChatScopeStore() {
  const store = createStore();
  const unsubscribe = store.sub(chatScopeAtom, () => undefined);
  return { store, unsubscribe };
}

function mountArchiveScopeStore() {
  const store = createStore();
  const unsubscribe = store.sub(archiveScopeAtom, () => undefined);
  return { store, unsubscribe };
}

describe('archiveMachineIdAtom', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to all machines and restores an explicitly persisted choice', () => {
    const store = createStore();
    const unmount = store.sub(archiveMachineIdAtom, () => {});
    expect(store.get(archiveMachineIdAtom)).toBeNull();
    store.set(archiveMachineIdAtom, 'server');
    unmount();
    const reopened = createStore();
    const unsubscribe = reopened.sub(archiveMachineIdAtom, () => {});
    expect(reopened.get(archiveMachineIdAtom)).toBe('server');
    unsubscribe();
  });
});
