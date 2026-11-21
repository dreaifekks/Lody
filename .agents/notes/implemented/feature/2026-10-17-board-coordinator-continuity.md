# Board coordinator continuity: idle compaction and a new conversation

Status: implemented
Translation: current

[中文](2026-10-17-board-coordinator-continuity.zh.md)

## Abstract

A Board coordinator is one long conversation, but its model context cannot grow
without bound, native auto-compaction comes too late, and it reduces the Board
instructions, which only the first message carries, to a paraphrase. When the
coordinator has been idle for 10 minutes with a context above min(150K, 40% of the
window), Lody now runs three quiet maintenance turns in the same Session: record
memory, `/compact`, and a renewal carrying the current Board instructions; the user
can also compact by hand or start a new agent conversation. The Session id never
changes, so the Inbox, report cursors, notes permission and thread ownership need no
migration; the trade-off is that compaction quality stays with the agent, and
agents without a compaction capability are skipped.

## Decisions and evidence

This implements plan B of
[Coordinator continuity](../../../../specs/project-coordinator/coordinator-continuity.zh.md)
with the user's 2026-10-17 decisions; its "实现" section lists where the
implementation differs from the proposal.

- **Where it runs**: the coordinator machine's Host-lease Worker.
  `CoordinatorWorkflow` owns a `BoardContinuityWorkflow` that reconciles after Board
  reports and before the Inbox wake, reusing the report observer's coordinator
  history subscription and `CoordinatorActivity` timers. No new transport or table.
- **Maintenance turns stay outside the Inbox**: the new `maintenance` dispatch source
  owns an assistant entry and no dispatch pointer, bypasses Inbox admission and
  batches, writes no `lastMessageAt`, sends no push, and wakes the Inbox and the
  dispatch check when it ends. The alternative, a new Inbox input kind, would change
  upstream SQLite admission and batching, and a `task` input folds queued results
  into the `/compact` prompt.
- **State lives in history**: the divider is a system turn recording kind, trigger,
  status, usage before and after, and whether instructions were renewed; a manual
  request is a divider in the `requested` state. The Worker reads the last 50 rows to
  decide whether anything happened since the last run, keeps no state outside it,
  and marks a leftover `running` divider `interrupted` after a restart.
- **Renewal**: a renewal turn follows the compaction; the execution service builds
  its prompt from the current Board row through the same entry as a member's first
  message (`boardPromptContext` + `buildPrompt`). Prompt assembly for user turns and
  Inbox batches is unchanged.
- **New conversation**: the same Lody Session; the old agent writes a handoff file,
  the execution service retires the ACP session and starts a new one without resume
  or history replay, and its first message carries the Board instructions and Lody's
  handoff facts. Fork and generation handoff were not used: both change the Session
  id the Board anchors on.
- **MCP selection**: maintenance turns and the new agent conversation take it as a
  chat follow-up does: the conversation's latest recorded choice, else the workspace
  defaults. Reading only the driving turn would give an empty selection after an
  Inbox turn and start the new agent without workspace MCP servers.
- **Fallback**: coordinator processes get `CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000`.

A released foreground turn still owns its deferred completion while native work
is pending. Board maintenance treats that ownership as busy through
`hasPendingNativeWork`, using the existing busy recheck. Starting a maintenance turn
instead would withdraw the user's delayed unread/push publication, or retire the
agent while its work is still running; no new queue or timer is needed.

## Behavior contract

| Question         | Contract                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger          | Coordinator history changes, the `board-idle` timer or a 30-second busy recheck wake the reconcile. At most one run per coordinator, held in the Worker's `running` set; a newer manual request supersedes older unhandled ones.                                                                                                                                                |
| Owner            | A run is a fiber forked into the Worker Scope; the turn itself belongs to the execution service like any visible turn. The maintenance turn's Promise is not `rawWork`, so stopping the Worker does not wait for it.                                                                                                                                                            |
| Cancellation     | Stopping the Worker interrupts the wait, never the running turn. The user's Stop cancels only the current step (a maintenance turn owns no Inbox execution, so the Inbox is not paused) and the run ends `interrupted`; a paused Inbox suspends automatic runs.                                                                                                                 |
| Handoff          | Before every step, a running turn, pending native background completion, a waiting user turn or Inbox work makes the run yield. From the handoff until the new agent's first turn ends, the execution service keeps Inbox batches away; when a user turn takes the Session first, the switch stays pending (`running` with `handoff`) and resumes once the coordinator is free. |
| Failure recovery | A reconcile failure is logged and rechecked after 30 seconds without affecting reports or the Inbox; run outcomes are written to the divider; an unconfirmed compaction is `failed`, never "tidied"; a renewal that never started (`duplicate` and the like) stays `renewed: false` and is retried when idle, and only a failed turn records a reason and stops retrying.       |

## Verification and limits

- "Board coordinator continuity" in `operation-coordinator.test.ts` uses the real
  Inbox, Loro history and an injected clock; "Board maintenance turns" in
  `session-execution-service.test.ts` checks the execution-service boundary; shared
  policy and stream-building tests cover the rest.
- Not run end to end against a real agent. Codex's `/compact` ignores the keep list;
  Kimi compacts in the background and will usually read as unconfirmed; Grok declares
  no compaction capability. With no running agent and no cached `compact` command,
  idle compaction is skipped.
- PR: to follow (the `board-coordinator` branch, PR #53).

## Later decision (2026-10-20): idle compaction counts waiting receipts

Board reports are passive: while the coordinator sits idle they wait in the Inbox and
arrive with the next input. The user drives several requests across several threads at
once, so ten or twenty reports can reach the main thread together. The idle check is now
`used + pending >= threshold`: `pending` covers the coordinator user's Inbox results no
batch has claimed yet (scoped by user and capped at 50 members, like the next input),
estimated with `estimateTokenCount` over the text `batchPreview` would produce (capped at
64 KiB). It comes from `CoordinatorBoardMaintenance.pendingTokens` and needs no new
trigger: the reconcile that writes a report into the Inbox reruns the idle check
(`coordinator-workflow.ts` runs Board reports before continuity). The window share can be
set as high as 95%, so the headroom below the threshold cannot be relied on to absorb them.
With no coordinator activity since the last maintenance run the check does not rerun, even
as reports pile up: compaction only shrinks the existing context, the reports arrive with
the next input, and compacting again right after a compaction saves little.

Placing the receipt batch before the current request was considered; the user chose to
keep the upstream order (request first, receipts after).

## Fix (2026-10-21): a manual request did not start after GC unloaded the coordinator document

Symptom: after GC cleaned an idle coordinator, "Tidy context now" stayed at "Tidying context…"
until the user sent another message. In the persisted history of the algorithm Board on devNuc,
the manual requests of 11:49 and 12:09 were still `requested`; the run that finished at 13:00
was an idle run under another run id, and none of its dividers reached storage.

Cause: the report observer opens each Board Session's `SessionDocument` once and subscribes to
its history. `cleanSessionDoc` (used by GC, archive and dispatch cleanup) destroys that instance
and drops it from the cache; later writes land in the repository's fresh replica, so the old
instance neither sees changes nor persists its own writes. A manual request writes history only,
not metadata, so nothing woke the reconcile. The user's message changed metadata and woke it, but
it still read and wrote the old instance: it saw no request, its last activity was still 09:36,
and with "idle for three hours" plus a turn that pushed usage past 150K it started an idle run at
once and wrote its dividers into the old instance.

Fix: `LoroDocumentManager.onSessionDocReleased` notifies after `cleanSessionDoc` destroyed and
uncached a document; `CoordinatorHistory.observe` wakes once when its own Session is released,
and `released()` reads the instance's `isDestroyed`; in `refresh` the report observer drops
released observations and reopens and resubscribes by membership. The reopen happens in the
reconcile right after the release, so later writes (the renderer's manual request included) wake
as usual and reads and writes go to the repository's current replica. Having GC skip Board
documents was considered: it covers GC only, archive and dispatch cleanup would still break the
observation, and GC would have to know about Boards. The cost is that Board Session documents are
loaded again after GC (the agent process still exits), as the Worker already does at startup for
every Board member.
The report observer keeps one finalizer on the Worker Scope that detaches the subscriptions
still held when it closes; an early detach removes its own entry, so repeated GC and membership
changes no longer leave the Scope holding old documents (found in cross-review: each
subscription used to add its own finalizer).

UI: a `requested` divider now reads "Tidy requested · starts when the coordinator is free" (and the
same for a new conversation), separate from the `running` "Tidying context…".

Tests: "Board coordinator continuity" adds a case on a real `LoroDocumentManager`: after
`cleanSessionDoc`, with no test wake, only the release notification and the write itself, the
manual request starts and is recorded `done` in the repository replica. Without the reopen in
`refresh` the case fails.

Not changed: `CoordinatorWorkflow`'s history subscriptions on Operation targets
(`subscriptions`) are not rebuilt after a release either; SQLite and metadata wakes cover that
path, and it stays as is.

## Later decision (2026-11-19): a new conversation can continue with another agent

An existing Session keeps its agent, so a coordinator's model could only change within the
agent it started with. "Start a new conversation" on the desktop now opens a dialog
(`BoardNewConversationDialog`) seeded with the coordinator's agent and the settings its composer
shows; the user can pick another agent configuration on the coordinator's machine, with its
model, mode and options. The choice rides on the request divider as `agent`
(`BoardCoordinatorAgentSchema`: a schedule's agent without a memory binding). The old agent
writes the handoff with its own settings. Once the new agent's first turn (`renew`) holds the
Session, and before any agent starts, `runBoardMaintenanceTurn` writes the Session's
`agentConfigId`, `cliType` and `agentType` (`SessionDocument.setAgentConfig`), so the agent it
starts and every later turn resolve the new configuration. The same write drops the previous
agent's conversation id (`acpSessionId`), because no other agent can resume it, and a maintenance
turn takes the conversation to resume from the Session only, never from the user turn that drove
it (both found in review: after a failed start the next turn, or a later compaction through the
driving turn's `resume`, handed the old id to the new agent). A start that fails or is stopped
therefore leaves the Session on the new agent with no agent conversation: the user's next turn starts it with the conversation rebuilt from history, and
another new conversation starts it fresh, without a handoff. Machine, project scope and Board
instructions do not change.

Why only then: a user turn already queued carries the old agent's types and would fail
`agent_type_mismatch` against metadata switched earlier. A user turn that comes first still runs
with the old agent, and the switch resumes when the coordinator is free.

Where the new settings live until the user speaks: the composer takes the runtime baseline only
when it is attached to the latest user turn, so the new agent's first turn records what it applied
against that turn (`runtimeConfigTurnId`, the Session's `latestUserMsgId`), and the composer shows
the chosen model with no new rule. Maintenance before the user's next turn finds the switch by the
`renew` entry after the driving turn and reads its divider (`switchedAgent`). Keying on the
divider's own position was rejected: a user turn that ran during a pending switch sits after the
divider but before the switch. Reading the divider in the composer was rejected for the same
reason, and because the composer holds only the history tail.

Not done: switching without a new conversation (the old agent conversation cannot continue under
another agent); a "default coordinator agent" Board setting, which would be a second entry for
the same action because a different agent always needs a new conversation; the phone menu, which
still starts a new conversation with the current agent. A coordinator with no user turn yet has no
turn to attach the baseline to, so its composer shows the new agent's default model. Mirror hands
a stored map back with an inherited `$cid` that a record parse copies, so the schema drops it from
`configOptionValues`; otherwise it would reach the agent as an option.

Tests: "Board coordinator continuity" in `operation-coordinator.test.ts` (handoff with the old
settings, the chosen agent's settings for the new conversation and for maintenance after it),
"SessionExecutionService Board maintenance turns" (metadata switched before the agent starts,
the baseline attached to the latest user turn; a removed agent configuration leaves the Session
as it was; a maintenance turn ignores the `resume` of its driving turn), "SessionDocument agent
switch" (the old conversation id goes with the switch), and
the header-menu case in `board-overview.test.tsx`. Run end to end on a temporary desktop with
two scripted agents; not yet against real agents.

## Fix (2026-11-22): Antigravity coordinator idle compaction

Symptom: idle compaction was always skipped when a managed builtin or persisted registry
Antigravity (`agy 1.5.10`) served as the Board coordinator.

Observed behavior: testing managed `antigravity 1.5.10` directly confirmed that it announces
`compact` via `available_commands_update`, and that sending `/compact <instructions>` (the shape
of `COMPACT_PROMPT`) compacts synchronously and runs a follow-up confirmation reply before
`session/prompt` returns, emitting a lowered `usage_update` well below `USAGE_DROP_PROOF` (0.8).
The boundary is that a bare `/compact` (with no trailing text) compacts synchronously without a
second model call, so `usage_update` does not drop until the next turn and would fail with
`compaction-unconfirmed`; `COMPACT_PROMPT` must therefore keep trailing instructions.

Causes (two gaps):

1. **Live process gap**: `AgentClient.supportsContextCompaction()` checks only
   `_meta.lody.compaction?.version === 1`; closed-source `agy` sends `_meta.antigravity` in
   `initialize` and omits `_meta.lody.compaction`, so a live process always returned `false`.
2. **Offline fallback gap**: after idle GC or a daemon restart, no live process runs and
   `coordinator-sessions.ts` falls back to Machine Flock's `acpCapability.availableCommands`.
   Because `agy` pushes commands asynchronously in `available_commands_update` instead of
   `NewSessionResponse`, capability probes in `acp-capabilities.ts` do not capture `compact` from
   asynchronous `available_commands_update` notifications, so the fallback returned `undefined`.
   `AcpCapabilityCacheEntrySchema` is `.strict()`, so adding a new cache field would break
   `acpCapability` sync across mixed-version LAN nodes.

Fix:

- Pass `cliType` into `withAntigravityAcpStream` (`apps/cli/src/agent/antigravity-acp-stream.ts`).
  Keep the entry guard on `isAntigravity(agentType)` so existing YOLO mode rewriting and
  `mcpCapabilities.http: true` compatibility stay intact for `custom/antigravity`, and gate only
  the `_meta.lody.compaction: { version: 1 }` injection on `isAntigravityProvider(cliType, agentType)`
  so both live and offline compaction support match only `builtin/antigravity` and
  `registry/antigravity-acp` (never injecting or falling back for `custom/antigravity`). Preserve
  existing `_meta` and `_meta.lody` fields and never overwrite a server-supplied `compaction`
  declaration, keeping `AgentClient` provider-neutral.
- Export `antigravitySupportsContextCompaction(cliType, agentType)`. In `coordinator-sessions.ts`,
  `compactionSupport` still gives the live process result highest priority; only when
  `live === undefined` does it return `true` for those two Antigravity providers, while
  normalizing any leading `/` on cached command names for other agents.
- Re-read `contextWindowUsage.used` in `board-continuity-workflow.ts` right after `:memory` and
  before `/compact` (`beforeCompact`) so `USAGE_DROP_PROOF` is judged against the immediate
  pre-compact baseline (preventing false `compaction-unconfirmed` when `:memory` grows context or
  records the first usage reading). The divider keeps pre-tidy `before` when present (falling back
  to `beforeCompact` only if `before` was absent) and records `usedAfter` only when strictly lower
  than that display baseline.

Tests: `antigravity-acp-stream.test.ts` covers `initialize` injection, preservation of existing
`_meta` / `_meta.lody` fields and server-provided `compaction`, passthrough for non-Antigravity
agents, keeping HTTP MCP and YOLO rewriting for `custom/antigravity` without injecting compaction,
`antigravitySupportsContextCompaction` matching, and `AgentClient` integration through
`withAntigravityAcpStream`; `operation-coordinator.test.ts` covers live `false`
precedence, offline Antigravity fallback, leading-slash `/compact` normalization, post-`:memory`
usage baseline re-reading, and an end-to-end `BoardContinuityWorkflow` run
(`:memory` → `/compact` → `:renew`) confirmed solely by the `usage_update` drop without a
`context_compaction` tool-call marker.
