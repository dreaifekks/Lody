import path from 'node:path';
import { Command } from 'commander';
import { getSessionRoomId, type WorkspaceId } from '@lody/shared';
import { getScheduleRegistryFlockDocId, getScheduleRoomId } from '@lody/shared';
import { listWorkspaceScheduleIds } from '@/lib/schedules/schedule-documents';
import {
  getAuthContextOrThrow,
  listAliveSessionMetas,
  resolveWorkspaceOrThrow,
  runOneShotCommand,
  syncDocForRead,
  syncWorkspaceMetaForRead,
  withWorkspaceManager,
  type CommonCommandOptions,
} from '@/lib/command-runtime';
import { exportWorkspaceData } from '@/lib/session-export';
import { mapWithConcurrency } from '@/lib/session-export/concurrency';
import { listWorkspacesForToken, type WorkspaceSummary } from '@/lib/workspace';
import { Effect } from 'effect';
import { z } from 'zod';
import { getCliPlatformKind } from '@/lib/cli-platform';
import { makeLocalWorkspaceCatalog } from '@/lib/local-workspace-catalog';
import {
  resolveTerminalToolTarget,
  runTerminalCommand,
  type WorkspaceCommandContext,
} from '@/lib/terminal-session-tools';

type ExportOptions = Pick<CommonCommandOptions, 'workspace' | 'debug'> & {
  images?: boolean;
  allWorkspace?: boolean;
  offline?: boolean;
};

const EXPORT_SYNC_CONCURRENCY = 4;

function buildDefaultOutputDir(): string {
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  return path.resolve(process.cwd(), `lody-export-${timestamp}`);
}

function toWorkspaceDirName(workspace: WorkspaceSummary): string {
  const candidate = (workspace.slug?.trim() || workspace.id).trim();
  return candidate.replace(/[\\/]/g, '_');
}

async function syncWorkspaceSessionsForExport(
  manager: Parameters<typeof exportWorkspaceData>[0]['manager'],
  workspace: WorkspaceSummary
): Promise<void> {
  await syncWorkspaceMetaForRead(manager, `export:${workspace.id}:meta`);
  const sessions = await listAliveSessionMetas(manager);
  await mapWithConcurrency(sessions, EXPORT_SYNC_CONCURRENCY, async (entry) => {
    await syncDocForRead(
      manager,
      getSessionRoomId(entry.meta.id),
      `export:${workspace.id}:${entry.meta.id}`
    );
  });

  // This reconciles visible index rows with repo existence, repairing a missing
  // projection row without reviving an explicit index tombstone.
  const workspaceId = workspace.id as WorkspaceId;
  await manager.syncFlockDocOrThrow(getScheduleRegistryFlockDocId(workspaceId), {
    reason: 'export:schedules:registry',
  });
  await mapWithConcurrency(
    await listWorkspaceScheduleIds(manager, workspaceId),
    EXPORT_SYNC_CONCURRENCY,
    async (id) => {
      await syncDocForRead(manager, getScheduleRoomId(id), `export:schedule:${id}`);
    }
  );
}

/**
 * Exports one workspace replica: the hosted command line's own, or a local
 * daemon's. Images and usage live in the hosted Lody; a local export, whose
 * images stay on the machines that hold them, leaves both out.
 */
export async function exportWorkspaceReplica(
  { auth, workspace, manager }: WorkspaceCommandContext,
  options: { outputDir: string; offline?: boolean; images?: boolean; hosted: boolean }
): Promise<{ sessionCount: number; outputDir: string; warnings: string[] }> {
  const outputDir = path.join(options.outputDir, toWorkspaceDirName(workspace));
  if (options.offline !== true) {
    await syncWorkspaceSessionsForExport(manager, workspace);
  }
  const result = await exportWorkspaceData({
    manager,
    workspace,
    cliToken: auth.token,
    outputDir,
    downloadImages: options.hosted && options.images !== false,
    includeUsage: options.hosted,
  });
  return {
    sessionCount: result.manifest.sessionCount,
    outputDir,
    warnings: result.warnings.map((warning) => `[${toWorkspaceDirName(workspace)}] ${warning}`),
  };
}

const ExportResultSchema = z.object({
  sessionCount: z.number(),
  outputDir: z.string(),
  warnings: z.array(z.string()),
});

export const exportCommand = new Command('export')
  .description('Export user-facing workspace session data')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--all-workspace', 'Export all accessible workspaces')
  .option('--no-images', 'Skip downloading image binaries')
  .option('--offline', 'Read the local cache without syncing first')
  .option('--debug', 'Enable debug output')
  .argument('[outputDir]', 'Output directory for export files')
  .action(async (outputDirArg: string | undefined, options: ExportOptions) => {
    await runOneShotCommand('export', options, async () => {
      const outputDir = path.resolve(outputDirArg ?? buildDefaultOutputDir());
      if (options.allWorkspace && options.workspace) {
        throw new Error('Pass either --workspace or --all-workspace, not both.');
      }

      const local = getCliPlatformKind() === 'local';
      const exports: Array<() => Promise<z.infer<typeof ExportResultSchema> & { name: string }>> =
        [];
      if (local) {
        // The daemon writes the files: it runs on this machine, as this user.
        const catalog = await Effect.runPromise(makeLocalWorkspaceCatalog().read());
        const selectors = options.allWorkspace
          ? catalog.workspaces.filter((row) => row.state === 'active').map((row) => row.workspaceId)
          : [options.workspace];
        for (const selector of selectors) {
          exports.push(async () => {
            const target = await resolveTerminalToolTarget(selector);
            const result = ExportResultSchema.parse(
              await runTerminalCommand(target, {
                command: 'export',
                outputDir,
                offline: options.offline,
              })
            );
            const row = catalog.workspaces.find(
              (entry) => entry.workspaceId === target.workspaceId
            );
            return { ...result, name: row?.name ?? target.workspaceId };
          });
        }
      } else {
        const auth = getAuthContextOrThrow('export');
        const workspaces = options.allWorkspace
          ? await listWorkspacesForToken(auth.token)
          : [await resolveWorkspaceOrThrow(auth, options.workspace)];
        for (const workspace of workspaces) {
          exports.push(async () => ({
            ...(await withWorkspaceManager(auth, workspace, 'export', (manager) =>
              exportWorkspaceReplica(
                { auth, workspace, manager },
                { outputDir, offline: options.offline, images: options.images, hosted: true }
              )
            )),
            name: workspace.name,
          }));
        }
      }

      let totalSessions = 0;
      const warnings: string[] = [];
      for (const run of exports) {
        const result = await run();
        totalSessions += result.sessionCount;
        warnings.push(...result.warnings);
        console.log(
          `Exported ${result.sessionCount} session(s) from ${result.name} to ${result.outputDir}`
        );
      }

      console.log(
        `Finished exporting ${totalSessions} session(s) across ${exports.length} workspace(s) to ${outputDir}`
      );
      if (local) console.log('A local export leaves out images and workspace usage.');
      if (warnings.length > 0) {
        console.warn(`Warnings: ${warnings.length}`);
        for (const warning of warnings) {
          console.warn(`- ${warning}`);
        }
      }
    });
  });
