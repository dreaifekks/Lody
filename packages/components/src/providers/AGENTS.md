# Workspace provider guidelines

`CLAUDE.md` links here; ancestor rules apply.

`CloudPlatformProvider` renders login without Convex auth. Its authenticated child
owns organization/E2EE inbox queries; the router supplies context, workspace actions
and owner/admin inboxes.

## Synced mirrors tolerate unknown roots

Synced Mirrors require `ignoreUnknownProperties: true` or new peers block writes.
Test: `packages/shared/tests/session-doc-forward-compat.test.ts`.

`createSessionMirror` owns Session history writes through its HistoryWriter. Read: [shared rules](../../../shared/AGENTS.md#session-history).

## Streams connection cardinality

- Discovery/refresh reuse workspace Machine Flock/RPC transports. Connections follow
  machine/workspace topology; extra configs add serialized RPCs, never subscriptions.
  Release unowned handles/subscriptions.

- Probe startup capabilities once per config/runtime via `refreshedConfigKeys`.
  Re-arm aborted passes after presence recovers; never re-probe answered configs.
  These launch real agents. Use machine cache unless user/setup/auth actions set
  `force`. [Intent](../../../../specs/acp-capability-refresh-cache.md).

## Workspace switching

- Prompt Shortcuts belong to one initialization effect. Retire before durable close;
  never reuse retired instances. Fence platform/cloud capability/retry generation.
  Legacy admission gates cloud discovery/store/token/writes: unknown waits, encrypted
  disables. Preserve local access.

- `$workspaceName` owns the render target. Before singleton reads, match route,
  runtime and runtime-owned doc-meta scope. Under `WorkspaceRouteTargetProvider`,
  visibility/sharing hooks default to empty projections on mismatch, disabling
  queries, Machine Flock, sharing and eager-sync. External `RuntimeProvider`
  consumers keep their defaults. `workspaceId`/`enabled` cannot bypass this fence.

- Each `resolveWorkspaceDataScope` wait names its `blocker`; keep scan failures on the scope.
  [Stuck report](../../../../.agents/notes/implemented/feature/2026-09-26-workspace-sync-stuck-telemetry.md).

## Workspace runtime

- Readers require backend identity and Meta plane. Missing/empty provisional history
  is never legacy evidence. Release waits on resolve/retire; keep Roost capabilities
  live and wake its bridge on arrival.

- Neutral local warm spares may initialize implicit workspaces without route
  publication; matching claims retain runtime/in-flight initialization. Never infer
  cloud workspaces. Only main-owned macOS local prepared windows mount speculative
  Sessions, gating receipts/ownership/autofocus/external-history refresh until
  presentation. Background prefetch has no exception.

- Prefetch never acquires UI Session stores/Mirrors. One worker per renderer owns
  raw Doc I/O and rebuildable snapshots keyed by workspace/room across windows.
  Terminate before slot release; detach peers on cancel. Check durable activity
  before constructing workers. The pre-queue timestamp high-water filter loads no
  snapshots/Docs/history/foreground cursors. Foreground acquisition cancels room
  prefetch and merges into the live Repo, preserving unsent edits. Workers never
  share UI persistence/cursors.
  [Intent](../../../../specs/session-background-prefetch.zh.md).

- Keep one Repo view across auth refresh and unrelated mode-cache changes;
  `WorkspaceTargetRouter` owns target/transport selection.
  Never restore a second writer or proxy-authoring/write-intent mirror.
- Runtime close retries recoverable cleanup, retaining fencing until confirmed Repo destruction.
  Failed startup shares this close path.
- Bootstrap exchanges only owned same-workspace CRDT snapshots. Check disk first;
  Web Locks restrict requests to live runtimes, and negative replies release waits.
  Never open stores for requests, trust peers as authority or replace live docs.
  Merge into the receiving Repo; seed before subscribing, persist before adoption/
  cursor advancement and import before reader creation to avoid bulk-event replay.

- Repo storage, LoroDoc cursors and eager-sync high-water state share a renderer
  namespace; independent replicas never share checkpoints. Meta/Flock cursors remain
  repo-owned; delete Meta progress through `repo.getReplicaCheckpointStore`.

- Unknown workspace mode permits local Repo access, never ordinary body egress.
  Preserve drafts until authenticated classification; retire and cancel provisional
  transports before recording an encrypted or contradictory verdict.
- E2EE uses local host keys, a dedicated bucket, Loro history and waiting-key leases;
  plaintext bypass is forbidden. Retain sealed old-epoch sends/historical reads.
  Prefer installed current keys; genuine absence allows retained published keys
  within the durable fifteen-minute grace, then fails for retry. Hints never pick
  write keys. Never persist tokens; forward rejected ones for exact eviction.
  Bind caches/inputs to account/workspace/genesis/signing key; drain before deletion
  and retain exact receipts.
  [Sealing](../../../../.agents/notes/implemented/architecture/2026-10-27-e2ee-epoch-receive-barrier.md),
  [M2](../../../../.agents/notes/proposed/architecture/2026-10-22-e2ee-m2-product-integration.md),
  [transport](../../../../specs/workspace-streams-content.md).

- Missing-key notices begin 30 seconds after explicit post-grace seal failure and
  clear on successful saves. They never retry, gate or discard edits.

- Select transport per room, never merge. Use `getReadinessTransportForRoom`;
  hooks without the router use `src/lib/room-readiness.ts`. Keep rules aligned.
- Electron's atomic local-platform snapshot supplies the CLI catalog's persistent
  `local:*` identity. Never substitute constant/temporary users.

- Locally resolved machines use Electron local session control regardless of
  cloud-token/sync state. Local bridge failure never falls back to remote RPC.

- Cloud Electron waits for the first **Run local agent** snapshot before runtime
  creation. Enabled uses dual sync; disabled uses cloud-only sync without local
  data-plane attachment or reconnect UI.

- Meta attachment is single-flight. Token/network/visibility edges may trigger one
  immediate recovery without resetting outage history. Only sustained health resets
  backoff; all later attempts, including rotation, are `recovery`.

- Ownerless workspace rooms use platform fallback transport; never disable sync by
  returning no transport.

- Resource monitoring uses owner-local or optional remote transport; unknown owners
  remain pending.

- Local presence origin/absence wins over cloud. UI uses display state; recovery
  uses raw state. Encrypted presence uses its authorized bucket/minimal plaintext
  allowlist on publish/cloud/local reads; unsupported protected channels stay disabled.

- Merge overlapping bootstrap/watch metadata per field with live values winning
  (`mergeBootstrapMetaCache`); snapshots never undo live archives.

## Attachment transfer ownership

The Loro queue validates protected image/file manifests before history writes.
Records stay bound to their original workspace; protected mode excludes Roost.

`sendResources` owns preparation/I/O/borrows; cancel/join before transport/cache
close. Only caches dispose stores. Loro commits locally then dispatches best-effort;
Roost freezes input/target and shares ordered queue leases. Negotiate
`sessionInputDispatch` v1: one owner request commits history/activation, and the
sender uses its receipt without readback/second RPC. Guide handoff needs an owner
receipt. Archive/delete cancel all durable work and join leases, beyond local
snapshots. Unready Blobs stay in memory; never replay uncertain steers.
[Decision](../../../../.agents/notes/proposed/architecture/2026-10-13-backend-independent-send-acceptance.md).

- Protected leases retain account/readers until confirmed close. Preallocated leases
  fence cold opens.
  Start native fencing at renderer cleanup; retain incomplete owners. Only overlapping
  custody/Repo namespaces wait. Device replacement shares account/workspace/genesis
  writers. First key receipt stays pending; usable epochs wake content.
