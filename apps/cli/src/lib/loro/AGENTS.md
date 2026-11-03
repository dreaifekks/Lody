# apps/cli/src/lib/loro — Loro repo/runtime layer

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

## Mirrors over synced docs tolerate unknown root keys

Synced Mirrors use `ignoreUnknownProperties: true`; unknown roots must not block writes.
Test: `packages/shared/tests/session-doc-forward-compat.test.ts`.

SessionDocument Mirror is control-only. HistoryWriter writes; SessionData reads.
`session-agent-writes.ts` uses shared planners, never UI ports or a second writer.
Replacement rules: [shared](../../../../../packages/shared/AGENTS.md#session-history).

## Opening a doc pulls its stream

`getOrCreateSessionDoc` joins and pulls a room, retaining it until cleanup.

Rules:

- Renderer metadata is imported into the meta Flock with no transport; the
  metadata live monitor must start at repo init (`ready()`), or
  `getDocMeta` stays stale and dispatch misses `latestUserMsgId`.
- Never open documents through workspace-wide room enumeration.
- Bulk/startup/recovery scans must first filter to candidates through indexes
  that do not join rooms: `repo.getDocMeta(roomId)` meta records, the `e/`
  existence index (`lib/loro/repo-existence.ts`), or a purpose-built local index
  (example: `session/session-fork-operation-store.ts`). Open docs only for the
  filtered candidates, under a concurrency bound (`mapWithConcurrency`, 4).
- Observation reads of another Machine's Session use
  `LoroDocumentManager.readSessionDocTransiently`: it reads a cached doc in
  place, otherwise opens a temporary wrapper outside `sessions` and destroys it.
  The room stays joined only until its first sync or `TRANSIENT_DOC_ROOM_RETAIN_MS`,
  so slow rooms still converge and no one-off read holds the room forever. A
  failed wrapper cleanup never replaces the completed read
  ([rationale](../../../../../.agents/notes/implemented/bug-fix/2026-11-02-cross-machine-read-room-lifetime.md)).
- Inspection cleanup requires proof of sole ownership: `sessions` has no refcounts,
  and destroy kills every holder's subscriptions. Otherwise leave the wrapper cached.
  Never unload a live wrapper's Repo room directly or let teardown publish hidden
  fork status/metadata.

Room enumeration follows the metadata activation index: `../../session/AGENTS.md`.

`getOrCreateSessionDoc(..., { skipAutoRead: true })` affects only newly initialized
wrappers. Use it for observation in an isolated command manager, never to change
a cached execution wrapper's policy. Read-only release must preserve status;
see [observe scopes](../../commands/session-observe-runtime.ts).

## Streams cursors are replica-bound

Per identity, share `repo.sqlite3`, not replicas: Meta/Flock cursors use `createRepoStreamsPersistence`, LoroDoc cursors from
`createDocumentRemoteCursorStore` (shared rows: daemon only). No shared
`remoteCursorStore` or schedule-only `onPersist*`. Test:
`tests/cli-streams-replica-checkpoints.test.ts`.

## Shared ACP runtime config contains no secrets

`SessionDocument.applyAcpRuntimeConfigPatch` must remove every option matched by
`isSensitiveAcpConfigOptionId`, even after upstream filtering.

## Presence is ephemeral and partitioned by origin

Read [presence contracts](../../../../../.agents/docs/cli-lib-loro-presence.md) before changes:
origin stores and session ownership. Intent: `specs/loro-ephemeral-presence-channel.md`.

The workspace's ONE serial queue carries machine heartbeats. Publish only from a
timer, lifecycle transition or navigation; never stream/progress/chunk callbacks.
Bound every field in shared presence schemas. Same-key coalescing does not bound
distinct keys or in-flight writes; `(phase, detail)` dedupe is not a rate limit.
Safe fields only; barriers are not exact heartbeat/peer receipts. Joined/close
does not prove fresh delivery/POST cleanup. Only LAN owner leases refresh durable
lastRunningSeen for Live Activities; viewers never end another machine's turn. Other
meta timestamps change with status. MachineMeta.lastSeen stays retired. Online checks use presence; null from
getOnlineMachineIds means unknown, never offline.

`session-active-presence.ts` owns native Turn leases, Clock heartbeats and latched
stall signals. Only its lease release clears presence; incidental lifecycle clears
cannot retire a Turn. Its Legacy entry owns execution/analytics. Intent:
`specs/session-initialization-deadline.md`.

`workspace-presence.ts` owns Scopes; `presence-replica.ts` is synchronous.
Only Legacy entries execute. No kernel Promise/timers,
extra runtime or POST/SSE queue. Failed release retains work/Cause/owner and
fences its generations; the registry retires it, never blocking the workspace.
Close joins completion. Revoke preserves local
production. CLI owns registry/token Scopes; workspace token users share one kernel.
`platform/presence.ts` uses the published SDK native entry.

## Device resources use `machine-monitor.ts`

Local renderer observer/snapshot state crosses protocol-v6 `machine-monitor` frames
and MUST sample without a cloud transport. Cloud observers/snapshots attach only after
the authorized remote bridge attaches, and detach on offline/revocation. Sampling is
observer-lease driven; never start OS probes permanently or persist snapshots.

## Catalog readers

Share Promise Repo; close readers first. Timeouts end waiters.
Retry baseline errors in-place. Only metadata and the workspace Flock stay joined;
any other catalog is released after `TRANSIENT_CATALOG_IDLE_MS` without a read
and stops retrying then. Role writes confirm remote sync.
Default MCP fallback requires an actual persisted remote cursor for that workspace
Flock, not local rows or an empty checkpoint generation. Keep the pinned SQLite
checkpoint reader read-only; cover receipt, restart and purge through real Streams
persistence when changing this SDK-format compatibility boundary.

## Machine Flock writes for this machine are local-first

Antigravity quota updates only its config/type; null/errors retain cache.

After `repo.flush()`, call `LoroDocumentManager.markMachineFlockDocDirty(...)` (or use
the manager as sync scheduler). Never await `handle.syncOnce()` in user/RPC paths
or fail durable local project changes on sync errors. `machine-flock-sync-coordinator.ts`
owns the live room, dirty state and exponential retry.

## Durable commands are scanned, not evented

`machine-flock-command-watcher.ts` owns durable command queues separately from the
sync writer. Every authoritative join rescans every queue; join/initial-sync failures
retry with bounded backoff. Events only wake work, and their `authoritative` flag
prevents stale setup from outrunning remote cancellation. Route event and rejoin
paths through `MessageHandler.rescanMachineCommands`. Use
`isRecoverableStreamsRoomStatus`; detached is not recoverable. Local-project removal
follows [library rules](../AGENTS.md).

## Keep Streams recovery signals separate

Keep recovery signals separate. `onStreamsOnline` releases parked dirty-Flock and
schedule work on every rising edge, without throttling. `onMetaRoomSynced` waits for
meta catch-up and scans the workspace index at most once per
`LODY_LORO_META_SYNCED_MIN_INTERVAL_MS` (30s), deferring rather than dropping work.
A real meta-room outage bypasses that floor; a transport flap does not. Health shorter
than `LODY_LORO_HEALTH_STABILITY_WINDOW_MS` (5s) charges the retry counter, and force
must not erase it. Retain `tests/reconnect-storm-repro.test.ts`.

Health follows the meta room. While it is joined, an aggregate `disconnected`
means one doc or Flock room failed: health reads `rooms-degraded`, a backed-off
per-room sweep (1s to 30s) retries that room, and cloud side effects keep running. Never
schedule a transport-wide reconnect for it; one room that never finished its
initial sync did that every two minutes
([note](../../../../../.agents/notes/implemented/bug-fix/2026-11-02-cross-machine-read-room-lifetime.md)).
