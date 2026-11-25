// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BOARD_CONTINUITY, type BoardContinuitySettings } from '@lody/shared';
import { BoardMaintenanceDivider } from '../src/components/boards/board-maintenance-divider';
import { BoardContinuityView } from '../src/components/boards/board-settings-panel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (_key: string, defaultValue?: string, options?: Record<string, unknown>) => {
      let text = typeof defaultValue === 'string' ? defaultValue : _key;
      if (options) {
        for (const [k, v] of Object.entries(options)) {
          text = text.replaceAll(`{{${k}}}`, String(v));
        }
      }
      return text;
    },
  }),
}));

const roots: Array<{ unmount: () => void; container: HTMLElement }> = [];

async function mount(element: React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  const handle = {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  roots.push(handle);
  return handle;
}

afterEach(() => {
  while (roots.length > 0) roots.pop()!.unmount();
});

describe('BoardMaintenanceDivider fold_rollover rendering', () => {
  it('renders requested, running, done (with nodeId and fold merge), failed, and interrupted labels', async () => {
    const view = await mount(
      <div>
        <BoardMaintenanceDivider
          meta={{ boardId: 'bd_1', kind: 'fold_rollover', trigger: 'manual', status: 'requested' }}
        />
        <BoardMaintenanceDivider
          meta={{ boardId: 'bd_1', kind: 'fold_rollover', trigger: 'idle', status: 'running' }}
        />
        <BoardMaintenanceDivider
          meta={{
            boardId: 'bd_1',
            kind: 'fold_rollover',
            trigger: 'idle',
            status: 'done',
            usedBefore: 168_000,
            usedAfter: 13_000,
            nodeId: 'seg_1234abcd',
          }}
        />
        <BoardMaintenanceDivider
          meta={{
            boardId: 'bd_1',
            kind: 'fold_rollover',
            trigger: 'idle',
            status: 'done',
            usedBefore: 168_000,
            usedAfter: 13_000,
            nodeId: 'seg_1234abcd',
            foldId: 'fld_5678ef90',
            foldedCount: 5,
          }}
        />
        <BoardMaintenanceDivider
          meta={{ boardId: 'bd_1', kind: 'fold_rollover', trigger: 'manual', status: 'failed' }}
        />
        <BoardMaintenanceDivider
          meta={{
            boardId: 'bd_1',
            kind: 'fold_rollover',
            trigger: 'manual',
            status: 'interrupted',
          }}
        />
      </div>
    );

    const labels = [...view.container.querySelectorAll('[role="status"]')].map((el) =>
      el.textContent?.trim()
    );
    expect(labels).toEqual([
      'Fold rollover requested · starts when the coordinator is free',
      'Rolling over context…',
      'Folded rollover · 168K → 13K · seg_1234abcd',
      'Folded rollover · 168K → 13K · seg_1234abcd · folded 5 → fld_5678ef90',
      'Fold rollover failed',
      'Fold rollover stopped',
    ]);
  });

  it('hides silent idle interrupted fold_rollover dividers', async () => {
    const view = await mount(
      <BoardMaintenanceDivider
        meta={{ boardId: 'bd_1', kind: 'fold_rollover', trigger: 'idle', status: 'interrupted' }}
      />
    );
    expect(view.container.querySelector('[role="status"]')).toBeNull();
  });
});

describe('BoardContinuityView strategy toggle', () => {
  it('switches between compact and fold_rollover strategies', async () => {
    const changes: BoardContinuitySettings[] = [];
    function Harness() {
      const [settings, setSettings] = useState<BoardContinuitySettings>(DEFAULT_BOARD_CONTINUITY);
      return (
        <BoardContinuityView
          value={settings}
          onChange={(next) => {
            changes.push(next);
            setSettings(next);
          }}
        />
      );
    }

    const view = await mount(<Harness />);
    const buttons = [...view.container.querySelectorAll<HTMLButtonElement>('button')];
    const compactBtn = buttons.find((b) => b.textContent?.trim() === 'Compact');
    const foldBtn = buttons.find(
      (b) => b.textContent?.trim() === 'Fold rollover (experimental)'
    );
    expect(compactBtn?.getAttribute('aria-pressed')).toBe('true');
    expect(foldBtn?.getAttribute('aria-pressed')).toBe('false');

    await act(async () => {
      foldBtn!.click();
    });
    expect(changes.at(-1)?.strategy).toBe('fold_rollover');
    expect(foldBtn?.getAttribute('aria-pressed')).toBe('true');
    expect(compactBtn?.getAttribute('aria-pressed')).toBe('false');

    await act(async () => {
      compactBtn!.click();
    });
    expect(changes.at(-1)?.strategy).toBe('compact');
    expect(compactBtn?.getAttribute('aria-pressed')).toBe('true');
  });
});
