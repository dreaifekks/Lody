// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRepository } from '@lody/cloud-api';
import type {
  LanGitHubState,
  LanMachine,
  LocalProjectControlRequest,
  LocalProjectControlResponse,
  WorkspaceId,
} from '@lody/shared';

import { currentWorkspaceIdAtom } from '../src/atoms/workspace-context';
import { LocalGitHubSettings } from '../src/components/settings/local-github-settings';
import { initI18n } from '../src/i18n';

/** The agent service of this machine, as the desktop shell reaches it. */
const shell = vi.hoisted(() => ({
  requests: [] as unknown[],
  answer: (_request: unknown): unknown => null,
}));
vi.mock('@/lib/electron', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/electron')>()),
  isElectronRenderer: () => true,
}));
vi.mock('@/lib/electron-ipc-client', () => ({
  getIpcServices: () => ({
    localProjects: {
      control: async (request: unknown) => {
        shell.requests.push(request);
        return shell.answer(request);
      },
    },
  }),
}));
/** What the credential of this desktop reads on GitHub. */
const github = vi.hoisted(() => ({ repositories: [] as WorkspaceRepository[] }));
vi.mock('@/lib/local-github-repositories', () => ({
  listLocalGitHubRepositories: async () => github.repositories,
  forgetLocalGitHubRepositories: () => {},
}));
vi.mock('@/lib/toast', () => ({ toast: { error: () => {}, success: () => {} } }));

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

const HOME = 'lw_home';
const machine = (overrides: Partial<LanMachine> & { machineId: string }): LanMachine => ({
  name: overrides.machineId,
  alias: null,
  os: 'linux',
  self: false,
  online: true,
  lans: [{ workspaceId: HOME, name: 'Home' }],
  version: '0.103.0-lan.35',
  build: null,
  update: null,
  controllable: true,
  agents: [],
  ...overrides,
});
const repository = (fullName: string): WorkspaceRepository => ({
  id: fullName.length,
  name: fullName.split('/')[1]!,
  fullName,
  private: fullName.includes('secret'),
  description: null,
});

describe('Settings > GitHub on a LAN', () => {
  let container: HTMLDivElement;
  let root: Root;
  let machines: LanMachine[];
  let states: Record<string, LanGitHubState>;
  /** What the hub keeps, as the agent service hands it over. */
  let hubToken: string | null;

  const render = async () => {
    const store = createStore();
    store.set(currentWorkspaceIdAtom, HOME as WorkspaceId);
    await act(async () => {
      root.render(
        <Provider store={store}>
          <LocalGitHubSettings />
        </Provider>
      );
      await vi.advanceTimersByTimeAsync(0);
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
  const click = async (element: HTMLElement) => {
    await act(async () => {
      element.click();
      await vi.advanceTimersByTimeAsync(0);
    });
  };
  const openMenu = async (label: string) => {
    await act(async () => {
      button(label).dispatchEvent(
        new TestPointerEvent('mousedown', { bubbles: true, button: 0, pointerType: 'mouse' })
      );
      await vi.advanceTimersByTimeAsync(500);
    });
  };
  const menuItem = (label: string): HTMLElement => {
    const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
      item.textContent?.includes(label)
    );
    if (!found) throw new Error(`No menu item "${label}"`);
    return found;
  };
  const typeToken = async (value: string) => {
    const input = document.body.querySelector<HTMLInputElement>('input[type="password"]');
    if (!input) throw new Error(`No token field in: ${text()}`);
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
      await vi.advanceTimersByTimeAsync(0);
    });
  };
  const sent = (type: string) =>
    (shell.requests as LocalProjectControlRequest[]).filter((request) => request.type === type);

  beforeEach(async () => {
    vi.useFakeTimers();
    await initI18n('en');
    Object.defineProperty(globalThis, 'PointerEvent', {
      configurable: true,
      value: TestPointerEvent,
    });
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
    shell.requests.length = 0;
    hubToken = 'github_pat_hub';
    machines = [
      machine({ machineId: 'desk', self: true }),
      machine({ machineId: 'server', alias: 'nas' }),
      machine({ machineId: 'laptop', online: false }),
      machine({ machineId: 'old' }),
    ];
    states = {
      desk: { own: null, lan: { login: 'octocat' } },
      server: { own: { login: 'me' }, lan: { login: 'octocat' } },
    };
    github.repositories = [repository('octocat/lody'), repository('octocat/secret-notes')];
    shell.answer = (raw) => {
      const request = raw as LocalProjectControlRequest;
      if (request.type === 'lan/machines') {
        return { ok: true, type: 'lan/machines', result: { machines, newest: null } };
      }
      if (request.type === 'lan/github-token') {
        if (request.token === 'github_pat_typo') {
          return {
            ok: false,
            type: request.type,
            error: 'execution_failed',
            message: 'GitHub does not accept this token',
          };
        }
        hubToken = request.token;
        for (const state of Object.values(states)) {
          state.lan = hubToken ? { login: 'hubber' } : null;
        }
        return { ok: true, type: request.type, result: { login: hubToken ? 'hubber' : null } };
      }
      const asked = request.type === 'lan/forward' ? request.request : request;
      if (asked.type !== 'lan/github') return null;
      const machineId = asked.machineId === '' ? 'desk' : asked.machineId;
      const state = states[machineId];
      const answer: LocalProjectControlResponse = state
        ? { ok: true, type: 'lan/github', result: structuredClone(state) }
        : { ok: false, type: 'lan/github', error: 'execution_failed', message: 'did not answer' };
      return request.type === 'lan/forward'
        ? { ok: true, type: 'lan/forward', result: { response: answer } }
        : answer;
    };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('shows whose token the hub keeps, the credential each machine uses and what it reads', async () => {
    await render();

    expect(text()).toContain('LAN token@octocat');
    expect(text()).toContain('deskLAN token · @octocat');
    // A machine's own gh login comes before the LAN's token.
    expect(text()).toContain('nasgh login · @me');
    expect(text()).toContain('laptopOffline');
    expect(text()).toContain('oldNo answer');
    expect(text()).toContain('lody');
    expect(text()).toContain('secret-notes');
    // An offline machine is not asked, and nothing is asked twice.
    expect(
      sent('lan/forward').map(
        (request) => request.type === 'lan/forward' && request.request.machineId
      )
    ).toEqual(['server', 'old']);
  });

  it('replaces the token through the agent service and never shows it', async () => {
    await render();
    github.repositories = [repository('hubber/tools')];

    await openMenu('LAN token');
    await click(menuItem('Replace token'));
    await typeToken('github_pat_typo');
    await submit();
    expect(text()).toContain('GitHub does not accept this token');

    await typeToken('  github_pat_new ');
    await submit();

    expect(sent('lan/github-token').at(-1)).toEqual({
      type: 'lan/github-token',
      machineId: '',
      workspaceId: HOME,
      token: 'github_pat_new',
    });
    expect(document.body.querySelector('form')).toBeNull();
    expect(text()).toContain('LAN token@hubber');
    // The pickers read what the new token reads.
    expect(text()).toContain('tools');
    expect(document.body.innerHTML).not.toContain('github_pat');
  });

  it('removes the token after asking, and offers to set one again', async () => {
    await render();

    await openMenu('LAN token');
    await click(menuItem('Remove token'));
    await click(button('Remove token'));

    expect(sent('lan/github-token').at(-1)).toMatchObject({ token: null });
    expect(text()).toContain('LAN tokenNot set');
    expect(button('Set token')).toBeTruthy();
    expect(text()).toContain('deskNo credential');
  });

  it('keeps no token row for a workspace no LAN carries', async () => {
    machines = [machine({ machineId: 'desk', self: true, lans: [] })];
    states = { desk: { own: { login: 'me' }, lan: null } };
    await render();

    expect(text()).not.toContain('LAN token');
    expect(text()).toContain('deskgh login · @me');
  });
});
