// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MachineId, MachineMeta, WorkspaceId } from '@lody/shared';
import { currentWorkspaceIdAtom } from '../src/atoms';
import { machineMetaCacheAtom } from '../src/atoms/doc-meta';
import { MachineFileActionsMenu } from '../src/components/boards/machine-file-view';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The file view's import graph reaches Monaco, which asks this of the document at load.
vi.hoisted(() => {
  document.queryCommandSupported = () => false;
});

const io = vi.hoisted(() => ({ copied: [] as string[], saved: [] as unknown[] }));
vi.mock('@/lib/clipboard', () => ({
  writeTextToClipboard: async (text: string) => {
    io.copied.push(text);
    return true;
  },
}));
vi.mock('@/lib/electron-ipc-client', () => ({
  getIpcServices: () => ({
    machineRpc: {
      saveMemberFile: async (request: unknown) => {
        io.saved.push(request);
        return { ok: true, saved: true };
      },
    },
  }),
}));

class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;
  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? '';
  }
}

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  await initI18n('en');
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.useFakeTimers();
  io.copied.length = 0;
  io.saved.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const openMenu = async () => {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="File actions"]');
  await act(async () => {
    trigger!.dispatchEvent(
      new TestPointerEvent('mousedown', { bubbles: true, button: 0, pointerType: 'mouse' })
    );
    await vi.advanceTimersByTimeAsync(40);
  });
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
};

it("offers a machine's file tab only what that machine gives: its path as a link names it, and the file", async () => {
  const store = createStore();
  store.set(currentWorkspaceIdAtom, 'lw_home' as WorkspaceId);
  store.set(machineMetaCacheAtom, {
    'machine-m-mini': { id: 'm-mini', name: 'Mac mini', lanAlias: 'mini' } as MachineMeta,
  });
  await act(async () => {
    root.render(
      <Provider store={store}>
        <MachineFileActionsMenu
          file={{ machineId: 'm-mini' as MachineId, path: '~/out/a.log' }}
          filePath="m-mini:~/out/a.log"
          leadingItems={[]}
        />
      </Provider>
    );
  });

  let items = await openMenu();
  // Nothing of the page session's: no editor, no folder, no session-relative path.
  expect(items.map((item) => item.textContent)).toEqual(['Copy file path', 'Download file']);
  await act(async () => items[0]!.click());
  expect(io.copied).toEqual(['mini:~/out/a.log']);

  items = await openMenu();
  await act(async () => items[1]!.click());
  expect(io.saved).toEqual([
    { workspaceId: 'lw_home', machineId: 'm-mini', machinePath: '~/out/a.log', fileName: 'a.log' },
  ]);
});
