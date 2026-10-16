# Board membership and the first Overview

Status: implemented
Translation: current

[中文](2026-10-15-board-overview.zh.md)

## Abstract

Parallel sessions need a shared place where the user can see their coordinator
and work without moving their existing sidebar groups. PR1 adds a Board row to
the workspace catalog and keeps membership on each session. Both CLI and UI
creation paths inherit membership; the read-only Overview reuses presence and
opens session history only for expanded rows. Reports, notes and handoff remain
future work, so saved rules do not yet control execution.

## Decision and evidence

The [design](../../../../specs/project-coordinator/design.md) divides the feature
into five steps. This implements only PR1. `workspace-flock.ts` normalizes Board
rows; the existing catalog room and writer supply local durability and later
upload. Creation writes the row before accepting the coordinator's initial turn;
a failed acceptance removes the row. The 50-board limit is a local catalog check,
not a distributed reservation across offline devices.

`prepareSessionInput` covers CLI/MCP, but the renderer has an independent
`session-submission.ts` entrypoint. Both renderer paths must inherit a parent
Board. Role and generation markers are explicit creation inputs, never inherited.
The MCP list filter also participates in cursor identity.

Overview uses the existing opened-by tree and child tabs. A collapsed row can
prove live activity and waiting-user state from presence/meta; transcript-derived
failure and waiting-coordinator state are available on expansion. The coordinator
is initially expanded to show chain depth. PR4 owns round/generation/review UI.
This keeps the design's lazy document boundary without adding cached history
summaries or opening every member's document.

The Schedule agent controls and existing session acceptance preserve agent/Role
selection, prompt composition, MCP defaults, and run config. A per-device opt-in
hides navigation and route content without erasing membership or stopping work.

## Review corrections

The follow-up keeps live presence ahead of waiting markers. A stale waiting
marker is ignored after a newer `lastMessageAt`; daemon marker lifecycle
is unchanged. A child inherits only its parent’s membership, including absence;
preparation cannot restore the caller’s Board from bound create options.

Creation now uses the shared prompt composer and one write-time capacity check
that excludes archived Boards. Overview acquires local-project catalogs once
per machine at list level. Integration tests create actual sessions through
`resolveCreateContext`; row tests use a Loro-backed ConversationView to distinguish
current failed turns/notices from an older failure followed by a new assignment.
New thread and Join/Remove actions are explicitly assigned to PR2 in the Spec.

## Verification and limits

After the review corrections, the full affected-package suites passed: shared
1,529; CLI 4,013 with one skipped; components 5,352. The new CLI integration goes
through `createSessionResult` and `resolveCreateContext`, and Overview uses a real
Loro-backed reader in its transcript cases. Lint/i18n/boundary, format and docs
checks passed.

The recursive workspace typecheck completed. Components passed after its project
map annotation was corrected; other packages passed except CLI's 11 existing
voice/prompt errors. `acp-extension-core` declares its types from `src`, where this
clean checkout has not applied the repository's existing voice/prompt patches.
Both patches pass `git apply --check`; neither those sources nor CLI agent files
changed here. Normal adapter preparation applies them, but this follow-up leaves
submodules unchanged, as permitted for the known check limitation.

The original PR1 browser checks covered desktop and 390px list/row previews.
Real LAN dispatch remains manual. No report observer, Board MCP tools, notes
document, round rejection or digest is shipped in PR1.

## Later change

The read-only Overview page, its expand-to-read rows and the Boards navigation item
were replaced on 2026-10-16 by the Board side panel on the coordinator's page; see
[Board home](2026-10-16-board-home.md). Membership and creation above still apply.
