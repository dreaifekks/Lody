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

## Behavior contract

| Question | Contract |
| --- | --- |
| Trigger | Coordinator history changes, the `board-idle` timer or a 30-second busy recheck wake the reconcile. At most one run per coordinator, held in the Worker's `running` set; a newer manual request supersedes older unhandled ones. |
| Owner | A run is a fiber forked into the Worker Scope; the turn itself belongs to the execution service like any visible turn. The maintenance turn's Promise is not `rawWork`, so stopping the Worker does not wait for it. |
| Cancellation | Stopping the Worker interrupts the wait, never the running turn. The user's Stop cancels the current step and the run ends `interrupted`; a paused Inbox suspends automatic runs. |
| Handoff | Before every step, a running turn, a waiting user turn or Inbox work makes the run yield. Once the old agent has handed over, a new conversation no longer yields to queued results: they go to the new agent. |
| Failure recovery | A reconcile failure is logged and rechecked after 30 seconds without affecting reports or the Inbox; run outcomes are written to the divider; an unconfirmed compaction is `failed`, never "tidied"; an unfinished renewal stays `renewed: false` and is retried when idle. |

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
