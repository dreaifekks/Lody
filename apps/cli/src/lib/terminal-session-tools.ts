import { Effect } from 'effect';
import { z } from 'zod';
import {
  LocalMachineRpcRequestSchema,
  type LocalMachineRpcRequest,
  type LocalMachineRpcResult,
  type TerminalCommand,
} from '@lody/shared';
import { IpcProtocolError, makeLocalControlClientAuto } from '@lody/shared/node/local-ipc';
import { makeLocalWorkspaceCatalog } from './local-workspace-catalog';
import {
  classifyLocalDaemonIpcError,
  getAuthContextOrThrow,
  LocalDaemonAvailabilityError,
  resolveWorkspaceOrThrow,
  withWorkspaceManager,
  type AuthContext,
} from './command-runtime';
import { getCliPlatformKind } from './cli-platform';
import type { LoroDocumentManager } from './loro/doc';
import type { WorkspaceSummary } from './workspace';

const TERMINAL_TOOL_TIMEOUT_MS = 60_000;

export type TerminalToolTarget = { machineId: string; workspaceId: string };

/**
 * The active local workspace a terminal command reads, chosen by id, slug or
 * name; `LODY_WORKSPACE_ID` stands in for a missing selector, as it does for
 * `schedule`.
 */
export async function resolveTerminalToolTarget(selector?: string): Promise<TerminalToolTarget> {
  const catalog = await Effect.runPromise(makeLocalWorkspaceCatalog().read());
  if (!catalog.machine) throw new Error('This machine has no workspace; start the daemon first.');
  const wanted = selector ?? process.env.LODY_WORKSPACE_ID;
  const active = catalog.workspaces.filter((row) => row.state === 'active');
  const candidates = active.filter(
    (row) => !wanted || [row.workspaceId, row.slug, row.name].includes(wanted)
  );
  if (candidates.length === 0)
    throw new Error(
      wanted ? `No active workspace matches ${wanted}.` : 'This machine has no active workspace.'
    );
  if (candidates.length > 1)
    throw new Error(
      `Choose a workspace with --workspace: ${candidates
        .map((row) => `${row.name} (${row.workspaceId})`)
        .join(', ')}`
    );
  return { machineId: catalog.machine.machineId, workspaceId: candidates[0]!.workspaceId };
}

/** A tool's failure, carrying the stable code the daemon reported when it had one. */
export class TerminalToolError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = 'TerminalToolError';
  }
}

const ToolErrorPayloadSchema = z.object({
  error: z.object({ code: z.string().optional(), message: z.string() }),
});

/**
 * Sends one terminal request to this machine's daemon. The request is checked
 * against the shared schema first, so a daemon that still rejects it as
 * malformed predates it.
 */
async function sendTerminalRequest(
  request: LocalMachineRpcRequest,
  timeoutMs: number
): Promise<LocalMachineRpcResult> {
  const outcome = await Effect.runPromise(
    makeLocalControlClientAuto()
      .machineRpc(LocalMachineRpcRequestSchema.parse(request), { timeoutMs })
      .pipe(Effect.either)
  );
  if (outcome._tag === 'Left') {
    if (outcome.left instanceof IpcProtocolError && outcome.left.status === 400)
      throw new Error(
        'The running daemon is older than this command line and cannot answer it; restart or update the daemon.'
      );
    throw classifyLocalDaemonIpcError(outcome.left);
  }
  const response = outcome.right;
  if (!response.ok) throw new Error(response.error);
  return response.result;
}

/**
 * Calls one of the daemon's read-only Session tools for this terminal and
 * returns its parsed JSON payload.
 */
export async function callTerminalSessionTool(
  target: TerminalToolTarget,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const result = await sendTerminalRequest(
    {
      method: 'cli/call-tool',
      machineId: target.machineId,
      workspaceId: target.workspaceId,
      // Drop absent options: the tool schemas are strict JSON.
      params: {
        name,
        arguments: z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(args))),
      },
    },
    TERMINAL_TOOL_TIMEOUT_MS
  );
  if (!('type' in result) || result.type !== 'session/tool-result')
    throw new Error('Unexpected Session tool response');
  const text = result.content.map((part) => part.text).join('');
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    if (result.isError) throw new TerminalToolError(text);
    throw new Error(`${name} returned a response that is not JSON`);
  }
  if (result.isError) {
    const parsed = ToolErrorPayloadSchema.safeParse(payload);
    throw parsed.success
      ? new TerminalToolError(parsed.data.error.message, parsed.data.error.code)
      : new TerminalToolError(text);
  }
  return payload;
}

// Creating a Session may prepare a worktree first; waiting adds its own deadline.
const TERMINAL_COMMAND_TIMEOUT_MS = 120_000;
/** Syncing or exporting a whole workspace reads every document it holds. */
const TERMINAL_BULK_COMMAND_TIMEOUT_MS = 30 * 60_000;

/** Runs a terminal command on this machine's daemon and returns its result. */
export async function runTerminalCommand(
  target: TerminalToolTarget,
  command: TerminalCommand
): Promise<Record<string, unknown>> {
  const result = await sendTerminalRequest(
    {
      method: 'cli/command',
      machineId: target.machineId,
      workspaceId: target.workspaceId,
      params: JSON.parse(JSON.stringify(command)) as TerminalCommand,
    },
    command.command === 'wait'
      ? command.timeoutMs + TERMINAL_COMMAND_TIMEOUT_MS
      : command.command === 'sync' || command.command === 'export'
        ? TERMINAL_BULK_COMMAND_TIMEOUT_MS
        : TERMINAL_COMMAND_TIMEOUT_MS
  ).catch((error: unknown) => {
    // The daemon keeps going after the socket gives up: a retry could send twice.
    if (
      (command.command === 'create' || command.command === 'chat') &&
      error instanceof LocalDaemonAvailabilityError &&
      error.code === 'DAEMON_BUSY'
    )
      throw new Error(
        `The daemon did not answer in time, but it may still have ${command.command === 'create' ? 'created the Session' : 'sent the message'}. Check \`session list\` or \`session history\` before retrying.`
      );
    throw error;
  });
  if (!('type' in result) || result.type !== 'cli/command-result')
    throw new Error('Unexpected session command response');
  return result.value;
}

/** What a workspace command's body reads and writes through. */
export type WorkspaceCommandContext = {
  auth: AuthContext;
  workspace: WorkspaceSummary;
  manager: LoroDocumentManager;
};

/**
 * Runs a workspace command's body where the workspace lives: the hosted
 * command line opens its own replica, while on the local platform the daemon
 * owns the only replica and runs the same body as `local` names it
 * (`commands/terminal-daemon.ts`), returning the body's JSON result.
 */
export async function runWorkspaceCommand<T>(
  loggerName: string,
  workspaceSelector: string | undefined,
  local: TerminalCommand,
  run: (context: WorkspaceCommandContext) => Promise<T>
): Promise<T> {
  if (getCliPlatformKind() === 'local') {
    const target = await resolveTerminalToolTarget(workspaceSelector);
    // The daemon ran `run` itself; its result crossed the socket as JSON.
    return (await runTerminalCommand(target, local)) as T;
  }
  const auth = getAuthContextOrThrow(loggerName);
  const workspace = await resolveWorkspaceOrThrow(auth, workspaceSelector);
  return await withWorkspaceManager(auth, workspace, loggerName, (manager) =>
    run({ auth, workspace, manager })
  );
}
