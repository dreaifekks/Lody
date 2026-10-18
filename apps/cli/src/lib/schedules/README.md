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
  → validate frozen target → materialize inert turn → revalidate → dispatch pointer
  → ordinary Session watcher owns execution
  → Board report enters the main session's passive Inbox
```

For owned destinations, preparation walks deterministic ids from sequence zero,
which is byte-for-byte the previous `scheduleOwnSessionId(id, epoch)`. Archived
sessions are skipped. Missing sessions end the search; other identity failures
remain configuration errors. The selected id is written with the preparation, so
restarts and retries cannot select again. A prepared destination that becomes
unavailable fails the run and releases its slot. An unavailable Board or an
unprepared existing destination waits without consuming an attempt or retaining
a slot; the ordinary dispatch deadline ends it as `skipped / DISPATCH_EXPIRED`.

`buildScheduleSessionCreateOptions` carries Board membership into normal Session
preparation. The ordinary startup prompt builder supplies Board instructions and
the shared directory. The schedule worker adds `_lodyScheduleId` only to that
user turn; it does not change its human execution identity. Board report derivation
uses this marker to emit `origin: schedule` even with `reportHumanTurns=false` or
a descendant target. The existing report workflow freezes `deliverWithNextInput`.

The command service owns membership and destination validation for CLI/MCP;
renderer writes continue through `withScheduleStore` and the normal repository.
See the [decision and verification](../../../../../.agents/notes/implemented/feature/2026-10-18-board-schedules.md).
