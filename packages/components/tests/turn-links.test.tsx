// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionLink } from '@lody/shared/session-link';

const shownToasts = vi.hoisted(() => [] as unknown[]);
vi.mock('@/lib/toast', () => {
  const show = (title: unknown) => {
    shownToasts.push(title);
    return String(title);
  };
  return { toast: Object.assign(show, { success: show, error: show, info: show }) };
});

import { SessionLinkProvider } from '../src/components/ai-gui/session-link-context';
import {
  TurnLinkHighlight,
  TurnLinkProvider,
  pendingTurnLinkAtom,
  useSessionLinkAction,
  useTurnLinkNavigation,
} from '../src/components/ai-gui/turn-links';
import type { ConversationListHandle } from '../src/components/ai-gui/conversation-list/types';
import type { ReadingPosition } from '../src/lib/conversation-scroll/types';
import { SESSION_DEEP_LINK_EVENT } from '../src/lib/session-deep-link';
import { initI18n } from '../src/i18n';

/** Rows as the view lists them: an assistant turn may take several. */
const ROWS = ['u1', 'assistant:u1', 'u2', 'assistant:u2', 'assistant:u2', 'u3', 'assistant:u3'].map(
  (turnId) => ({ turnId })
);

const readAt = (turnId: string): ReadingPosition => ({
  kind: 'read',
  anchor: { kind: 'turn', turnId, turnIndex: 0, rowKey: turnId, item: null, offsetPx: 0 },
  screenY: 0,
});

/** The list as the turn links see it: where the reader is. */
function createReader() {
  let position: ReadingPosition = { kind: 'follow' };
  const list = {
    readingPosition: () => position,
    restoreReadingPosition: (next: ReadingPosition) => {
      position = next;
    },
  } as unknown as ConversationListHandle;
  return {
    listRef: { current: list },
    scrollRowToTop: (row: number) => {
      position = readAt(ROWS[row]!.turnId);
    },
    scrollToBottom: () => {
      position = { kind: 'follow' };
    },
    /** The reader scrolls by hand. */
    scrollTo: (turnId: string) => {
      position = readAt(turnId);
    },
    readsAt: () =>
      position.kind === 'follow'
        ? 'latest'
        : position.anchor.kind === 'turn'
          ? position.anchor.turnId
          : position.anchor.fixed,
  };
}
type Reader = ReturnType<typeof createReader>;

function SessionLinkChip({ target }: { target: SessionLink }) {
  const open = useSessionLinkAction(target);
  const name = `${target.sessionId}#${target.turnId ?? ''}`;
  return open ? (
    <button type="button" data-link={name} onClick={open} />
  ) : (
    <span data-link={name} />
  );
}

type ConversationProps = {
  sessionId: string;
  reader: Reader;
  links: readonly SessionLink[];
  revealed?: boolean;
  isSticky?: boolean;
  latestSendId?: string;
};

function Conversation({
  sessionId,
  reader,
  links,
  revealed = true,
  isSticky = false,
  latestSendId,
}: ConversationProps) {
  const turnLinks = useTurnLinkNavigation({
    sessionId,
    listRef: reader.listRef,
    rows: ROWS,
    scrollRowToTop: reader.scrollRowToTop,
    scrollToBottom: reader.scrollToBottom,
    revealed,
    isSticky,
    latestSendId,
  });
  return (
    <TurnLinkProvider value={turnLinks}>
      {ROWS.map((row, index) => (
        <div key={index} data-row={row.turnId}>
          <TurnLinkHighlight turnId={row.turnId} />
        </div>
      ))}
      {links.map((target) => (
        <SessionLinkChip key={`${target.sessionId}#${target.turnId}`} target={target} />
      ))}
      <button
        type="button"
        data-latest=""
        aria-label={turnLinks.canGoBack ? 'back' : 'latest'}
        onClick={turnLinks.goBackOrToLatest}
      />
    </TurnLinkProvider>
  );
}

let container: HTMLDivElement;
let root: Root;
let store: ReturnType<typeof createStore>;
let openedLinks: string[];
const recordDeepLink = (event: Event) => {
  openedLinks.push(String((event as CustomEvent<unknown>).detail));
};

beforeAll(async () => {
  await initI18n('en');
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  store = createStore();
  openedLinks = [];
  shownToasts.length = 0;
  window.addEventListener(SESSION_DEEP_LINK_EVENT, recordDeepLink);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.removeEventListener(SESSION_DEEP_LINK_EVENT, recordDeepLink);
});

const render = (props: ConversationProps, navigation = true) =>
  act(() =>
    root.render(
      <Provider store={store}>
        <SessionLinkProvider enabled={navigation}>
          <Conversation {...props} />
        </SessionLinkProvider>
      </Provider>
    )
  );
const click = (selector: string) =>
  act(() => container.querySelector<HTMLElement>(selector)!.click());
const clickLink = (sessionId: string, turnId = '') => click(`[data-link="${sessionId}#${turnId}"]`);
const flashedRows = () =>
  [...container.querySelectorAll('[data-turn-link-highlight]')].map(
    (flash) => flash.parentElement!.dataset.row
  );
const latestButton = () => container.querySelector('[data-latest]')!.getAttribute('aria-label');

const S1 = 'Session_One';
const S2 = 'Session_Two';
const link = (sessionId: string, turnId?: string): SessionLink => ({
  sessionId,
  ...(turnId ? { turnId } : {}),
});

describe('turn links', () => {
  it('scroll to a turn of the conversation on screen and flash all its rows, without navigating', () => {
    const reader = createReader();
    render({ sessionId: S1, reader, links: [link(S1, 'assistant:u2')] });

    clickLink(S1, 'assistant:u2');

    expect(reader.readsAt()).toBe('assistant:u2');
    expect(flashedRows()).toEqual(['assistant:u2', 'assistant:u2']);
    expect(openedLinks).toEqual([]);
    expect(latestButton()).toBe('back');
  });

  it('unwind jumps newest first, then go to the latest', () => {
    const reader = createReader();
    render({ sessionId: S1, reader, links: [link(S1, 'u1'), link(S1, 'assistant:u2')] });
    reader.scrollTo('u3');

    clickLink(S1, 'u1');
    clickLink(S1, 'assistant:u2');
    expect(reader.readsAt()).toBe('assistant:u2');

    click('[data-latest]');
    expect(reader.readsAt()).toBe('u1');
    click('[data-latest]');
    expect(reader.readsAt()).toBe('u3');
    expect(latestButton()).toBe('latest');
    click('[data-latest]');
    expect(reader.readsAt()).toBe('latest');
  });

  it('return to the end when the jump started there', () => {
    const reader = createReader();
    render({ sessionId: S1, reader, links: [link(S1, 'u1')], isSticky: true });

    clickLink(S1, 'u1');
    render({ sessionId: S1, reader, links: [link(S1, 'u1')], isSticky: false });
    click('[data-latest]');

    expect(reader.readsAt()).toBe('latest');
  });

  it.each([
    ['reaching the end', { isSticky: true }],
    ['sending a message', { latestSendId: 'local-1' }],
    ['switching conversations', { sessionId: S2 }],
  ])('forget the way back on %s', (_, change) => {
    const reader = createReader();
    const props = { sessionId: S1, reader, links: [link(S1, 'u1')] };
    render(props);
    clickLink(S1, 'u1');
    expect(latestButton()).toBe('back');

    render({ ...props, ...change });

    expect(latestButton()).toBe('latest');
  });

  it('leave the reader where they are when the turn is gone, and say so', () => {
    const reader = createReader();
    render({ sessionId: S1, reader, links: [link(S1, 'assistant:gone')] });
    reader.scrollTo('u3');

    clickLink(S1, 'assistant:gone');

    expect(reader.readsAt()).toBe('u3');
    expect(flashedRows()).toEqual([]);
    expect(latestButton()).toBe('latest');
    expect(shownToasts).toEqual(['That turn is no longer in this conversation.']);
  });

  it('open another conversation first, and scroll there once it has restored its position', () => {
    const reader = createReader();
    render({ sessionId: S1, reader, links: [link(S2, 'u3')] });

    clickLink(S2, 'u3');
    expect(openedLinks).toEqual([`lody://session/${S2}`]);
    expect(reader.readsAt()).toBe('latest');

    const destination = createReader();
    render({ sessionId: S2, reader: destination, links: [], revealed: false });
    expect(destination.readsAt()).toBe('latest');

    render({ sessionId: S2, reader: destination, links: [], revealed: true });
    expect(destination.readsAt()).toBe('u3');
    expect(flashedRows()).toEqual(['u3']);
    // Nothing to go back to in this conversation; the jump came from another.
    expect(latestButton()).toBe('latest');
    expect(store.get(pendingTurnLinkAtom)).toBeNull();
  });

  it('drop a pending turn when a later link opens a conversation without one', () => {
    const reader = createReader();
    render({ sessionId: S1, reader, links: [link(S2, 'u3'), link(S2)] });

    clickLink(S2, 'u3');
    clickLink(S2);
    render({ sessionId: S2, reader, links: [] });

    expect(reader.readsAt()).toBe('latest');
  });

  it('work without session navigation only inside the conversation on screen', () => {
    const reader = createReader();
    render({ sessionId: S1, reader, links: [link(S1, 'u1'), link(S2, 'u1'), link(S1)] }, false);

    expect(container.querySelector(`button[data-link="${S1}#u1"]`)).not.toBeNull();
    expect(container.querySelector(`span[data-link="${S2}#u1"]`)).not.toBeNull();
    expect(container.querySelector(`span[data-link="${S1}#"]`)).not.toBeNull();
  });
});
