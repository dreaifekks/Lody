// What a hub keeps of its streams.
//
// The Streams server records a snapshot of a stream by moving the stream's
// earliest offset, and never deletes the entries before it. No reader reaches
// them any more: the server answers a read from below the earliest offset
// with 410, and a bootstrap sends the snapshot with the entries after it.
// The hub deletes them only while no Streams server has the database open. A
// bootstrap takes the snapshot, sends it, and only then reads the entries
// after it; deleting while it sends would cut out entries it still owes when
// another client records a newer snapshot meanwhile. The entry that ends at
// the snapshot stays: the server records a snapshot, or reads a JSON stream,
// only at an offset where a stored entry starts or ends.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DATABASE_FILE_NAME = 'streams.sqlite';

/** From this share of free pages on, the file is rewritten to give them back. */
const VACUUM_FREE_SHARE = 0.25;

/**
 * Deletes the entries the snapshots in a hub's data directory replaced. Runs
 * while no Streams server has the database open. With a quarter of the file
 * free or more, VACUUM gives the space back to the file system; less stays
 * for the server to reuse.
 */
export function reclaimLanHubStreams(dataDir: string, log?: (line: string) => void): void {
  const databasePath = path.join(dataDir, DATABASE_FILE_NAME);
  if (!fs.existsSync(databasePath)) return;
  const started = Date.now();
  const database = new Database(databasePath, { fileMustExist: true });
  let deleted: number;
  let bytesBefore: number;
  try {
    const pageSize = Number(database.pragma('page_size', { simple: true }));
    bytesBefore = Number(database.pragma('page_count', { simple: true })) * pageSize;
    // Stream by stream through the end-offset index: a database with nothing
    // to delete costs one probe per stream.
    deleted = database
      .prepare(
        `DELETE FROM entries WHERE id IN (
           SELECT entries.id FROM streams CROSS JOIN entries
             ON entries.stream_id_fk = streams.id AND entries.end_offset < streams.earliest_offset
         )`
      )
      .run().changes;
    const free = Number(database.pragma('freelist_count', { simple: true }));
    const pages = Number(database.pragma('page_count', { simple: true }));
    if (free >= pages * VACUUM_FREE_SHARE) database.exec('VACUUM');
  } finally {
    database.close();
  }
  const bytesAfter = fs.statSync(databasePath).size;
  if (deleted === 0 && bytesAfter === bytesBefore) return;
  log?.(
    `[storage] Deleted ${deleted} entries that snapshots replaced: ` +
      `${bytesBefore} -> ${bytesAfter} bytes in ${Date.now() - started} ms.`
  );
}
