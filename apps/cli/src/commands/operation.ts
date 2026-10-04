import { Command } from 'commander';
import type { SessionId, WorkspaceId } from '@lody/shared';
import { runOneShotCommand, printJson } from '@/lib/command-runtime';
import { runWorkspaceCommand, type WorkspaceCommandContext } from '@/lib/terminal-session-tools';
import {
  getLodyOperationStorePath,
  LodyOperationStore,
  OperationListQuerySchema,
  runWithOperationStoreBusyRetry,
  type OperationListQuery,
} from '@/orchestration/operation-store';
import { renderTerminalTable } from '@/lib/terminal-table';

type Options = OperationListQuery & {
  workspace?: string;
  session?: string;
  json?: boolean;
  debug?: boolean;
};
/**
 * The Operations a requester Session started for this user, from the store of
 * the machine they run on: read by the hosted command line, or by a local
 * daemon, whose identity in the workspace names the user.
 */
export async function listRequesterOperations(
  { auth, workspace }: Pick<WorkspaceCommandContext, 'auth' | 'workspace'>,
  sessionId: string,
  query: OperationListQuery
) {
  const store = new LodyOperationStore(getLodyOperationStorePath(auth.machineId), undefined, {
    maintenance: false,
  });
  try {
    return await runWithOperationStoreBusyRetry(() =>
      store.listForRequester(
        {
          workspaceId: workspace.id as WorkspaceId,
          requesterSessionId: sessionId as SessionId,
          requesterUserId: auth.userId,
        },
        query
      )
    );
  } finally {
    store.close();
  }
}

export const operationCommand = new Command('operation')
  .description('Inspect Operations on this machine')
  .addCommand(
    new Command('list')
      .description('List Operations owned by a requester Session and the authenticated user')
      .option('--workspace <selector>', 'Workspace id, slug or name')
      .option('--session <id>', 'Requester session id (defaults to LODY_SESSION_ID)')
      .option('--state <state>', 'active or finished')
      .option('--limit <count>', 'Page size (1-100, default 20)', Number)
      .option('--cursor <cursor>', 'Next page cursor')
      .option('--json', 'Print JSON')
      .option('--debug', 'Enable debug output')
      .action(async (options: Options) =>
        runOneShotCommand('operation', options, async () => {
          const sessionId = options.session?.trim() || process.env.LODY_SESSION_ID?.trim();
          if (!sessionId) throw new Error('Pass --session or set LODY_SESSION_ID.');
          const query = OperationListQuerySchema.parse({
            state: options.state,
            limit: options.limit,
            cursor: options.cursor,
          });
          const page = await runWorkspaceCommand(
            'operation',
            options.workspace,
            { command: 'operation-list', session: sessionId, ...query },
            (context) => listRequesterOperations(context, sessionId, query)
          );
          if (options.json) printJson(page);
          else {
            console.log(
              renderTerminalTable(
                [{ header: 'ID' }, { header: 'Kind' }, { header: 'State' }, { header: 'Items' }],
                page.items.map((row) => [row.operationId, row.kind, row.state, row.itemCount])
              )
            );
            if (page.nextCursor) console.log(`Next page: --cursor ${page.nextCursor}`);
          }
        })
      )
  );
