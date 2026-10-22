import {
  getWorkspaceFlockDocId,
  serializeAgentRoleRow,
  workspaceFlockKeys,
  type BoardMeta,
  MAX_BOARDS_PER_WORKSPACE,
  listWorkspaceBoards,
  normalizeBoardMeta,
  readWorkspaceFlockRowsFromFlock,
  type AgentRoleId,
  type AgentRole,
  type McpServerId,
  type WorkspaceId,
  type WorkspaceMcpServerMeta,
  type WorkspaceVoiceSetting,
  type LodyAgentToolId,
} from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';

/**
 * Catalog mutations: durable locally, shared optimistically.
 *
 * Every write resolves as soon as `flockRowPut`/`flockRowDelete` lands — that is
 * the point at which the row exists and the UI can move on. The explicit upload
 * still runs, but nobody waits for it and no surface reports it:
 *
 * - it is a round trip, and blocking an editor on it made a finished, already
 *   durable save sit there looking unfinished for seconds;
 * - failing it is not a failed save, and the old "saved on this device but not
 *   yet synced" banner said something the user could neither act on nor dismiss;
 * - the catalog room stays joined while any consumer is mounted, so a document
 *   this one-shot upload could not push reconciles on the room's own sync.
 *
 * What must never happen is the opposite: reporting a write as failed, or
 * rolling one back, because the upload did not go through.
 */

export type WorkspaceCatalogWriteDeps = {
  workspaceId: WorkspaceId;
  writer: Pick<WorkspaceRuntime['writer'], 'flockRowPut' | 'flockRowDelete'>;
  repo: Pick<WorkspaceRuntime['repo'], 'openFlockDoc'>;
};

/**
 * Push the committed document to the workspace, best effort.
 *
 * Never rejects: a caller has already made its change durable, and there is
 * nothing for it — or the user — to do about a failed upload but let the room
 * carry it later.
 */
export const uploadWorkspaceCatalog = async (deps: WorkspaceCatalogWriteDeps): Promise<void> => {
  try {
    const handle = await deps.repo.openFlockDoc(getWorkspaceFlockDocId(deps.workspaceId));
    await handle.syncOnce();
  } catch (error) {
    console.warn('Workspace catalog upload deferred to room sync', error);
  }
};

/** Durable write, then an upload nobody waits on. */
const putRow = async (
  deps: WorkspaceCatalogWriteDeps,
  key: Parameters<WorkspaceRuntime['writer']['flockRowPut']>[1],
  value: unknown
): Promise<void> => {
  await deps.writer.flockRowPut(getWorkspaceFlockDocId(deps.workspaceId), key, value);
  void uploadWorkspaceCatalog(deps);
};

const deleteRow = async (
  deps: WorkspaceCatalogWriteDeps,
  key: Parameters<WorkspaceRuntime['writer']['flockRowDelete']>[1]
): Promise<void> => {
  await deps.writer.flockRowDelete(getWorkspaceFlockDocId(deps.workspaceId), key);
  void uploadWorkspaceCatalog(deps);
};

export const putWorkspaceMcpServer = (
  deps: WorkspaceCatalogWriteDeps,
  entry: WorkspaceMcpServerMeta
): Promise<void> => putRow(deps, workspaceFlockKeys.mcpServer(entry.id), entry);

export const deleteWorkspaceMcpServer = (
  deps: WorkspaceCatalogWriteDeps,
  id: McpServerId
): Promise<void> => deleteRow(deps, workspaceFlockKeys.mcpServer(id));

/**
 * Write a Role — created, edited, shared, or unshared.
 *
 * Sharing is this same call: `visibility` lives on the row, so the whole catalog
 * stays one family and no state exists where a Role is in both directories or
 * neither. The stored shape is the serializer's: v1 for a single-target Role,
 * v2 — which older clients skip rather than rewrite — once it has several.
 */
export const writeWorkspaceAgentRole = (
  deps: WorkspaceCatalogWriteDeps,
  role: AgentRole
): Promise<void> =>
  putRow(deps, workspaceFlockKeys.agentRole(role.id), serializeAgentRoleRow(role));

export const deleteWorkspaceAgentRole = (
  deps: WorkspaceCatalogWriteDeps,
  id: AgentRoleId
): Promise<void> => deleteRow(deps, workspaceFlockKeys.agentRole(id));

/** Turn experimental prompt suggestions on or off for every device of the workspace. */
export const writeWorkspacePromptSuggestionsSetting = (
  deps: WorkspaceCatalogWriteDeps,
  enabled: boolean
): Promise<void> =>
  enabled
    ? putRow(deps, workspaceFlockKeys.promptSuggestionsSetting(), { version: 1 })
    : deleteRow(deps, workspaceFlockKeys.promptSuggestionsSetting());

/** Share one Codex agent for voice with every device of the workspace, or stop sharing. */
export const writeWorkspaceVoiceSetting = (
  deps: WorkspaceCatalogWriteDeps,
  setting: WorkspaceVoiceSetting | null
): Promise<void> =>
  setting
    ? putRow(deps, workspaceFlockKeys.voiceSetting(), setting)
    : deleteRow(deps, workspaceFlockKeys.voiceSetting());

/** Pin these local projects (machine-qualified keys) on every device; none clears the row. */
export const writeWorkspacePinnedProjects = (
  deps: WorkspaceCatalogWriteDeps,
  keys: readonly string[]
): Promise<void> =>
  keys.length > 0
    ? putRow(deps, workspaceFlockKeys.pinnedProjectsSetting(), { version: 1, keys: [...keys] })
    : deleteRow(deps, workspaceFlockKeys.pinnedProjectsSetting());

/** The experimental Lody tools every machine of the workspace offers its agents. */
export const writeWorkspaceAgentTools = (
  deps: WorkspaceCatalogWriteDeps,
  tools: readonly LodyAgentToolId[]
): Promise<void> =>
  putRow(deps, workspaceFlockKeys.agentToolsSetting(), { version: 1, tools: [...tools] });

export const writeWorkspaceBoard = (
  deps: WorkspaceCatalogWriteDeps,
  board: BoardMeta
): Promise<void> => putRow(deps, workspaceFlockKeys.board(board.id), board);
export const deleteWorkspaceBoard = (
  deps: WorkspaceCatalogWriteDeps,
  id: BoardMeta['id']
): Promise<void> => deleteRow(deps, workspaceFlockKeys.board(id));

const countActiveBoards = async (deps: WorkspaceCatalogWriteDeps): Promise<number> => {
  const handle = await deps.repo.openFlockDoc(getWorkspaceFlockDocId(deps.workspaceId));
  return listWorkspaceBoards(readWorkspaceFlockRowsFromFlock(handle.flock)).filter(
    (entry) => entry.archivedAtMs === undefined
  ).length;
};

/**
 * Restoring brings a Board back under the active limit, so it is checked here too.
 * The row leaves the archive last: if a member fails, the Board stays archived and
 * its Restore entry remains for a retry.
 */
export async function restoreWorkspaceBoard(
  deps: WorkspaceCatalogWriteDeps,
  board: BoardMeta,
  restoreMembers: () => Promise<void>
): Promise<BoardMeta> {
  if ((await countActiveBoards(deps)) >= MAX_BOARDS_PER_WORKSPACE) throw new Error('BOARD_LIMIT');
  await restoreMembers();
  const { archivedAtMs: _archivedAtMs, ...restored } = board;
  await writeWorkspaceBoard(deps, restored);
  return restored;
}

/**
 * Renames the Board as its row stands now, so a rename typed against an older copy
 * keeps every other field another window or machine changed meanwhile.
 */
export async function renameWorkspaceBoard(
  deps: WorkspaceCatalogWriteDeps,
  id: BoardMeta['id'],
  name: string
): Promise<BoardMeta> {
  const handle = await deps.repo.openFlockDoc(getWorkspaceFlockDocId(deps.workspaceId));
  const current = listWorkspaceBoards(readWorkspaceFlockRowsFromFlock(handle.flock)).find(
    (entry) => entry.id === id
  );
  if (!current) throw new Error('BOARD_NOT_FOUND');
  const next = normalizeBoardMeta({ ...current, name });
  if (!next) throw new Error('BOARD_INVALID');
  await writeWorkspaceBoard(deps, next);
  return next;
}

/** Board creation compensates only a rejected first-turn acceptance, never upload. */
export async function createWorkspaceBoard<T>(
  deps: WorkspaceCatalogWriteDeps,
  board: BoardMeta,
  startCoordinator: () => Promise<T>
): Promise<T> {
  if ((await countActiveBoards(deps)) >= MAX_BOARDS_PER_WORKSPACE) throw new Error('BOARD_LIMIT');
  await writeWorkspaceBoard(deps, board);
  try {
    return await startCoordinator();
  } catch (error) {
    await deleteWorkspaceBoard(deps, board.id);
    throw error;
  }
}
