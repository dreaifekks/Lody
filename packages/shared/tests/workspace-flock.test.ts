import { getAgentRoleTargets, normalizeAgentRole } from '../src/agent-role';
import { describe, expect, it } from 'vitest';

import { AGENT_ROLE_VERSION, withAgentRoleTargets, type AgentRole } from '../src/agent-role';
import type { AgentConfigId, AgentRoleId, MachineId, McpServerId, WorkspaceId } from '../src/ids';
import {
  applyWorkspaceFlockRowEvents,
  deleteWorkspaceAgentRoleFromFlock,
  deleteWorkspaceMcpServerFromFlock,
  listWorkspaceAgentRoles,
  writeWorkspaceAgentRoleToFlock,
  getWorkspaceFlockDocId,
  getWorkspaceAgentTools,
  getWorkspacePinnedProjectKeys,
  getWorkspaceVoiceSetting,
  isWorkspacePromptSuggestionsEnabled,
  listWorkspaceMcpServers,
  parseWorkspaceFlockRow,
  readWorkspaceFlockRowsFromFlock,
  serializeWorkspaceFlockKey,
  workspaceFlockKeys,
  writeWorkspaceMcpServerToFlock,
  type WorkspaceFlockKey,
  type WorkspaceFlockWritableFlock,
} from '../src/workspace-flock';
import type { WorkspaceMcpServerMeta } from '../src/workspace-mcp';

const id = (value: string): McpServerId => value as McpServerId;
const agentRole = (
  roleId: string,
  overrides: Partial<AgentRole> & { instances?: import('@lody/shared').AgentRoleTarget[] } = {}
): AgentRole =>
  withAgentRoleTargets(
    {
      v: AGENT_ROLE_VERSION,
      id: roleId as AgentRoleId,
      ownerUserId: 'user-1',
      visibility: 'private',
      name: roleId,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    },
    overrides.instances ?? [
      {
        id: `${roleId}:machine-1` as import('@lody/shared').AgentRoleInstanceId,
        machineId: 'machine-1' as MachineId,
        agentConfigId: 'config-1' as AgentConfigId,
        runConfig: overrides.runConfig ?? {},
      },
    ]
  );

const entry = (serverId: string, name = serverId): WorkspaceMcpServerMeta => ({
  id: id(serverId),
  name,
  transport: 'stdio',
  connection: { transport: 'stdio', command: 'node' },
  createdAt: 1,
  updatedAt: 1,
});

class FakeWorkspaceFlock implements WorkspaceFlockWritableFlock {
  readonly rows = new Map<string, { key: WorkspaceFlockKey; value: unknown }>();
  readonly scanOptions: Array<{ prefix?: readonly unknown[] } | undefined> = [];
  commits = 0;

  scan(options?: { prefix?: readonly unknown[] }) {
    this.scanOptions.push(options);
    return [...this.rows.values()].filter(
      ({ key }) => options?.prefix?.every((part, index) => key[index] === part) ?? true
    );
  }

  set(key: WorkspaceFlockKey, value: unknown): void {
    this.rows.set(JSON.stringify(key), { key: [...key] as WorkspaceFlockKey, value });
  }

  delete(key: WorkspaceFlockKey): void {
    this.rows.delete(JSON.stringify(key));
  }

  commit(): void {
    this.commits += 1;
  }
}

describe('workspace Flock helpers', () => {
  it('builds the workspace-scoped document id', () => {
    expect(getWorkspaceFlockDocId('workspace-1' as WorkspaceId)).toBe('workspace-1:wf:workspace');
  });

  it('round-trips valid rows and drops mismatched or malformed foreign rows', () => {
    const valid = entry('server-1');
    const key = workspaceFlockKeys.mcpServer(valid.id);
    expect(parseWorkspaceFlockRow(key, valid)).toEqual({ key, value: valid });
    expect(parseWorkspaceFlockRow(key, { ...valid, id: id('other') })).toBeUndefined();
    expect(parseWorkspaceFlockRow(key, { ...valid, transport: 'sse' })).toBeUndefined();

    const flock = new FakeWorkspaceFlock();
    flock.set(key, valid);
    flock.rows.set('malformed', { key: ['mcpServer', 'bad'], value: { id: 'bad' } });
    const rows = readWorkspaceFlockRowsFromFlock(flock);
    expect(rows[serializeWorkspaceFlockKey(key)]).toEqual({ key, value: valid });
    expect(Object.keys(rows)).toHaveLength(1);
    // One prefixed scan per family, never an unprefixed full-document scan.
    expect(flock.scanOptions).toEqual([
      { prefix: ['mcpServer'] },
      { prefix: ['agentRole'] },
      { prefix: ['board'] },
      { prefix: ['setting'] },
    ]);
  });

  it('keeps one workspace voice agent and drops a malformed or unknown setting', () => {
    const key = workspaceFlockKeys.voiceSetting();
    const setting = {
      version: 1 as const,
      configId: 'config-1' as AgentConfigId,
      machineId: 'machine-1' as MachineId,
    };
    expect(parseWorkspaceFlockRow(key, { ...setting, extra: true })).toEqual({
      key,
      value: setting,
    });
    expect(parseWorkspaceFlockRow(key, { ...setting, version: 2 })).toBeUndefined();
    expect(parseWorkspaceFlockRow(key, { ...setting, configId: '' })).toBeUndefined();
    expect(parseWorkspaceFlockRow(['setting', 'theme'], setting)).toBeUndefined();
    expect(parseWorkspaceFlockRow(key, { ...setting, voice: 'maple' })).toEqual({
      key,
      value: { ...setting, voice: 'maple' },
    });
    expect(parseWorkspaceFlockRow(key, { ...setting, voice: 'Not a voice' })).toEqual({
      key,
      value: setting,
    });

    const flock = new FakeWorkspaceFlock();
    flock.set(key, setting);
    expect(getWorkspaceVoiceSetting(readWorkspaceFlockRowsFromFlock(flock))).toEqual(setting);
    expect(getWorkspaceVoiceSetting({})).toBeNull();
  });

  it('keeps the offered agent tools, known ids only, in canonical order', () => {
    const key = workspaceFlockKeys.agentToolsSetting();
    expect(
      parseWorkspaceFlockRow(key, { version: 1, tools: ['widget', 'bogus', 'notify'] })
    ).toEqual({ key, value: { version: 1, tools: ['notify', 'widget'] } });
    expect(parseWorkspaceFlockRow(key, { version: 2, tools: [] })).toBeUndefined();
    expect(parseWorkspaceFlockRow(key, { version: 1 })).toBeUndefined();

    const flock = new FakeWorkspaceFlock();
    expect(getWorkspaceAgentTools(readWorkspaceFlockRowsFromFlock(flock))).toEqual([]);
    flock.set(key, { version: 1, tools: ['review'] });
    expect(getWorkspaceAgentTools(readWorkspaceFlockRowsFromFlock(flock))).toEqual(['review']);
    // The voice row lives in the same family and does not read as tools.
    flock.set(workspaceFlockKeys.voiceSetting(), {
      version: 1,
      configId: 'config-1',
      machineId: 'machine-1',
    });
    expect(getWorkspaceAgentTools(readWorkspaceFlockRowsFromFlock(flock))).toEqual(['review']);
  });

  it('turns prompt suggestions on with their own row, apart from the voice agent', () => {
    const key = workspaceFlockKeys.promptSuggestionsSetting();
    expect(parseWorkspaceFlockRow(key, { version: 1, extra: true })).toEqual({
      key,
      value: { version: 1 },
    });
    expect(parseWorkspaceFlockRow(key, { version: 2 })).toBeUndefined();

    const flock = new FakeWorkspaceFlock();
    expect(isWorkspacePromptSuggestionsEnabled(readWorkspaceFlockRowsFromFlock(flock))).toBe(false);
    flock.set(key, { version: 1 });
    const rows = readWorkspaceFlockRowsFromFlock(flock);
    expect(isWorkspacePromptSuggestionsEnabled(rows)).toBe(true);
    expect(getWorkspaceVoiceSetting(rows)).toBeNull();

    const off = applyWorkspaceFlockRowEvents(rows, [{ key, value: undefined }]);
    expect(isWorkspacePromptSuggestionsEnabled(off)).toBe(false);
  });

  it('keeps the pinned projects as trimmed, de-duplicated machine-qualified keys', () => {
    const key = workspaceFlockKeys.pinnedProjectsSetting();
    expect(
      parseWorkspaceFlockRow(key, {
        version: 1,
        keys: ['machine-a:project-1', ' machine-b:project-2 ', 'machine-a:project-1', 7, ''],
      })
    ).toEqual({ key, value: { version: 1, keys: ['machine-a:project-1', 'machine-b:project-2'] } });
    expect(parseWorkspaceFlockRow(key, { version: 2, keys: [] })).toBeUndefined();
    expect(parseWorkspaceFlockRow(key, { version: 1 })).toBeUndefined();

    const flock = new FakeWorkspaceFlock();
    expect(getWorkspacePinnedProjectKeys(readWorkspaceFlockRowsFromFlock(flock))).toEqual([]);
    flock.set(key, { version: 1, keys: ['machine-a:project-1'] });
    const rows = readWorkspaceFlockRowsFromFlock(flock);
    expect(getWorkspacePinnedProjectKeys(rows)).toEqual(['machine-a:project-1']);
    // Sibling settings in the same family neither read as pins nor hide them.
    expect(isWorkspacePromptSuggestionsEnabled(rows)).toBe(false);
    expect(getWorkspaceAgentTools(rows)).toEqual([]);

    const cleared = applyWorkspaceFlockRowEvents(rows, [{ key, value: undefined }]);
    expect(getWorkspacePinnedProjectKeys(cleared)).toEqual([]);
  });

  it('does not commit unchanged writes and deletes only once', () => {
    const flock = new FakeWorkspaceFlock();
    const server = entry('server-1');
    expect(writeWorkspaceMcpServerToFlock(flock, server)).toBe(true);
    expect(writeWorkspaceMcpServerToFlock(flock, server)).toBe(false);
    expect(flock.commits).toBe(1);
    expect(deleteWorkspaceMcpServerFromFlock(flock, server.id)).toBe(true);
    expect(deleteWorkspaceMcpServerFromFlock(flock, server.id)).toBe(false);
    expect(flock.commits).toBe(2);
  });

  it('applies add, update, delete, and no-op events with referential stability', () => {
    const first = entry('first', 'Zulu');
    const second = entry('second', 'Alpha');
    const firstKey = workspaceFlockKeys.mcpServer(first.id);
    const secondKey = workspaceFlockKeys.mcpServer(second.id);
    const initial = applyWorkspaceFlockRowEvents({}, [
      { key: firstKey, value: first },
      { key: secondKey, value: second },
    ]);
    expect(listWorkspaceMcpServers(initial).map(({ name }) => name)).toEqual(['Alpha', 'Zulu']);
    expect(applyWorkspaceFlockRowEvents(initial, [{ key: firstKey, value: first }])).toBe(initial);

    const updatedFirst = { ...first, description: 'updated', updatedAt: 2 };
    const updated = applyWorkspaceFlockRowEvents(initial, [{ key: firstKey, value: updatedFirst }]);
    expect(updated).not.toBe(initial);
    expect(updated[serializeWorkspaceFlockKey(firstKey)]?.value).toEqual(updatedFirst);

    const deleted = applyWorkspaceFlockRowEvents(updated, [{ key: secondKey }]);
    expect(deleted[serializeWorkspaceFlockKey(secondKey)]).toBeUndefined();
    expect(applyWorkspaceFlockRowEvents(deleted, [{ key: ['unknown'] }])).toBe(deleted);
  });

  it('keeps agent roles and MCP servers in one document without either reading the other', () => {
    const flock = new FakeWorkspaceFlock();
    const server = entry('server-1');
    const role = agentRole('role-1', { name: 'Reviewer', description: 'Review code changes' });
    expect(writeWorkspaceMcpServerToFlock(flock, server)).toBe(true);
    expect(writeWorkspaceAgentRoleToFlock(flock, role)).toBe(true);

    const rows = readWorkspaceFlockRowsFromFlock(flock);
    expect(listWorkspaceMcpServers(rows)).toEqual([server]);
    expect(listWorkspaceAgentRoles(rows)).toEqual([role]);
  });

  it('shares a role by updating its own row rather than moving it', () => {
    const flock = new FakeWorkspaceFlock();
    const role = agentRole('role-1');
    writeWorkspaceAgentRoleToFlock(flock, role);
    const shared = { ...role, visibility: 'workspace' as const, revision: 2, updatedAt: 2 };
    expect(writeWorkspaceAgentRoleToFlock(flock, shared)).toBe(true);

    const rows = readWorkspaceFlockRowsFromFlock(flock);
    expect(Object.keys(rows)).toHaveLength(1);
    expect(listWorkspaceAgentRoles(rows)).toEqual([shared]);
    expect(writeWorkspaceAgentRoleToFlock(flock, shared)).toBe(false);
    expect(deleteWorkspaceAgentRoleFromFlock(flock, role.id)).toBe(true);
    expect(deleteWorkspaceAgentRoleFromFlock(flock, role.id)).toBe(false);
  });

  it('writes every migrated target as v2 without a stale legacy mirror', () => {
    const flock = new FakeWorkspaceFlock();
    const role = agentRole('role-1', {
      instances: [
        {
          id: 'claude' as import('@lody/shared').AgentRoleInstanceId,
          machineId: 'machine-2' as MachineId,
          agentConfigId: 'config-2' as AgentConfigId,
          runConfig: { modelId: 'opus', memory: { providerId: 'nowledge-mem', memoryId: 'lody' } },
        },
        {
          id: 'codex' as import('@lody/shared').AgentRoleInstanceId,
          machineId: 'machine-1' as MachineId,
          agentConfigId: 'config-1' as AgentConfigId,
          runConfig: {},
        },
      ],
    });
    writeWorkspaceAgentRoleToFlock(flock, role);
    const stored = flock.rows.get(JSON.stringify(workspaceFlockKeys.agentRole(role.id)))?.value;
    expect(stored).toMatchObject({ v: 2, targets: getAgentRoleTargets(role) });
    expect(stored).not.toHaveProperty('machineId');
    expect(stored).not.toHaveProperty('instances');
  });

  it('drops a role row whose stored value no longer validates', () => {
    const flock = new FakeWorkspaceFlock();
    const role = agentRole('role-1');
    flock.set(workspaceFlockKeys.agentRole(role.id), { ...role, name: '   ' });
    expect(listWorkspaceAgentRoles(readWorkspaceFlockRowsFromFlock(flock))).toEqual([]);
  });

  it('normalizes a secret-shaped option out of a stored role row', () => {
    const flock = new FakeWorkspaceFlock();
    // Written by a client that predates instances.
    const { instances: _instances, ...role } = agentRole('role-1');
    flock.set(workspaceFlockKeys.agentRole(role.id), {
      ...role,
      runConfig: { modelId: 'gpt-5.6', configOptionValues: { api_key: 'sk-live', fast: true } },
    });
    expect(listWorkspaceAgentRoles(readWorkspaceFlockRowsFromFlock(flock))[0]?.runConfig).toEqual({
      modelId: 'gpt-5.6',
      configOptionValues: { fast: true },
    });
  });

  it('stores a multi-machine role as v2 and a single-machine role as the unchanged v1 row', () => {
    const flock = new FakeWorkspaceFlock();
    const key = workspaceFlockKeys.agentRole('role-1' as AgentRoleId);
    const single = agentRole('role-1', { runConfig: { modelId: 'gpt-5.6' } });
    writeWorkspaceAgentRoleToFlock(flock, single);
    const storedSingle = flock.rows.get(JSON.stringify(key))?.value as Record<string, unknown>;
    // Exactly what an older client wrote and still reads.
    expect(storedSingle).toMatchObject({ v: 1, machineId: 'machine-1', agentConfigId: 'config-1' });
    expect(storedSingle).not.toHaveProperty('additionalTargets');
    expect(storedSingle).not.toHaveProperty('targets');

    const multi: AgentRole = {
      ...single,
      alias: 'Reviewer-Mac',
      additionalTargets: [
        {
          machineId: 'machine-2' as MachineId,
          agentConfigId: 'config-2' as AgentConfigId,
          runConfig: { modelId: 'gpt-5.6-luna' },
        },
      ],
    };
    expect(writeWorkspaceAgentRoleToFlock(flock, multi)).toBe(true);
    const storedMulti = flock.rows.get(JSON.stringify(key))?.value as Record<string, unknown>;
    // Older clients accept only v1, so they skip this row instead of rewriting
    // it without the second machine.
    expect(storedMulti.v).toBe(2);
    expect(storedMulti).not.toHaveProperty('machineId');
    expect(storedMulti.targets).toEqual(getAgentRoleTargets(multi));
    expect(listWorkspaceAgentRoles(readWorkspaceFlockRowsFromFlock(flock))).toEqual([
      normalizeAgentRole(multi),
    ]);
    expect(writeWorkspaceAgentRoleToFlock(flock, multi)).toBe(false);

    // Back to one machine: the row returns to the v1 shape and the alias goes.
    writeWorkspaceAgentRoleToFlock(flock, single);
    expect(flock.rows.get(JSON.stringify(key))?.value).toMatchObject({ v: 1 });
  });
  it('leaves legacy and opaque v2 catalog rows byte-for-byte unchanged on reads and unrelated writes', () => {
    const flock = new FakeWorkspaceFlock();
    const legacy = {
      ...agentRole('legacy'),
      instances: [
        {
          id: 'kept-a',
          machineId: 'machine-1',
          agentConfigId: 'config-1',
          runConfig: { memory: { providerId: 'nowledge-mem', memoryId: 'synthetic-a' } },
        },
        {
          id: 'kept-b',
          machineId: 'machine-1',
          agentConfigId: 'config-2',
          runConfig: { modelId: 'synthetic-b' },
        },
      ],
    };
    const opaque = {
      ...agentRole('opaque'),
      v: 2,
      targets: legacy.instances,
      extensionFromPeer: { retain: true },
    };
    const future = { ...opaque, id: 'future', v: 3 };
    for (const row of [legacy, opaque, future])
      flock.set(workspaceFlockKeys.agentRole(row.id as AgentRoleId), row);
    const before = JSON.stringify([...flock.rows]);
    const commits = flock.commits;
    const loaded = listWorkspaceAgentRoles(readWorkspaceFlockRowsFromFlock(flock));
    expect(loaded.map((role) => role.id)).toEqual(['legacy', 'opaque']);
    expect(loaded.map((role) => getAgentRoleTargets(role).map((target) => target.id))).toEqual([
      ['kept-a', 'kept-b'],
      ['kept-a', 'kept-b'],
    ]);
    expect(JSON.stringify([...flock.rows])).toBe(before);
    expect(flock.commits).toBe(commits);
    writeWorkspaceMcpServerToFlock(flock, entry('synthetic-server'));
    for (const row of [legacy, opaque, future])
      expect(
        flock.rows.get(JSON.stringify(workspaceFlockKeys.agentRole(row.id as AgentRoleId)))?.value
      ).toEqual(row);
  });
});
