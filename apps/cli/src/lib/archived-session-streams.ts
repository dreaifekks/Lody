import fs from 'node:fs/promises';
import path from 'node:path';
import type { MachineId, SessionId, SessionMeta, WorkspaceId } from '@lody/shared';
import { mapWithConcurrency } from './bounded-concurrency';
import { getLoroRepoStorageBaseDir } from './loro/sqlite-repo-store';
import type { LoroDocumentManager } from './loro/doc';
import { formatErrorMessage } from '@/utils/format-error';
import type { Logger } from '@/utils/logger';

/** Docs a compaction opens at once: the bulk-open bound of the Loro layer. */
const BACKFILL_CONCURRENCY = 4;
const BACKFILL_MARKER = 'archived-streams-compacted';

type Compactor = Pick<LoroDocumentManager, 'compactArchivedSessionStreams'>;

/**
 * Records a snapshot of the streams of a Session this machine archived, so the
 * hub can delete the entries before it when it next starts.
 */
export async function compactArchivedSessionStreams(
  manager: Compactor,
  sessionId: SessionId,
  logger: Logger
): Promise<boolean> {
  try {
    const recorded = await manager.compactArchivedSessionStreams(sessionId);
    logger.debug(
      `[${sessionId}] Archived session snapshot recorded: session=${recorded.session} fileIndex=${recorded.fileIndex}`
    );
    return true;
  } catch (error) {
    logger.debug(
      `[${sessionId}] Archived session snapshot not recorded: ${formatErrorMessage(error)}`
    );
    return false;
  }
}

/**
 * Once per workspace replica: compacts every Session this machine archived
 * before archiving did so itself. A marker beside the replica records a run
 * in which every Session succeeded; a run with failures is repeated at the
 * next start.
 */
export async function backfillArchivedSessionStreams(options: {
  manager: Compactor;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  listSessions: () => Promise<ReadonlyArray<{ meta: SessionMeta }>>;
  logger: Logger;
}): Promise<void> {
  const marker = path.join(getLoroRepoStorageBaseDir(options.workspaceId), BACKFILL_MARKER);
  if (
    await fs.stat(marker).then(
      () => true,
      () => false
    )
  )
    return;
  const archived = (await options.listSessions()).filter(
    ({ meta }) => meta.isArchived === true && meta.machineId === options.machineId
  );
  const startedAt = Date.now();
  const results = await mapWithConcurrency(archived, BACKFILL_CONCURRENCY, ({ meta }) =>
    compactArchivedSessionStreams(options.manager, meta.id, options.logger)
  );
  const failed = results.filter((ok) => !ok).length;
  options.logger.info(
    `[archived-streams] Recorded snapshots of ${archived.length - failed} of ${archived.length} archived sessions in ${Date.now() - startedAt} ms`
  );
  if (failed === 0) await fs.writeFile(marker, `${new Date().toISOString()}\n`);
}
