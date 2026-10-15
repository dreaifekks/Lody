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

## Verification and limits

Behavioral suites cover normalization, catalog events, status precedence, MCP
creation membership, UI child inheritance and real-atom Overview updates. Full affected-package suites passed: shared 1,528; CLI 4,012 with one skipped;
components 5,348. Full-workspace typecheck, lint/i18n/boundary checks, formatting
and docs checks passed. The aggregate CI run exited 143 before completing; the
affected suites were then completed separately. Storybook list/row previews were
checked in a browser at desktop and 390px widths; real LAN dispatch remains manual. No report observer,
Board MCP tools, notes document, round rejection or digest is shipped in PR1.
