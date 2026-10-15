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

## Evidence and verification

Behavior tests cover role instructions, daemon routing/member revocation/coordinator-only
replacement/capacity, startup tool visibility, two-replica concurrent appends, metadata removal
and UI edit/preview failure retention. Browser previews use synthetic Storybook data at desktop
and 390px widths, with no horizontal overflow. Full shared (1531) and components (5354) suites
passed. The CLI full suite ran 4018 tests with one skip; the sole HTTP fixture failure was
corrected and its 13-test suite passed on rerun. All workspace typechecks ran; components and
Electron passed after correcting the new Session id type, while CLI retains exactly the known
11 ACP Core voice/prompt errors. Lint, i18n, format, boundary and docs checks passed. Aggregate
`pnpm check` stopped at sandboxed adapter-patch preflight; elevated `git apply --check` confirmed
the patch applies, and the checks above ran separately without changing adapter sources.
Real cross-machine propagation and
agent startup after manual membership changes still need a live LAN check. No PR was opened.
