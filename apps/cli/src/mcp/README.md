# MCP transport and orchestration background

Binding rules remain in [AGENTS.md](AGENTS.md). This document explains interoperability
and lifecycle decisions behind them; it does not introduce additional requirements.

## Stdio lifetime

`commands/internal.ts` executes `serveStdioMcp` with the SDK/Node adapter in
`stdio/lifecycle.ts`. Its scoped connection waits for stdin EOF/close, SDK transport
close, SIGINT or SIGTERM. Input/output errors fail the command; malformed protocol
messages retain the SDK's existing error behavior. Subscriptions are installed before
connection, and partial startup is cleaned up before returning. Only after the command
finishes may `index.ts` close the shared shell-cache/Presence application runtime.

SDK 2.0.0 stdio `close()` synchronously detaches stream listeners and cancels SDK
requests, without asynchronous I/O. Tool handler Promises still belong to their
existing owners: SDK cancellation does not establish raw-work completion. This
migration covers the stdio host, not HTTP, daemon or tool orchestration.
See the [decision and verification](../../../../.agents/notes/implemented/bug-fix/2026-10-14-mcp-stdio-lifetime.md).

## HTTP and loopback

- The MCP HTTP host answers a strict HTTP client (Grok's Rust `rmcp`), which reports a
  never-completing response as a transport failure, not an MCP error. Every request must
  reach a terminated response: `GET /mcp` is answered with 405 rather than handed to the
  SDK, which in stateless JSON mode opens an SSE stream it can never write to or close.
- Agent child processes reach the host over loopback, so a proxy must never intercept it.
  `@lody/shared/proxy-env` `withLoopbackNoProxy` is applied last when assembling agent env
  (`session.ts` `buildShellEnv`, `acp-runner.ts`) and writes BOTH `NO_PROXY` and
  `no_proxy`: clients disagree about a present-but-empty value, and Rust `reqwest` reads
  the uppercase spelling first and treats an empty one as "bypass nothing".

## Operation identity

- Session orchestration derives its human identity from the active execution runtime populated
  by the dispatch payload, not from the daemon credential, Session owner, or observed history.
  An absent active runtime fails closed; never reconstruct invocation identity from history.
  Freeze the source Turn id and invoking user with every accepted Operation. Store the user
  once as `requesterUserId` and the causal Turn as `sourceTurnId`. The
  Operation's requester Session id already identifies the source Session, and a single-value
  actor tag adds no information. Recovery uses the Operation's owner Machine plus current
  authorization; it does not freeze the daemon account that originally accepted the Operation.
  Every MCP Session path rejects a runtime invocation without userId.

## Machine presence

- Machine liveness is THREE-state. `getOnlineMachineIds()` returning null means the presence room
  could not be joined — status UNKNOWN, never offline. Block a dispatch or report `MACHINE_OFFLINE`
  only for a definite `offline`; an unknown Machine proceeds and fails against its own deadline,
  and a surface reporting liveness carries the state, not a boolean. Collapsing unknown to offline
  refused healthy Machines and silently emptied candidate lists during a cold start or reconnect
  backoff. Contract: `specs/loro-ephemeral-presence-channel.md`.

## Operation acceptance

- MCP session tools use stable machine/session/agent-config ids and strict, narrow input schemas.
  Create/chat Commands require a caller-chosen Operation id, and Create persists the Operation
  before its fallible availability step: a transient post-accept failure returns the active fixed
  target for daemon replay, and `session_create({ operationId, resume: true })` recovers it without
  the prompt. Completion enters the Inbox and is batched at normal turn release or fresh
  human input; arrival alone never wakes idle/paused sessions. There is no public wait tool,
  and new callers must not use the legacy `wait=true` adapter.

## Machine catalog retry guidance

- A retryable Machine catalog `SYNC_UNAVAILABLE` means freshness could not be confirmed
  and the local catalog could not validate a selection. It does not prove that an id is
  valid; a typo or inaccessible catalog may remain unresolved. Permanent transport/auth
  failures and explicit validation errors retain their existing non-retryable classification.
- Without an active Operation handle, an Agent must wait at least 5 seconds between calls
  and make at most **3 total attempts** (initial call plus 2 retries) for the same request.
  Reuse the identical arguments and `operationId`; never mint ids to bypass this budget.
  After the third failure, stop and report the catalog blocker so the user can check the
  selection, access, and connectivity. This is caller guidance, not a server-enforced counter.
- Chat can fail after acceptance. Retrying with the same id recovers the existing fixed
  target rather than appending a second prompt. Once an active handle is returned, stop
  resubmitting: the daemon owns recovery and queues completion in the Inbox. Existing
  Operation status tools remain available for an intentional status check; do not poll in a loop.
- The Agent call budget does not shorten an accepted Operation's deadline. Daemon
  materialization retains its existing 1–30 second backoff until the Operation deadline
  (24 hours by default, configurable up to 7 days), always rechecking the fixed target
  Turn before writing.

## Role dispatch

- `session_create` and `session_create_many` resolve an explicit Agent Role id directly from
  the workspace catalog; no driving-Turn mention authorization is required. Resolve its target,
  Prompt prefix, revision, and concrete run config before Operation acceptance. Recovery uses
  the frozen canonical Prompt and target dispatch config and never rereads the mutable catalog.
  A Role is a template (name, description, Prompt prefix) with ordered instances: each has a
  stable id, an optional alias, a machine, an Agent config, a run config and optional memory.
  Instances with one alias, or without one on one agent family (runtime plus provider brand),
  are a group that stands in for itself across machines; a machine holds at most one instance
  per group, and writes refuse a second. The create picks one with `selectAgentRoleInstance`
  before resolving the rest: a named `agentRoleInstanceId` must exist, run now and match any
  `machineId` passed with it; an explicit `machineId`, else the machine of a local `workContext`
  project (or the requester's, with `useCurrentSessionAsParent`), runs that machine's instance
  in the earliest group; otherwise the first group, in list order, with a usable instance runs,
  the requester's machine first inside it. A pinned machine or instance that cannot run the Role
  fails the create with the usable instances listed, never moving the work, and the reply's
  `agentRole` (`agentRoles` for a batch) names the instance id, group name, machine and rule.
  "Usable" is the per-instance availability `lody_agent_role_list/get` report (with each
  instance's alias and group): anything not `unavailable`.
  A Local Project requester defaults to a child only when the chosen machine is its own.
  Writers also keep the legacy single-machine fields as a mirror of the first instance, so a
  client that predates instances still runs the Role there. Readers convert older rows
  deterministically: a lan.4 `placements` row gives one instance per switched-on machine and a
  single-machine row one instance, each with the id `<roleId>:<machineId>` and no alias.
  `readDelegatedMachineAccess`
  requires both the executing Machine owner and the driving human to be able to use the target
  (owned, or shared plus shared project); never decide it from synced `MachineMeta.ownerUserId`
  ([note](../../../../.agents/notes/implemented/bug-fix/2026-09-28-mcp-cross-machine-agent-role.md)).

## Board membership

Creating a Session from a Board member inherits its `boardId`, for child Tabs,
independent work contexts and batches alike. Coordinator role and generation are
not inherited. `lody_session_list({ boardId: "current" })` lists the invoking
Session's Board; an explicit id filters another Board, and a non-member's
`current` query is empty. The Board filter is part of cursor identity.
This is PR1 of the [Board design](../../../../specs/project-coordinator/design.md);
Board-specific tools and automatic reports are later steps.

## Chat configuration

- Chat follow-ups inherit omitted mode/model/options from the target's last model turn
  (else its last matching turn). Explicit fields and category options
  win; a model change drops old options. Validate effort/Fast against the final model:
  probe mismatch cannot reject them, and missing per-model data defers to runtime. Drop
  incompatible inherited selectors; fill builtin mode only when still empty.
  ([note](../../../../.agents/notes/implemented/bug-fix/2026-09-17-chat-follow-up-inherits-target-run-config.md))

## Local routing

- Local Session/catalog tools route through `session/call-tool` to the daemon's
  existing repo. `session-tool-router.ts` reuses SDK-parsed MCP arguments and
  parses daemon inputs; `session-command-environment.ts` scopes identity and
  host operations with AsyncLocalStorage. Require an active local user Turn and
  exact workspace/machine scope; never open a second local writer replica.
  Cloud keeps its authenticated command runtime and remote recovery confirmation.

## Agent config writes

The permission tier cap on Agent Role and Schedule writes covers the MCP tools only.
`lody schedule` and the other CLI write commands are no boundary against an Agent:
in the ask and edit tiers its shell commands already need the person's approval, in
the auto and full tiers it already has everything its user has, and telling an
Agent's process from the person's by process ancestry is defeated by `setsid` or an
outside scheduler.

A Schedule written with an Agent Role in `target` keeps a reference to that Role
(`definition.agentRole`), and each run resolves it again on the Schedule's machine
([run contract](../lib/schedules/AGENTS.md)). The cap therefore ranks a bound
Schedule by what its Role resolves to at the moment of the write, never by the Agent
saved beside the reference, and a run is not ranked again: raising a Role afterwards
is itself a person's edit or a capped `lody_agent_role_update`. Known limits:

- A reference without an instance runs the first usable instance of the Role on that
  machine, so adding an instance ahead of it there changes what the Schedule runs.
- Slot admission and the Registry row keep the Agent the Role resolved to at the last
  save until the Schedule is saved again.
- A build without the `scheduleAgentRoles` capability rejects the definition and its
  Registry row: it neither lists nor runs a bound Schedule.

Known limits of the alerts on these writes:

- The hub marks a notice id seen before APNs answers, so a retry of the same id after
  a transient APNs failure is dropped (as for every LAN alert).
- The desktop remembers the ids it alerted on per session only while it runs.
- `lody_agent_role_create` has no request id: if the Role landed but its alert did
  not, a retry is refused as a duplicate name. Re-sending an alert also marks its
  conversation unread again.

### Schedule MCP selection

`lody_schedule_create`, `lody_schedule_update` and `lody_schedule_propose` accept
`mcpServerIds` as workspace MCP ids or unique names. Names are stored as ids;
`lody_schedule_get` includes the choice in `schedule.definition`. On create or
propose, omission follows workspace `enabledByDefault` servers at every run;
`[]` selects none. Update omission preserves the stored choice; update `null`
clears it so runs follow workspace defaults again. Ids the schedule already
saved are not resolved again, so an edit still succeeds after one of those
servers was removed (runs skip it). Existing-chat
destinations retain that chat's MCP selection.

The human CLI accepts the same field inside `lody schedule create/edit --file`
JSON drafts, for example `"mcpServerIds": ["mail", "search"]` or
`"mcpServerIds": []`. CLI edit replaces the full draft, so omitting the field
there restores workspace defaults. The editor's composer menu also sets the
selection; confirmation cards preserve proposed ids.

## Bounded collaboration

If A sends an Agent-authored input to B, B cannot issue a new `session_chat` back to
A while that exact input drives its active turn. This is a per-turn sender restriction,
not a parent/child relationship or a permanent restriction between conversations.
Single and legacy chats return non-retryable `REVERSE_CHAT_FORBIDDEN` before accepting
work. Mixed batches retain unrelated items; a batch containing only reverse targets
is rejected without creating an Operation. Matching accepted retries retain their
existing identity and do not append another prompt.

The runtime selects the exact source input id; its history author supplies only the
sender provenance, never human authorization. Missing input history blocks a new chat;
legacy inputs without Agent sender metadata cannot be classified by this guard. A new
human-authored turn does not inherit an earlier input's restriction. This small fix does
not change completion scheduling or add a note tool or ancestor graph.

The shared causal chain limit is 16 hops, including delegated target turns and
completion continuations. A turn at the cap cannot start another Operation;
the existing guard returns non-retryable `CHAIN_DEPTH_EXCEEDED` before acceptance.
This is a depth limit, not a shared total-message or fan-out budget.

MCP initialization instructions and all four create/chat tool descriptions tell
agents to send only task-advancing messages, omit acknowledgments and courtesy
replies, and use automatic completion delivery instead of manually sending the
same result back. At the cap, report remaining work to the user without retrying
or creating another session to evade the limit. These prompts guide behavior;
the runtime guard enforces the depth bound.

Completed work is persisted and batched at normal release or fresh human input; result
arrival alone never wakes idle or paused sessions. `lody_operation_batch_get` reads
a fixed, Session/user-bound batch without new work. Pages are bounded to 128 KiB; large
individual members return ordered `member-json` fragments. This reader does not grant
submission permission. Human recovery provenance comes from fixed UI/CLI producers,
never model tool fields, role or userId.
