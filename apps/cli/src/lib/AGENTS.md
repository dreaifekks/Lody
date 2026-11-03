# CLI library

`CLAUDE.md` aliases this file. Index:
[README.md](README.md). Scoped rules: [acp](acp/AGENTS.md),
[code-collab](code-collab/AGENTS.md), [file-preview](file-preview/AGENTS.md),
[loro](loro/AGENTS.md), [pr-poller](pr-poller/AGENTS.md).

**Before dispatch/sync read context/message-flow.md; before catalog/Fleet changes read [E2EE rules](e2ee/AGENTS.md).** WS/DO is deprecated; do not extend it.

## Composition and transports

- Daemon commands borrow its replica; command cleanup failures never fence.
- GitHub auth: conversation-owner personal → matching-owner machine → repo App,
  once per source. Failures advance without a policy RPC; local context grants
  machine eligibility. Never persist managed tokens or replay uncertain writes.
  Checkout/LFS share the pinned helper context. Contract: [identity fallback](../../../../specs/github-identity-fallback.md).

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

- INVARIANT: agent PATH merges keep the session's `gh` shim dir first
  ([note](../../../../.agents/notes/implemented/bug-fix/2026-09-26-gh-shim-broker-and-path.md)).

## Encrypted workspace catalog

- `local-workspace-catalog.ts` keeps encrypted discovery in account/machine-bound
  `workspace-catalog.json.e2ee`, ordinary rows only in v1 `workspaces`; lock both writes.
  Ordinary-only mutations never rewrite encrypted rows. Old v1 writers cannot erase
  the sidecar or account/machine-bound `.e2ee-invalid` marker.
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

- `session-gc-manager.ts` separates evict/block thresholds. Probes fail open; unknown
  Windows commit growth never becomes zero. Sweeps do not force cached probes; recheck
  fresh pressure briefly before rejecting a turn and bound evictions. Never clean native
  running work; bound background waits. Only sessionActivity agents reset idle from
  post-turn output. Eligibility failures retain that Session only; foreground reclamation
  is bounded to 10s. See [signals](../../../../.agents/docs/cli-lib-memory-pressure.md).

- **Session attachments**: before changing preparation, transfer, materialization,
  or backfill, read the [lifecycle rules](../../../../.agents/docs/cli-lib-session-files.md).
  CLI/MCP input preparation must finish before history/dispatch; recovery uses frozen
  references, never source paths. [Input contract](../../../../specs/cli-session-attachments.md).
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
