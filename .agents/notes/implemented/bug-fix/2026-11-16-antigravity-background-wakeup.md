# Antigravity ACP v1 background work and idle GC

Status: implemented
Translation: current

[中文](2026-11-16-antigravity-background-wakeup.zh.md)

## Abstract

`agy acp` (`Antigravity ACP Server`, ACP v1) ends `session/prompt` with `end_turn` while
background work is still running and does not advertise Core `sessionActivity`. Lody
previously synthesized `sessionActivity` and `_meta.lody.backgroundTaskId` from stdout
tool heuristics and `session/list` `updatedAt` polling, then removed those heuristics
(matching upstream `#3097`) because wire-level audits on `agy 1.5.14` and production runs
showed that placeholder text and `<SYSTEM_MESSAGE>` notifications stay internal to `agy`'s
transcript and heuristic counting locked sessions in `running` presence, suppressed
unread/completion notifications, and polled `session/list` every 2 seconds for up to 24
hours. Lody now keeps only deterministic Antigravity compatibility (`isAntigravityServer`,
`realpath` `cwd` negotiation, `session/resume` preference, `CommandLine`/`Cwd` and
`Path`/`TargetFile` normalization), consumes Core `sessionActivity` and
`_meta.lody.backgroundTaskId` only when an agent authoritatively emits them, and refreshes
idle GC unconditionally in `MessageHandler.enqueueACPUpdate` whenever live post-turn
model/tool output arrives.

## Problem

`agy acp` does not advertise Core `sessionActivity` (`_lody/session/activity_update`).
Wire-level tests on `agy 1.5.14` and production failures invalidated every assumption of
the former heuristic tracker:

- `run_command` and `schedule` background placeholder text (`Tool is running as a
  background task with task id: ...`) is written only to `agy`'s internal `transcript.jsonl`,
  not emitted on the ACP JSON-RPC wire (`tool_call` stays `in_progress` until terminal
  `completed`/`failed`). Regex extraction (`BG_TASK_PLACEHOLDER_*`) never matched real
  background runs and only misfired when tool stdout quoted source/log lines.
- `<SYSTEM_MESSAGE>` wakeup notifications are never sent via `user_message_chunk` on ACP.
- `invoke_subagent` / `send_message` / `swarm` emit `status: "completed"` immediately on
  dispatch and can complete inside the same turn with no `tool_call_update` or
  `agent_thought_chunk`, leaking `pendingWakeups` until the 24-hour cap.
- Post-`end_turn` wakeups on `agy 1.5.10+` stream live `session/update` frames with no
  closing boundary frame (`updatedAt` in `session/list` also freezes during slow tools and
  long thoughts), so fixed stillness timers cannot distinguish completion from active work.
- Feeding an unreliable heuristic into `AgentClient.reportsSessionActivity()` /
  `getNativeWork()` caused `SessionActivePresence` to broadcast `running` ("working"),
  `SessionExecutionService` to suppress completion notifications and later emit false
  `nativeWorkInterrupted` notices, and `runAntigravityPollLoop` to poll `session/list`
  every 2 seconds for 24 hours.

## Decision

- **No heuristic `sessionActivity` or placeholder `backgroundTaskId` synthesis (upstream `#3097`).**
  `AntigravitySessionTracker`, `runAntigravityPollLoop`, `BG_TASK_PLACEHOLDER_LINE_PATTERN`,
  and `extractAntigravityBackgroundTaskId` are removed from `antigravity-background.ts` and
  `agent-client.ts`. `AgentClient.reportsSessionActivity()` returns `true` only when the
  agent advertises Core `sessionActivity` v1. Without an authoritative signal from `agy`,
  turns finish immediately at `end_turn` and normal idle GC applies, matching
  [Session GC respects native agent work](2026-10-18-gc-respects-native-agent-work.md).
  Authoritative Core `sessionActivity` v1 presence (`backgroundTaskState`,
  `backgroundTaskCount`, `BackgroundTaskStatusRow`, breathing rings) and persisted
  `_meta.lody.backgroundTaskId` handling in `packages/shared` and `packages/components`
  remain intact for Claude, DeepSeek Harness, and any future `agy` release that advertises
  Core `sessionActivity` v1.
- **Keep live post-turn output safe from mid-stream idle GC.**
  `MessageHandler.enqueueACPUpdate` calls `touchSession(sessionId)` unconditionally when
  live post-turn model/tool output (`agent_message_chunk`, `agent_thought_chunk`,
  `tool_call`, `tool_call_update`, `subagent_event`, `plan`, `plan_update`, `plan_removed`)
  is routed to a `finalized_turn`, closing the gap where `agy 1.5.10+` could otherwise be
  reaped mid-wakeup after `reportsSessionActivity()` returned `false`. Passive metadata
  notifications (`session_info_update`, `available_commands_update`, etc.) do not touch.
- **Keep deterministic Antigravity compatibility.** `antigravity-background.ts` retains
  `isAntigravityServer` (builtin `antigravity` and custom `Antigravity ACP Server` parity,
  excluding legacy `antigravity-acp`). `AgentClient` retains `realpath` `cwd` negotiation,
  `session/resume` preference over `session/load`, `toolName` projection, and PascalCase
  `CommandLine`/`Cwd` normalization (alongside `Path`/`TargetFile` fallback in
  `tool-call-history.ts`).

## Rejected alternatives

- **Synthesizing `sessionActivity` from stdout tool notifications + `session/list` polling.**
  Implemented on 2026-11-16 and removed on 2026-11-22: without an authoritative task-count
  signal from `agy`, false positives permanently stuck sessions in `running` presence for
  up to 24 hours.
- **Replaying wakeup output from `session/load` snapshots.** Tested on real `agy` 1.5.7;
  every `session/load` stopped and restarted the session's MCP servers, interrupting
  in-progress tool calls.
- **Reading `agy`'s on-disk transcript.** Undocumented internal format that can change with
  any `agy` release.
- **Holding `session/prompt` open or sending synthetic steers after `end_turn`.** Locks
  the composer or violates root `AGENTS.md`.

## Verification

`apps/cli/src/agent/antigravity-background.test.ts` drives the real `AgentClient` and
pins: builtin/custom `Antigravity ACP Server` parity vs legacy `antigravity-acp`,
`CommandLine`/`Cwd` and `toolName` normalization, that no synthetic `nativeWork`,
placeholder `backgroundTaskId`, or `session/list` / `session/load` polling occurs after
`end_turn` when Core `sessionActivity` is absent, that authoritative Core `sessionActivity`
v1 and `_meta.lody.backgroundTaskId` are honored if advertised, and `realpath` `cwd`
negotiation. `apps/cli/tests/message-handler-acp-batching.test.ts` pins that live
post-turn output restarts the GC idle clock regardless of `reportsSessionActivity()` while
passive metadata updates do not.
