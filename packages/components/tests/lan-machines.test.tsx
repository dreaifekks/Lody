// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedConfigPreview } from '@lody/shared/hosted-config';
import type { LanMachine, LanMachines } from '@lody/shared/lan-control';

import {
  LanMachinesView,
  describeLanMachineBuild,
  type LanMachinesViewProps,
} from '../src/components/settings/lan-machines';
import { resolveLanMachineWorkspace, type LanMachineAnswer } from '../src/hooks/use-lan-machines';
import { initI18n } from '../src/i18n';

const toasts = vi.hoisted(() => ({
  success: [] as string[],
  error: [] as string[],
  info: [] as string[],
}));
vi.mock('@/lib/toast', () => ({
  toast: {
    success: (message: string) => toasts.success.push(message),
    error: (message: string) => toasts.error.push(message),
    info: (message: string) => toasts.info.push(message),
  },
}));

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

const RUNNING = '0.100.0-lan.4';
const NEWEST = '0.100.0-lan.5';
const source = { repository: 'someone/Lody', tag: 'lan-latest' };
const home = { workspaceId: 'lw_home', name: 'Home' };
const office = { workspaceId: 'lw_office', name: 'Office' };

const machine = (overrides: Partial<LanMachine> & { machineId: string }): LanMachine => ({
  name: overrides.machineId,
  alias: null,
  os: 'linux',
  self: false,
  online: true,
  lans: [home],
  version: RUNNING,
  build: { version: RUNNING, update: 'service', source },
  update: null,
  controllable: true,
  agents: [],
  ...overrides,
});

const desk = machine({
  machineId: 'desk',
  os: 'darwin',
  self: true,
  lans: [home, office],
  build: { version: RUNNING, update: 'desktop', source },
  agents: [{ agentType: 'claude', name: 'Claude Code', version: '2.1.280', state: 'current' }],
});
const server = machine({
  machineId: 'server',
  agents: [
    { agentType: 'codex', name: 'Codex', version: '0.155.0', target: '0.156.0', state: 'outdated' },
  ],
});

const inventoryOf = (machines: LanMachine[], newest: string | null = NEWEST): LanMachines => ({
  machines,
  newest: newest
    ? { version: newest, commit: 'abcdef12', builtAt: '2026-09-29T00:00:00.000Z' }
    : null,
});

const hostedPreview: HostedConfigPreview = {
  found: true,
  sources: [
    {
      workspaceId: 'hosted',
      name: 'Team',
      items: [
        { category: 'agentConfigs', id: 'codex', name: 'Codex', action: 'create' },
        { category: 'localProjects', id: 'p1', name: 'mizuki', action: 'create' },
        { category: 'localProjects', id: 'p2', name: 'lody', action: 'unchanged' },
      ],
    },
  ],
};

describe('the build of a machine', () => {
  it('is updated on request only by a service that would come back', () => {
    expect(describeLanMachineBuild(server, NEWEST)).toEqual({ state: 'available', by: 'request' });
    expect(describeLanMachineBuild(desk, NEWEST)).toEqual({
      state: 'available',
      by: 'application',
    });
    expect(
      describeLanMachineBuild(
        machine({ machineId: 'checkout', build: { version: RUNNING, update: 'manual' } }),
        NEWEST
      )
    ).toEqual({ state: 'available', by: 'hand' });
    // A service that says it updates itself but takes no requests is asked nothing.
    expect(
      describeLanMachineBuild(
        machine({ machineId: 'old', controllable: false, build: null }),
        NEWEST
      )
    ).toEqual({ state: 'available', by: 'hand' });
  });

  it('is the newest, or not one of the fork', () => {
    expect(describeLanMachineBuild(server, RUNNING)).toEqual({ state: 'newest', by: null });
    expect(describeLanMachineBuild(server, null)).toEqual({ state: 'unknown', by: null });
    expect(
      describeLanMachineBuild(machine({ machineId: 'upstream', version: '0.100.0' }), NEWEST)
    ).toEqual({ state: 'unknown', by: null });
  });

  it('says where an update stands before it says what is out', () => {
    const installing = { phase: 'installing', version: NEWEST, at: 1 } as const;
    expect(
      describeLanMachineBuild(machine({ machineId: 'busy', update: installing }), NEWEST)
    ).toEqual({ state: 'updating', by: null });
    expect(
      describeLanMachineBuild(
        machine({ machineId: 'failed', update: { ...installing, phase: 'failed' } }),
        NEWEST
      )
    ).toEqual({ state: 'failed', by: 'request' });
  });
});

describe('the workspace a machine is asked in', () => {
  it('is the LAN the window shows when the machine is in it', () => {
    expect(resolveLanMachineWorkspace(desk, 'lw_office')).toBe('lw_office');
    expect(resolveLanMachineWorkspace(server, 'lw_office')).toBe('lw_home');
    expect(resolveLanMachineWorkspace(server, null)).toBe('lw_home');
  });

  it('is the workspace the window shows for this machine without a LAN', () => {
    const alone = machine({ machineId: 'alone', self: true, lans: [] });
    expect(resolveLanMachineWorkspace(alone, 'lw_implicit')).toBe('lw_implicit');
    expect(resolveLanMachineWorkspace(alone, null)).toBeNull();
    expect(
      resolveLanMachineWorkspace(machine({ machineId: 'lost', lans: [] }), 'lw_home')
    ).toBeNull();
  });
});

describe('the machines of the LANs', () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: Array<[string, ...unknown[]]>;
  let answers: {
    update: LanMachineAnswer<{ outcome: 'started' | 'current'; version: string }>;
    install: LanMachineAnswer<{ agentType: string; outcome: 'started' | 'current' }>;
    preview: LanMachineAnswer<HostedConfigPreview>;
    alias: LanMachineAnswer<{ alias: string | null }> | null;
  };

  const render = async (inventory: LanMachines, overrides: Partial<LanMachinesViewProps> = {}) => {
    await act(async () => {
      root.render(
        <LanMachinesView
          inventory={inventory}
          updateMachine={async (target) => {
            calls.push(['update', target.machineId]);
            return answers.update;
          }}
          installAgent={async (target, agentType) => {
            calls.push(['install', target.machineId, agentType]);
            return answers.install;
          }}
          previewHostedImport={async (target) => {
            calls.push(['preview', target.machineId]);
            return answers.preview;
          }}
          setAlias={async (target, alias, color) => {
            calls.push(['alias', target.machineId, alias, color]);
            return answers.alias ?? { ok: true, result: { alias, color } };
          }}
          importHostedConfig={async (target, input) => {
            calls.push(['import', target.machineId, input]);
            return {
              ok: true,
              result: { workspaceId: 'lw_home', items: hostedPreview.sources[0]!.items },
            };
          }}
          {...overrides}
        />
      );
    });
  };

  const text = () => document.body.textContent ?? '';
  const rowOf = (name: string): HTMLElement => {
    const row = [...container.querySelectorAll<HTMLElement>('section > div > div')].find(
      (candidate) => candidate.textContent?.includes(name)
    );
    if (!row) throw new Error(`No row of ${name} in: ${text()}`);
    return row;
  };
  const buttonIn = (scope: ParentNode, label: string): HTMLButtonElement | undefined =>
    [...scope.querySelectorAll('button')].find(
      (candidate) =>
        candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label
    );
  const click = async (element: Element | undefined | null) => {
    expect(element).toBeTruthy();
    await act(async () => {
      (element as HTMLElement).click();
      await vi.advanceTimersByTimeAsync(0);
    });
  };
  const openMenuOf = async (name: string) => {
    const trigger = buttonIn(rowOf(name), `More for ${name}`);
    expect(trigger).toBeTruthy();
    await act(async () => {
      trigger?.dispatchEvent(
        new TestPointerEvent('mousedown', { bubbles: true, button: 0, pointerType: 'mouse' })
      );
      await vi.advanceTimersByTimeAsync(500);
    });
  };
  const menuItem = (label: string): HTMLElement | undefined =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
      item.textContent?.includes(label)
    );

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
    toasts.success.length = 0;
    toasts.error.length = 0;
    toasts.info.length = 0;
    calls = [];
    answers = {
      update: { ok: true, result: { outcome: 'started', version: NEWEST } },
      install: { ok: true, result: { agentType: 'codex', outcome: 'started' } },
      preview: { ok: true, result: hostedPreview },
      alias: null,
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

  it('says what each machine runs, where it is reached and what is out', async () => {
    await render(
      inventoryOf([
        desk,
        server,
        machine({ machineId: 'laptop', online: false, lans: [office] }),
        machine({ machineId: 'old', controllable: false, build: null, version: '0.100.0-lan.3' }),
      ])
    );

    const own = rowOf('desk').textContent ?? '';
    expect(own).toContain('This machine');
    expect(own).toContain(`${RUNNING} · macOS · Home, Office`);
    // This application installs what this machine runs, and offers it beside
    // its own build; a runtime an agent already runs with is not worth a word.
    expect(own).not.toContain(`${NEWEST} is out`);
    expect(own).not.toContain('Claude Code');
    expect(buttonIn(rowOf('desk'), 'Update')).toBeUndefined();

    // A machine that answers is the resting state: what is said is what is out.
    const member = rowOf('server').textContent ?? '';
    expect(member).not.toContain('Online');
    expect(member).toContain(`${NEWEST} is out`);
    expect(member).toContain('Codex 0.155.0 → 0.156.0');
    expect(buttonIn(rowOf('server'), 'Update')).toBeTruthy();

    // A machine that is away, or that would not understand, is asked nothing:
    // its row keeps the one menu, for what is set on this side.
    const asked = (name: string) =>
      [...rowOf(name).querySelectorAll('button')].map((button) =>
        button.getAttribute('aria-label')
      );
    expect(rowOf('laptop').textContent).toContain('Offline');
    expect(asked('laptop')).toEqual(['More for laptop']);
    expect(rowOf('old').textContent).toContain(
      `${NEWEST} is out. It is updated on the machine itself.`
    );
    expect(asked('old')).toEqual(['More for old']);
  });

  it('names the LANs of a machine only where they tell machines apart', async () => {
    await render(inventoryOf([server, machine({ machineId: 'spare' })]));
    expect(rowOf('server').textContent).toContain(`${RUNNING} · Linux`);
    expect(rowOf('server').textContent).not.toContain('Home');

    await render(inventoryOf([server, machine({ machineId: 'spare', lans: [home, office] })]));
    expect(rowOf('server').textContent).toContain(`${RUNNING} · Linux · Home`);
    expect(rowOf('spare').textContent).toContain(`${RUNNING} · Linux · Home, Office`);
  });

  it('says how long a machine that answers takes to, after its facts', async () => {
    await render(inventoryOf([desk, server, machine({ machineId: 'laptop', online: false })]), {
      Latency: ({ machine: of }) => <> · {of.machineId} answers</>,
    });

    expect(rowOf('desk').textContent).toContain('Home, Office · desk answers');
    expect(rowOf('server').textContent).toContain('Home · server answers');
    expect(rowOf('laptop').textContent).not.toContain('answers');
  });

  it('marks the machine that hosts the hub and the standby, and says why on hover', async () => {
    await render(
      inventoryOf([
        machine({
          ...desk,
          hub: { part: 'standby', term: 1, snapshotAt: new Date().toISOString(), rttMs: 5 },
        }),
        machine({ ...server, hub: { part: 'hub', term: 1, snapshotAt: null, rttMs: 0 } }),
        machine({
          machineId: 'laptop',
          lans: [office],
          build: { ...desk.build!, update: 'desktop' },
        }),
        machine({
          machineId: 'spare',
          hub: { part: 'candidate', term: 1, snapshotAt: null, rttMs: 9 },
        }),
      ])
    );
    // The glyph leads the row; it carries the hint, where there is one.
    const hint = (name: string) =>
      rowOf(name).querySelector('span')?.getAttribute('aria-label') ?? null;

    expect(hint('server')).toBe('Hosts the hub · Term 1');
    expect(hint('desk')).toBe('Hub standby · Copy taken 0 minutes ago · 5 ms to the hub');
    // A machine with no part in keeping the hub has nothing to say about it.
    expect(hint('laptop')).toBeNull();
    expect(hint('spare')).toBeNull();
  });

  it('says where an update stands, and how one ended that failed', async () => {
    await render(
      inventoryOf([
        machine({
          machineId: 'busy',
          update: { phase: 'installing', version: NEWEST, at: 1 },
        }),
        machine({
          machineId: 'broken',
          update: { phase: 'failed', version: NEWEST, at: 1, error: 'npm could not install' },
        }),
      ])
    );

    expect(rowOf('busy').textContent).toContain(`Installing ${NEWEST}…`);
    expect(buttonIn(rowOf('busy'), 'Update')).toBeUndefined();
    expect(rowOf('broken').textContent).toContain(
      `The update to ${NEWEST} failed. npm could not install`
    );
    expect(buttonIn(rowOf('broken'), 'Update')).toBeTruthy();
  });

  it('updates a machine once the user said so', async () => {
    await render(inventoryOf([desk, server]));

    await click(buttonIn(rowOf('server'), 'Update'));
    expect(text()).toContain('Update server?');
    expect(text()).toContain('Agents that run on it are interrupted.');
    expect(calls).toEqual([]);

    await click(buttonIn(document.body.querySelector('[role="alertdialog"]')!, 'Update'));
    expect(calls).toEqual([['update', 'server']]);
    expect(toasts.success).toEqual([`server installs ${NEWEST} and starts again when it is done.`]);
  });

  it('says why a machine refused', async () => {
    answers.update = { ok: false, message: 'already', reason: 'busy' };
    await render(inventoryOf([server]));

    await click(buttonIn(rowOf('server'), 'Update'));
    await click(buttonIn(document.body.querySelector('[role="alertdialog"]')!, 'Update'));
    expect(toasts.error).toEqual(['server is already updating.']);

    answers.update = { ok: false, message: 'the hub is away', reason: null };
    await click(buttonIn(rowOf('server'), 'Update'));
    await click(buttonIn(document.body.querySelector('[role="alertdialog"]')!, 'Update'));
    expect(toasts.error.at(-1)).toBe('server: the hub is away');
  });

  it('starts the agent service of a machine again, and removes one that is gone', async () => {
    const gone = machine({ machineId: 'old-box', online: false });
    const byHand = machine({
      machineId: 'laptop',
      build: { version: RUNNING, update: 'manual', source },
    });
    await render(inventoryOf([desk, server, gone, byHand]), {
      restartMachine: async (target) => {
        calls.push(['restart', target.machineId]);
        return { ok: true, result: { outcome: 'started' } };
      },
      removeMachine: async (target) => {
        calls.push(['remove', target.machineId]);
      },
    });

    await openMenuOf('server');
    // A machine that answers stays.
    expect(menuItem('Remove…')).toBeUndefined();
    await click(menuItem('Restart agent service…'));
    expect(text()).toContain('Restart the agent service of server?');
    expect(calls).toEqual([]);
    await click(buttonIn(document.body.querySelector('[role="alertdialog"]')!, 'Restart'));
    expect(calls).toEqual([['restart', 'server']]);
    expect(toasts.success).toEqual(['server is starting its agent service again.']);

    // Nothing would start a service run by hand again.
    await openMenuOf('laptop');
    expect(menuItem('Restart agent service…')).toBeUndefined();

    // One that is gone takes no request, and can be removed.
    await openMenuOf('old-box');
    expect(menuItem('Restart agent service…')).toBeUndefined();
    await click(menuItem('Remove…'));
    expect(text()).toContain('Remove old-box?');
    await click(buttonIn(document.body.querySelector('[role="alertdialog"]')!, 'Remove'));
    expect(calls.at(-1)).toEqual(['remove', 'old-box']);
  });

  it('installs the runtime of an agent that is behind', async () => {
    await render(inventoryOf([desk, server]));

    await openMenuOf('server');
    await click(menuItem('Update Codex to 0.156.0'));

    expect(calls).toEqual([['install', 'server', 'codex']]);
    expect(toasts.success).toEqual([
      'server downloads Codex. New sessions use it once it is there.',
    ]);

    // An agent that has what it runs with offers nothing.
    await openMenuOf('desk');
    expect(menuItem('Claude Code')).toBeUndefined();
  });

  it('imports the hosted configuration of a machine, category by category', async () => {
    await render(inventoryOf([desk, server]));

    await openMenuOf('server');
    await click(menuItem('Import from hosted Lody'));

    expect(calls).toEqual([['preview', 'server']]);
    expect(text()).toContain('Import from hosted Lody on server');
    expect(text()).toContain('From Team');
    expect(text()).toContain('New: Codex');
    expect(text()).toContain('Already here: lody');

    await click(document.body.querySelector('[aria-label="Agents (1)"]'));
    await click(buttonIn(document.body, 'Import (1)'));

    expect(calls.slice(1)).toEqual([
      ['import', 'server', { sourceWorkspaceId: 'hosted', categories: ['localProjects'] }],
      ['preview', 'server'],
    ]);
    expect(toasts.success).toEqual(['Imported: 2']);
  });

  describe('the entry editors reach a machine through', () => {
    const named = () =>
      calls.filter(([what]) => what === 'ssh').map(([, machineId, entry]) => [machineId, entry]);
    const naming: Partial<LanMachinesViewProps> = {
      onSshEntryChange: (target, entry) => calls.push(['ssh', target.machineId, entry]),
    };
    const write = async (value: string) => {
      const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] input');
      if (!input) throw new Error(`No field in: ${text()}`);
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          input,
          value
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    const save = () => buttonIn(document.body.querySelector('[role="dialog"]')!, 'Save');

    it('is named for a machine, as the configuration of this computer writes it', async () => {
      await render(inventoryOf([desk, server]), { ...naming, sshEntries: {} });

      await openMenuOf('server');
      await click(menuItem('SSH entry for editors'));
      expect(text()).toContain('SSH entry for server');
      expect(save()?.disabled).toBe(true);

      await write('  ts:home-devNuc ');
      expect(save()?.disabled).toBe(false);
      await click(save());

      expect(named()).toEqual([['server', { host: 'ts:home-devNuc' }]]);
      expect(document.body.querySelector('[role="dialog"] input')).toBeNull();
    });

    it('is kept for the machine, changed, and taken back', async () => {
      await render(inventoryOf([desk, server]), {
        ...naming,
        sshEntries: { server: 'me@nuc', desk: 'never-shown' },
      });
      // A setting of this computer is read where it is set, not in the list.
      expect(text()).not.toContain('me@nuc');
      expect(text()).not.toContain('never-shown');

      await openMenuOf('server');
      await click(menuItem('SSH entry for editors'));
      const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] input');
      expect(input?.value).toBe('me@nuc');
      // What is written already is not saved again.
      expect(save()?.disabled).toBe(true);

      await write('admin@Home-Nuc');
      await click(save());
      expect(named()).toEqual([['server', { host: 'Home-Nuc', user: 'admin' }]]);

      await openMenuOf('server');
      await click(menuItem('SSH entry for editors'));
      await write('');
      await click(save());
      expect(named().at(-1)).toEqual(['server', null]);
    });

    it('is not saved when an editor could not be handed it', async () => {
      await render(inventoryOf([server]), { ...naming, sshEntries: {} });
      await openMenuOf('server');
      await click(menuItem('SSH entry for editors'));

      for (const value of ['-oProxyCommand=id', 'two words', 'you@me@nuc', 'nuc/../x', '@nuc']) {
        await write(value);
        expect(text(), value).toContain('An editor cannot be handed this name.');
        expect(save()?.disabled, value).toBe(true);
      }
      await write('nuc');
      expect(text()).not.toContain('An editor cannot be handed this name.');
      expect(save()?.disabled).toBe(false);

      await click(buttonIn(document.body.querySelector('[role="dialog"]')!, 'Cancel'));
      expect(named()).toEqual([]);
    });

    it('is named for a machine that is away, and never for this one', async () => {
      const laptop = machine({ machineId: 'laptop', online: false });
      await render(inventoryOf([desk, laptop]), { ...naming, sshEntries: {} });

      await openMenuOf('laptop');
      expect(menuItem('SSH entry for editors')).toBeTruthy();
      // A machine that is away is asked nothing else.
      expect(menuItem('Import from hosted Lody')).toBeUndefined();
      await click(menuItem('SSH entry for editors'));
      await click(buttonIn(document.body.querySelector('[role="dialog"]')!, 'Cancel'));

      await openMenuOf('desk');
      expect(menuItem('Import from hosted Lody')).toBeTruthy();
      expect(menuItem('SSH entry for editors')).toBeUndefined();
    });
  });

  describe('the short name of a machine', () => {
    const aliased = () =>
      calls.filter(([what]) => what === 'alias').map(([, machineId, alias]) => [machineId, alias]);
    const colored = () =>
      calls
        .filter(([what]) => what === 'alias')
        .map(([, machineId, , color]) => [machineId, color]);
    const swatch = (label: string) =>
      document.body.querySelector<HTMLButtonElement>(
        `[role="dialog"] button[aria-label="${label}"]`
      );
    const field = () => document.body.querySelector<HTMLInputElement>('[role="dialog"] input');
    const write = async (value: string) => {
      const input = field();
      if (!input) throw new Error(`No field in: ${text()}`);
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          input,
          value
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    const save = () => buttonIn(document.body.querySelector('[role="dialog"]')!, 'Save');
    const nameIt = async (name: string) => {
      await openMenuOf(name);
      await click(menuItem('Short name and color'));
    };

    it('comes before the machine name, which stays beside it', async () => {
      const nas = machine({ machineId: 'nas', name: 'home-nas-ubuntu-2404', alias: 'nas' });
      await render(inventoryOf([desk, nas]));

      const title = [...rowOf('home-nas-ubuntu-2404').querySelectorAll('span > span > span')]
        .slice(0, 2)
        .map((span) => span.textContent);
      expect(title).toEqual(['nas', 'home-nas-ubuntu-2404']);
      expect(rowOf('desk').textContent).toContain('desk');
    });

    it('is given to any machine, even one that is away, and taken back', async () => {
      const laptop = machine({ machineId: 'laptop', online: false, controllable: false });
      await render(inventoryOf([desk, laptop]));

      await nameIt('laptop');
      expect(text()).toContain('Short name and color for laptop');
      expect(save()?.disabled).toBe(true);
      await write('  old   one ');
      await click(save());
      expect(aliased()).toEqual([['laptop', 'old one']]);
      expect(field()).toBeNull();

      await render(inventoryOf([desk, { ...laptop, alias: 'old one' }]));
      await nameIt('laptop');
      expect(field()?.value).toBe('old one');
      expect(save()?.disabled).toBe(true);
      await write('');
      await click(save());
      expect(aliased().at(-1)).toEqual(['laptop', null]);

      await nameIt('desk');
      await write('me');
      await click(save());
      expect(aliased().at(-1)).toEqual(['desk', 'me']);
    });

    it('gives the name a color, which the row shows, and takes it back', async () => {
      await render(inventoryOf([desk, server]));
      await nameIt('server');
      expect(swatch('No color')?.getAttribute('aria-pressed')).toBe('true');
      await click(swatch('Teal'));
      expect(swatch('Teal')?.getAttribute('aria-pressed')).toBe('true');
      // A color alone is a change worth saving; the short name stays as it was.
      expect(save()?.disabled).toBe(false);
      await click(save());
      expect(aliased().at(-1)).toEqual(['server', null]);
      expect(colored().at(-1)).toEqual(['server', 'teal']);

      await render(inventoryOf([desk, { ...server, color: 'teal' }]));
      // The name itself, not the line it leads.
      const name = [...rowOf('server').querySelectorAll<HTMLElement>('span')].find(
        (span) => span.textContent === 'server' && span.childElementCount === 0
      );
      expect(name?.style.color).toBe('hsl(var(--lan-machine-teal))');
      await nameIt('server');
      expect(swatch('Teal')?.getAttribute('aria-pressed')).toBe('true');
      expect(save()?.disabled).toBe(true);
      await click(swatch('No color'));
      await click(save());
      expect(colored().at(-1)).toEqual(['server', null]);
    });

    it('says so when it could not be given', async () => {
      answers.alias = {
        ok: false,
        message: 'No LAN of this machine has that machine',
        reason: null,
      };
      await render(inventoryOf([server]));
      await nameIt('server');
      await write('nuc');
      await click(save());
      expect(toasts.error).toEqual([
        'Could not name server: No LAN of this machine has that machine',
      ]);
    });
  });

  it('says so when a machine has no hosted installation or does not answer', async () => {
    answers.preview = { ok: true, result: { found: false, sources: [] } };
    await render(inventoryOf([server]));
    await openMenuOf('server');
    await click(menuItem('Import from hosted Lody'));
    expect(text()).toContain('No hosted Lody was found on server.');

    await click(buttonIn(document.body.querySelector('[role="dialog"]')!, 'Close'));
    answers.preview = { ok: false, message: 'server did not answer', reason: null };
    await openMenuOf('server');
    await click(menuItem('Import from hosted Lody'));
    expect(text()).toContain('server did not answer');
  });
});
