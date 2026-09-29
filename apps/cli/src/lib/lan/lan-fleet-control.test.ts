import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import {
  getMachineRoomId,
  type AgentConfigId,
  type AgentConfigMeta,
  type LanMemberControlRequest,
  type LocalProjectControlResponse,
  type MachineId,
  type MachineMeta,
  type WorkspaceId,
} from '@lody/shared';
import { getLanHubWorkspaceId } from '@lody/shared/lan-hub';
import { addLanHub, type LanHub } from '@lody/shared/node/lan-hub';
import { upsertMachineAgentConfig } from '@/lib/agent-config-machine-flock';
import type { Logger } from '@/utils/logger';
import { LanFleetControl, isLanControlRequest } from './lan-fleet-control';
import { LanMachineControl } from './lan-machine-control';
import type { LanMemberWorkspace } from './lan-members';

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
const RUNNING = '0.100.0-lan.4';
const source = { repository: 'someone/Lody', tag: 'lan-latest' };
const home: LanHub = addLanHub([], {
  name: 'Home',
  url: 'http://10.0.0.1:8788',
  token: 'home-token-0123456789',
}).hub;
const HOME = getLanHubWorkspaceId(home.id) as WorkspaceId;

describe('what an agent service does for the members of its LANs', () => {
  let root: string;
  let workspace: LanMemberWorkspace;
  let control: LanMachineControl;
  let sent: Array<{ hub: string; request: LanMemberControlRequest }>;
  let answer: LocalProjectControlResponse | null;
  let hubs: LanHub[];
  let running: boolean;
  let installed: boolean;
  const opened: Array<{ repo: LoroRepo; store: SqliteRepoStore }> = [];

  const createFleetControl = () =>
    new LanFleetControl({
      logger: silentLogger(),
      machineId: THIS,
      machineName: 'desk',
      control,
      hubs: () => hubs,
      workspaces: () => (running ? [workspace] : []),
      workspace: async (workspaceId) =>
        running && workspaceId === workspace.workspaceId ? workspace : null,
      send: async (hub, request) => {
        sent.push({ hub: hub.name, request });
        return answer;
      },
      now: () => 500,
    });

  const register = async (machineId: MachineId, meta: Partial<MachineMeta> = {}) => {
    await workspace.repo.upsertDocMeta(getMachineRoomId(machineId), {
      id: machineId,
      name: machineId.replace('machine-', ''),
      ownerUserId: workspace.userId,
      cliVersion: RUNNING,
      os: 'linux',
      sessions: [],
      protocolCapabilities: { lanControl: 1 },
      ...meta,
    } as Parameters<LoroRepo['upsertDocMeta']>[1]);
  };

  const factsOf = async (machineId: MachineId) =>
    (await workspace.repo.getDocMeta(getMachineRoomId(machineId)))?.meta as MachineMeta | undefined;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-fleet-'));
    const store = new SqliteRepoStore({ path: path.join(root, 'home.sqlite3') });
    const repo = await LoroRepo.create({ storageAdapter: store.storage, metaDebounceCommitMs: 0 });
    opened.push({ repo, store });
    workspace = {
      workspaceId: HOME,
      name: 'Home',
      userId: 'local:home',
      lan: true,
      repo,
      getOnlineMachineIds: async () => new Set([THIS, SERVER]),
      sync: { markMachineFlockDocDirty: () => {} },
    };
    control = new LanMachineControl({
      logger: silentLogger(),
      build: { version: RUNNING, update: 'desktop', source },
      installation: { kind: 'desktop' },
      runtimes: () => ({
        getRuntimeStatus: async () =>
          installed
            ? {
                kind: 'installed',
                platformArch: 'linux-x64',
                version: '0.156.0',
                targetVersion: '0.156.0',
                command: '/data/codex',
                updateAvailable: false,
              }
            : { kind: 'not-installed', platformArch: 'linux-x64', version: '0.156.0' },
        ensureCurrentRuntime: async () => {
          installed = true;
        },
        pruneSupersededVersions: async () => {},
      }),
      restart: () => {},
      readNewest: async () => ({
        version: '0.100.0-lan.5',
        commit: 'cccccccccccccccccccccccccccccccccccccccc',
        repository: source.repository,
        tag: source.tag,
        builtAt: '2026-09-29T00:00:00.000Z',
        assets: [],
      }),
      settle: async () => {},
    });
    sent = [];
    answer = null;
    hubs = [home];
    running = true;
    installed = false;
    await register(THIS);
    await register(SERVER);
  });

  afterEach(async () => {
    for (const { repo, store } of opened.splice(0)) {
      await repo.destroy().catch(() => undefined);
      store.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('knows the requests it takes from the ones of a project', () => {
    const machineId = THIS;
    const workspaceId = HOME;
    expect(isLanControlRequest({ type: 'lan/machines', machineId })).toBe(true);
    expect(isLanControlRequest({ type: 'hosted-config/preview', machineId, workspaceId })).toBe(
      true
    );
    expect(isLanControlRequest({ type: 'local-project/list', machineId })).toBe(false);
  });

  it('lists the machines with the newest build to measure them against', async () => {
    const response = await createFleetControl().dispatch({ type: 'lan/machines', machineId: THIS });

    expect(response).toMatchObject({
      ok: true,
      type: 'lan/machines',
      result: {
        newest: { version: '0.100.0-lan.5' },
        machines: [
          { machineId: THIS, self: true, lans: [{ workspaceId: HOME, name: 'Home' }] },
          { machineId: SERVER, self: false, online: true, controllable: true },
        ],
      },
    });
  });

  it('carries a request to a member through the hub of their LAN', async () => {
    const request: LanMemberControlRequest = {
      type: 'lan/update-machine',
      machineId: SERVER,
      workspaceId: HOME,
    };
    answer = {
      ok: true,
      type: 'lan/update-machine',
      result: { outcome: 'started', version: '0.100.0-lan.5' },
    };

    const response = await createFleetControl().dispatch({
      type: 'lan/forward',
      machineId: THIS,
      request,
    });

    expect(response).toEqual({ ok: true, type: 'lan/forward', result: { response: answer } });
    expect(sent).toEqual([{ hub: 'Home', request }]);
  });

  it('says so when no LAN of this machine carries the workspace any more', async () => {
    hubs = [];
    const response = await createFleetControl().dispatch({
      type: 'lan/forward',
      machineId: THIS,
      request: { type: 'lan/update-machine', machineId: SERVER, workspaceId: HOME },
    });

    expect(response).toMatchObject({
      ok: true,
      type: 'lan/forward',
      result: { response: { ok: false, type: 'lan/update-machine' } },
    });
    expect(sent).toEqual([]);
  });

  it('answers what is asked of this machine, and nothing meant for another', async () => {
    const fleet = createFleetControl();

    expect(
      await fleet.answer({ type: 'lan/update-machine', machineId: THIS, workspaceId: HOME })
    ).toMatchObject({ ok: false, error: 'execution_failed', data: { reason: 'desktop' } });
    expect(
      await fleet.answer({ type: 'lan/update-machine', machineId: SERVER, workspaceId: HOME })
    ).toMatchObject({ ok: false, error: 'machine_mismatch' });
    expect(
      await fleet.answer({
        type: 'lan/update-machine',
        machineId: THIS,
        workspaceId: 'lw_elsewhere' as WorkspaceId,
      })
    ).toMatchObject({ ok: false, error: 'workspace_not_found' });
    expect(sent).toEqual([]);
  });

  it('tells the members what this machine runs, until it is closed', async () => {
    const fleet = createFleetControl();

    await fleet.publish();
    expect((await factsOf(THIS))?.lanBuild).toEqual({
      version: RUNNING,
      update: 'desktop',
      source,
    });
    expect((await factsOf(SERVER))?.lanBuild).toBeUndefined();

    await workspace.repo.upsertDocMeta(getMachineRoomId(THIS), {
      lanBuild: undefined,
    } as Parameters<LoroRepo['upsertDocMeta']>[1]);
    fleet.close();
    await fleet.publish();
    expect((await factsOf(THIS))?.lanBuild).toBeUndefined();
  });

  it('tells the members again when what this machine says changed', async () => {
    await upsertMachineAgentConfig(workspace.repo, HOME, {
      id: 'desk-codex' as AgentConfigId,
      machineId: THIS,
      name: 'Codex',
      cliType: 'builtin',
      agentType: 'codex',
      env: {},
    } as AgentConfigMeta);
    const fleet = createFleetControl();
    fleet.start();
    await fleet.publish();
    expect((await factsOf(THIS))?.lanAgents).toEqual([
      { agentType: 'codex', name: 'Codex', target: '0.156.0', state: 'missing' },
    ]);

    // Installing a runtime changes what the machine says twice: when it
    // starts and when it is done. Nobody asks the fleet to tell the members.
    const done = new Promise<void>((resolve) => {
      let changes = 0;
      control.onChange(() => {
        changes += 1;
        if (changes === 2) resolve();
      });
    });
    await control.installAgent('codex');
    await done;
    fleet.close();
    // What was under way when the fleet closed is said; nothing after it.
    await fleet.publish();

    expect((await factsOf(THIS))?.lanAgents).toEqual([
      {
        agentType: 'codex',
        name: 'Codex',
        version: '0.156.0',
        target: '0.156.0',
        state: 'current',
      },
    ]);
  });
});
