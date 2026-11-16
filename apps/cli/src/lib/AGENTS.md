# CLI library

`CLAUDE.md` aliases this file. Index:
[README.md](README.md). Scoped rules: [acp](acp/AGENTS.md),
[code-collab](code-collab/AGENTS.md), [file-preview](file-preview/AGENTS.md),
[loro](loro/AGENTS.md), [pr-poller](pr-poller/AGENTS.md).

**Before dispatch/sync read context/message-flow.md; before catalog/Fleet changes read [E2EE rules](e2ee/AGENTS.md).** WS/DO is deprecated; do not extend it.

Credential JSON publication creates an exclusive 0600 temporary file and atomically
replaces its destination on POSIX. New state roots use 0700; existing custom
directories keep their permissions. Windows retains direct file writes.

## Composition and transports

- Bound ordinary daemon owners read history and manage Session metadata locally; other accounts and remote targets still require cloud authorization.

- Daemon commands borrow its replica; command cleanup failures never fence.
- Before changing GitHub authentication or agent PATH merging, read the
  [credential broker rules](../session/worktree/AGENTS.md#git-credential-broker).

- Only `cloud-cli-port.ts` constructs official cloud clients and endpoint adapters.
  Daemon modules must not construct cloud SDKs or read deployment URLs. The local
  port reaches only [LAN hubs/members](../../../../.agents/docs/lan.md), without cloud I/O.
  Unavailable operations fail at their boundary; only best-effort background effects
  may skip. Preserve platform-boundary and local-zero-cloud checks.
- A `--paired-workspace` machine port reads only its own workspace plan, with its device
  credential (`e2eeMachinePairing.workspaceEntitlement`), for the cooperative quotas;
  it never borrows an account API key.
- Client-visible RPC references come from public `@lody/cloud-api`; generated server
  declarations and private workspace packages are forbidden. Prime the token provider
  before reading `getGatewayBaseUrl()`, and never let runtime transports or Machine RPC
  require `LODY_LORO_STREAMS_BASE_URL` as a parallel hidden composition path.
- `cloud-pr-association.ts`: use `authSiteUrl`, not `authBaseUrl` (internal proxy).
  Six failures/workspace/repo, no eviction; reset on client recreation. Log once.
- Local control queue cancellation must bypass session main work. Health reads,
  per-config refreshes and per-agent installs must use independent lanes; restart
  and upgrade stay serialized together. [Decision](../../../../.agents/notes/implemented/bug-fix/2026-09-20-acp-authenticate-queue-lane.md).
- Local control negotiates NDJSON or legacy buffered JSON, preserving intermediate
  replies. `MachineRuntime` may collect responses but forwards each as sent. Cancel
  parked history watches before shutdown drain; preserve shared writers.
- Route remote attach/detach/revoke through `machine-runtime.ts` `runBridgeTransition`.
  Keep bodies short; backfill authorization generations change inside that queue.
- The renderer authors user/UI writes on its own Repo/Streams connection; CLI authors
  agent data. Never restore v4-v6 write intents, proxy authors or CLI preview-comment
  mirrors. Dispatch follows renderer `latestUserMsgId` plus local Machine RPC.
  Preserve `specs/local-first-two-plane.md`.

## Encrypted workspace catalog

- `local-workspace-catalog.ts` keeps encrypted discovery in account/machine-bound
  `workspace-catalog.json.e2ee`, ordinary rows only in v1 `workspaces`; lock both writes.
  Ordinary-only mutations never rewrite encrypted rows. Old v1 writers cannot erase
  the sidecar or account/machine-bound `.e2ee-invalid` marker.
- A failing workspace list detaches encrypted runtimes only on explicit refusal or revocation, or after 24 unconfirmed hours until reconfirmed.
- Offline/ordinary writes never replace unreadable sidecars. Only authenticated online-list
  reconciliation may archive a corrupt `.e2ee` file before rebuilding; permission and marker
  errors stay errors. Retain originals, failure receipts and usable ordinary rows.
  Persist ordinary remote-list results; return degraded receipts with current auth/revocation
  checks. Atomically publish `.e2ee-invalid` BEFORE encrypted updates; retain through failed
  writes/cleanup until healthy publication. Derive unavailable from the marker, never unknown
  v1 fields; stale sidecars cannot bootstrap. Fleet keeps scoped recoverable issues, bounded
  retries and pending signature until healthy receipt.

## Local Loro data plane

Read [Loro rules](loro/AGENTS.md) before room enumeration, presence, Flock writes or
reconnection. Before data-plane changes, read the [v7 design](../../../../.agents/docs/cli-lib-local-loro-data-plane.md).
Preserve named manager options, peer scope, scheduler/bulk limits, sender framing,
RAW-chunk `createJsonLineSplitter`, and renderer room lifetime. The Legacy engine
shares one native process writer. Await release receipts; Fleet closes that writer
only after all workspace and connection owners release, retaining failed owners for
recovery. Renderer joins never call `getOrCreateSessionDoc`, retain cloud rooms or
receive cloud status as local health.

## Sessions and turns

- Manual terminal PTYs belong to Fleet, not the agent runtime. Agent termination,
  cancellation, and idle or memory-pressure GC must preserve them. Close them on
  explicit terminal close, conversation archive/delete, or Fleet shutdown. ACP
  agent-owned terminals retain their separate execution lifecycle.

- `session-gc-manager.ts`: `evaluateMemoryPressure` returns TWO verdicts, `evict` and
  `block`, sharing no threshold. Probes fail OPEN; `null` Windows commit growth
  never becomes `0`. Sweeps never force the cached commit probe; never act on a
  cached sample once pressure appears; re-check briefly before failing a turn; bound
  evictions per call. The threshold is a safety MARGIN, not "what a turn needs".
  [Per-OS signals](../../../../.agents/docs/cli-lib-memory-pressure.md). Idle counts
  native work: never clean `running`, cap background waits. Post-turn output resets
  it only for `sessionActivity` agents.
  Eligibility read failures retain only that session; foreground reclamation waits at most 10s.
  Candidates include every cached Session doc (`combineGCSessionSources`): an untracked
  doc idles from its last hand-out, unloads with status preserved, and GC checks peek
  rather than open it. A Loro heap past 3 GiB shortens the idle timeout until restart.
- **Session attachments**: before changing preparation, transfer, materialization,
  or backfill, read the [lifecycle rules](../../../../.agents/docs/cli-lib-session-files.md).
  CLI/MCP input preparation must finish before history/dispatch; recovery uses frozen
  references, never source paths. [Input contract](../../../../specs/cli-session-attachments.md).
  Local attachments carry machine-local paths. Prepare generated bytes through local control; authorize actual reads against the machine owner or the existing workspace-contained file RPC. A payload path is never a remote file-read grant.
  Local images use source paths and upload receipts;
  retain their local identity after upload for frozen inputs and offline reads.
  Reconcile durable image receipts into history items, stored input blocks, and
  queued configs, including references arriving after the upload completes.
  Never enroll existing `local_attachment` references in image backfill.
  Keep ACP `resource_link` file URIs, workspace-contained agent output, and
  MessageHandler-owned authorization-generation/AbortController backfill fencing.
- Read [ACP rules](acp/AGENTS.md) before buffering, history gates, evidence persistence,
  late-output routing or shutdown changes. Resume replay follows context/hotspots.md.

## Projects, providers, tasks

- Codex/DeepSeek history import requires `_meta.lody.sessionHistory` v1 and the Core
  read method, never `loadSession`. Publish only after history/cursor durability;
  legacy metadata shells remain selectable for hydration.
- Keep source hashes/ids separate from the cursor-bound stored-content baseline.
  Compare exact content; never sanitize edits or migrate missing baselines. Write
  history and capture its baseline without an async gap before metadata publication.
- Validate the selected Provider machine/id/type without fallback. Legacy requests
  use the sole same-type Provider. Keep Provider-scoped catalogs and stable replay/import
  keys. Bind an unbound import only if that Provider lists its source; never replace
  bindings or merge another account's native id. Refresh through that binding and
  record load-reported selection on the last imported user turn through
  `applyAcpRuntimeConfigPatch`.

- Local-project deletion retains registrations referenced by Projects or group runs;
  disable standalone display without archiving their Sessions. Catalog read/sync
  failure keeps the command queued. Otherwise archive all unarchived machine/project
  Sessions via existence/metadata indexes before removing the row; archive failure
  retains the command. Explicit cleanup covers only Lody-created Session worktrees:
  inspect before submission and deletion, never force-delete or backup-commit dirty
  worktrees, record deleted/kept/failed results, and complete with visible results
  even on cleanup failure. Never delete the original project directory.
- Before provider setup changes read its [rules](../../../../.agents/docs/cli-lib-provider-setup.md).
  Preserve row ownership, single publication, cancellation and cloud/local queue timing.
  Setup rows contain no authorization URLs, codes, tokens or raw provider output.
- **A `file-preview/` preview must never activate Code Collab**: no workspace watch, no
  All Changes recompute, no Flock publish.
