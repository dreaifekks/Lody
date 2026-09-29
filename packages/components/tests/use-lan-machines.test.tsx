// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LanMachine,
  LanMachines,
  LocalProjectControlRequest,
  LocalProjectControlResponse,
  WorkspaceId,
} from '@lody/shared';

import { currentWorkspaceIdAtom } from '../src/atoms/workspace-context';
import { useLanMachines, type LanMachinesControl } from '../src/hooks/use-lan-machines';

const shell = vi.hoisted(() => ({
  requests: [] as unknown[],
  answer: (_request: unknown): unknown => null,
}));
vi.mock('@/lib/electron', () => ({ isElectronRenderer: () => true }));
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

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const machine = (overrides: Partial<LanMachine> & { machineId: string }): LanMachine => ({
  name: overrides.machineId,
  os: 'linux',
  self: false,
  online: true,
  lans: [{ workspaceId: 'lw_home', name: 'Home' }],
  version: '0.100.0-lan.4',
  build: null,
  update: null,
  controllable: true,
  agents: [],
  ...overrides,
});
const desk = machine({ machineId: 'desk', self: true });
const server = machine({ machineId: 'server' });

const inventory = (machines: LanMachine[]): LocalProjectControlResponse => ({
  ok: true,
  type: 'lan/machines',
  result: { machines, newest: null } satisfies LanMachines,
});

describe('asking the machines of the LANs', () => {
  let container: HTMLDivElement;
  let root: Root;
  let control: LanMachinesControl;
  let listed: LanMachine[];
  let answers: Map<string, LocalProjectControlResponse>;

  function Probe() {
    control = useLanMachines();
    return null;
  }

  const sent = (type: string) =>
    (shell.requests as LocalProjectControlRequest[]).filter((request) => request.type === type);

  beforeEach(async () => {
    vi.useFakeTimers();
    shell.requests.length = 0;
    listed = [desk, server];
    answers = new Map();
    shell.answer = (request) => {
      const { type } = request as LocalProjectControlRequest;
      return type === 'lan/machines' ? inventory(listed) : (answers.get(type) ?? null);
    };
    const store = createStore();
    store.set(currentWorkspaceIdAtom, 'lw_home' as WorkspaceId);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <Provider store={store}>
          <Probe />
        </Provider>
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('lists the machines and keeps the list current', async () => {
    expect(control.loading).toBe(false);
    expect(control.inventory?.machines.map((entry) => entry.machineId)).toEqual([
      'desk',
      'server',
    ]);
    expect(sent('lan/machines')).toEqual([{ type: 'lan/machines', machineId: '' }]);

    listed = [desk];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(control.inventory?.machines).toHaveLength(1);
  });

  it('follows a machine that updates more closely', async () => {
    listed = [
      desk,
      machine({
        machineId: 'server',
        update: { phase: 'installing', version: '0.100.0-lan.5', at: 1 },
      }),
    ];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    const before = sent('lan/machines').length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(sent('lan/machines').length - before).toBe(2);
  });

  it('keeps what the agent service said while it is away', async () => {
    shell.answer = () => null;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(control.inventory?.machines).toHaveLength(2);
  });

  it('asks this machine itself and another member through the agent service', async () => {
    answers.set('lan/install-agent', {
      ok: true,
      type: 'lan/install-agent',
      result: { agentType: 'codex', outcome: 'started' },
    });
    answers.set('lan/forward', {
      ok: true,
      type: 'lan/forward',
      result: {
        response: {
          ok: true,
          type: 'lan/update-machine',
          result: { outcome: 'started', version: '0.100.0-lan.5' },
        },
      },
    });

    let own;
    let member;
    await act(async () => {
      own = await control.installAgent(desk, 'codex');
      member = await control.updateMachine(server);
    });

    expect(own).toEqual({ ok: true, result: { agentType: 'codex', outcome: 'started' } });
    expect(member).toEqual({ ok: true, result: { outcome: 'started', version: '0.100.0-lan.5' } });
    expect(sent('lan/install-agent')).toEqual([
      { type: 'lan/install-agent', agentType: 'codex', machineId: '', workspaceId: 'lw_home' },
    ]);
    expect(sent('lan/forward')).toEqual([
      {
        type: 'lan/forward',
        machineId: '',
        request: { type: 'lan/update-machine', machineId: 'server', workspaceId: 'lw_home' },
      },
    ]);
  });

  it('says why a machine refused, and that one did not answer', async () => {
    answers.set('lan/forward', {
      ok: true,
      type: 'lan/forward',
      result: {
        response: {
          ok: false,
          type: 'lan/update-machine',
          error: 'execution_failed',
          message: 'The desktop application updates this agent service',
          data: { reason: 'desktop' },
        },
      },
    });
    let refused;
    await act(async () => {
      refused = await control.updateMachine(server);
    });
    expect(refused).toEqual({
      ok: false,
      message: 'The desktop application updates this agent service',
      reason: 'desktop',
    });

    answers.set('lan/forward', {
      ok: false,
      type: 'lan/forward',
      error: 'daemon_unavailable',
      message: 'Local CLI daemon is unavailable.',
    });
    let silent;
    await act(async () => {
      silent = await control.previewHostedImport(server);
    });
    expect(silent).toEqual({ ok: false, message: 'Local CLI daemon is unavailable.', reason: null });

    let unreachable;
    await act(async () => {
      unreachable = await control.updateMachine(machine({ machineId: 'lost', lans: [] }));
    });
    expect(unreachable).toMatchObject({ ok: false, reason: null });
    expect(sent('lan/forward')).toHaveLength(2);
  });
});
