# Schedule execution

Schedules use one definition document, workspace Registry gate and machine-local
SQLite ledger, including those with `boardId`. The
[Board schedule Spec](../../../../../specs/project-coordinator/board-schedules.md)
owns product intent; [AGENTS.md](AGENTS.md) owns runtime invariants.

```text
Registry + definition fingerprint
  → ledger plans fixed run/turn ids (synchronous IMMEDIATE transaction)
  → preparation reads Board, Agent and destination
  → ledger freezes PreparedSessionInput + selected Session id together
  → materialize inert turn → validate frozen target → dispatch pointer
  → ordinary Session watcher owns execution
  → Board report enters the main session's passive Inbox
```

For owned destinations, preparation walks deterministic ids from sequence zero,
which is byte-for-byte the previous `scheduleOwnSessionId(id, epoch)`. Archived
and permanently deleted sessions are skipped, as are threads detached from a
Board schedule’s Board. Missing sessions end the search; other identity failures
remain configuration errors. The selected id is written with the preparation, so
restarts and retries cannot select again. A prepared destination that becomes
unavailable fails the run and releases its slot. An unavailable Board or an
unprepared existing destination waits without consuming an attempt or retaining
a slot; the ordinary dispatch deadline ends it as `skipped / DISPATCH_EXPIRED`.
A dispatched archived target releases its slot once actual local work drains,
even if activation/queue markers remain: dispatch and queue promotion refuse
archived sessions (`session-dispatch-logic.ts`, `session-dispatch-watcher.ts`).

`buildScheduleSessionCreateOptions` carries Board membership into normal Session
preparation. The ordinary startup prompt builder supplies Board instructions and
the shared directory. The schedule worker adds `_lodyScheduleId` to its user
turn; Inbox continuations retain it so the eventual conclusion still reports.
Human follow-ups do not inherit it, and edit-and-resend removes it. It does not
change execution identity. The history parser retains the marker; the mirror’s
existing catch-all stores the string as a primitive without adding it to the
explicit queue configuration. Board report derivation
uses this marker to emit `origin: schedule` even with `reportHumanTurns=false` or
a descendant target. The existing report workflow freezes `deliverWithNextInput`.

The command service owns membership and destination validation for CLI/MCP;
renderer writes continue through `withScheduleStore` and the normal repository.
See the [decision and verification](../../../../../.agents/notes/implemented/feature/2026-10-18-board-schedules.md).
