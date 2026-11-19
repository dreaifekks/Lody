# Archive snapshots across the Streams upgrade

Status: implemented
Translation: current

[中文](2026-11-19-archived-streams-snapshot-upgrade.zh.md)

## Abstract

Archived LAN sessions need explicit snapshots because their streams may never reach the automatic upload threshold. Updating to `loro-repo 0.25.1` and `streams-crdt 0.21.1` removed the patched snapshot-manager entry used by the fork, although the repository patch still applied. The fork retains a narrow `repair` entry in the pinned transport and calls it through the existing repository adapter. It bypasses size thresholds while preserving the normal snapshot safety checks; it changes no wire format.

## Responsibilities and decision

`StreamsTransportAdapter.uploadDocSnapshot` and `uploadFlockDocSnapshot` resolve the joined room. The transport snapshot manager owns permission checks, serialization, complete server cursors, absence of pending local writes, captured-version checks, and current/open room checks before upload. Archive-triggered repair also refuses an in-flight upload or an unfinished initial join.

Only the byte threshold and foreign-writer threshold are bypassed for explicit archive uploads. Ordinary debounced uploads retain the upstream behavior. The runtime's `uploadSnapshotForTesting` helper is not used: it does not retain the same snapshot-manager admission and capture path.

Both versioned patches must travel together. Regenerating the repository patch alone cannot detect the missing private transport method. The owning behavioral regression is [archived-session-streams.test.ts](../../../../apps/cli/src/lib/archived-session-streams.test.ts), which records actual session and file-index snapshots and checks the hub's retained entries after restart. Tests against synthetic streams establish the pinned package combination; they do not establish compatibility with future private transport APIs.

Current behavior: [what the hub keeps](../../../docs/lan-host.md#what-the-hub-keeps).
