# Antigravity ACP v1 background work and idle GC

Status: implemented
Translation: current

[中文](2026-11-16-antigravity-background-wakeup.zh.md)

## Abstract

`agy acp` ends `session/prompt` with `end_turn` while its background work is still
running, then stops writing to stdout, so Lody's idle GC killed processes that were
still working. Lody now ends the turn normally and synthesizes Core `sessionActivity`
until that work has woken the model and gone quiet, using only side-effect-free
`session/list` polling. Output agy produces in those wakeups is not replayed into Lody:
the only API that returns it, `session/load`, restarts the session's MCP servers and
interrupted a tool call in a real run. agy 1.5.10 and later stream that output live.

## Problem

`agy acp` (`Antigravity ACP Server`, ACP v1) resolves `session/prompt` with
`end_turn` as soon as the model yields, even while background work it started is
still running: `run_command` past its async threshold, `schedule` timers and crons,
`invoke_subagent` / `send_message`, `swarm` and async `run_workflow`. When that work
finishes, agy wakes the model inside its own session, but agy 1.5.9 and earlier no
longer write `session/update` or `session/request_permission` to stdout until the next
prompt. Correction: agy 1.5.10 and later send them at once, and Lody's late-output
routing writes them into the finished turn
([measurement](../feature/2026-11-15-antigravity-agy-cli-acp.md#findings)). agy does not advertise
the Core `sessionActivity` extension, so Lody saw an idle session and
`SessionGCManager` killed the process after the idle timeout while the work was still
running.

## Decision

The fix stays inside `apps/cli/src/agent/` (`antigravity-background.ts` and
`AgentClient`). It reuses the native-work contract from
[Session GC respects native agent work](2026-10-18-gc-respects-native-agent-work.md):
the turn ends at `end_turn`, and `sessionActivity` keeps the process alive.

- **Pending work at `end_turn`.** From the tool notifications streamed live during the
  turn, Lody tracks still-`pending` or `in_progress` tools by `toolCallId` in
  `pendingToolIds` (defaulting an omitted `tool_call` status to `pending`), and counts
  wakeup-only items separately in `pendingWakeups`: tools whose complete output is a
  standalone single-line agy "running as a background task with task id: ..." placeholder
  (excluding non-background read/search/edit/write/delete/move/think tools and multi-block
  outputs), or tools that dispatch work reporting only by waking the model
  (`invoke_subagent`, `send_message`, `swarm`, a `run_workflow` with no output). A
  `toolCallId` migrates exclusively between `pendingToolIds` and `pendingWakeups`, and
  each wakeup-only `toolCallId` is counted at most once. agy keeps a `schedule`
  `in_progress` until it fires, so timers need no special case. `IsDaemon: true` and
  failed tools are not counted. No agy tool arguments are parsed.
- **Release by live completion, activity, and reconciliation.** While items are pending,
  Lody polls `session/list` every 2 seconds and reports `background`, or `running` while
  `updatedAt` or post-`end_turn` live wakeup notifications are moving. On agy 1.5.10+,
  a terminal `tool_call_update` removes that exact `toolCallId` from `pendingToolIds`
  while keeping the 30-second stillness window active so the model can finish its wakeup
  reply; merged completions settle together without prematurely decrementing still-running
  tools, new background tools started during a wakeup are tracked in `pendingToolIds` or
  `pendingWakeups`, and pure `in_progress` progress updates do not trigger inferred
  completions. When a live wakeup signal (model output or a wakeup-started helper tool
  completing) settles a `pendingWakeups` item, `pendingWakeups` is decremented directly
  so a later cross-turn tool completion cannot revive it; once post-`end_turn` live
  streaming is observed for the session, delayed replies do not decrement still-running
  `pendingToolIds`. For agy 1.5.9 and earlier (which send no post-`end_turn` tool
  updates) or poll-only bursts without live tool events, a qualifying burst followed by
  30 seconds of stillness increments `inferredCompletions` rather than guessing which
  `toolCallId` finished; effective pending work is
  `pendingToolIds.size + pendingWakeups - inferredCompletions`. Lody reports idle when
  effective pending work reaches zero and no wakeup burst is active, and after 24 hours
  at most, matching the Core `background` cap. When remaining pending work lacks
  sufficient settlement evidence (for example, neither usable live settlement signals
  nor working `session/list` poll activity are available, or several wakeup-only items
  merge into one wakeup burst so only one item settles), the monitor can keep protecting
  until the 24-hour cap.
- **Across turns.** `pendingToolIds`, `pendingWakeups`, and `inferredCompletions` carry
  into the next turn so earlier background work stays protected. When a later turn
  receives or replays a terminal `tool_call_update` for an earlier `toolCallId`, Lody
  removes it from `pendingToolIds` and reconciles any prior `inferredCompletions` by one
  so the same completion is never subtracted twice.
- **`cwd`.** Lody negotiates the `realpath` of the workdir as the Antigravity ACP
  `cwd`; agy compares edit targets by realpath, so a symlinked workdir otherwise made
  in-workspace edits ask for permission.

## Rejected alternatives

- **Replaying wakeup output from `session/load` snapshots.** Implemented and tested
  on a real agy 1.5.7 with `gemini-4-hydrogen-medium`; replay itself worked. Every
  load stopped and restarted the session's MCP servers: 19 loads and 20 server starts
  in 125 seconds at a 6-second rhythm. With loads throttled to one a minute and only
  after `updatedAt` had been still for 10 seconds, a 30-second MCP tool call was still
  cut off about 10.7 seconds in and returned `failed` with EOF, because `updatedAt`
  does not move while a tool runs. No timing rule can tell "done" from "waiting on a
  slow tool" from outside.
- **Loading with an empty `mcpServers` list.** Unverified; agy may detach the
  session's MCP servers for the rest of its life.
- **Reading agy's on-disk transcript.** Side-effect free, but an undocumented format
  that can change with any agy release.
- **Holding `session/prompt` open until background work finishes.** Locks the
  composer for up to 30 minutes and needs a second state machine; the native-work
  contract already covers background work after a turn.
- **Counting tasks from agy tool arguments** (`DurationSeconds`, `CronExpression`,
  `MaxIterations`, swarm `tasks`/`n`, `manage_*` kills). The count drifts as soon as
  agy changes an argument.
- **Synthetic prompts or steers after `end_turn`.** Root `AGENTS.md` forbids text
  that steers the agent.
- **Antigravity cases in `SessionGCManager` or `MessageHandler`.** Those consumers
  stay provider-neutral.

## Verification

`apps/cli/src/agent/antigravity-background.test.ts` drives the real `AgentClient`
against a fake `session/list`. It pins turn completion at `end_turn`, protection of
silent work beyond the idle timeout, one wakeup per pending item, the 24-hour cap,
continued protection when `session/list` fails, daemon and failed-tool exclusion,
carry-over across a new message, `realpath` negotiation, and that `session/load` is
never called. Real-machine runs covered the replay design that this note rejects; the
activity-only release rule has not been run against a real agy.

## Limits

- With agy 1.5.9 and earlier, output agy writes after `end_turn` reaches Lody only with
  the next prompt, inside the new turn, and never if the process is replaced first.
  agy 1.5.10 and later send it at once.
- For wakeup-only dispatches (which emit no terminal completion update) or agy 1.5.9
  and earlier, several items that wake agy in a single burst release only one item, so
  the session stays protected until the next burst or the 24-hour cap. On agy 1.5.9 and
  earlier, work the model starts during a wakeup is not visible until the next prompt and
  is not counted; agy 1.5.10+ streams those tool notifications live so they are tracked.
- With agy 1.5.9 and earlier, a post-`end_turn` tool waiting for a permission request
  agy does not forward still wedges that agy session until the user cancels;
  `realpath` negotiation removes the most common trigger. agy 1.5.10 forwards the
  request.
- Because `updatedAt` and model replies carry no task attribution, if a tracked tool
  completes in the same wave as an `updatedAt` advance and the model only replies more
  than `wakeupQuietMs` (30s) later while a wakeup-only dispatch is also pending, that
  delayed reply is indistinguishable from the wakeup-only dispatch completing (matching
  the prior `wakeupQuietMs` wave contract). Conversely, when a tracked tool completes
  with neither model output nor an `updatedAt` advance, the next wakeup reply is
  conservatively attributed to that tool so a parallel wakeup-only dispatch stays
  protected.
