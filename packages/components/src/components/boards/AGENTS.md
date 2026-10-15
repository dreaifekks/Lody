# Boards

Parent instructions apply. `CLAUDE.md` symlinks here; edit `AGENTS.md` only.
Intent: [Board design](../../../../../specs/project-coordinator/design.md).

- Board rows share the workspace Flock catalog and its durability/upload split.
  Membership is `SessionMeta.boardId`, never a second member list.
- CLI/MCP independent creates inherit the invoking session's board; contained Tabs
  inherit only their parent, including when that parent has no Board. The renderer's `createSession` and `startSession` must do
  this too. Never inherit `boardRole` or `boardGeneration` implicitly.
- The 50-Board creation limit counts only unarchived rows and is checked once
  in the catalog writer.
- Overview acquires machine localProject catalogs at list level, once per machine.
  Live activity takes priority over waiting markers; without presence, only a
  marker newer than `lastMessageAt` means waiting for the user.
- Overview uses visible session metadata and live presence. Only expanded rows
  acquire session documents; the coordinator starts expanded. History reads use
  ConversationView, never a materialized full-history mirror.
- The experiment gates navigation and the page. Turning it off retains data and
  does not stop ordinary sessions or their membership inheritance.
- Manual membership changes affect only the selected Session, clear its generation,
  and never detach the fixed coordinator. Tab inheritance happens at creation.
- Board tools are advertised at ACP startup, but the daemon authorizes against
  current metadata on every call. A header is never membership authority.
- Catalog/notes refresh is best effort: warn on sync failure and use the local replica.
  Recheck local membership before notes writes; never use sparse metadata ids as caller identity.
- Notes use one LoroText in `board-<id>` on `<workspace>:bd:<id>`. Each local write
  checks UTF-8 capacity before mutation; replicas may exceed it after merging
  concurrent writes. Never truncate a merge; allow a reducing replacement.
- Only the coordinator (both role and catalog id) or the user may replace notes.
  Durable local writes do not fail because upload failed.
- Manual joins stamp `boardJoinedAtMs`; old states never become new reports.
- The coordinator host observes current member documents. Reports, Inbox indexing
  and cursors commit together; only the existing Inbox may batch or wake.
- Reviewer/other grandchild completions return through their parent; blockers still
  report. Thread prompts require verbatim child conclusions and coordinator decisions
  before changes. Cancellation never creates a Board wake.
- Startup prompts describe implemented reports. Round enforcement, handoff and digest
  scheduling remain later steps.
