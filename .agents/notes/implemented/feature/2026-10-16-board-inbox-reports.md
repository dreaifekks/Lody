# Board automatic reports through Operation Inbox

Status: implemented
Translation: current

[中文](2026-10-16-board-inbox-reports.zh.md)

## Abstract

Board coordinators need current member outcomes without reverse chat or duplicate
review completions. PR3 records member events as finished Operations and reuses the
upstream Inbox for every wake and batch. A native observer keeps event cursors and
subscriptions, while the existing transaction owns durable acceptance. Grandchild
completion is carried verbatim by its parent; the coordinator decides follow-up work.

## Decisions and evidence

This follows [PR2](2026-10-15-board-tools-notes.md) and the six confirmed
[Inbox revision decisions](../../../../specs/project-coordinator/design.md#decided-inbox-revision).
It replaces the obsolete Delivery-based PR3 approach, without importing its scheduler.

The trigger is a Board catalog, member metadata or history change. The existing
Host-lease coordinator owns the observer, Scope subscriptions and coalesced reconcile;
only dirty member documents are reread. Ordinary Operation reconciliation runs first
so its receipts can suppress duplicate success/failure events, including retained
finished roots. Failed/cancelled roots do not permanently cover unfinished targets.
The observer excludes itself, archived members and pre-join state. Human completions
and grandchild completions advance cursors even when filtered. A waiting-turn identity
makes permission-report deduplication independent of timestamp precision.

One synchronous SQLite transaction commits finished Operations, Inbox indexing and
cursors. Failure rolls them all back; the existing activity backoff retries retained
dirty work. Observer failure cannot prevent an ordinary Inbox wake. Scope cancellation
ends observation; pause and collaboration stop leave results queued under upstream
admission. No transport owner, timer pipeline or Delivery state is added. Existing
Session/Loro Promise adapters remain adapters; this is not a migration of those owners.

Opaque hashed event IDs fit the existing Operation contract and retain expired-ID
protection. Finished rows keep the schema-required deadline field but are never deadline
work. System driving configuration is available in shallow Loro/Roost directory reads;
only selected input/output bodies are materialized. The depth-limit watermark is
observational evidence, not a new scheduling rule. One stable history notice exposes
that limit and does not itself drive an agent.

The UI uses existing compact result rows and live titles. Thread prompts require
verbatim child conclusions and no edits before the coordinator selects them. Rounds,
handoff, digest scheduling and Board-wide stop remain outside PR3.

## Verification and limits

Behavioral suites exercise real Mirror imports and `repo.watch`, explicit reconcile
barriers and injected clocks, transactional rollback/restart/retirement, Inbox
busy/human/pause/stop/depth behavior, receipt coverage, human/grandchild filtering,
join/archive state, coalescing and owned retries. Component tests exercise mixed
batches, navigation, live titles, system driving depth and stopped-state reset.
The exact startup payload sent to ACP includes the reviewer instruction.

With official Node 22.22.1 and native TypeScript stripping, the complete `pnpm check`
passed: CLI 4806 passed / 1 skipped, shared 1741, components 5849 and Electron 303
passed. This includes repository-wide type checking, lint/Effect lint, i18n and all
boundary guards. `pnpm format`, `pnpm format:check` and `pnpm run docs check` passed.
Playwright checked the synthetic InboxReports story at 1440px and 390px: status labels
remain inside the viewport and the narrow layout has no horizontal overflow. Screenshots
are outside the repository. Cross-machine synchronization and real agents still require
LAN validation; synthetic tests do not establish those runtime outcomes.
