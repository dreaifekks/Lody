# Board tools, instructions and shared notes

Status: implemented
Translation: current

[中文](2026-10-15-board-tools-notes.zh.md)

## Abstract

Board members need a shared record and tools that stay aligned with their current membership.
PR2 adds daemon-routed Board reads and LoroText notes, role-specific startup instructions,
and UI entry points for threads and membership. Concurrent appends merge instead of replacing
one Flock row. The capacity limit is enforced per local write; reporting and handoff promises
remain explicitly unavailable until PR3/PR4.

## Decision and ownership

This builds on [PR1](2026-10-15-board-overview.md) and implements the PR2 slice of the
[design](../../../../specs/project-coordinator/design.md#pr2-implemented).

```text
ACP startup metadata -> HTTP header / stdio env -> advertised Board tools
Session tool call -> daemon active-turn gate -> current membership -> Board catalog / notes
Overview notes panel -> shared LoroText writer -> existing repo persistence and room sync
```

- Shared owns document naming, text edits and byte bounds. CLI opens/syncs the document;
  renderer owns panel subscriptions. There is no second daemon replica or registry.
- A header never grants access. Replacement checks both `boardRole` and the catalog's
  coordinator id. The daemon rechecks membership after document sync before writing.
- Manual membership edits affect one Session; the coordinator remains fixed. New threads
  reuse Agent/Role controls and normal admission in chat context. Coordinator defaults stay
  independent of a thread's choice.
- Prompt text describes today's capabilities. Ordinary Operation completions remain available;
  Board reports, round refusal and handoff are not promised before their implementation.
- Overview tools use collapsed-row metadata/presence, bounded to 100 rows / 64 KiB; history
  detail remains on demand. This preserves PR1's document acquisition boundary.
- The local UTF-8 capacity check cannot be a distributed lock. Over-limit concurrent merges
  retain both contributions; subsequent appends fail and a reducing replacement is allowed.

## Review corrections

Creation and tool calls previously required hub sync even with a complete local replica.
They now follow the existing settings reader: attempt sync, warn on failure and continue
from local data. Each tool invocation refreshes the catalog once and still rereads local
membership before notes writes. Local durability and background upload retain their owners.
Coordinator checks and default headings use the invoking Session id, allowing sparse metadata.
The coordinator prompt says Lody attaches constraints to each thread's first message, so it
need not repeat them; a missing Board row now uses `Effect.fail`.

The existing suites now exercise daemon tool reads/writes with rejected sync and sparse
metadata, actual ACP payloads through the execution service for members/nonmembers and both
roles without reinjection on continuation, and new-thread dialog submission to `startSession`
with boardId but no boardRole/project, closing the form after acceptance.

## Evidence and verification

Behavior tests cover role instructions, daemon routing/member revocation/coordinator-only
replacement/capacity, startup tool visibility, two-replica concurrent appends, metadata removal,
UI edit/preview failure retention, rejected sync with sparse metadata, execution-service ACP
payloads and new-thread form submission. The original synthetic Storybook checks at desktop
and 390px widths had no horizontal overflow; this correction changes no rendered UI.

The correction's full CLI suite passed 4020 tests with one skip. Components ran all 5355
assertions successfully, but the full run exited with six react-photo-view timer errors after
jsdom teardown in the unchanged `session-file-card.test.tsx`. That file and the Board suite
then passed together (32 tests) without unhandled errors; the full run is not reported green.
All 19 workspace typechecks
ran: 18 passed and CLI retained exactly the same 11 ACP Core voice/prompt diagnostics.
Lint, i18n, formatting, boundary and docs checks passed. Aggregate `pnpm check` still stopped at
sandboxed adapter-patch preflight; elevated `git apply --check` confirmed the patch applies,
and checks ran separately without changing adapter sources. Real cross-machine propagation
and agent startup after manual membership changes still need a live LAN check. No PR was opened.

## Compatibility with the 0.105.0 LAN baseline

PR1–PR2 now apply to `cbd59168f`. Prompt construction keeps the upstream
post-setup branch probe and passes `branchToRename` and `boardContext` in one
options object. Board catalog refresh remains before session creation; a failed
refresh warns and uses the local replica. UI membership inheritance runs inside
`prepareCreate`, preserving backend selection and first-turn admission. Tests cover
both UI creation paths and Board metadata alongside Roost selection.

The mobile home keeps Schedule search and creation alongside the Board entry.
The removed automatic-review switch, setup dialog and runtime test stay removed;
ordinary reviewer threads still work like any other member. The Overview uses
`LODY_MAX_CHAIN_DEPTH` (16 on this baseline). Board startup guidance follows the
existing batched Operation results and reverse-chat restriction without promising
an idle wake-up. No Board reporting observer or stop-collaboration integration is
added. The design pair is preserved exactly from PR2 for its separate revision.

Migration verification used the official Node 22.22.1 binary: full `pnpm check`
passed, including all workspace typechecks, lint/Effect lint, CI tests, i18n and
boundary guards. Shared passed 1,737 tests, CLI 4,784 (one skipped), components
5,847, and Electron 303. Formatting and docs checks passed. Playwright checked
the real components with synthetic Storybook data at 1440px and 390px: Board
list, Overview rows, notes editing/saving/preview, and mobile Schedule/Board
navigation. There was no horizontal overflow on the Board previews. Screenshots
stay outside the repository; live cross-machine dispatch and notes propagation
remain manual checks.

The exact baseline passed all workspace typechecks and the CLI suite. Its initial
process/script failures came from the system Node lacking compiled TypeScript
support: the 43 process tests and 84 script tests passed with official Node.
The additional component baseline run was stopped after the environment comparison;
the migrated component suite ran to completion. No baseline code was changed.
