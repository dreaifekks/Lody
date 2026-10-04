import {
  buildSessionToolServer,
  runWithMcpSessionContext,
  TERMINAL_SESSION_ID,
  type McpSessionContext,
} from './lody-mcp-server';
import type { SessionToolHandlers } from './session-tool-router';
import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  SessionToolResultSchema,
  type SessionMeta,
} from '@lody/shared';
import { getSessionCommandEnvironment } from '@/lib/session-command-environment';

// Registration is stateless (tools read scope from ALS), so build the handler table once.
let handlers: SessionToolHandlers | undefined;
const getHandlers = () => {
  if (!handlers) {
    handlers = new Map();
    void buildSessionToolServer(handlers);
  }
  return handlers;
};

/** Only explicitly registered Session/catalog tools cross this IPC boundary. */
export async function executeDaemonSessionTool(
  context: McpSessionContext,
  name: string,
  args: unknown
) {
  const environment = getSessionCommandEnvironment();
  if (
    !environment ||
    context.machineId !== environment.auth.machineId ||
    context.workspaceId !== environment.workspace.id
  )
    throw new Error('Session tool scope mismatch');
  const invocation = environment.host.readInvocation(context.sessionId);
  if (!invocation.active || invocation.requesterUserId !== environment.auth.userId)
    throw new Error('Session tool requires an active local user Turn');
  const row = await environment.manager.repo.getDocMeta(getSessionRoomId(context.sessionId));
  if (
    !row?.meta ||
    isLoroRepoDocDeleted(row) ||
    (row.meta as SessionMeta).machineId !== environment.auth.machineId
  )
    throw new Error('Requester Session does not belong to this machine');
  const handler = getHandlers().get(name);
  if (!handler) throw new Error(`Unsupported daemon Session tool: ${name}`);
  const result = await runWithMcpSessionContext(context, () => handler(args));
  return SessionToolResultSchema.parse({ type: 'session/tool-result', ...result });
}

/**
 * Read-only tools a terminal on this machine may call. Each answers from the
 * workspace alone; none needs the Session or Turn an Agent call carries.
 */
export const TERMINAL_SESSION_TOOLS: ReadonlySet<string> = new Set([
  'lody_session_list',
  'lody_session_status_many',
  'lody_session_history',
  'lody_machine_list',
  'lody_project_list',
  'lody_agent_config_list',
  'lody_agent_config_get',
  'lody_agent_role_list',
  'lody_agent_role_get',
  'lody_mcp_list',
]);

/**
 * A terminal command of this machine's user. The local control socket is
 * reachable only by that user, so the daemon's own identity is the requester.
 */
export async function executeDaemonTerminalTool(
  scope: { machineId: string; workspaceId: string },
  name: string,
  args: unknown
) {
  const environment = getSessionCommandEnvironment();
  if (
    !environment ||
    scope.machineId !== environment.auth.machineId ||
    scope.workspaceId !== environment.workspace.id
  )
    throw new Error('Session tool scope mismatch');
  if (!TERMINAL_SESSION_TOOLS.has(name))
    throw new Error(`${name} is not available from a terminal`);
  const handler = getHandlers().get(name);
  if (!handler) throw new Error(`Unsupported daemon Session tool: ${name}`);
  const result = await runWithMcpSessionContext(
    {
      ...scope,
      sessionId: TERMINAL_SESSION_ID,
      terminal: true,
      localControlSocketPath: undefined,
      workdir: process.cwd(),
    },
    () => handler(args)
  );
  return SessionToolResultSchema.parse({ type: 'session/tool-result', ...result });
}
