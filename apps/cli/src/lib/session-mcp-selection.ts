import {
  getDefaultSelectedMcpServerIds,
  resolveSessionConversationConfig,
  type McpServerId,
  type WorkspaceId,
} from '@lody/shared';

import type { LoroDocumentManager } from './loro/doc';
import { listWorkspaceMcpCatalog, syncMcpCatalog } from './workspace-mcp-store';
import { formatErrorMessage } from '@/utils/format-error';
import { getLogger } from '@/utils/logger';

/**
 * Turns written outside the desktop composer must still record a workspace MCP
 * selection: dispatch reads an absent one as `[]`. These helpers give such
 * producers (Schedules, CLI and MCP Session tools) the composer's own choice.
 */
export type McpSelectionManager = Pick<LoroDocumentManager, 'repo' | 'syncFlockDocOrThrow'>;

/**
 * Keep a stated selection, including an explicit `[]`. Without one, use the
 * catalog's `enabledByDefault` servers, which is what a new composer preselects.
 * Like the composer, a default may come from this machine's catalog copy: a
 * failed refresh is logged, never a reason to refuse the Turn.
 */
export async function resolveMcpSelectionOrWorkspaceDefault(args: {
  manager: McpSelectionManager;
  workspaceId: WorkspaceId;
  localOnly?: boolean;
  selection: readonly McpServerId[] | undefined;
}): Promise<McpServerId[]> {
  if (args.selection !== undefined) return [...args.selection];
  if (!args.localOnly) {
    await syncMcpCatalog(args.manager, args.workspaceId).catch((error: unknown) => {
      getLogger('mcp-selection').debug(
        `Using the local MCP catalog copy for workspace defaults: ${formatErrorMessage(error)}`
      );
    });
  }
  return getDefaultSelectedMcpServerIds(
    await listWorkspaceMcpCatalog(args.manager.repo, args.workspaceId)
  );
}

/** The selection an existing Session last recorded, read the way its composer reads it. */
export const readRecordedSessionMcpSelection = (
  history: readonly { id: string; role: unknown; inputConfig?: unknown }[]
): McpServerId[] | undefined => resolveSessionConversationConfig(history).mcpServerIds;
