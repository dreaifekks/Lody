// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ElectronUpdaterState } from '@lody/shared/electron-ipc';

import { LanAppUpdate } from '../src/components/settings/lan-app-update';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;

  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? '';
  }
}

/** A pointer pressing: Base UI opens a Select on it and picks the row it lands on. */
async function pointerClick(element: Element): Promise<void> {
  const init = { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', detail: 1 };
  await act(async () => {
    element.dispatchEvent(new TestPointerEvent('pointermove', init));
    element.dispatchEvent(new TestPointerEvent('pointerdown', init));
    element.dispatchEvent(new MouseEvent('mousedown', init));
    (element as HTMLElement).focus();
    element.dispatchEvent(new TestPointerEvent('pointerup', init));
    element.dispatchEvent(new MouseEvent('mouseup', init));
    (element as HTMLElement).click();
  });
  // Base UI finishes opening a popup in a frame that `act` does not flush.
  await act(async () => {
    for (let index = 0; index < 2; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
}

const followed = {
  repository: 'someone/Lody',
  tag: 'lan-latest',
  url: 'https://github.com/someone/Lody/releases/tag/lan-latest',
};

const updater = (overrides: Partial<ElectronUpdaterState>): ElectronUpdaterState => ({
  phase: 'idle',
  currentVersion: '0.100.0-lan.4',
  followed,
  ...overrides,
});

describe('the build of this application', () => {
  let container: HTMLDivElement;
  let root: Root;
  let asked: string[];

  const render = async (state: ElectronUpdaterState | null, updating = false) => {
    await act(async () => {
      root.render(
        <LanAppUpdate
          updater={state}
          updating={updating}
          onCheck={() => asked.push('check')}
          onFollow={(channel) => asked.push(`follow ${channel}`)}
          onUpdate={() => asked.push('update')}
          onViewChanges={() => asked.push('changes')}
        />
      );
    });
  };
  const button = (label: string): HTMLButtonElement | undefined =>
    [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label
    );
  const click = async (label: string) => {
    await act(async () => button(label)?.click());
  };

  beforeEach(async () => {
    await initI18n('en');
    asked = [];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('names the build and the releases it follows', async () => {
    await render(updater({ phase: 'up_to_date' }));

    expect(container.textContent).toContain('Lody OSS 0.100.0-lan.4');
    expect(container.textContent).toContain('Up to date · Follows someone/Lody (lan-latest)');

    await click('Check for updates');
    expect(asked).toEqual(['check']);
  });

  it('switches between the releases of the fork', async () => {
    await render(updater({ phase: 'up_to_date' }));
    const trigger = container.querySelector<HTMLElement>('[aria-label="Release followed"]');
    expect(trigger?.textContent).toContain('Stable');

    await pointerClick(trigger!);
    const dev = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => !option.closest('[hidden]') && option.textContent?.trim() === 'Dev'
    );
    await pointerClick(dev!);
    expect(asked).toEqual(['follow dev']);

    // A release of another name is followed as the build was stamped.
    await render(updater({ followed: { ...followed, tag: 'nightly' } }));
    expect(container.querySelector('[aria-label="Release followed"]')).toBeNull();
  });

  it('offers a later build and what changed in it', async () => {
    await render(updater({ phase: 'available', availableVersion: '0.100.0-lan.5' }));

    expect(container.textContent).toContain('0.100.0-lan.5 is out');
    // One statement at rest: what is on offer takes the place of where it comes from.
    expect(container.textContent).not.toContain('Follows');
    expect(button('Check for updates')).toBeUndefined();

    await click('What changed');
    await click('Update and restart');
    expect(asked).toEqual(['changes', 'update']);
  });

  it('says how far a download is and offers nothing meanwhile', async () => {
    await render(
      updater({ phase: 'downloading', availableVersion: '0.100.0-lan.5', percent: 41.6 }),
      true
    );

    expect(container.textContent).toContain('Downloading 0.100.0-lan.5: 42%');
    expect(button('Update and restart')).toBeUndefined();
    expect(button('Check for updates')?.disabled).toBe(true);
  });

  it('keeps the update on offer after it failed', async () => {
    await render(
      updater({
        phase: 'available',
        availableVersion: '0.100.0-lan.5',
        error: 'LodyOSS-lan-mac-arm64.zip is not the file the release describes',
      })
    );

    expect(container.textContent).toContain(
      'The update failed: LodyOSS-lan-mac-arm64.zip is not the file the release describes'
    );
    expect(button('Update and restart')?.disabled).toBe(false);

    await render(updater({ phase: 'error', error: 'The release did not answer' }));
    expect(container.textContent).toContain(
      'The release could not be read: The release did not answer'
    );
    expect(button('Check for updates')?.disabled).toBe(false);
  });

  it('says why an application cannot replace itself', async () => {
    await render(updater({ phase: 'disabled', disabledReason: 'not_installed' }));

    expect(container.textContent).toContain('Move it to Applications to let it update itself.');
    expect(container.querySelectorAll('button')).toHaveLength(0);

    await render(updater({ phase: 'disabled', disabledReason: 'something_new' }));
    expect(container.textContent).toContain('No build of the fork installs itself');
  });

  it('shows nothing for an application its publisher updates', async () => {
    await render({ phase: 'up_to_date', currentVersion: '0.100.0' });
    expect(container.textContent).toBe('');
    await render(null);
    expect(container.textContent).toBe('');
  });
});
