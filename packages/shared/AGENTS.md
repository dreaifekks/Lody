# Shared contracts

`CLAUDE.md` symlinks here. Edit `AGENTS.md` only.

Discover archive/restore/delete from one ready Repo snapshot, never UI caches.
Archive uses `collectSessionArchiveTargets`; restore/delete keep direct containment.
Exact deletion bypasses discovery: [relations](../../specs/session-relations.md).

## Session history

- `createSessionMirror` owns renderer/CLI history through one `HistoryWriter`, including
  legacy callbacks. Read flags never change ownership; raw writes and second writers
  are forbidden. UI/CLI business uses `SessionData`; follow its [scope](src/session-data/AGENTS.md).
- Validate new turns and changed known fields before mutation. Invalid commands leave
  old values intact and throw content-free diagnostics. Preserve unknown string item
  types, stored extensions and unchanged opaque content without rewriting on open.
- Shared parsers retain JSON extension dictionaries, not arbitrary objects. `schema.ts`
  defines insertion layout: metadata strings stay primitive and only streaming fields
  use `LoroText`, including nested fields. Stored representations remain unchanged.
- Parser tests cover nested discriminators and correlated metadata. Fork regressions
  cross SessionDocument/HistoryWriter; mocked history updates are insufficient.
- Stored copies require writer-captured snapshots. Parse authored changes and new notices;
  external ACP imports are new input. Prepend without replacing initialization containers
  and reject colliding ids. Rollback covers only changed ranges, preserves other rows,
  and rejects identity/order edits except pending-to-seen on newly inserted user rows.
- Derive independent tool-field parsers from the tool schema. Validate changed fields
  and content blocks only; tool identity changes require the complete parser. Normalize
  legacy CLI selectors on new input only, preserving untouched historical values.
- ACP tool blocks and locations preserve declared `_meta` and extension keys. Unknown
  block types cannot bypass validation of known variants. Execution config stays closed.
- New writes and read normalization retain steer provenance for edit-and-resend.
- Scalar/fileDiff writes read only the requested field. Writer parsers retain schema
  refinements and filter/validate in one pass without mutating RPC schemas. `readStored`
  supplies detached hashing data, not copy provenance; keep `capture` protection.
- Streaming/mixed writes use indexed `updateTail`/`updateEntry` and child output windows.
  Preflight writes, preserve ownership/ids and invalidate stale indexes. Snapshot/progress
  never reads transcripts; full-history updates require structural or unwindowable work.
- Permission responses read request metadata and materialize only the matching turn;
  a supplied turn id restricts lookup. Preserve legacy JSON metadata.
- Pinned `loro-mirror` owns text-event optimization; schema and validation must not depend
  on a local patch. Subagent events preserve run identity and root ownership.

## Machine protocol negotiation

- Ask Question consumers must preserve Core note/replacement semantics and validate
  associations per the [notes contract](../../specs/ask-question-answer-notes.md).

- Independent Plan configuration uses Core's boolean `plan_mode`, including static
  capabilities, semantic dispatch, and UI toggles. Preserve `collaboration_mode`
  default/plan only for agents that advertise the legacy option; planning must not
  change permission policy.

- Session automation readers require `sessionAutomations` locally or `remoteAutomationControl` remotely; unsupported machines expose no controls, polling or connection warning.
- Daemon workflows gate on `MachineMeta.protocolCapabilities`, never CLI version.
  Missing means unsupported. Full-message schedules require v3 and `messageVersion: 1`.
- An ACP capability entry may carry the agent's advertised `authMethods`; absence means no probe
  has asked, and an empty list records that the agent advertises none. The same list is returned
  by a capability refresh. `methodId` on an authenticate `start` request is negotiated by
  `acpAuthenticationMethodSelection`, because the strict request schema rejects an unknown field
  on older daemons.
- ACP `cacheVersion` gates freshness, not readability. Preserve understood fields across
  versions and runtime-override matching; omit known-incompatible fields. Pre-v11 commands
  can contain project data: Machine Flock owns probe previews, Sessions own actual lists.
- Quota: share `src/subscription-quota.ts`; key `agentConfigId + limitId`.
  Bound Providers ignore legacy; delete scoped rows.

## Session goal control

- A goal action's transport follows what it does, not what the agent is. Status-only
  actions (`pause`, `clear`) use the `_lody/session/goal` request and must reach a
  goal whose prompt is still open; actions that start work (`set`, `resume`) run
  inside a Lody-owned prompt carrying `_meta.lody.goalControl`, because every unit of
  agent work needs a conversation entry to be attributed to. Never start goal work
  from the request path.
- Offer only the actions the runtime advertised in its ACP capability, never a
  provider name check. A goal turn carries no run configuration, so resuming cannot
  change model or mode. Behavior: [goal control Spec](../../specs/session-goal-control.md).

## Workspace MCP / Roles

- MCP/UI: read [auth contracts](src/AGENTS.md).
  Catalog/defaults: workspace Flock; selections: turns. Missing project rows inherit
  workspace defaults; `[]` disables all. Resolve defaults only at authoring; no machine
  bindings. Preserve `mcpServerIds: []`; send the driving turn's selection to ACP,
  never reread history. Schedule definitions can select MCP ids for future turns.
- MCP/Role catalog writes resolve on local Flock durability, followed by explicit
  upload. Settings neither await nor report upload; its failure never fails or rolls
  back a durable write. CLI reports its sync result. See
  [catalog explanation](../../.agents/docs/workspace-catalog-durability.md).
- Roles use one workspace Flock `agentRole` family; sharing changes `visibility`.
  No secrets, MCP selections or memory contents; filter sensitive options on read/write.
  `modeId`/`_permission` pins hide the permission button, retaining warnings.
  No Role-level auto-approval policy.
  Settings/mentions check read/manage access; explicit MCP ids need no mention grant.
- Role targets bind ids to machine, Agent config, run config and memory.
  Write one as v1 with an `instances` mirror preserving ids/aliases/config on old
  forks; multiple as v2. Read legacy instances/placements intact, without writing.
  Old clients skip v2.
- Within one Role/machine, alias or unaliased Agent family is unique. Aliases may
  repeat elsewhere. Multiple machines require a machine; multiple targets there
  require an alias/id. Pins fail without fallback. Menus list and pin every target.
  Freeze target/config/prompt/revision at acceptance; retries ignore edits.
  [Memory](../../specs/agent-role-memory.md).
- Keep `author`, human `userId`, and recipient execution config separate.
  [Contract](../../specs/message-author-identity.md).

Presence: E2EE requires UUID session IDs and bounded plaintext allowlists on publish/receive;
ordinary behavior stays unchanged. [Contract](../../.agents/docs/cli-lib-loro-presence.md).

Encrypted attachment manifests contain secret per-file keys and belong only in protected conversation content or local recovery receipts. Relay requests use opaque metadata and attachment-only grants; never publish a manifest or key in a URL. Format and recovery rationale: [attachment decision](../../.agents/notes/implemented/architecture/2026-10-28-encrypted-attachments.md).
