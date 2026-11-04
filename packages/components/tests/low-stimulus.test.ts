import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import {
  sidebarCollapsedOpenedBySessionsAtom,
  toggleSidebarCollapsedOpenedBySessionAtom,
} from '../src/atoms/focus-layer';
import {
  experimentalFeaturesEnabledAtom,
  lowStimulusExperimentEnabledAtom,
  lowStimulusModeEnabledAtom,
} from '../src/atoms/settings';
import { foldedFamilyActivity } from '../src/components/sidebar-folded-family';
import { hiddenSessionHasUnread, isOpenerCollapsed } from '../src/lib/low-stimulus';

type Row = {
  id: string;
  latestMessageAt: number;
  hasUnreadMessages?: boolean;
  isWorking?: boolean;
  isWaitingPermission?: boolean;
};

const family = (root: Row, hidden: Row[], rootLastReadAt?: number, sendStates = {}) =>
  foldedFamilyActivity(root, hidden, rootLastReadAt, (row) => row.id, sendStates);

const root: Row = { id: 'root', latestMessageAt: 100 };

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
    expect(hiddenSessionHasUnread(true, 300, undefined)).toBe(true);
  });

  it('never makes a read or closed session unread', () => {
    expect(hiddenSessionHasUnread(false, 300, 200)).toBe(false);
    expect(hiddenSessionHasUnread(false, 300, undefined)).toBe(false);
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
