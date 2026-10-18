# Board schedules and archived destination handoff

Status: implemented
Translation: current

[中文](2026-10-18-board-schedules.zh.md)

## Abstract

Recurring Board work needs a thread that owns its results while the main session
remains passive. Board membership now travels through ordinary schedule
persistence, permission checks, preparation and the shared UI. Preparation skips
archived dedicated destinations and atomically freezes the selected id with the
run; an archived frozen target fails before handoff and releases admission.
Per-turn schedule provenance produces passive Board reports without changing the
human identity that authorizes execution. The implementation has deterministic
coverage; packaged desktop and real Agent/LAN scheduling remain unverified.

## Decision and responsibilities

This extends the [machine-owned schedule decision](2026-09-24-machine-owned-scheduled-tasks.md)
and the [Board report decision](2026-10-16-board-inbox-reports.md). The
[Board schedule Spec](../../../../specs/project-coordinator/board-schedules.md)
and [dispatcher model](../../../../specs/project-coordinator/board-dispatcher-model.zh.md)
remain draft.

- `boardId` is optional in definitions, the mirrored map, Registry rows, drafts
  and proposal metadata. It participates in executable fingerprints and
  idempotent replay comparisons. MCP checks both the old and new Board against
  current caller membership; UI and CLI use normal human-owned writes.
- A dedicated id adds a sequence only after zero. Preparation selects the first
  absent/usable session, skipping deleted tombstones (even without metadata),
  archived sessions and detached Board threads; the ledger writes `prepared` and `sessionId` in one
  transaction. No asynchronous work enters the planning transaction. A durable
  retry uses the frozen id even if an earlier sequence is restored meanwhile.
- The worker owns prehandoff validation and failure recovery. Board or unprepared
  existing-session unavailability parks the run with no attempt or retained
  slot. Frozen-session unavailability is terminal. The dispatch pointer remains
  the transfer of ownership to the normal Session watcher; committed work is
  never redirected or rolled back. An archived accepted target releases admission
  once local work drains, even with pending activation/queue markers. The watcher
  removes archived sessions; dispatch guards reject archived targets before queue
  lookup and again before execution.
  Shutdown ownership is unchanged.
- `_lodyScheduleId` lives in the prepared user turn's input metadata, with a
  primitive string through the mirror catch-all and shared history parser/normalizer.
  Inbox continuations inherit it so their eventual conclusion still reports;
  human edit-and-resend removes it from the replacement configuration. This retains
  the human author and user id while allowing `origin: schedule` reporting.
  Scheduled descendant work reports too, because it lacks an Operation receipt
  to its parent. Ordinary human follow-ups remain subject to `reportHumanTurns`.
- `SchedulesWorkspace` takes a Board scope and navigation callbacks. The Board
  wrapper uses its existing list/form/actions, stacked at panel width; global
  rows exclude Board schedules. Proposal and provenance navigation enter the
  owning Board's Schedules tab, on desktop and mobile. List and save validation use
  the same current-epoch deterministic selector; restored earlier sequences win
  over newer chats, other epochs and unrelated scheduleId matches. The embedded
  list explicitly selects compact row geometry, so a 520px Board panel does not
  inherit the wide viewport’s table minimum. It hides the duplicate page title
  while retaining search/New and uses destination-neutral empty copy. Global
  layout and copy remain unchanged; the Board story wraps the list at 520px.

## Alternatives and trade-offs

A second scheduler or a mutable “current thread” field would duplicate execution
ownership or introduce synced selection races. Sequence selection at preparation
keeps existing run/turn identities and needs no new durable cursor. Session-level
provenance would misclassify later human turns, so the marker is per input.

The Spec's 24-hour configuration expiry originally called the outcome “failed”.
The existing engine uses `skipped / DISPATCH_EXPIRED`; the Spec now names that
behavior explicitly. No retry deadline/state-machine change was needed.

Effect feature/fix assessment: the changed code adds pure derivation and fields
to the existing Promise-owned preparation/command engine. Its Repo, Session
preparation and ledger dependencies do not expose a complete native Effect
capability chain. Migrating the worker here would pull in unrelated lifecycle
owners, so no partial wrapper or new runtime was added. The existing native
Board report workflow consumes the changed pure derivation unchanged.

## Verification

Owning suites cover archive/deletion/detachment sequence selection, current-epoch UI
identity, human edit-and-resend provenance removal, Inbox provenance retention,
archived post-handoff slot release, retry/restart identity,
configuration blocking and slot release, real Session preparation membership,
MCP membership authorization and Registry filtering, proposal retention, Board
reports across the real history writer and passive Inbox, and UI scope/selection.
Storybook covers the Board list and dedicated-thread editor.

With official Node v22.23.3, `pnpm check` passed: CLI 4,884 tests (one existing
skip), components 5,900, shared 1,745 and Electron 306, along with type, lint,
i18n and boundary checks. `pnpm format` passed; changed shared/component sources
were also formatted explicitly because those packages have no format script.
`pnpm run docs check` reports zero errors and 71 existing warnings. The stories
passed type checking; visual inspection is deferred to the user-arranged reviewer.
No schedules were created in a live workspace. No reviewer session, remote push,
PR, tag or release was performed as part of implementation.
