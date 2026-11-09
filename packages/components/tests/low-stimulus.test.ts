// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  sidebarCollapsedOpenedBySessionsAtom,
  toggleSidebarCollapsedOpenedBySessionAtom,
} from '../src/atoms/focus-layer';
import { familyReadThroughAtom, setConversationOnScreenAtom } from '../src/atoms/low-stimulus-seen';
import {
  experimentalFeaturesEnabledAtom,
  lowStimulusExperimentEnabledAtom,
  lowStimulusModeEnabledAtom,
} from '../src/atoms/settings';
import { foldedFamilyActivity } from '../src/components/sidebar-folded-family';
import { SessionRowStatusIndicator } from '../src/components/sidebar-row-shared';
import { useLowStimulusConversationSeen } from '../src/hooks/use-low-stimulus-conversation-seen';
import {
  familyReadThrough,
  hiddenSessionHasUnread,
  isOpenerCollapsed,
} from '../src/lib/low-stimulus';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Row = {
  id: string;
  latestMessageAt: number;
  hasUnreadMessages?: boolean;
  isWorking?: boolean;
  isWaitingPermission?: boolean;
};

const family = (root: Row, hidden: Row[], rootReadThrough = -Infinity, sendStates = {}) =>
  foldedFamilyActivity(root, hidden, rootReadThrough, (row) => row.id, sendStates);

const root: Row = { id: 'root', latestMessageAt: 100 };

afterEach(() => localStorage.clear());

describe('isOpenerCollapsed', () => {
  it('reads an absent opener as expanded without the mode and folded with it', () => {
    expect(isOpenerCollapsed(false, {}, 'opener')).toBe(false);
    expect(isOpenerCollapsed(false, undefined, 'opener')).toBe(false);
    expect(isOpenerCollapsed(true, {}, 'opener')).toBe(true);
    expect(isOpenerCollapsed(true, undefined, 'opener')).toBe(true);
  });

  it('keeps an explicit choice in both modes', () => {
    expect(isOpenerCollapsed(false, { opener: true }, 'opener')).toBe(true);
    expect(isOpenerCollapsed(false, { opener: false }, 'opener')).toBe(false);
    expect(isOpenerCollapsed(true, { opener: true }, 'opener')).toBe(true);
    expect(isOpenerCollapsed(true, { opener: false }, 'opener')).toBe(false);
  });
});

describe('the low-stimulus switch', () => {
  it('needs both the master switch and its own', () => {
    const store = createStore();
    store.set(lowStimulusExperimentEnabledAtom, true);
    expect(store.get(lowStimulusModeEnabledAtom)).toBe(false);
    store.set(experimentalFeaturesEnabledAtom, true);
    expect(store.get(lowStimulusModeEnabledAtom)).toBe(true);
    store.set(lowStimulusExperimentEnabledAtom, false);
    expect(store.get(lowStimulusModeEnabledAtom)).toBe(false);
  });
});

describe('toggling an opener', () => {
  it('unfolds a default-folded opener on the first click in the mode', () => {
    const store = createStore();
    store.set(experimentalFeaturesEnabledAtom, true);
    store.set(lowStimulusExperimentEnabledAtom, true);
    store.set(toggleSidebarCollapsedOpenedBySessionAtom, 'opener');
    const record = store.get(sidebarCollapsedOpenedBySessionsAtom);
    expect(isOpenerCollapsed(true, record, 'opener')).toBe(false);
    store.set(toggleSidebarCollapsedOpenedBySessionAtom, 'opener');
    expect(isOpenerCollapsed(true, store.get(sidebarCollapsedOpenedBySessionsAtom), 'opener')).toBe(
      true
    );
  });

  it('folds on the first tap of a list that shows the upstream default in the mode', () => {
    const store = createStore();
    store.set(experimentalFeaturesEnabledAtom, true);
    store.set(lowStimulusExperimentEnabledAtom, true);
    store.set(toggleSidebarCollapsedOpenedBySessionAtom, 'opener', false);
    expect(store.get(sidebarCollapsedOpenedBySessionsAtom)).toEqual({ opener: true });
    store.set(toggleSidebarCollapsedOpenedBySessionAtom, 'opener', true);
    expect(store.get(sidebarCollapsedOpenedBySessionsAtom)).toEqual({ opener: false });
  });

  it('folds an expanded opener on the first click without the mode', () => {
    const store = createStore();
    store.set(toggleSidebarCollapsedOpenedBySessionAtom, 'opener');
    expect(store.get(sidebarCollapsedOpenedBySessionsAtom)).toEqual({ opener: true });
    store.set(toggleSidebarCollapsedOpenedBySessionAtom, 'opener');
    expect(store.get(sidebarCollapsedOpenedBySessionsAtom)).toEqual({ opener: false });
  });
});

describe('hiddenSessionHasUnread', () => {
  it('stops counting output the last read of the root already covers', () => {
    expect(hiddenSessionHasUnread(true, 100, 200)).toBe(false);
    expect(hiddenSessionHasUnread(true, 200, 200)).toBe(false);
  });

  it('counts output newer than that read, and any unread output of a never-read root', () => {
    expect(hiddenSessionHasUnread(true, 300, 200)).toBe(true);
    expect(hiddenSessionHasUnread(true, 300, familyReadThrough(undefined, undefined))).toBe(true);
  });

  it('never makes a read or closed session unread', () => {
    expect(hiddenSessionHasUnread(false, 300, 200)).toBe(false);
    expect(hiddenSessionHasUnread(false, 300, familyReadThrough(undefined, undefined))).toBe(false);
  });
});

describe('familyReadThrough', () => {
  it('is the later of the read receipt and the last time the root was on screen', () => {
    expect(familyReadThrough(100, 300)).toBe(300);
    expect(familyReadThrough(300, 100)).toBe(300);
    expect(familyReadThrough(100, undefined)).toBe(100);
    expect(familyReadThrough(undefined, 300)).toBe(300);
  });
});

// A read receipt holds the root's own last message time, never the time of reading.
// This root last spoke at 100 and is read through 100; its hidden Session spoke later.
describe('reading a folded family through its root', () => {
  const hiddenUnread = (store: ReturnType<typeof createStore>, latestMessageAt: number) =>
    family(
      root,
      [{ id: 'child', latestMessageAt, hasUnreadMessages: true }],
      store.get(familyReadThroughAtom)('root', 100)
    ).unread;
  /** Another window's write, as this window hears of it. */
  const hearStored = (seenAt: Record<string, number>) =>
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'lody-low-stimulus-seen-at',
        newValue: JSON.stringify(seenAt),
        storageArea: localStorage,
      })
    );

  beforeEach(() => localStorage.clear());

  it('keeps newer hidden output until the root conversation has been on screen', () => {
    const store = createStore();
    expect(hiddenUnread(store, 150)).toBe(1);
    store.set(setConversationOnScreenAtom, 'root', true, 200);
    store.set(setConversationOnScreenAtom, 'root', false, 210);
    expect(hiddenUnread(store, 150)).toBe(0);
  });

  it('counts nothing a hidden Session says while the root is on screen', () => {
    const store = createStore();
    store.set(setConversationOnScreenAtom, 'root', true, 200);
    expect(hiddenUnread(store, 9_000)).toBe(0);
  });

  it('counts hidden output again once it is newer than the moment the root left the screen', () => {
    const store = createStore();
    store.set(setConversationOnScreenAtom, 'root', true, 200);
    store.set(setConversationOnScreenAtom, 'root', false, 300);
    expect(hiddenUnread(store, 300)).toBe(0);
    expect(hiddenUnread(store, 301)).toBe(1);
  });

  it('reads each root on its own and never behind its receipt', () => {
    const store = createStore();
    store.set(setConversationOnScreenAtom, 'other', true, 200);
    expect(hiddenUnread(store, 150)).toBe(1);
    store.set(setConversationOnScreenAtom, 'root', true, 40);
    store.set(setConversationOnScreenAtom, 'root', false, 50);
    expect(store.get(familyReadThroughAtom)('root', 100)).toBe(100);
  });

  it('still knows after a restart that a conversation showing at the time had been seen', () => {
    createStore().set(setConversationOnScreenAtom, 'root', true, 200);
    const restarted = createStore();
    // Mounting reads this device's storage, as the module does when the app loads.
    const unsubscribe = restarted.sub(familyReadThroughAtom, () => {});
    expect(restarted.get(familyReadThroughAtom)('root', 100)).toBe(200);
    unsubscribe();
  });

  it('remembers the 200 conversations seen last and falls back to the receipt for older ones', () => {
    const store = createStore();
    for (let at = 1; at <= 201; at += 1) {
      store.set(setConversationOnScreenAtom, `session-${at}`, true, at);
      store.set(setConversationOnScreenAtom, `session-${at}`, false, at);
    }
    const readThrough = store.get(familyReadThroughAtom);
    expect(readThrough('session-1', undefined)).toBe(-Infinity);
    expect(readThrough('session-2', undefined)).toBe(2);
    expect(readThrough('session-201', undefined)).toBe(201);
  });

  it('keeps what another window saw when this one writes without having heard of it', () => {
    const first = createStore();
    first.set(setConversationOnScreenAtom, 'root', true, 200);
    first.set(setConversationOnScreenAtom, 'root', false, 210);
    // No storage event reached the second window before it wrote.
    createStore().set(setConversationOnScreenAtom, 'other', true, 230);
    const restarted = createStore();
    const unsubscribe = restarted.sub(familyReadThroughAtom, () => {});
    expect(restarted.get(familyReadThroughAtom)('root', 100)).toBe(210);
    expect(restarted.get(familyReadThroughAtom)('other', 100)).toBe(230);
    unsubscribe();
  });

  it('adds what another window stored to its own instead of replacing it', () => {
    const store = createStore();
    const unsubscribe = store.sub(familyReadThroughAtom, () => {});
    store.set(setConversationOnScreenAtom, 'root', true, 200);
    store.set(setConversationOnScreenAtom, 'root', false, 210);
    // That window wrote before it heard of this one's root, and saw an older moment of it.
    hearStored({ other: 230 });
    hearStored({ root: 205 });
    expect(hiddenUnread(store, 208)).toBe(0);
    expect(store.get(familyReadThroughAtom)('other', 100)).toBe(230);
    unsubscribe();
  });
});

describe('useLowStimulusConversationSeen', () => {
  let host: HTMLDivElement;
  let reactRoot: Root;
  const Surface = (props: { sessionId: string; onScreen: boolean }) => {
    useLowStimulusConversationSeen(props.sessionId, props.onScreen);
    return null;
  };
  const show = (store: ReturnType<typeof createStore>, onScreen: boolean, sessionId = 'root') =>
    act(() =>
      reactRoot.render(
        createElement(Provider, { store }, createElement(Surface, { sessionId, onScreen }))
      )
    );
  const modeStore = (lowStimulus: boolean) => {
    const store = createStore();
    store.set(experimentalFeaturesEnabledAtom, lowStimulus);
    store.set(lowStimulusExperimentEnabledAtom, lowStimulus);
    return store;
  };

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
    host = document.createElement('div');
    reactRoot = createRoot(host);
  });
  afterEach(() => {
    act(() => reactRoot.unmount());
    vi.useRealTimers();
  });

  it('reads a conversation through now while it is on screen, then through the moment it left', () => {
    const store = modeStore(true);
    show(store, true);
    expect(store.get(familyReadThroughAtom)('root', 100)).toBe(Infinity);
    vi.setSystemTime(2_000);
    show(store, false);
    expect(store.get(familyReadThroughAtom)('root', 100)).toBe(2_000);
  });

  it('records the moment a conversation on screen is unmounted or replaced by another', () => {
    const store = modeStore(true);
    show(store, true);
    vi.setSystemTime(3_000);
    show(store, true, 'next');
    expect(store.get(familyReadThroughAtom)('root', 100)).toBe(3_000);
    expect(store.get(familyReadThroughAtom)('next', 100)).toBe(Infinity);
    vi.setSystemTime(4_000);
    act(() => reactRoot.unmount());
    expect(store.get(familyReadThroughAtom)('next', 100)).toBe(4_000);
  });

  it('records nothing while the mode is off, and starts when it turns on', () => {
    const store = modeStore(false);
    show(store, true);
    expect(store.get(familyReadThroughAtom)('root', 100)).toBe(100);
    act(() => {
      store.set(experimentalFeaturesEnabledAtom, true);
      store.set(lowStimulusExperimentEnabledAtom, true);
    });
    expect(store.get(familyReadThroughAtom)('root', 100)).toBe(Infinity);
  });
});

describe('foldedFamilyActivity', () => {
  it('draws nothing for an idle, read family', () => {
    const activity = family(root, [{ id: 'child', latestMessageAt: 50 }], 100);
    expect(activity).toEqual({ failed: 0, waiting: 0, working: 0, sending: 0, unread: 0 });
  });

  it('clears a hidden unread the root read covers and brings it back on new output', () => {
    const child: Row = { id: 'child', latestMessageAt: 150, hasUnreadMessages: true };
    expect(family(root, [child], 200).unread).toBe(0);
    expect(family(root, [{ ...child, latestMessageAt: 250 }], 200).unread).toBe(1);
  });

  it('keeps the root own unread regardless of its read receipt', () => {
    expect(family({ ...root, hasUnreadMessages: true }, [], 50).unread).toBe(1);
  });

  it('counts waiting and working of hidden sessions however old their output is', () => {
    const activity = family(
      root,
      [
        { id: 'waiting', latestMessageAt: 1, isWaitingPermission: true, isWorking: true },
        { id: 'working', latestMessageAt: 1, isWorking: true },
      ],
      200
    );
    expect(activity).toMatchObject({ waiting: 1, working: 1, unread: 0 });
  });

  it('counts a hidden send failure and a root send in progress', () => {
    const activity = family(root, [{ id: 'child', latestMessageAt: 1 }], 200, {
      root: 'sending',
      child: 'failed',
    });
    expect(activity).toMatchObject({ failed: 1, sending: 1 });
  });
});

describe('the done transition of a status mark', () => {
  let host: HTMLDivElement;
  let reactRoot: Root;
  const draw = (store: ReturnType<typeof createStore>, working: boolean) =>
    act(() =>
      reactRoot.render(
        createElement(
          Provider,
          { store },
          createElement(SessionRowStatusIndicator, {
            isWorking: working,
            hasUnreadMessages: !working,
          })
        )
      )
    );
  /** A session finishes with output to read, as the row sees it. */
  const finish = (lowStimulus: boolean) => {
    const store = createStore();
    store.set(experimentalFeaturesEnabledAtom, lowStimulus);
    store.set(lowStimulusExperimentEnabledAtom, lowStimulus);
    draw(store, true);
    draw(store, false);
  };

  beforeEach(() => {
    // Every animation stays unfinished, as a real one is while it plays.
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: () => ({ finished: new Promise(() => {}), cancel: () => {} }),
    });
    host = document.createElement('div');
    reactRoot = createRoot(host);
  });
  afterEach(() => {
    act(() => reactRoot.unmount());
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });

  it('plays when a session finishes with output to read', () => {
    finish(false);
    expect(host.querySelector('[data-session-done-transition]')).not.toBeNull();
  });

  it('goes straight to the dot in the mode', () => {
    finish(true);
    expect(host.querySelector('[data-session-done-transition]')).toBeNull();
    expect(host.querySelector('[data-session-unread-dot]')).not.toBeNull();
  });
});
