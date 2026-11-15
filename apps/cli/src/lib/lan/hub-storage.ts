// What a hub keeps of its streams.
//
// The Streams server records a snapshot of a stream by moving the stream's
// earliest offset, and never deletes the entries before it. No reader reaches
// them any more: the server answers a read from below the earliest offset
// with 410, and a bootstrap sends the snapshot with the entries after it. The
// hub adds a trigger that deletes them in the transaction recording the
// snapshot. It keeps the entry that ends at the snapshot: the server records
// a snapshot, or reads a JSON stream, only at an offset where a stored entry
// starts or ends.
import fs from 'node:fs';
import Database from 'better-sqlite3';

const TRIM_REPLACED_ENTRIES = `
CREATE TRIGGER IF NOT EXISTS lody_trim_replaced_entries
AFTER UPDATE OF earliest_offset ON streams
BEGIN
  DELETE FROM entries
  WHERE stream_id_fk = NEW.id AND end_offset < NEW.earliest_offset;
END`;

/** Every later snapshot deletes the entries it replaces. The server must have created its tables. */
export function trimLanHubStreams(databasePath: string): void {
  const database = new Database(databasePath, { fileMustExist: true });
  try {
    database.exec(TRIM_REPLACED_ENTRIES);
  } finally {
    database.close();
  }
}

export type LanHubStreamsReclaim = {
  /** Streams that still held entries a snapshot replaced. */
  streams: number;
  /** The size of the database, the part still in its write-ahead log included. */
  bytesBefore: number;
  /** The size of the file once the log is folded in. */
  bytesAfter: number;
};

/**
 * Deletes the entries snapshots replaced before the trigger existed, and gives
 * their space back to the file system. Runs while nothing else has the
 * database open: VACUUM rewrites the whole file.
 */
export function reclaimLanHubStreams(databasePath: string): LanHubStreamsReclaim {
  const database = new Database(databasePath, { fileMustExist: true });
  let streams: number;
  let bytesBefore: number;
  try {
    bytesBefore =
      Number(database.pragma('page_count', { simple: true })) *
      Number(database.pragma('page_size', { simple: true }));
    database.exec(TRIM_REPLACED_ENTRIES);
    // Setting the earliest offset again runs the trigger for that stream.
    streams = database
      .prepare(
        `UPDATE streams SET earliest_offset = earliest_offset
         WHERE EXISTS (
           SELECT 1 FROM entries
           WHERE stream_id_fk = streams.id AND end_offset < streams.earliest_offset
         )`
      )
      .run().changes;
    if (streams > 0) database.exec('VACUUM');
  } finally {
    database.close();
  }
  return { streams, bytesBefore, bytesAfter: fs.statSync(databasePath).size };
}
