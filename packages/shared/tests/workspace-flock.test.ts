import { describe, expect, it } from 'vitest';

import { AGENT_ROLE_VERSION, withAgentRoleInstances, type AgentRole } from '../src/agent-role';
import type { AgentConfigId, AgentRoleId, MachineId, McpServerId, WorkspaceId } from '../src/ids';
import {
  applyWorkspaceFlockRowEvents,
  deleteWorkspaceAgentRoleFromFlock,
  deleteWorkspaceMcpServerFromFlock,
  listWorkspaceAgentRoles,
  writeWorkspaceAgentRoleToFlock,
  getWorkspaceFlockDocId,
  getWorkspaceAgentTools,
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
const agentRole = (roleId: string, overrides: Partial<AgentRole> = {}): AgentRole =>
  withAgentRoleInstances(
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
        id: `${roleId}:machine-1` as AgentRole['instances'][number]['id'],
        label: 'Default',
        machineId: 'machine-1' as MachineId,
        agentConfigId: 'config-1' as AgentConfigId,
        runConfig: {},
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

  it('writes the first instance into the legacy fields older clients read', () => {
    const flock = new FakeWorkspaceFlock();
    const role = agentRole('role-1', {
      instances: [
        {
          id: 'claude' as AgentRole['instances'][number]['id'],
          label: 'Claude',
          machineId: 'machine-2' as MachineId,
          agentConfigId: 'config-2' as AgentConfigId,
          runConfig: { modelId: 'opus', memory: { providerId: 'nowledge-mem', memoryId: 'lody' } },
        },
        {
          id: 'codex' as AgentRole['instances'][number]['id'],
          label: 'Codex',
          machineId: 'machine-1' as MachineId,
          agentConfigId: 'config-1' as AgentConfigId,
          runConfig: {},
        },
      ],
    });
    // A row whose mirror went stale is rewritten from its instances on write.
    writeWorkspaceAgentRoleToFlock(flock, { ...role, machineId: 'machine-1' as MachineId });
    expect(
      flock.rows.get(JSON.stringify(workspaceFlockKeys.agentRole(role.id)))?.value
    ).toMatchObject({
      machineId: 'machine-2',
      agentConfigId: 'config-2',
      runConfig: { modelId: 'opus', memory: { providerId: 'nowledge-mem', memoryId: 'lody' } },
    });
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
});
