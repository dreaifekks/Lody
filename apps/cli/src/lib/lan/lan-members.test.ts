import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import {
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  getMachineRoomId,
  type AgentConfigId,
  type AgentConfigMeta,
  type LanMemberControlRequest,
  type LocalProjectControlResponse,
  type MachineId,
  type MachineMeta,
  type WorkspaceId,
} from '@lody/shared';
import type {
  LanMachineBuild,
  LanReleaseManifest,
  LanReleaseSource,
} from '@lody/shared/lan-release';
import type { ManagedRuntimeStatus } from '@/agent/managed-agent-runtime';
import { upsertMachineAgentConfig } from '@/lib/agent-config-machine-flock';
import type { Logger } from '@/utils/logger';
import { LanMachineControl, type LanMachineControlOptions } from './lan-machine-control';
import {
  answerLanMemberControl,
  forwardLanMemberControl,
  listLanMachines,
  publishLanMachineFacts,
  type LanMemberWorkspace,
} from './lan-members';

const silentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  setDebug: () => {},
  child: () => silentLogger(),
  close: async () => {},
});

const THIS = 'machine-desk' as MachineId;
const SERVER = 'machine-server' as MachineId;
const LAPTOP = 'machine-laptop' as MachineId;
const HOME = 'lw_home' as WorkspaceId;
const OFFICE = 'lw_office' as WorkspaceId;
const HOME_USER = 'local:home';
const OFFICE_USER = 'local:office';
const RUNNING = '0.100.0-lan.4';
const source: LanReleaseSource = { repository: 'someone/Lody', tag: 'lan-latest' };

const newest: LanReleaseManifest = {
  version: '0.100.0-lan.5',
  commit: 'cccccccccccccccccccccccccccccccccccccccc',
  repository: source.repository,
  tag: source.tag,
  builtAt: '2026-09-29T00:00:00.000Z',
  assets: [],
};

const installed = (version: string, target = version): ManagedRuntimeStatus => ({
  kind: 'installed',
  platformArch: 'linux-x64',
  version,
  targetVersion: target,
  command: '/data/runtime',
  updateAvailable: version !== target,
});

describe('the machines of the LANs of a machine', () => {
  let root: string;
  const opened: Array<{ repo: LoroRepo; store: SqliteRepoStore }> = [];

  const open = async (name: string) => {
    const store = new SqliteRepoStore({ path: path.join(root, `${name}.sqlite3`) });
    const repo = await LoroRepo.create({ storageAdapter: store.storage, metaDebounceCommitMs: 0 });
    opened.push({ repo, store });
    return repo;
  };

  const workspace = async (
    workspaceId: WorkspaceId,
    overrides: Partial<LanMemberWorkspace> = {}
  ): Promise<LanMemberWorkspace> => ({
    workspaceId,
    name: workspaceId === HOME ? 'Home' : workspaceId === OFFICE ? 'Office' : 'Lody',
    userId: workspaceId === OFFICE ? OFFICE_USER : HOME_USER,
    lan: true,
    repo: await open(workspaceId),
    getOnlineMachineIds: async () => new Set<MachineId>(),
    sync: { markMachineFlockDocDirty: () => {} },
    ...overrides,
  });

  const register = async (
    target: LanMemberWorkspace,
    machineId: MachineId,
    meta: Partial<MachineMeta> = {}
  ) => {
    await target.repo.upsertDocMeta(getMachineRoomId(machineId), {
      id: machineId,
      name: machineId.replace('machine-', ''),
      ownerUserId: target.userId,
      cliVersion: '0.100.0-lan.3',
      os: 'linux',
      sessions: [],
      protocolCapabilities: { ...CURRENT_MACHINE_PROTOCOL_CAPABILITIES, lanControl: 1 },
      ...meta,
    } as Parameters<LoroRepo['upsertDocMeta']>[1]);
  };

  const provide = async (target: LanMemberWorkspace, machineId: MachineId, agentType: string) => {
    await upsertMachineAgentConfig(target.repo, target.workspaceId, {
      id: `${machineId}-${agentType}` as AgentConfigId,
      machineId,
      name: agentType,
      cliType: 'builtin',
      agentType,
      env: {},
    } as AgentConfigMeta);
  };

  const readFacts = async (target: LanMemberWorkspace, machineId: MachineId) => {
    const meta = (await target.repo.getDocMeta(getMachineRoomId(machineId)))?.meta as
      | MachineMeta
      | undefined;
    return { lanBuild: meta?.lanBuild, lanUpdate: meta?.lanUpdate, lanAgents: meta?.lanAgents };
  };

  const createControl = (
    build: Partial<LanMachineBuild> = {},
    overrides: Partial<LanMachineControlOptions> = {}
  ) =>
    new LanMachineControl({
      logger: silentLogger(),
      build: { version: RUNNING, update: 'service', source, ...build },
      installation: { kind: 'installer', root: '/opt/lan', runtime: 'node', entry: 'index.js' },
      runtimes: () => ({
        getRuntimeStatus: async (name) =>
          name === 'codex' ? installed('0.155.0', '0.156.0') : installed('2.1.280'),
        ensureCurrentRuntime: async () => {},
        pruneSupersededVersions: async () => {},
      }),
      restart: () => {},
      readNewest: async () => newest,
      settle: async () => {},
      ...overrides,
    });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-members-'));
  });

  afterEach(async () => {
    for (const { repo, store } of opened.splice(0)) {
      await repo.destroy().catch(() => undefined);
      store.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const list = (workspaces: LanMemberWorkspace[], control = createControl()) =>
    listLanMachines({
      workspaces,
      machineId: THIS,
      machineName: 'desk',
      os: 'darwin',
      control,
      now: 500,
    });

  it('lists a member of two LANs once, this machine first, and nobody else', async () => {
    const home = await workspace(HOME, {
      getOnlineMachineIds: async () => new Set([THIS, SERVER]),
    });
    const office = await workspace(OFFICE, { getOnlineMachineIds: async () => new Set([THIS]) });
    await register(home, THIS);
    await register(office, THIS);
    await register(home, SERVER, {
      cliVersion: '0.100.0-lan.3',
      lanBuild: { version: '0.100.0-lan.3', update: 'service', source },
      lanAgents: [
        { agentType: 'claude', name: 'Claude Code', version: '2.1.280', state: 'current' },
      ],
    });
    await register(office, SERVER, { cliVersion: '0.100.0-lan.3' });
    await register(office, LAPTOP, { name: 'an old laptop', protocolCapabilities: {} });
    // Left in the workspace by a build that took every member for another user.
    await register(home, 'machine-ghost' as MachineId, { ownerUserId: 'local:shared' });
    await provide(home, THIS, 'claude');

    const { machines, newest: release } = await list([home, office]);

    expect(release).toEqual({
      version: '0.100.0-lan.5',
      commit: newest.commit,
      builtAt: newest.builtAt,
    });
    expect(machines.map((machine) => machine.machineId)).toEqual([THIS, SERVER, LAPTOP]);
    expect(machines[0]).toEqual({
      machineId: THIS,
      name: 'desk',
      os: 'darwin',
      self: true,
      online: true,
      lans: [
        { workspaceId: HOME, name: 'Home' },
        { workspaceId: OFFICE, name: 'Office' },
      ],
      version: RUNNING,
      build: { version: RUNNING, update: 'service', source },
      update: null,
      controllable: true,
      agents: [
        {
          agentType: 'claude',
          name: 'Claude Code',
          version: '2.1.280',
          target: '2.1.280',
          state: 'current',
        },
      ],
    });
    expect(machines[1]).toMatchObject({
      machineId: SERVER,
      self: false,
      online: true,
      lans: [
        { workspaceId: HOME, name: 'Home' },
        { workspaceId: OFFICE, name: 'Office' },
      ],
      version: '0.100.0-lan.3',
      build: { update: 'service' },
      controllable: true,
      agents: [{ agentType: 'claude', version: '2.1.280' }],
    });
    expect(machines[2]).toMatchObject({
      machineId: LAPTOP,
      name: 'an old laptop',
      online: false,
      build: null,
      controllable: false,
      agents: [],
    });
  });

  it('lists this machine alone when it is a member of no LAN', async () => {
    const implicit = await workspace('lw_implicit' as WorkspaceId, { lan: false });
    await register(implicit, THIS);
    await register(implicit, SERVER);
    await provide(implicit, THIS, 'codex');

    const { machines } = await list([implicit]);

    expect(machines).toHaveLength(1);
    expect(machines[0]).toMatchObject({
      machineId: THIS,
      lans: [],
      agents: [{ agentType: 'codex', version: '0.155.0', target: '0.156.0', state: 'outdated' }],
    });
    expect((await list([])).machines).toMatchObject([{ machineId: THIS, lans: [], agents: [] }]);
  });

  it('does not take an unknown presence for an absence', async () => {
    const home = await workspace(HOME, { getOnlineMachineIds: async () => null });
    const office = await workspace(OFFICE, {
      getOnlineMachineIds: async () => {
        throw new Error('the hub is away');
      },
    });
    await register(home, SERVER);
    await register(office, SERVER);

    const { machines } = await list([home, office]);
    expect(machines.find((machine) => machine.machineId === SERVER)?.online).toBeNull();
  });

  it('tells the members what this machine runs, once', async () => {
    const home = await workspace(HOME);
    await register(home, THIS);
    await provide(home, THIS, 'codex');
    const control = createControl();
    const publish = () =>
      publishLanMachineFacts({ workspace: home, machineId: THIS, control, now: 500 });

    expect(await publish()).toBe(true);
    expect(await readFacts(home, THIS)).toEqual({
      lanBuild: { version: RUNNING, update: 'service', source },
      lanUpdate: undefined,
      lanAgents: [
        {
          agentType: 'codex',
          name: 'Codex',
          version: '0.155.0',
          target: '0.156.0',
          state: 'outdated',
        },
      ],
    });
    expect(await publish()).toBe(false);

    await provide(home, THIS, 'claude');
    expect(await publish()).toBe(true);
    expect((await readFacts(home, THIS)).lanAgents).toHaveLength(2);
  });

  it('tells nothing before the machine registered, or where no member reads it', async () => {
    const home = await workspace(HOME);
    const implicit = await workspace('lw_implicit' as WorkspaceId, { lan: false });
    await register(implicit, THIS);
    const control = createControl();

    expect(
      await publishLanMachineFacts({ workspace: home, machineId: THIS, control, now: 500 })
    ).toBe(false);
    expect(
      await publishLanMachineFacts({ workspace: implicit, machineId: THIS, control, now: 500 })
    ).toBe(false);
    expect(await readFacts(implicit, THIS)).toEqual({});
  });

  it('closes the update it reported before it started again', async () => {
    const home = await workspace(HOME);
    const reported = { phase: 'restarting', version: RUNNING, at: 100 } as const;
    await register(home, THIS, { lanUpdate: reported });

    await publishLanMachineFacts({
      workspace: home,
      machineId: THIS,
      control: createControl(),
      now: 500,
    });
    expect((await readFacts(home, THIS)).lanUpdate).toBeUndefined();

    const office = await workspace(OFFICE);
    await register(office, THIS, { lanUpdate: { ...reported, version: '0.100.0-lan.9' } });
    await publishLanMachineFacts({
      workspace: office,
      machineId: THIS,
      control: createControl(),
      now: 500,
    });
    expect((await readFacts(office, THIS)).lanUpdate).toMatchObject({
      phase: 'failed',
      version: '0.100.0-lan.9',
      at: 500,
    });
  });

  it('carries out what a member asks of it', async () => {
    const home = await workspace(HOME);
    await register(home, THIS);
    const started: string[] = [];
    const control = createControl(
      {},
      {
        applyUpdate: async () => {
          started.push('update');
        },
      }
    );
    const ask = (request: LanMemberControlRequest) =>
      answerLanMemberControl({ request, workspace: home, machineId: THIS, control });

    expect(await ask({ type: 'lan/update-machine', machineId: THIS, workspaceId: HOME })).toEqual({
      ok: true,
      type: 'lan/update-machine',
      result: { outcome: 'started', version: '0.100.0-lan.5' },
    });
    expect(started).toEqual(['update']);

    expect(
      await ask({
        type: 'lan/install-agent',
        machineId: THIS,
        workspaceId: HOME,
        agentType: 'codex',
      })
    ).toEqual({
      ok: true,
      type: 'lan/install-agent',
      result: { agentType: 'codex', outcome: 'started' },
    });
  });

  it('says why it refuses', async () => {
    const home = await workspace(HOME);
    const ask = (request: LanMemberControlRequest, control: LanMachineControl) =>
      answerLanMemberControl({ request, workspace: home, machineId: THIS, control });

    expect(
      await ask(
        { type: 'lan/update-machine', machineId: THIS, workspaceId: HOME },
        createControl({ update: 'desktop' })
      )
    ).toMatchObject({ ok: false, type: 'lan/update-machine', data: { reason: 'desktop' } });
    expect(
      await ask(
        { type: 'lan/install-agent', machineId: THIS, workspaceId: HOME, agentType: 'bub' },
        createControl()
      )
    ).toMatchObject({ ok: false, type: 'lan/install-agent', data: { reason: 'unknown_agent' } });
  });

  it('answers a member that asks for the hosted configuration of this machine', async () => {
    const home = await workspace(HOME);
    await register(home, THIS);
    const previous = process.env.LODY_HOSTED_DATA_DIR;
    process.env.LODY_HOSTED_DATA_DIR = path.join(root, 'no-hosted-installation');
    try {
      expect(
        await answerLanMemberControl({
          request: { type: 'hosted-config/preview', machineId: THIS, workspaceId: HOME },
          workspace: home,
          machineId: THIS,
          control: createControl(),
        })
      ).toEqual({
        ok: true,
        type: 'hosted-config/preview',
        result: { found: false, sources: [] },
      });
      expect(
        await answerLanMemberControl({
          request: {
            type: 'hosted-config/import',
            machineId: THIS,
            workspaceId: HOME,
            sourceWorkspaceId: 'hosted',
            categories: ['localProjects'],
          },
          workspace: home,
          machineId: THIS,
          control: createControl(),
        })
      ).toMatchObject({ ok: false, type: 'hosted-config/import', error: 'execution_failed' });
    } finally {
      if (previous === undefined) delete process.env.LODY_HOSTED_DATA_DIR;
      else process.env.LODY_HOSTED_DATA_DIR = previous;
    }
  });

  describe('a request to another member', () => {
    const request: LanMemberControlRequest = {
      type: 'lan/update-machine',
      machineId: SERVER,
      workspaceId: HOME,
    };
    const started: LocalProjectControlResponse = {
      ok: true,
      type: 'lan/update-machine',
      result: { outcome: 'started', version: '0.100.0-lan.5' },
    };

    const forward = async (
      answer: LocalProjectControlResponse | null | Error,
      options: { request?: LanMemberControlRequest; workspace?: LanMemberWorkspace | null } = {}
    ) => {
      const sent: LanMemberControlRequest[] = [];
      const home = await workspace(HOME);
      await register(home, SERVER, { name: 'server' });
      await register(home, LAPTOP, { name: 'laptop', protocolCapabilities: {} });
      await register(home, 'machine-ghost' as MachineId, { ownerUserId: 'local:shared' });
      const response = await forwardLanMemberControl({
        request: options.request ?? request,
        workspace: options.workspace === undefined ? home : options.workspace,
        machineId: THIS,
        send: async (forwarded) => {
          sent.push(forwarded);
          if (answer instanceof Error) throw answer;
          return answer;
        },
      });
      return { response, sent };
    };

    it('brings back what the member answers', async () => {
      const { response, sent } = await forward(started);
      expect(response).toEqual(started);
      expect(sent).toEqual([request]);

      const refused: LocalProjectControlResponse = {
        ok: false,
        type: 'lan/update-machine',
        error: 'execution_failed',
        message: 'This machine is already updating',
        data: { reason: 'busy' },
      };
      expect((await forward(refused)).response).toEqual(refused);
    });

    it('says so when the member does not answer or answers something else', async () => {
      expect((await forward(null)).response).toMatchObject({
        ok: false,
        message: 'server did not answer',
      });
      expect((await forward(new Error('the hub is away'))).response).toMatchObject({
        ok: false,
        message: 'server could not be reached: the hub is away',
      });
      expect(
        (
          await forward({
            ok: true,
            type: 'lan/install-agent',
            result: { agentType: 'codex', outcome: 'started' },
          })
        ).response
      ).toMatchObject({ ok: false, type: 'lan/update-machine' });
      expect(
        (await forward({ ok: true, type: 'local-project/list', result: { workspaces: [] } }))
          .response
      ).toMatchObject({ ok: false, type: 'lan/update-machine' });
    });

    it('asks no machine that would not answer', async () => {
      const old = await forward(started, { request: { ...request, machineId: LAPTOP } });
      expect(old.response).toMatchObject({ ok: false, data: { reason: 'manual' } });
      expect(old.sent).toEqual([]);

      for (const machineId of ['machine-ghost', 'machine-unknown', THIS] as MachineId[]) {
        const { response, sent } = await forward(started, { request: { ...request, machineId } });
        expect(response.ok).toBe(false);
        expect(sent).toEqual([]);
      }

      const implicit = await workspace('lw_implicit' as WorkspaceId, { lan: false });
      await register(implicit, SERVER);
      for (const target of [implicit, null]) {
        const { response, sent } = await forward(started, { workspace: target });
        expect(response.ok).toBe(false);
        expect(sent).toEqual([]);
      }
    });
  });
});
