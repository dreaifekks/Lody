// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MachineId,
  SessionBtwProgress,
  SessionBtwRequest,
  SessionBtwResponse,
  SessionId,
} from '@lody/shared';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import {
  activeBtwArticleContextAtomFamily,
  btwSessionStateAtomFamily,
  buildBtwArticleContextPayload,
  openBtwForSessionAtom,
  openBtwWithSelectionAtom,
  resolveBtwModelPillLabel,
} from '../src/components/sessions/btw/btw-atoms';
import {
  useBtwController,
  type BtwController,
} from '../src/components/sessions/btw/use-btw-controller';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SESSION_ID = 'session-btw-test-1' as SessionId;
const MACHINE_ID = 'machine-btw-test-1' as MachineId;

describe('useBtwController and btw-atoms', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('derives default model pill labels and readOnlyTools suffix', () => {
    expect(resolveBtwModelPillLabel({ agentType: 'antigravity' })).toBe('Hydrogen · Low');
    expect(resolveBtwModelPillLabel({ agentType: 'claude', readOnlyTools: true })).toBe(
      'Haiku · Low · 只读'
    );
    expect(resolveBtwModelPillLabel({ agentType: 'codex' })).toBe('Luna · Low');
    expect(
      resolveBtwModelPillLabel({
        agentType: 'antigravity',
        modelLabel: 'Flash · Low',
        readOnlyTools: true,
      })
    ).toBe('Flash · Low · 只读');
  });

  it('truncates article excerpts above 12,000 chars and marks truncated=true', () => {
    const shortPayload = buildBtwArticleContextPayload({
      path: 'files/btw/design.md',
      text: 'hello',
    });
    expect(shortPayload).toEqual({ path: 'files/btw/design.md', excerpt: 'hello' });

    const longText = 'a'.repeat(12_500);
    const longPayload = buildBtwArticleContextPayload({
      path: 'files/btw/design.md',
      text: longText,
    });
    expect(longPayload?.excerpt).toHaveLength(12_000);
    expect(longPayload?.truncated).toBe(true);
  });

  it('streams deltas, continues turns without overwriting, tracks unread, toggles readOnlyTools, cancels, and closes', async () => {
    const store = createStore();
    const calls: Array<{
      machineId: MachineId;
      params: SessionBtwRequest;
      onProgress?: (progress: SessionBtwProgress) => void;
      signal?: AbortSignal;
    }> = [];
    const deferredQueue: Array<Deferred<SessionBtwResponse | null>> = [];

    const requestSessionBtw = vi.fn(
      (
        machineId: MachineId,
        params: SessionBtwRequest,
        options?: {
          onProgress?: (progress: SessionBtwProgress) => void;
          signal?: AbortSignal;
        }
      ) => {
        calls.push({
          machineId,
          params,
          onProgress: options?.onProgress,
          signal: options?.signal,
        });
        if (params.action === 'ask') {
          const deferred = createDeferred<SessionBtwResponse | null>();
          deferredQueue.push(deferred);
          return deferred.promise;
        }
        return Promise.resolve({
          btwId: params.btwId,
          text: '',
          cancelled: params.action === 'cancel',
        });
      }
    );

    store.set(runtimeAtom, { requestSessionBtw } as unknown as WorkspaceRuntime);
    store.set(activeBtwArticleContextAtomFamily(SESSION_ID), {
      path: 'files/btw-drawer/design.md',
      excerpt: 'Streams RPC pushes SSE frames.',
      ownerId: 'view-1',
      priority: 2,
    });

    let latest!: BtwController;
    const onFocusComposer = vi.fn();

    function Harness({ isVisible = true }: { isVisible?: boolean }) {
      latest = useBtwController({
        sessionId: SESSION_ID,
        machineId: MACHINE_ID,
        agentType: 'antigravity',
        isVisible,
        onFocusComposer,
      });
      return null;
    }

    act(() => {
      root.render(
        <Provider store={store}>
          <Harness />
        </Provider>
      );
    });

    expect(latest.modelPillLabel).toBe('Hydrogen · Low');
    expect(latest.articleFileName).toBe('design.md');

    // Open with document selection preserves state and stages selection chip
    act(() => {
      store.set(openBtwWithSelectionAtom, {
        sessionId: SESSION_ID,
        selection: {
          path: 'files/btw-drawer/design.md',
          text: 'SSE onProgress frames',
          location: 'Line 10',
        },
      });
    });
    expect(latest.state.isOpen).toBe(true);
    expect(latest.state.pendingSelection?.text).toBe('SSE onProgress frames');

    // Turn 1: ask with selection + matching article excerpt
    let ask1!: Promise<void>;
    act(() => {
      ask1 = latest.ask('Will 90ms batching feel laggy?');
    });
    expect(latest.state.isStreaming).toBe(true);
    expect(latest.state.pendingSelection).toBeNull();
    expect(latest.state.turns).toHaveLength(1);
    expect(latest.state.turns[0]?.selection?.text).toBe('SSE onProgress frames');
    expect(calls[0]?.params).toMatchObject({
      action: 'ask',
      sessionId: SESSION_ID,
      question: 'Will 90ms batching feel laggy?',
      articleContext: {
        path: 'files/btw-drawer/design.md',
        selection: 'SSE onProgress frames',
        excerpt: 'Streams RPC pushes SSE frames.',
      },
    });
    const firstBtwId = calls[0]!.params.btwId;

    // Stream progress deltas and switch back to main while streaming
    act(() => {
      calls[0]?.onProgress?.({
        btwId: firstBtwId,
        kind: 'status',
        status: 'streaming',
        modelLabel: 'Hydrogen · Low',
      });
      calls[0]?.onProgress?.({
        btwId: firstBtwId,
        kind: 'delta',
        delta: 'No, ',
      });
      calls[0]?.onProgress?.({
        btwId: firstBtwId,
        kind: 'delta',
        delta: '90ms is smooth.',
      });
    });
    expect(latest.state.streamingText).toBe('No, 90ms is smooth.');

    // Close drawer back to main while still streaming
    act(() => {
      latest.close();
    });
    expect(latest.state.isOpen).toBe(false);

    // Finish turn 1 while hidden -> marks hasUnread = true
    await act(async () => {
      deferredQueue[0]!.resolve({
        btwId: firstBtwId,
        text: 'No, 90ms is smooth.',
        modelLabel: 'Hydrogen · Low',
      });
      await ask1;
    });
    expect(latest.state.isStreaming).toBe(false);
    expect(latest.state.hasUnread).toBe(true);
    expect(latest.state.turns).toHaveLength(2);

    // Reopen via cross-component atom -> clears unread and preserves turns
    act(() => {
      store.set(openBtwForSessionAtom, SESSION_ID);
    });
    expect(latest.state.isOpen).toBe(true);
    expect(latest.state.hasUnread).toBe(false);
    expect(latest.state.turns).toHaveLength(2);

    // Toggle readOnlyTools on and ask Turn 2 -> appends without wiping Turn 1
    act(() => {
      latest.toggleReadOnlyTools();
    });
    expect(latest.state.readOnlyTools).toBe(true);
    expect(latest.modelPillLabel).toBe('Hydrogen · Low · 只读');

    let ask2!: Promise<void>;
    act(() => {
      ask2 = latest.ask('Check machine-rpc-server.ts');
    });
    expect(calls[1]?.params).toMatchObject({
      action: 'ask',
      btwId: firstBtwId,
      readOnlyTools: true,
      priorTurns: [
        { role: 'user', text: 'Will 90ms batching feel laggy?' },
        { role: 'assistant', text: 'No, 90ms is smooth.' },
      ],
    });

    // Stream partial delta then cancel -> aborts signal, commits partial text, sends cancel RPC
    act(() => {
      calls[1]?.onProgress?.({
        btwId: firstBtwId,
        kind: 'delta',
        delta: 'Partial answer...',
      });
    });
    act(() => {
      latest.cancel();
    });
    expect(calls[1]?.signal?.aborted).toBe(true);
    expect(latest.state.isStreaming).toBe(false);
    expect(latest.state.turns.at(-1)).toMatchObject({
      role: 'assistant',
      text: 'Partial answer...',
      cancelled: true,
    });
    expect(calls.at(-1)?.params).toEqual({
      action: 'cancel',
      sessionId: SESSION_ID,
      btwId: firstBtwId,
    });

    // Late progress/resolve from cancelled request must be ignored
    await act(async () => {
      calls[1]?.onProgress?.({ btwId: firstBtwId, kind: 'delta', delta: 'stale' });
      deferredQueue[1]!.resolve({ btwId: firstBtwId, text: 'stale final' });
      await ask2;
    });
    expect(latest.state.streamingText).toBe('');
    expect(latest.state.turns.at(-1)?.text).toBe('Partial answer...');

    // Clear and close (`×`) -> resets turns, closes drawer, rotates btwId, sends close RPC
    act(() => {
      latest.clearAndClose();
    });
    expect(latest.state.isOpen).toBe(false);
    expect(latest.state.turns).toEqual([]);
    expect(latest.state.readOnlyTools).toBe(false);
    expect(latest.state.btwId).not.toBe(firstBtwId);
    expect(calls.at(-1)?.params).toEqual({
      action: 'close',
      sessionId: SESSION_ID,
      btwId: firstBtwId,
    });
  });

  it('intercepts Escape in capture phase while visible and open so parent dialogs stay open', () => {
    const store = createStore();
    const parentEscape = vi.fn();

    function Harness() {
      useBtwController({
        sessionId: SESSION_ID,
        machineId: MACHINE_ID,
        agentType: 'claude',
        isVisible: true,
      });
      return null;
    }

    act(() => {
      store.set(openBtwForSessionAtom, SESSION_ID);
      root.render(
        <Provider store={store}>
          <Harness />
        </Provider>
      );
    });

    document.addEventListener('keydown', parentEscape);
    try {
      const escapeEvent = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        document.body.dispatchEvent(escapeEvent);
      });
      expect(escapeEvent.defaultPrevented).toBe(true);
      expect(parentEscape).not.toHaveBeenCalled();
      expect(store.get(btwSessionStateAtomFamily(SESSION_ID)).isOpen).toBe(false);
    } finally {
      document.removeEventListener('keydown', parentEscape);
    }
  });

  it('yields Escape to dialogs opened above the session while intercepting Escape for an enclosing dialog', () => {
    const store = createStore();
    const scopeRef = { current: null as HTMLDivElement | null };

    function Harness() {
      useBtwController({
        sessionId: SESSION_ID,
        machineId: MACHINE_ID,
        agentType: 'claude',
        isVisible: true,
        scopeElementRef: scopeRef,
      });
      return (
        <div role="dialog" data-article-dialog="">
          <div>
            <div ref={scopeRef} />
          </div>
        </div>
      );
    }

    act(() => {
      store.set(openBtwForSessionAtom, SESSION_ID);
      root.render(
        <Provider store={store}>
          <Harness />
        </Provider>
      );
    });

    // Another modal stacked above the article dialog gets Escape first.
    const higherModal = document.createElement('div');
    higherModal.setAttribute('role', 'dialog');
    document.body.append(higherModal);
    try {
      const ev1 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      act(() => {
        higherModal.dispatchEvent(ev1);
      });
      expect(ev1.defaultPrevented).toBe(false);
      expect(store.get(btwSessionStateAtomFamily(SESSION_ID)).isOpen).toBe(true);
    } finally {
      higherModal.remove();
    }

    // With only the enclosing article dialog present, Escape closes /btw instead of the dialog.
    const ev2 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      container.querySelector('[data-article-dialog]')!.dispatchEvent(ev2);
    });
    expect(ev2.defaultPrevented).toBe(true);
    expect(store.get(btwSessionStateAtomFamily(SESSION_ID)).isOpen).toBe(false);
  });
});
