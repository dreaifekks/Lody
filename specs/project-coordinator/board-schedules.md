# Board schedules

Status: draft
Translation: current

[中文](board-schedules.zh.md)

Proposed by the user on 2026-10-18, on `feat/board-schedules`, based on the
[Board dispatcher model](board-dispatcher-model.zh.md). This fills the scheduling
part of the [Board design](design.md). A daily digest sent into the main session
is outside this change.

## Scenario

In a Board's Schedules tab, the user creates “Summarize yesterday's merged commits
at 09:00”, chooses an Agent and machine, and saves. The machine creates a Board
thread for the first run and continues it on later days. On completion the thread
and Board show their ordinary unread dots. The main session stays asleep; the
result joins its next input as a Board event. The user can also ask the main
session to create the same schedule with `lody_schedule_*` and `boardId`.

## Decisions

### A Board owns its schedules

- Definitions and Registry rows carry optional `boardId`. A Board's panel provides
  list, create, edit, pause, resume, delete and run-now actions. Global schedule
  lists hide these rows. A conversation's schedule provenance link opens the
  owning Board's Schedules tab.
- These are ordinary schedules: the same documents, Registry execution gate,
  host-local SQLite ledger, manual/once/interval/cron rules and time zones,
  misfire/overlap policy, Agent/Role/MCP selection, permission ceiling and slots.
  There is no second scheduler.
- Missing or archived Boards block handoff as recoverable `BOARD_UNAVAILABLE`
  without retaining a slot. Definitions are not automatically paused or changed;
  restoring the Board lets scheduling resume.

### Destination threads

- **Dedicated thread, default (`own_session`)**: create it on the first run and
  reuse it. It is an ordinary member with `boardId`, no `boardRole`; normal
  startup includes Board instructions, tools and the shared directory.
- **New thread each run (`new_session`)**: create one thread per run.
- **Existing thread (`existing_session`)**: choose a member of this Board other
  than the main session. It must have the same owner, machine and Agent as the
  schedule, under the ordinary destination rules.

### Archived destinations

Sending a scheduled turn into an archived conversation could previously leave it
unexecuted while permanently occupying its Agent's slot. The following rules
apply to ordinary and Board schedules alike:

- A dedicated destination derives ids from schedule id, epoch and a sequence.
  Start at zero, skip archived sessions, and select the first absent or
  unarchived one. Sequence zero is the existing dedicated id. Decide only during
  preparation, freeze it with that run, and never select again on retries.
  No additional definition state is written. UI links use the newest unarchived
  Session carrying the schedule id.
- An archived existing destination blocks as recoverable `SESSION_UNAVAILABLE`
  without retaining a slot. Restore it or change the destination; never silently
  substitute another thread.
- If the frozen destination is archived after preparation but before handoff,
  fail that run instead of sending it.

### Results return as Board events

- The thread's ordinary `lastMessageAt` and unread indicators advance.
- A scheduled turn's completion or failure emits a Board event with source
  `schedule`, regardless of `reportHumanTurns`. Descendant targets also report:
  a scheduled input has no parent Operation receipt to carry its result upward.
  The user did not necessarily witness this run. Events freeze
  `deliverWithNextInput`; the main session stays asleep until its next human or
  scheduled input.
- Threads still own their task and may create children under the dispatcher
  model.

### Management through MCP

- Existing create/update/propose tools accept optional `boardId`. List accepts
  a `boardId` filter and includes it in rows. Get/pause/resume retain their
  signatures; no new tools are added.
- An Agent can write a Board schedule only as a current member of that Board.
  Stored and resulting membership are both checked. Existing destinations must
  be Board threads. Permission ceilings and proposal confirmation still apply.
- The main session's instructions recommend scheduling recurring work on a
  thread with `boardId`, defaulting to a dedicated thread.

## Pending confirmation

1. Board schedules have one management entry, entirely outside the global UI
   list. MCP list with no filter still returns all schedules.
2. The main session cannot be a destination. Scheduled digests there would
   consume queued events and grow its context; that feature is deferred.
3. Archived existing destinations block rather than move: the user's explicitly
   chosen destination must remain meaningful.
4. Archiving a Board does not pause definitions. Each due run records a
   configuration problem and, after 24 hours, follows the existing scheduler's
   `skipped / DISPATCH_EXPIRED` terminal state. Restoring resumes without another
   switch; archiving leaves expired run records. No new failure state is added.
5. Scheduled completions always enter the event log even if the user later reads
   the thread. Each queued output retains the existing 1,000-character bound.
6. Older clients reject definitions with `boardId`. All fork machines run the
   same version; no compatibility layer is added.

## Evidence

- Shared schedule definitions, ids and Registry: `packages/shared/src/schedule-types.ts`
  and `schedule-registry.ts`.
- Runtime and commands: `apps/cli/src/lib/schedules/`; MCP:
  `apps/cli/src/mcp/schedule-tools.ts`.
- Board reports: `packages/shared/src/board.ts` and
  `apps/cli/src/orchestration/board-report-workflow.ts`.
- UI: `packages/components/src/components/schedules/` and Board panel components.
- The archived-destination incident was observed on 2026-10-16; its private
  diagnostic record is not committed here.
- [Implementation and verification note](../../.agents/notes/implemented/feature/2026-10-18-board-schedules.md).
