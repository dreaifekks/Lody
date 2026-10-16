# Boards

Parent instructions apply. `CLAUDE.md` symlinks here; edit `AGENTS.md` only.
Intent: [Board design](../../../../../specs/project-coordinator/design.md).

- Board rows share the workspace Flock catalog and its durability/upload split.
  Membership is `SessionMeta.boardId`, never a second member list.
- CLI/MCP independent creates inherit the invoking session's board; contained Tabs
  inherit only their parent, including when that parent has no Board. The renderer's `createSession` and `startSession` must do
  this too. Never inherit `boardRole` or `boardGeneration` implicitly.
- The 50-Board limit counts only unarchived rows and is checked in the catalog
  writer, on create and on restore.
- A coordinator is its Board: the sidebar, mobile home and Archive lists drop
  `boardRole === 'coordinator'` at their own sources, never in shared atoms. A Board
  opens as the coordinator's Session page with the `board` side panel;
  `/boards/<id>` redirects there with `?board=1`, applied once and then removed.
- The panel's thread rows use visible metadata and one derived presence atom; they
  never acquire member documents. Live activity takes priority over waiting markers;
  without presence, only a marker newer than `lastMessageAt` means waiting.
  localProject catalogs are acquired at list level, once per machine.
- A thread opened in the panel is a `SessionChatInterface` whose workspace session
  is the thread itself. Never give it a `side-session:` tab id: closing those
  deletes the Session. Narrow windows open the thread's own page instead.
- Archiving a Board archives the coordinator and member roots, then writes
  `archivedAtMs`; restoring restores every root, since Session restore covers
  only direct Tabs.
- The experiment gates the sidebar section, the Board panel and archived Boards.
  Turning it off retains data and does not stop ordinary sessions or their
  membership inheritance.
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
