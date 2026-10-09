import { normalizeAgentRole, type CatalogAgentRole } from './agent-role';
import type { AgentConfigId, AgentRoleId, MachineId, McpServerId, WorkspaceId } from './ids';
import { isWorkspaceMcpServerMeta, type WorkspaceMcpServerMeta } from './workspace-mcp';
import { LODY_AGENT_TOOL_IDS, type LodyAgentToolId } from './lody-agent-tools';

export const WORKSPACE_FLOCK_DOC_STREAM_SEGMENT = 'wf';
const WORKSPACE_FLOCK_DOC_NAME = 'workspace';

export const getWorkspaceFlockDocId = (workspaceId: WorkspaceId): string =>
  `${workspaceId}:${WORKSPACE_FLOCK_DOC_STREAM_SEGMENT}:${WORKSPACE_FLOCK_DOC_NAME}`;

export type WorkspaceFlockMcpServerKey = ['mcpServer', McpServerId];
export type WorkspaceFlockAgentRoleKey = ['agentRole', AgentRoleId];
/** One row per workspace-wide setting. */
export type WorkspaceFlockVoiceSettingKey = ['setting', 'voice'];
export type WorkspaceFlockPromptSuggestionsSettingKey = ['setting', 'promptSuggestions'];
export type WorkspaceFlockAgentToolsSettingKey = ['setting', 'agentTools'];
export type WorkspaceFlockSettingKey =
  | WorkspaceFlockVoiceSettingKey
  | WorkspaceFlockPromptSuggestionsSettingKey
  | WorkspaceFlockAgentToolsSettingKey;
export type WorkspaceFlockKey =
  | WorkspaceFlockMcpServerKey
  | WorkspaceFlockAgentRoleKey
  | WorkspaceFlockSettingKey;

/** The Codex agent config every device of the workspace uses for experimental voice. */
export type WorkspaceVoiceSetting = {
  version: 1;
  configId: AgentConfigId;
  machineId: MachineId;
  /**
   * The voice calls use, a name the agent's Codex lists; absent follows Codex's
   * default. Optional so clients that predate it keep reading the row.
   */
  voice?: string;
};

/**
 * Experimental next-message suggestions for Claude sessions. The row exists
 * only while the feature is on. It is workspace-wide because the machine that
 * runs a session decides when Claude starts, whichever device sent the message.
 */
export type WorkspacePromptSuggestionsSetting = { version: 1 };

/**
 * The experimental Lody MCP tools agents of this workspace are offered. Read by
 * each machine when it starts an agent; a tool missing here is not listed.
 */
export type WorkspaceAgentToolsSetting = {
  version: 1;
  tools: LodyAgentToolId[];
};

const normalizeAgentTools = (value: unknown): WorkspaceAgentToolsSetting | null => {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record['version'] !== 1 || !Array.isArray(record['tools'])) return null;
  return {
    version: 1,
    tools: LODY_AGENT_TOOL_IDS.filter((id) => (record['tools'] as unknown[]).includes(id)),
  };
};

const isVoiceName = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9_-]{1,64}$/.test(value);

export const isWorkspaceVoiceSetting = (value: unknown): value is WorkspaceVoiceSetting => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record['version'] === 1 &&
    typeof record['configId'] === 'string' &&
    record['configId'].length > 0 &&
    typeof record['machineId'] === 'string' &&
    record['machineId'].length > 0
  );
};

/**
 * Every family stored in the one workspace document.
 *
 * Agent Roles share this document with the MCP catalog rather than getting a
 * document of their own, and private/workspace Roles share one family rather
 * than two: sharing a Role is then an ordinary update of its own row, with no
 * data moved between documents and no window where a Role exists in both or
 * neither.
 */
export const WORKSPACE_FLOCK_ROW_FAMILIES = ['mcpServer', 'agentRole', 'setting'] as const;

export const workspaceFlockKeys = {
  mcpServer: (id: McpServerId): WorkspaceFlockMcpServerKey => ['mcpServer', id],
  agentRole: (id: AgentRoleId): WorkspaceFlockAgentRoleKey => ['agentRole', id],
  voiceSetting: (): WorkspaceFlockVoiceSettingKey => ['setting', 'voice'],
  promptSuggestionsSetting: (): WorkspaceFlockPromptSuggestionsSettingKey => [
    'setting',
    'promptSuggestions',
  ],
  agentToolsSetting: (): WorkspaceFlockAgentToolsSettingKey => ['setting', 'agentTools'],
} as const;

export type ParsedWorkspaceFlockKey =
  | {
      kind: 'mcpServer';
      key: WorkspaceFlockMcpServerKey;
      mcpServerId: McpServerId;
    }
  | {
      kind: 'agentRole';
      key: WorkspaceFlockAgentRoleKey;
      agentRoleId: AgentRoleId;
    }
  | {
      kind: 'voiceSetting';
      key: WorkspaceFlockVoiceSettingKey;
    }
  | {
      kind: 'promptSuggestionsSetting';
      key: WorkspaceFlockPromptSuggestionsSettingKey;
    }
  | {
      kind: 'agentToolsSetting';
      key: WorkspaceFlockAgentToolsSettingKey;
    };

export const parseWorkspaceFlockKey = (
  key: readonly unknown[]
): ParsedWorkspaceFlockKey | undefined => {
  if (key.length !== 2 || typeof key[1] !== 'string') {
    return undefined;
  }
  const id = key[1].trim();
  if (!id) {
    return undefined;
  }
  if (key[0] === 'mcpServer') {
    const mcpServerId = id as McpServerId;
    return { kind: 'mcpServer', key: workspaceFlockKeys.mcpServer(mcpServerId), mcpServerId };
  }
  if (key[0] === 'agentRole') {
    const agentRoleId = id as AgentRoleId;
    return { kind: 'agentRole', key: workspaceFlockKeys.agentRole(agentRoleId), agentRoleId };
  }
  if (key[0] === 'setting' && id === 'voice') {
    return { kind: 'voiceSetting', key: workspaceFlockKeys.voiceSetting() };
  }
  if (key[0] === 'setting' && id === 'agentTools') {
    return { kind: 'agentToolsSetting', key: workspaceFlockKeys.agentToolsSetting() };
  }
  if (key[0] === 'setting' && id === 'promptSuggestions') {
    return {
      kind: 'promptSuggestionsSetting',
      key: workspaceFlockKeys.promptSuggestionsSetting(),
    };
  }
  return undefined;
};

export type WorkspaceFlockMcpServerRow = {
  key: WorkspaceFlockMcpServerKey;
  value: WorkspaceMcpServerMeta;
};
export type WorkspaceFlockAgentRoleRow = {
  key: WorkspaceFlockAgentRoleKey;
  value: CatalogAgentRole;
};
export type WorkspaceFlockVoiceSettingRow = {
  key: WorkspaceFlockVoiceSettingKey;
  value: WorkspaceVoiceSetting;
};
export type WorkspaceFlockPromptSuggestionsSettingRow = {
  key: WorkspaceFlockPromptSuggestionsSettingKey;
  value: WorkspacePromptSuggestionsSetting;
};
export type WorkspaceFlockAgentToolsSettingRow = {
  key: WorkspaceFlockAgentToolsSettingKey;
  value: WorkspaceAgentToolsSetting;
};
export type WorkspaceFlockRow =
  | WorkspaceFlockMcpServerRow
  | WorkspaceFlockAgentRoleRow
  | WorkspaceFlockVoiceSettingRow
  | WorkspaceFlockPromptSuggestionsSettingRow
  | WorkspaceFlockAgentToolsSettingRow;
export type WorkspaceFlockRowId = string & { __brand: 'WorkspaceFlockRowId' };
export type WorkspaceFlockRowMap = Record<WorkspaceFlockRowId, WorkspaceFlockRow>;

export type WorkspaceFlockScanRow = {
  readonly key: readonly unknown[];
  readonly value?: unknown;
};
export type WorkspaceFlockEvent = WorkspaceFlockScanRow;
export type WorkspaceFlockScanOptions = { readonly prefix?: readonly unknown[] };
export type WorkspaceFlockReadableFlock = {
  scan(options?: WorkspaceFlockScanOptions): Iterable<WorkspaceFlockScanRow>;
};
export type WorkspaceFlockWritableFlock = WorkspaceFlockReadableFlock & {
  set(key: WorkspaceFlockKey, value: unknown, timestamp?: number): void;
  delete(key: WorkspaceFlockKey, timestamp?: number): void;
  commit(): void;
};

export const serializeWorkspaceFlockKey = (key: WorkspaceFlockKey): WorkspaceFlockRowId =>
  JSON.stringify(key) as WorkspaceFlockRowId;

export const parseWorkspaceFlockRow = (
  key: readonly unknown[],
  value: unknown
): WorkspaceFlockRow | undefined => {
  const parsedKey = parseWorkspaceFlockKey(key);
  if (!parsedKey) {
    return undefined;
  }
  if (parsedKey.kind === 'mcpServer') {
    if (!isWorkspaceMcpServerMeta(value) || value.id !== parsedKey.mcpServerId) {
      return undefined;
    }
    return { key: parsedKey.key, value };
  }
  if (parsedKey.kind === 'agentToolsSetting') {
    const setting = normalizeAgentTools(value);
    return setting ? { key: parsedKey.key, value: setting } : undefined;
  }
  if (parsedKey.kind === 'voiceSetting') {
    if (!isWorkspaceVoiceSetting(value)) return undefined;
    return {
      key: parsedKey.key,
      value: {
        version: 1,
        configId: value.configId,
        machineId: value.machineId,
        // A malformed voice is dropped, not the agent choice that carries it.
        ...(isVoiceName(value.voice) ? { voice: value.voice } : {}),
      },
    };
  }
  if (parsedKey.kind === 'promptSuggestionsSetting') {
    if (typeof value !== 'object' || value === null) return undefined;
    if ((value as Record<string, unknown>)['version'] !== 1) return undefined;
    return { key: parsedKey.key, value: { version: 1 } };
  }
  // Normalized rather than merely validated: an option key an older client
  // should never have written must not survive into a Session config just
  // because it is already in the document.
  const role = normalizeAgentRole(value);
  if (!role || role.id !== parsedKey.agentRoleId) {
    return undefined;
  }
  return { key: parsedKey.key, value: role };
};

const isMcpServerRow = (row: WorkspaceFlockRow): row is WorkspaceFlockMcpServerRow =>
  row.key[0] === 'mcpServer';

const isAgentRoleRow = (row: WorkspaceFlockRow): row is WorkspaceFlockAgentRoleRow =>
  row.key[0] === 'agentRole';

export const readWorkspaceFlockRowsFromFlock = (
  flock: WorkspaceFlockReadableFlock
): WorkspaceFlockRowMap => {
  const rows: WorkspaceFlockRowMap = {};
  for (const family of WORKSPACE_FLOCK_ROW_FAMILIES) {
    for (const row of flock.scan({ prefix: [family] })) {
      const parsed = parseWorkspaceFlockRow(row.key, row.value);
      if (parsed) {
        rows[serializeWorkspaceFlockKey(parsed.key)] = parsed;
      }
    }
  }
  return rows;
};

export const getWorkspaceMcpCatalog = (
  rows: WorkspaceFlockRowMap
): Record<McpServerId, WorkspaceMcpServerMeta> => {
  const catalog = {} as Record<McpServerId, WorkspaceMcpServerMeta>;
  for (const row of Object.values(rows)) {
    if (isMcpServerRow(row)) {
      catalog[row.key[1]] = row.value;
    }
  }
  return catalog;
};

export const getWorkspaceVoiceSetting = (
  rows: WorkspaceFlockRowMap
): WorkspaceVoiceSetting | null => {
  const row = rows[serializeWorkspaceFlockKey(workspaceFlockKeys.voiceSetting())];
  return row && row.key[0] === 'setting' ? (row.value as WorkspaceVoiceSetting) : null;
};

export const isWorkspacePromptSuggestionsEnabled = (rows: WorkspaceFlockRowMap): boolean =>
  rows[serializeWorkspaceFlockKey(workspaceFlockKeys.promptSuggestionsSetting())] !== undefined;

/** The experimental agent tools the workspace offers; none when the row is absent. */
export const getWorkspaceAgentTools = (rows: WorkspaceFlockRowMap): LodyAgentToolId[] => {
  const row = rows[serializeWorkspaceFlockKey(workspaceFlockKeys.agentToolsSetting())];
  return row && row.key[1] === 'agentTools' ? (row.value as WorkspaceAgentToolsSetting).tools : [];
};

export const listWorkspaceMcpServers = (rows: WorkspaceFlockRowMap): WorkspaceMcpServerMeta[] =>
  Object.values(rows)
    .filter(isMcpServerRow)
    .map((row) => row.value)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

export const listWorkspaceAgentRoles = (rows: WorkspaceFlockRowMap): CatalogAgentRole[] =>
  Object.values(rows)
    .filter(isAgentRoleRow)
    .map((row) => row.value)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

const workspaceFlockRowsEqual = (
  left: WorkspaceFlockRow | undefined,
  right: WorkspaceFlockRow | undefined
): boolean => {
  if (left === right) return true;
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
};

export const writeWorkspaceMcpServerToFlock = (
  flock: WorkspaceFlockWritableFlock,
  entry: WorkspaceMcpServerMeta
): boolean => writeWorkspaceFlockRow(flock, workspaceFlockKeys.mcpServer(entry.id), entry);

export const deleteWorkspaceMcpServerFromFlock = (
  flock: WorkspaceFlockWritableFlock,
  id: McpServerId
): boolean => deleteWorkspaceFlockRow(flock, workspaceFlockKeys.mcpServer(id));

export const writeWorkspaceAgentRoleToFlock = (
  flock: WorkspaceFlockWritableFlock,
  role: CatalogAgentRole
): boolean => writeWorkspaceFlockRow(flock, workspaceFlockKeys.agentRole(role.id), role);

export const deleteWorkspaceAgentRoleFromFlock = (
  flock: WorkspaceFlockWritableFlock,
  id: AgentRoleId
): boolean => deleteWorkspaceFlockRow(flock, workspaceFlockKeys.agentRole(id));

const writeWorkspaceFlockRow = (
  flock: WorkspaceFlockWritableFlock,
  key: WorkspaceFlockKey,
  value: unknown
): boolean => {
  const row = parseWorkspaceFlockRow(key, value);
  if (!row) {
    return false;
  }
  const rowId = serializeWorkspaceFlockKey(row.key);
  const previous = readSingleRow(flock, row.key)[rowId];
  if (workspaceFlockRowsEqual(previous, row)) {
    return false;
  }
  flock.set(row.key, row.value);
  flock.commit();
  return true;
};

const deleteWorkspaceFlockRow = (
  flock: WorkspaceFlockWritableFlock,
  key: WorkspaceFlockKey
): boolean => {
  const rowId = serializeWorkspaceFlockKey(key);
  if (!readSingleRow(flock, key)[rowId]) {
    return false;
  }
  flock.delete(key);
  flock.commit();
  return true;
};

export const applyWorkspaceFlockRowEvents = (
  previous: WorkspaceFlockRowMap,
  events: readonly WorkspaceFlockEvent[]
): WorkspaceFlockRowMap => {
  let next: WorkspaceFlockRowMap | null = null;
  const mutableNext = (): WorkspaceFlockRowMap => {
    next ??= { ...previous };
    return next;
  };

  for (const event of events) {
    const parsedKey = parseWorkspaceFlockKey(event.key);
    if (!parsedKey) continue;
    const rowId = serializeWorkspaceFlockKey(parsedKey.key);
    const current = next ?? previous;
    if (event.value === undefined) {
      if (Object.prototype.hasOwnProperty.call(current, rowId)) {
        delete mutableNext()[rowId];
      }
      continue;
    }
    const parsed = parseWorkspaceFlockRow(event.key, event.value);
    if (!parsed) {
      if (Object.prototype.hasOwnProperty.call(current, rowId)) {
        delete mutableNext()[rowId];
      }
      continue;
    }
    if (!workspaceFlockRowsEqual(current[rowId], parsed)) {
      mutableNext()[rowId] = parsed;
    }
  }
  return next ?? previous;
};

const readSingleRow = (
  flock: WorkspaceFlockReadableFlock,
  key: WorkspaceFlockKey
): WorkspaceFlockRowMap => {
  const rows: WorkspaceFlockRowMap = {};
  for (const candidate of flock.scan({ prefix: key })) {
    const row = parseWorkspaceFlockRow(candidate.key, candidate.value);
    if (row) rows[serializeWorkspaceFlockKey(row.key)] = row;
  }
  return rows;
};
