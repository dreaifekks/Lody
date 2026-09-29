import type { RemoteCursorStore } from '@loro-dev/streams-crdt';
import {
  createLoroStreamUrl,
  getLoroMetaStreamId,
  getLoroStreamIdForDocId,
  getLoroStreamsShardUrls,
  LORO_STREAMS_BUCKET_ID,
  streamsSnapshotCodec,
  type WorkspaceId,
} from '@lody/shared';
import { LAN_HUB_SCHEME } from '@lody/shared/platform-kind';
import type { LoroRepo } from 'loro-repo';
import { StreamsTransportAdapter, createRepoStreamsPersistence } from 'loro-repo/transport/streams';

export type WorkspaceStreamsTransportOptions = {
  repo: LoroRepo;
  workspaceId: WorkspaceId;
  /**
   * LoroDoc room cursors only. Meta and named Flock progress is replica-bound:
   * the repo's IndexedDB restores each checkpoint with the data it covers, so a
   * window or tab never resumes past state its own replica lacks.
   */
  documentRemoteCursorStore: RemoteCursorStore;
  auth: ConstructorParameters<typeof StreamsTransportAdapter>[0]['auth'];
  streamsBaseUrl: string;
  shardHostSuffix: string | undefined;
};

/** The key under which the transport checkpoints this workspace's Meta room. */
export const getWorkspaceMetaStreamUrl = (
  workspaceId: WorkspaceId,
  streamsBaseUrl: string
): string =>
  createLoroStreamUrl({
    bucketId: LORO_STREAMS_BUCKET_ID,
    streamId: getLoroMetaStreamId(workspaceId),
    baseUrl: streamsBaseUrl,
  });

type ReconnectConfig = NonNullable<
  ConstructorParameters<typeof StreamsTransportAdapter>[0]['reconnectConfig']
>;

/**
 * A LAN may be reached through a relay at a few dozen KB/s, where the first
 * sync of a large session takes minutes. The default two-minute deadline would
 * abort it and start it over indefinitely, so a LAN gets ten. The option is
 * forwarded to streams-crdt, which the adapter's declared type does not list.
 */
const LAN_INITIAL_SYNC_HARD_TIMEOUT_MS = 10 * 60_000;

function reconnectConfigFor(streamsBaseUrl: string): ReconnectConfig | undefined {
  if (!streamsBaseUrl.startsWith(`${LAN_HUB_SCHEME}://`)) return undefined;
  return { initialSyncHardTimeoutMs: LAN_INITIAL_SYNC_HARD_TIMEOUT_MS } as ReconnectConfig;
}

/** The renderer's durable Streams transport for one workspace repo. */
export const createWorkspaceStreamsTransport = (
  options: WorkspaceStreamsTransportOptions
): StreamsTransportAdapter =>
  new StreamsTransportAdapter({
    bucketId: LORO_STREAMS_BUCKET_ID,
    metaStreamId: getLoroMetaStreamId(options.workspaceId),
    docStreamId: (docId) => getLoroStreamIdForDocId(options.workspaceId, docId),
    flockDocStreamId: (flockDocId) => flockDocId,
    auth: options.auth,
    // Every cursor save first awaits that resource's own durability barrier.
    persistence: createRepoStreamsPersistence(options.repo, {
      documentRemoteCursorStore: options.documentRemoteCursorStore,
    }),
    snapshotCodec: streamsSnapshotCodec,
    baseUrl: options.streamsBaseUrl,
    shardUrls: getLoroStreamsShardUrls(options.streamsBaseUrl, options.shardHostSuffix),
    snapshotUpload: {
      canUpload: async () => true,
    },
    reconnectConfig: reconnectConfigFor(options.streamsBaseUrl),
  });
