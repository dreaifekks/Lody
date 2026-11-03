import {
  type ProjectRef,
  resolveSessionConversationConfig,
  type McpServerId,
  type WorkspaceId,
} from '@lody/shared';

import type { LoroDocumentManager } from './loro/doc';
import {
  readProjectDefaultMcpIds,
  syncMcpCatalog,
  waitForMcpDefaultCatalog,
} from './workspace-mcp-store';
import { getSessionCommandEnvironment } from './session-command-environment';

/**
 * Turns written outside the desktop composer must still record a workspace MCP
 * selection: dispatch reads an absent one as `[]`. These helpers give such
 * producers (Schedules, CLI and MCP Session tools) the composer's own choice.
 */
export type McpSelectionManager = Pick<LoroDocumentManager, 'repo' | 'syncFlockDocOrThrow'> &
  Partial<
    Pick<
      LoroDocumentManager,
      'hasWorkspaceCatalogReader' | 'catalogBaselineReady' | 'hasPersistedWorkspaceCatalog'
    >
  >;

/**
 * Keep a stated selection, including an explicit `[]`. Without one, use the
 * catalog's `enabledByDefault` servers, which is what a new composer preselects.
 * Use the daemon's confirmed catalog baseline, with the upstream persisted-checkpoint
 * policy. A retryable cold read must happen before Operation acceptance.
 */
export async function resolveMcpSelectionOrWorkspaceDefault(args: {
  manager: McpSelectionManager;
  workspaceId: WorkspaceId;
  localOnly?: boolean;
  project?: ProjectRef;
  machineId?: string;
  selection: readonly McpServerId[] | undefined;
}): Promise<McpServerId[]> {
  if (args.selection !== undefined) return [...args.selection];
  const environment = getSessionCommandEnvironment();
  if (!args.localOnly && !(environment && !environment.host.remote)) {
    if (
      args.manager.hasWorkspaceCatalogReader?.() &&
      args.manager.catalogBaselineReady &&
      args.manager.hasPersistedWorkspaceCatalog
    ) {
      await waitForMcpDefaultCatalog(
        {
          catalogBaselineReady: args.manager.catalogBaselineReady.bind(args.manager),
          hasPersistedWorkspaceCatalog: args.manager.hasPersistedWorkspaceCatalog.bind(
            args.manager
          ),
        },
        args.workspaceId
      );
    } else {
      await syncMcpCatalog(args.manager, args.workspaceId);
    }
  }
  return readProjectDefaultMcpIds(
    args.manager.repo,
    args.workspaceId,
    args.project,
    args.machineId ?? ''
  );
}

/** The selection an existing Session last recorded, read the way its composer reads it. */
export const readRecordedSessionMcpSelection = (
  history: readonly { id: string; role: unknown; inputConfig?: unknown }[]
): McpServerId[] | undefined => resolveSessionConversationConfig(history).mcpServerIds;
