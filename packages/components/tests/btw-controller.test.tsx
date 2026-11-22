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
  btwDraftAtomFamily,
  btwSessionStateAtomFamily,
  buildBtwArticleContextPayload,
  openBtwForSessionAtom,
  openBtwWithSelectionAtom,
  removeBtwArticleContextAtom,
  resolveBtwModelPillLabel,
  upsertBtwArticleContextAtom,
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

  it('settles streaming state on unmount so remounting the same session can ask immediately', async () => {
    const store = createStore();
    const sessionId = 'session-btw-unmount-1' as SessionId;
    const calls: Array<{
      machineId: MachineId;
      params: SessionBtwRequest;
      onProgress?: (progress: SessionBtwProgress) => void;
      signal?: AbortSignal;
    }> = [];
    const pendingAsk = createDeferred<SessionBtwResponse | null>();

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
        if (
          params.action === 'ask' &&
          calls.filter((c) => c.params.action === 'ask').length === 1
        ) {
          return pendingAsk.promise;
        }
        return Promise.resolve({ btwId: params.btwId, text: 'reopened-ok' });
      }
    );

    store.set(runtimeAtom, { requestSessionBtw } as unknown as WorkspaceRuntime);

    let latest!: BtwController;
    function Harness() {
      latest = useBtwController({
        sessionId,
        machineId: MACHINE_ID,
        agentType: 'antigravity',
        isVisible: true,
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

    let ask1!: Promise<void>;
    act(() => {
      ask1 = latest.ask('Long question');
    });
    const btwId = calls[0]!.params.btwId;
    act(() => {
      calls[0]?.onProgress?.({ btwId, kind: 'delta', delta: 'Partial before unmount' });
    });
    expect(latest.state.isStreaming).toBe(true);

    // Unmount while still streaming
    act(() => {
      root.unmount();
    });

    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(calls.at(-1)).toMatchObject({
      machineId: MACHINE_ID,
      params: { action: 'close', sessionId, btwId },
    });

    // Atom must synchronously settle to isStreaming=false and isOpen=false with partial text committed
    const settled = store.get(btwSessionStateAtomFamily(sessionId));
    expect(settled.isOpen).toBe(false);
    expect(settled.isStreaming).toBe(false);
    expect(settled.streamingText).toBe('');
    expect(settled.turns.at(-1)).toMatchObject({
      role: 'assistant',
      text: 'Partial before unmount',
      cancelled: true,
    });

    // Late resolution of abandoned promise must be ignored
    await act(async () => {
      pendingAsk.resolve({ btwId, text: 'late-stale-text' });
      await ask1;
    });

    // Remounting the same session immediately permits a fresh question
    root = createRoot(container);
    act(() => {
      root.render(
        <Provider store={store}>
          <Harness />
        </Provider>
      );
    });
    expect(latest.state.isOpen).toBe(false);
    expect(latest.state.isStreaming).toBe(false);
    await act(async () => {
      await latest.ask('Follow-up after reopen');
    });
    expect(latest.state.isStreaming).toBe(false);
    expect(latest.state.turns.at(-1)?.text).toBe('reopened-ok');
  });

  it('closes the original session/machine/btwId and settles the origin atom when sessionId prop switches', async () => {
    const store = createStore();
    const sessionA = 'session-btw-switch-a' as SessionId;
    const sessionB = 'session-btw-switch-b' as SessionId;
    const machineA = 'machine-switch-a' as MachineId;
    const machineB = 'machine-switch-b' as MachineId;

    const calls: Array<{ machineId: MachineId; params: SessionBtwRequest }> = [];
    const pendingAskA = createDeferred<SessionBtwResponse | null>();

    const requestSessionBtw = vi.fn((machineId: MachineId, params: SessionBtwRequest) => {
      calls.push({ machineId, params });
      if (params.action === 'ask') return pendingAskA.promise;
      return Promise.resolve({ btwId: params.btwId, text: '' });
    });

    store.set(runtimeAtom, { requestSessionBtw } as unknown as WorkspaceRuntime);

    let latest!: BtwController;
    function Harness({ sid, mid }: { sid: SessionId; mid: MachineId }) {
      latest = useBtwController({
        sessionId: sid,
        machineId: mid,
        agentType: 'claude',
        isVisible: true,
      });
      return null;
    }

    act(() => {
      root.render(
        <Provider store={store}>
          <Harness sid={sessionA} mid={machineA} />
        </Provider>
      );
    });

    let askA!: Promise<void>;
    act(() => {
      askA = latest.ask('Question on A');
    });
    const btwIdA = calls[0]!.params.btwId;
    expect(store.get(btwSessionStateAtomFamily(sessionA)).isStreaming).toBe(true);

    // Switch same hook instance to sessionB / machineB while sessionA is still streaming
    act(() => {
      root.render(
        <Provider store={store}>
          <Harness sid={sessionB} mid={machineB} />
        </Provider>
      );
    });

    // Close RPC MUST target original (machineA, sessionA, btwIdA), NOT (machineB, btwIdB)
    expect(calls.at(-1)).toEqual({
      machineId: machineA,
      params: { action: 'close', sessionId: sessionA, btwId: btwIdA },
    });
    expect(store.get(btwSessionStateAtomFamily(sessionA)).isStreaming).toBe(false);
    expect(store.get(btwSessionStateAtomFamily(sessionB)).isStreaming).toBe(false);

    await act(async () => {
      pendingAskA.resolve({ btwId: btwIdA, text: 'stale' });
      await askA;
    });
  });

  it('restores underlying File Viewer context automatically when a higher-priority Article closes', () => {
    const store = createStore();
    const sessionId = 'session-btw-context-stack' as SessionId;

    // File Viewer mounts with priority 1
    store.set(upsertBtwArticleContextAtom, {
      sessionId,
      payload: {
        path: 'src/viewer-file.ts',
        excerpt: 'export const viewer = 1;',
        ownerId: 'viewer-1',
        priority: 1,
      },
    });
    expect(store.get(activeBtwArticleContextAtomFamily(sessionId))?.path).toBe(
      'src/viewer-file.ts'
    );

    // Article opens on top with priority 2 -> becomes active
    store.set(upsertBtwArticleContextAtom, {
      sessionId,
      payload: {
        path: 'files/btw-drawer/design.md',
        excerpt: '# Design Doc',
        ownerId: 'article-1',
        priority: 2,
      },
    });
    expect(store.get(activeBtwArticleContextAtomFamily(sessionId))?.path).toBe(
      'files/btw-drawer/design.md'
    );

    // Closing Article removes only ownerId='article-1' -> seamlessly restores File Viewer!
    store.set(removeBtwArticleContextAtom, { sessionId, ownerId: 'article-1' });
    expect(store.get(activeBtwArticleContextAtomFamily(sessionId))).toMatchObject({
      path: 'src/viewer-file.ts',
      ownerId: 'viewer-1',
      priority: 1,
    });

    // Closing File Viewer clears context to null
    store.set(removeBtwArticleContextAtom, { sessionId, ownerId: 'viewer-1' });
    expect(store.get(activeBtwArticleContextAtomFamily(sessionId))).toBeNull();
  });

  it('preserves user readOnlyTools toggle made mid-stream when the in-flight response settles', async () => {
    const store = createStore();
    const sessionId = 'session-btw-midstream-toggle' as SessionId;
    const pendingAsk = createDeferred<SessionBtwResponse | null>();
    const requestSessionBtw = vi.fn((_machineId: MachineId, params: SessionBtwRequest) => {
      if (params.action === 'ask') {
        return pendingAsk.promise;
      }
      return Promise.resolve({ btwId: params.btwId, text: '' });
    });
    store.set(runtimeAtom, { requestSessionBtw } as unknown as WorkspaceRuntime);

    let latest!: BtwController;
    function Harness() {
      latest = useBtwController({
        sessionId,
        machineId: MACHINE_ID,
        agentType: 'antigravity',
        isVisible: true,
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

    act(() => {
      latest.toggleReadOnlyTools();
    });
    expect(latest.state.readOnlyTools).toBe(true);

    let askPromise!: Promise<void>;
    act(() => {
      askPromise = latest.ask('Inspect file');
    });
    const btwId = requestSessionBtw.mock.calls[0]![1].btwId;

    // User turns readOnlyTools OFF while the old read-only response is still in flight
    act(() => {
      latest.toggleReadOnlyTools();
    });
    expect(latest.state.readOnlyTools).toBe(false);

    await act(async () => {
      pendingAsk.resolve({ btwId, text: 'done', readOnlyTools: true });
      await askPromise;
    });

    // Old response must NOT flip readOnlyTools back to true
    expect(latest.state.readOnlyTools).toBe(false);
  });

  it('closes /btw back to main conversation when hidden (tab switch) while preserving history and live background stream', async () => {
    const store = createStore();
    const sessionId = 'session-btw-tab-hide' as SessionId;
    const pendingAsk = createDeferred<SessionBtwResponse | null>();
    const requestSessionBtw = vi.fn((_machineId: MachineId, params: SessionBtwRequest) => {
      if (params.action === 'ask') return pendingAsk.promise;
      return Promise.resolve({ btwId: params.btwId, text: '' });
    });
    store.set(runtimeAtom, { requestSessionBtw } as unknown as WorkspaceRuntime);

    let latest!: BtwController;
    function Harness({ isVisible }: { readonly isVisible: boolean }) {
      latest = useBtwController({
        sessionId,
        machineId: MACHINE_ID,
        agentType: 'antigravity',
        isVisible,
      });
      return null;
    }

    act(() => {
      root.render(
        <Provider store={store}>
          <Harness isVisible />
        </Provider>
      );
    });

    let askPromise!: Promise<void>;
    act(() => {
      askPromise = latest.ask('Background question');
    });
    const btwId = requestSessionBtw.mock.calls[0]![1].btwId;
    expect(latest.state.isOpen).toBe(true);
    expect(latest.state.isStreaming).toBe(true);

    // Switch away to another tab (`isVisible: true -> false`): closes /btw to main view,
    // does NOT abort the background stream, and preserves turns & btwId.
    act(() => {
      root.render(
        <Provider store={store}>
          <Harness isVisible={false} />
        </Provider>
      );
    });
    expect(latest.state.isOpen).toBe(false);
    expect(latest.state.isStreaming).toBe(true);
    expect(latest.state.btwId).toBe(btwId);
    expect(latest.state.turns).toHaveLength(1);

    // Stream completes while tab is hidden -> marks hasUnread = true without reopening /btw
    await act(async () => {
      pendingAsk.resolve({ btwId, text: 'Completed in background' });
      await askPromise;
    });
    expect(latest.state.isOpen).toBe(false);
    expect(latest.state.isStreaming).toBe(false);
    expect(latest.state.hasUnread).toBe(true);
    expect(latest.state.turns).toHaveLength(2);

    // Switching back to the tab lands on main conversation with unread indicator preserved
    act(() => {
      root.render(
        <Provider store={store}>
          <Harness isVisible />
        </Provider>
      );
    });
    expect(latest.state.isOpen).toBe(false);
    expect(latest.state.hasUnread).toBe(true);
    expect(latest.completedTurnCount).toBe(1);

    // Clicking toggle reopens /btw with full history and clears unread
    act(() => {
      latest.toggleOpen();
    });
    expect(latest.state.isOpen).toBe(true);
    expect(latest.state.hasUnread).toBe(false);
    expect(latest.state.turns.at(-1)?.text).toBe('Completed in background');
  });

  it('defaults to main conversation after unmount and remount while preserving turns and btwId', async () => {
    const store = createStore();
    const sessionId = 'session-btw-remount-main' as SessionId;
    const requestSessionBtw = vi.fn((_machineId: MachineId, params: SessionBtwRequest) =>
      Promise.resolve({ btwId: params.btwId, text: 'Preserved answer' })
    );
    store.set(runtimeAtom, { requestSessionBtw } as unknown as WorkspaceRuntime);

    let latest!: BtwController;
    function Harness() {
      latest = useBtwController({
        sessionId,
        machineId: MACHINE_ID,
        agentType: 'claude',
        isVisible: true,
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

    await act(async () => {
      await latest.ask('Keep my history');
    });
    const originalBtwId = latest.state.btwId;
    expect(latest.state.isOpen).toBe(true);
    expect(latest.state.turns).toHaveLength(2);

    // Navigate away to another session (unmount)
    act(() => {
      root.unmount();
    });
    const afterLeave = store.get(btwSessionStateAtomFamily(sessionId));
    expect(afterLeave.isOpen).toBe(false);
    expect(afterLeave.btwId).toBe(originalBtwId);
    expect(afterLeave.turns).toHaveLength(2);

    // Re-enter the session (remount) -> opens on main conversation with turns preserved
    root = createRoot(container);
    act(() => {
      root.render(
        <Provider store={store}>
          <Harness />
        </Provider>
      );
    });
    expect(latest.state.isOpen).toBe(false);
    expect(latest.state.btwId).toBe(originalBtwId);
    expect(latest.completedTurnCount).toBe(1);
    expect(latest.state.turns).toHaveLength(2);
  });

  it('keeps explicit openBtwWithSelectionAtom open and focuses composer when triggered while hidden or pre-mount', () => {
    const store = createStore();
    const sessionId = 'session-btw-explicit-open' as SessionId;
    const onFocusComposer = vi.fn();
    const originalRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as typeof window.requestAnimationFrame;

    try {
      let latest!: BtwController;
      function Harness({ isVisible }: { readonly isVisible: boolean }) {
        latest = useBtwController({
          sessionId,
          machineId: MACHINE_ID,
          agentType: 'antigravity',
          isVisible,
          onFocusComposer,
        });
        return null;
      }

      // Mount hidden (e.g. Board thread covered by File Viewer tab), then explicitly quote into /btw
      act(() => {
        root.render(
          <Provider store={store}>
            <Harness isVisible={false} />
          </Provider>
        );
      });
      act(() => {
        store.set(openBtwWithSelectionAtom, {
          sessionId,
          selection: { path: 'docs/spec.md', text: 'important paragraph' },
        });
      });
      expect(latest.state.isOpen).toBe(true);
      expect(onFocusComposer).not.toHaveBeenCalled();

      // Returning to that session MUST keep /btw open and focus composer
      act(() => {
        root.render(
          <Provider store={store}>
            <Harness isVisible />
          </Provider>
        );
      });
      expect(latest.state.isOpen).toBe(true);
      expect(latest.state.pendingSelection?.text).toBe('important paragraph');
      expect(onFocusComposer).toHaveBeenCalledTimes(1);

      // Pre-mount explicit open also stays open and focuses on mount
      const sessionId2 = 'session-btw-premount-open' as SessionId;
      const onFocus2 = vi.fn();
      store.set(openBtwForSessionAtom, sessionId2);
      const container2 = document.createElement('div');
      document.body.append(container2);
      const root2 = createRoot(container2);
      let latest2!: BtwController;
      function Harness2() {
        latest2 = useBtwController({
          sessionId: sessionId2,
          machineId: MACHINE_ID,
          agentType: 'antigravity',
          isVisible: true,
          onFocusComposer: onFocus2,
        });
        return null;
      }
      try {
        act(() => {
          root2.render(
            <Provider store={store}>
              <Harness2 />
            </Provider>
          );
        });
        expect(latest2.state.isOpen).toBe(true);
        expect(onFocus2).toHaveBeenCalledTimes(1);
      } finally {
        act(() => root2.unmount());
        container2.remove();
      }
    } finally {
      window.requestAnimationFrame = originalRaf;
    }
  });

  it('clears btwDraftAtomFamily on clearAndClose and yields Escape to active search bar or open menu', () => {
    const store = createStore();
    const sessionId = 'session-btw-clear-and-escape' as SessionId;

    let latest!: BtwController;
    function Harness() {
      latest = useBtwController({
        sessionId,
        machineId: MACHINE_ID,
        agentType: 'claude',
        isVisible: true,
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
    act(() => {
      latest.open();
      store.set(btwDraftAtomFamily(sessionId), 'unsent draft');
    });
    expect(store.get(btwDraftAtomFamily(sessionId))).toBe('unsent draft');

    // Escape inside a search bar yields to search
    const searchEl = document.createElement('div');
    searchEl.setAttribute('role', 'search');
    const searchInput = document.createElement('input');
    searchEl.append(searchInput);
    document.body.append(searchEl);
    try {
      const evSearch = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        searchInput.dispatchEvent(evSearch);
      });
      expect(evSearch.defaultPrevented).toBe(false);
      expect(latest.state.isOpen).toBe(true);
    } finally {
      searchEl.remove();
    }

    // Escape while an open menu is mounted yields to the menu
    const menuEl = document.createElement('div');
    menuEl.setAttribute('role', 'menu');
    document.body.append(menuEl);
    try {
      const evMenu = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        document.body.dispatchEvent(evMenu);
      });
      expect(evMenu.defaultPrevented).toBe(false);
      expect(latest.state.isOpen).toBe(true);
    } finally {
      menuEl.remove();
    }

    // clearAndClose clears both state and unsent draft
    act(() => {
      latest.clearAndClose();
    });
    expect(latest.state.isOpen).toBe(false);
    expect(store.get(btwDraftAtomFamily(sessionId))).toBe('');
  });
});
