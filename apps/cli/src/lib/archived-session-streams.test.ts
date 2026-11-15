import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getCodeCollabFileIndexFlockDocId,
  getSessionRoomId,
  type MachineId,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { addLanHub } from '@lody/shared/node/lan-hub';
import type { Logger } from '@/utils/logger';
import { bindTestPresenceApplication } from '../../tests/presence-application-fixture';
import { backfillArchivedSessionStreams } from './archived-session-streams';
import { startLanHubServer, type LanHubServer } from './lan/hub-server';
import { LanMembership, toLanWorkspaces } from './lan/lan-membership';
import { LoroDocumentManager } from './loro/doc';
import { getLoroRepoStorageBaseDir } from './loro/sqlite-repo-store';
import { streamsRoomBinding } from './loro/streams-room-binding';

const silentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  setDebug: () => {},
  child: () => silentLogger(),
  close: async () => {},
});

const OWN = 'machine-own' as MachineId;
const OTHER = 'machine-other' as MachineId;

/** A member's agent service against the real Streams server, through the hub's gate. */
describe('archived session streams', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const previousDataDir = process.env.LODY_DATA_DIR;
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    if (previousDataDir === undefined) delete process.env.LODY_DATA_DIR;
    else process.env.LODY_DATA_DIR = previousDataDir;
  });

  type Stream = { stream: string; earliest: number; next: number; entries: number };
  /** The hub's record of every stream a Session id names. */
  const streamsOf = (dataDir: string, sessionId: string): Stream[] => {
    const database = new Database(path.join(dataDir, 'streams.sqlite'), { readonly: true });
    try {
      return database
        .prepare(
          `SELECT streams.stream_id AS stream, earliest_offset AS earliest, next_offset AS next,
             (SELECT COUNT(*) FROM entries WHERE entries.stream_id_fk = streams.id) AS entries
           FROM streams WHERE substr(stream_id, instr(stream_id, ':') + 1) IN (?, ?)
           ORDER BY stream_id`
        )
        .all(`s:${sessionId}`, `fi:${sessionId}`) as Stream[];
    } finally {
      database.close();
    }
  };

  it('records a snapshot at the tail of what this machine archived, which the next hub start keeps alone', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-archived-streams-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    process.env.LODY_DATA_DIR = path.join(root, 'member');
    const hubDir = path.join(root, 'hub');
    const startHub = async (port = 0): Promise<LanHubServer> => {
      const hub = await startLanHubServer({ host: '127.0.0.1', port, dataDir: hubDir });
      cleanups.push(() => hub.close());
      return hub;
    };
    const hub = await startHub();

    const lan = addLanHub([], { name: 'Test', url: hub.url, token: hub.token }).hub;
    const workspaceId = toLanWorkspaces([lan])[0]!.id as WorkspaceId;
    const presence = bindTestPresenceApplication(silentLogger());
    cleanups.push(() => presence.closeLegacy());
    const membership = new LanMembership({
      settings: { hubs: [lan], machineName: null, source: 'file' },
      logger: silentLogger(),
      onRestartRequired: () => {},
    });
    const manager = await LoroDocumentManager.create(workspaceId, 'user', silentLogger(), {
      streamsTokens: membership.streamsTokens,
    });
    cleanups.push(() => manager.cleanUp({ fast: true, preserveSessionStatus: true }));
    await manager.attachRemoteStreamsTransport();
    const { repo } = manager;

    /** A Session whose doc took `writes` separate appends, and its file index if it had one. */
    const session = async (id: string, writes: number, fileIndex: boolean) => {
      const sessionId = id as SessionId;
      const docId = getSessionRoomId(sessionId);
      const room = await repo.joinDocRoom(docId);
      const { doc } = await repo.openPersistedDoc(docId);
      for (let i = 0; i < writes; i += 1) {
        doc.getMap('turns').set(`turn-${i}`, 'x'.repeat(200));
        doc.commit();
        await streamsRoomBinding(room).waitUntilSynced();
      }
      room.unsubscribe();
      await manager.unloadDocRoom(docId);
      if (fileIndex) {
        const handle = await repo.openFlockDoc(
          getCodeCollabFileIndexFlockDocId(workspaceId, sessionId)
        );
        for (let i = 0; i < writes; i += 1) {
          handle.flock.put(['file', `src/${i}.ts`], { change: 'modified' });
          await repo.flush();
          await handle.syncOnce();
        }
      }
      return sessionId;
    };
    const archivedWithFiles = await session('archived-with-files', 6, true);
    const archived = await session('archived', 6, false);
    const othersArchived = await session('others-archived', 6, false);
    const open = await session('open', 6, false);
    const meta = (id: SessionId, machineId: MachineId, isArchived: boolean) => ({
      meta: { id, machineId, isArchived } as SessionMeta,
    });

    await backfillArchivedSessionStreams({
      manager,
      workspaceId,
      machineId: OWN,
      listSessions: async () => [
        meta(archivedWithFiles, OWN, true),
        meta(archived, OWN, true),
        meta(othersArchived, OTHER, true),
        meta(open, OWN, false),
      ],
      logger: silentLogger(),
    });

    const [fileIndexStream, sessionStream] = streamsOf(hubDir, archivedWithFiles);
    for (const stream of [fileIndexStream, sessionStream]) {
      expect(stream?.entries).toBeGreaterThan(2);
      expect(stream?.earliest).toBe(stream?.next);
    }
    expect(fileIndexStream?.stream).toContain(':fi:');
    // A Session without a file index gets no stream for one.
    const [archivedStream, ...noFileIndex] = streamsOf(hubDir, archived);
    expect(noFileIndex).toEqual([]);
    expect(archivedStream?.earliest).toBe(archivedStream?.next);
    // What another machine archived, or what is still open, stays as it was.
    for (const id of [othersArchived, open]) {
      expect(streamsOf(hubDir, id)).toEqual([expect.objectContaining({ earliest: 0 })]);
    }
    expect(
      fs.existsSync(path.join(getLoroRepoStorageBaseDir(workspaceId), 'archived-streams-compacted'))
    ).toBe(true);

    await manager.detachRemoteStreamsTransport();
    await hub.close();
    await startHub(hub.port);
    for (const stream of [
      ...streamsOf(hubDir, archivedWithFiles),
      ...streamsOf(hubDir, archived),
    ]) {
      // The entry that ends at the snapshot stays: offsets are checked against stored edges.
      expect(stream.entries).toBe(1);
    }
    expect(streamsOf(hubDir, open)[0]?.entries).toBeGreaterThan(2);
  }, 60_000);
});
