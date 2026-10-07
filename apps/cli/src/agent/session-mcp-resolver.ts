import {
  getWorkspaceAgentTools,
  getWorkspaceFlockDocId,
  getWorkspaceMcpCatalog,
  isWorkspacePromptSuggestionsEnabled,
  readWorkspaceFlockRowsFromFlock,
  resolveSessionMcpServers,
  type LodyAgentToolId,
  type McpServerId,
  type ResolveSessionMcpServersResult,
  type ResolveSessionMcpServersInput,
  type SessionId,
  type WorkspaceFlockReadableFlock,
  type WorkspaceId,
} from '@lody/shared';
import { formatErrorMessage } from '@/utils/format-error';

/**
 * Applies the agent's advertised capabilities to an already-loaded catalog.
 * Pure, so it can run at the exact point ACP startup needs the server list.
 */
export type SessionMcpCatalogSelector = (
  agentCapabilities: ResolveSessionMcpServersInput['agentCapabilities']
) => ResolveSessionMcpServersResult;

export type LoadSessionMcpCatalogInput = {
  repo: {
    openFlockDoc(docId: string): Promise<{ flock: WorkspaceFlockReadableFlock }>;
  };
  syncFlockDoc?: (docId: string, options: { timeoutMs: number }) => Promise<void>;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  selectedIds: readonly McpServerId[];
  logger: { debug(message: string): void };
  env?: Readonly<Record<string, string | undefined>>;
};

const CATALOG_SYNC_TIMEOUT_MS = 5_000;

const EMPTY_SELECTION: SessionMcpCatalogSelector = () => ({ servers: [], problems: [] });

/**
 * Loads the workspace MCP catalog for an ACP session start.
 *
 * Deliberately split from selection: the only thing selection needs from the
 * agent is its advertised `http` capability, so this — a remote catalog sync
 * plus a document read — can overlap process spawn and the ACP handshake
 * instead of adding a round trip between `initialize` and `newSession`.
 *
 * Best effort. Configuration failures come back as problems on the selector so
 * the agent still starts with its built-in MCP.
 */
export const loadSessionMcpCatalog = async (
  input: LoadSessionMcpCatalogInput
): Promise<SessionMcpCatalogSelector> => {
  const { logger, selectedIds, sessionId } = input;
  if (selectedIds.length === 0) {
    return EMPTY_SELECTION;
  }

  const docId = getWorkspaceFlockDocId(input.workspaceId);
  if (input.syncFlockDoc) {
    try {
      await input.syncFlockDoc(docId, { timeoutMs: CATALOG_SYNC_TIMEOUT_MS });
    } catch (error) {
      logger.debug(
        `[${sessionId}] Workspace MCP catalog refresh failed; using local rows: ${formatErrorMessage(error)}`
      );
    }
  }

  try {
    const handle = await input.repo.openFlockDoc(docId);
    const catalog = getWorkspaceMcpCatalog(readWorkspaceFlockRowsFromFlock(handle.flock));
    const env = input.env ?? process.env;
    return (agentCapabilities) =>
      resolveSessionMcpServers({ catalog, selectedIds, agentCapabilities, env });
  } catch (error) {
    const reason = formatErrorMessage(error);
    logger.debug(`[${sessionId}] Workspace MCP catalog read failed: ${reason}`);
    return () => ({ servers: [], problems: [{ kind: 'catalog_unavailable', reason }] });
  }
};

export type SessionWorkspaceSettings = {
  promptSuggestions: boolean;
  agentTools: LodyAgentToolId[];
};

/**
 * The workspace settings an agent start needs: whether Claude should suggest
 * the next message, and which experimental Lody tools the agent is offered.
 *
 * Syncs the workspace document once first, whatever the MCP selection is: a
 * daemon without a desktop has no other reader of that document, so its local
 * copy is only as new as its last sync. Best effort: a failed sync reads the
 * local copy, and a failed read reports everything off.
 */
export const loadSessionWorkspaceSettings = async (
  input: Omit<LoadSessionMcpCatalogInput, 'selectedIds' | 'env'>
): Promise<SessionWorkspaceSettings> => {
  const docId = getWorkspaceFlockDocId(input.workspaceId);
  if (input.syncFlockDoc) {
    try {
      await input.syncFlockDoc(docId, { timeoutMs: CATALOG_SYNC_TIMEOUT_MS });
    } catch (error) {
      input.logger.debug(
        `[${input.sessionId}] Workspace settings refresh failed; using local rows: ${formatErrorMessage(error)}`
      );
    }
  }
  try {
    const handle = await input.repo.openFlockDoc(docId);
    const rows = readWorkspaceFlockRowsFromFlock(handle.flock);
    return {
      promptSuggestions: isWorkspacePromptSuggestionsEnabled(rows),
      agentTools: getWorkspaceAgentTools(rows),
    };
  } catch (error) {
    input.logger.debug(
      `[${input.sessionId}] Workspace settings read failed; experimental settings stay off: ${formatErrorMessage(error)}`
    );
    return { promptSuggestions: false, agentTools: [] };
  }
};
