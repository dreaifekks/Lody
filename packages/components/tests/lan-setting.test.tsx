// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ElectronLanFailure,
  ElectronLanState,
  ElectronLanSummary,
} from '@lody/shared/electron-ipc';

import { LanSettingView, type LanSettingViewProps } from '../src/components/settings/lan-setting';
import { initI18n } from '../src/i18n';

const toasts = vi.hoisted(() => ({ success: [] as string[], error: [] as string[] }));
vi.mock('@/lib/toast', () => ({
  toast: {
    success: (message: string) => toasts.success.push(message),
    error: (message: string) => toasts.error.push(message),
  },
}));
const clipboard = vi.hoisted(() => ({ written: [] as string[], works: true }));
vi.mock('@/lib/clipboard', () => ({
  writeTextToClipboard: async (text: string) => {
    if (clipboard.works) clipboard.written.push(text);
    return clipboard.works;
  },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const lan = (id: string, name: string, url: string): ElectronLanSummary => ({
  id: id.repeat(32),
  name,
  url,
  slug: name.toLowerCase(),
  workspaceId: `lw_${id.repeat(32)}`,
  userId: `local:${id.repeat(32)}`,
});

const home = lan('a', 'Home', 'http://100.64.0.1:8788');
const office = lan('b', 'Office', 'https://hub.example.com');

const stateWith = (overrides: Partial<ElectronLanState> = {}): ElectronLanState => ({
  editable: true,
  error: null,
  machineName: { name: 'macbook', explicit: false },
  lans: [home, office],
  ...overrides,
});

describe('LAN settings', () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: Array<[string, unknown]>;
  let answer: { ok: true } | ElectronLanFailure;

  const render = async (overrides: Partial<LanSettingViewProps> = {}) => {
    const record =
      (name: string) =>
      async (input: unknown): Promise<{ ok: true } | ElectronLanFailure> => {
        calls.push([name, input]);
        return answer;
      };
    await act(async () => {
      root.render(
        <LanSettingView
          state={stateWith()}
          reachability={{ [home.id]: 'reachable', [office.id]: 'unreachable' }}
          servedWorkspaceIds={new Set([home.workspaceId, office.workspaceId])}
          join={record('join')}
          add={record('add')}
          update={record('update')}
          remove={record('remove')}
          setMachineName={record('setMachineName')}
          getInvite={async (input) => {
            calls.push(['getInvite', input]);
            return 'lody-lan://secret@100.64.0.1:8788/Home';
          }}
          {...overrides}
        />
      );
    });
  };

  const text = () => document.body.textContent ?? '';
  const button = (label: string): HTMLButtonElement => {
    const found = [...document.body.querySelectorAll('button')].find(
      (candidate) =>
        candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label
    );
    if (!found) throw new Error(`No button "${label}" in: ${text()}`);
    return found;
  };
  const click = async (label: string) => {
    await act(async () => {
      button(label).click();
    });
  };
  const field = (label: string): HTMLInputElement => {
    const found = [...document.body.querySelectorAll('label')].find(
      (candidate) => candidate.textContent?.trim() === label
    );
    // A field its tab names carries the name itself.
    const input = found
      ? document.getElementById(found.htmlFor)
      : document.body.querySelector(`input[aria-label="${label}"]`);
    if (!(input instanceof HTMLInputElement)) throw new Error(`No field "${label}" in: ${text()}`);
    return input;
  };
  const type = async (label: string, value: string) => {
    const input = field(label);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const submit = async () => {
    const form = document.body.querySelector('form');
    if (!form) throw new Error(`No form in: ${text()}`);
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
  };

  beforeEach(async () => {
    await initI18n('en');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    calls = [];
    answer = { ok: true };
    toasts.success.length = 0;
    toasts.error.length = 0;
    clipboard.written.length = 0;
    clipboard.works = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
  });

  it('lists every LAN with where it is reached and whether it answers', async () => {
    await render();

    expect(text()).toContain('Home');
    expect(text()).toContain('http://100.64.0.1:8788');
    // A LAN that answers is the resting state: only one that does not is marked.
    expect(text()).not.toContain('Connected');
    expect(text()).toContain('Office');
    expect(text()).toContain('https://hub.example.com');
    expect(text()).toContain('Unreachable');
  });

  it('shows a LAN as starting until the agent service serves its workspace', async () => {
    await render({ servedWorkspaceIds: new Set([home.workspaceId]) });

    expect(text()).toContain('Starting');
    // What the host answers says nothing while this machine is not in the LAN yet.
    expect(text()).not.toContain('Unreachable');
  });

  it('invites to join or host a LAN while there is none', async () => {
    await render({ state: stateWith({ lans: [] }) });
    expect(text()).toContain('This machine belongs to no LAN');
    expect(text()).toContain('lody lan up');
  });

  it('joins a LAN with its invite and closes the editor', async () => {
    await render();
    await click('Join a LAN');
    await type('Invite', '  lody-lan://token@10.0.0.1:8788/Garage ');
    await type('Name', 'Workshop');
    await submit();

    expect(calls).toEqual([
      ['join', { invite: 'lody-lan://token@10.0.0.1:8788/Garage', name: 'Workshop' }],
    ]);
    expect(document.body.querySelector('form')).toBeNull();
  });

  it('joins a LAN by address and token, leaving the name to the shell', async () => {
    await render();
    await click('Join a LAN');
    await click('Address and token');
    await type('Address', '10.0.0.1:8788');
    await type('Token', 'secret-token');
    await submit();

    expect(calls).toEqual([['add', { url: '10.0.0.1:8788', token: 'secret-token', name: null }]]);
  });

  it.each<[ElectronLanFailure['code'], string]>([
    ['invalid_invite', 'This is not a LAN invite. An invite starts with lody-lan://.'],
    ['invalid_url', 'The address is not valid. Use something like 100.64.0.1:8788.'],
    ['invalid_token', 'The token is not valid.'],
    ['invalid_name', 'The name is empty or too long.'],
    ['invalid_input', 'The request is not valid.'],
    ['duplicate_name', 'Another LAN already has this name.'],
    ['duplicate_hub', 'This machine already belongs to this LAN.'],
    ['unknown_hub', 'This LAN no longer exists.'],
    ['not_editable', 'The LAN of this machine is set by its environment.'],
    ['write_failed', 'The LAN settings could not be saved.'],
    ['unavailable', 'LANs are not available here.'],
  ])('explains %s and keeps the editor open', async (code, message) => {
    answer = { ok: false, code, message: 'raw message of the shell' };
    await render();
    await click('Join a LAN');
    await type('Invite', 'anything');
    await submit();

    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(document.body.querySelector('form')).not.toBeNull();
  });

  it('renames and moves a LAN, and warns that moving interrupts agents', async () => {
    await render();
    await click('Edit Home');
    expect(text()).not.toContain('Agents running on this machine are interrupted');

    await type('Name', 'Flat');
    await type('Address', '192.168.1.5:8788');
    expect(text()).toContain('Agents running on this machine are interrupted');
    await submit();

    expect(calls).toEqual([['update', { id: home.id, name: 'Flat', url: '192.168.1.5:8788' }]]);
  });

  it('leaves a LAN only after confirmation', async () => {
    await render();
    await click('Leave Office');
    expect(calls).toEqual([]);
    expect(text()).toContain('This machine leaves Office');

    await click('Leave');

    expect(calls).toEqual([['remove', { id: office.id }]]);
  });

  it('copies the invite and says what holding it means', async () => {
    await render();
    await click('Copy the invite of Home');

    expect(calls).toEqual([['getInvite', { id: home.id }]]);
    expect(clipboard.written).toEqual(['lody-lan://secret@100.64.0.1:8788/Home']);
    expect(toasts.success).toEqual([
      'Invite of Home copied. Whoever has it can control every machine in this LAN.',
    ]);
    // The credential reaches the clipboard, never the page.
    expect(text()).not.toContain('secret');
  });

  it('reports an invite that could not be copied', async () => {
    clipboard.works = false;
    await render();
    await click('Copy the invite of Home');

    expect(toasts.success).toEqual([]);
    expect(toasts.error).toEqual(['The invite could not be copied.']);
  });

  it('names the machine, and follows the host name again on request', async () => {
    await render({ state: stateWith({ machineName: { name: 'Studio Mac', explicit: true } }) });
    expect(text()).toContain('Studio Mac');

    await click('Rename');
    await type('Name', 'devnuc');
    await submit();
    expect(calls).toEqual([['setMachineName', { name: 'devnuc' }]]);

    calls = [];
    await click('Rename');
    await click('Follow the host name');
    expect(calls).toEqual([['setMachineName', { name: null }]]);
  });

  it('does not offer to follow the host name to a machine that already does', async () => {
    await render();

    await click('Rename');

    expect(
      [...document.body.querySelectorAll('button')].some(
        (candidate) => candidate.textContent?.trim() === 'Follow the host name'
      )
    ).toBe(false);
  });

  it('puts the build of this application beside the name of this machine', async () => {
    await render({ application: <p>Lody OSS 0.100.0-lan.4</p> });

    const group = [...container.querySelectorAll('section')].find((section) =>
      section.textContent?.includes('macbook')
    );
    expect(group?.textContent).toContain('This machine');
    expect(group?.textContent).toContain('Lody OSS 0.100.0-lan.4');
  });

  it('allows no edit while the environment sets the LAN', async () => {
    await render({ state: stateWith({ editable: false }) });

    expect(text()).toContain('LODY_LAN_HUB_URL');
    expect(button('Join a LAN').disabled).toBe(true);
    expect(button('Rename').disabled).toBe(true);
    expect(button('Leave Home').disabled).toBe(true);
    expect(button('Edit Home').disabled).toBe(true);
    // Joining other machines stays possible.
    expect(button('Copy the invite of Home').disabled).toBe(false);
  });

  it('says that the settings file is unreadable and keeps showing the LANs in use', async () => {
    await render({ state: stateWith({ error: 'LAN config is not valid JSON' }) });

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'The LAN settings file cannot be read'
    );
    expect(text()).toContain('Home');
  });
});
