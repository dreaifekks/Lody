# Boards

Parent instructions apply. `CLAUDE.md` symlinks here; edit `AGENTS.md` only.
Intent: [Board design](../../../../../specs/project-coordinator/design.md).

- Boards use the workspace Flock catalog and its durability/upload split.
  `SessionMeta.boardId` alone owns membership.
- Independent creates inherit the invoking Board; contained Tabs inherit only
  their parent, including no Board. Renderer `createSession`/`startSession` do too. Never inherit `boardRole` or `boardGeneration` implicitly.
- The catalog writer enforces 50 unarchived Boards on create and restore.
- A Board's conversations live in the Board: the sidebar, mobile home and Archive
  lists drop them with `isBoardSession` at their own sources, never in shared atoms
  (coordinators always; threads while the experiment is on). The palette shows a
  coordinator as its Board and a thread as "Board › thread". Every entry uses
  `boardEntrySearch` (the coordinator's own Tab, `?board=1`); a thread adds
  `boardThread` (`boardMemberEntrySearch`). Clear these before opening the member
  like its row. In-Board entries use the mounted navigation hook.
- New Boards have a name, optional goal and coordinator without a first turn
  (`createSession`). `files.machineId` records its machine. `closeSessionTab` never
  deletes an empty coordinator.
- The panel's thread rows use visible metadata and one derived presence atom; they
  never acquire member documents. Live activity takes priority over waiting markers;
  without presence, only a marker newer than `lastMessageAt` means waiting. Thread
  and Board rows draw the sidebar's `SessionRowStatusIndicator` (✋, working, unread);
  Board rows aggregate all members. Rows have no "done" mark.
  Cards alone add a 14px Check for idle `boardThreadFamilies`, synced presence,
  online machines and a read thread with `lastMessageAt`. Family wait/work, then
  thread-only unread wins; known stop/failure/cancel blocks it. Settled is not success.
  localProject catalogs are acquired at list level, once per machine.
- `BoardSidebar` selects by Session/Tab `boardId`; scalar reads, memoized rows.
- Thread rows reuse sidebar actions (no pin) and `SessionHeaderMenu`. Board glyph:
  headers/page tabs only. Back (`boardEntrySearch`) never on coordinator pages;
  full-page parent links use the palette format and `boardMemberEntrySearch`.
- A thread opened in the panel is a `SessionChatInterface` whose workspace session
  is the thread itself. Never use a `side-session:` tab id: closing it deletes the Session.
- `useBoardSessionNavigation` scopes cards, relations, breadcrumbs, rows and palette:
  only members open in-panel; outside, narrow and expanded targets use pages.
  Page-bound resource links retain the original exact-tab deep-link path.
  Coordinator children use `opensInCoordinatorPage`, never a second surface.
- Thread rows group opened sessions and Tabs by the family's strongest state.
- Board entries reset to half and half with `layoutResetKey` (Board id + entry),
  without remounting or persisting the split.
- The Files tab is the session file tree (`FileTreeProviderView`) over
  `BoardDirectoryFileProvider`, with shared notes above it. Tree opens stay inside
  Files; conversation links use closeable viewer tabs carrying `BoardFilePreview`.
  Current-workspace Board paths use member resources, never the session provider.
- `BoardSidePanel`/`BoardSettings` key state by workspace and Board id. Settings
  open from the conversation header gear, never the panel.
- The Board directory `<data dir>/boards/<ws>/<board>/{files,memory}/` lives on
  `boardFilesMachineId` (row, else the coordinator's machine). Only that machine
  serves it, after checking the asking session is a member in its own replica.
  Paths are relative to one area and never leave it: the area root comes from the
  data dir with every level lstat-checked, no level or leaf may be a link, and leaves
  open with `O_NOFOLLOW`. The caller's own `source`/`saveTo` stay in its session
  working directory, links resolved, as attachments do. Everyone else
  reaches it through its local agent: `board/files-list`, member ranges with
  `boardId`, `lody_board_files_*` over the LAN `files` connection (`lanBoardFiles`).
  A daemon reads the Board row with `readSyncedBoard`: its catalog replica lacks rows
  made elsewhere until it syncs.
  The renderer never reads it directly. Shared notes stay the Loro document.
- Older clients strip `instructions`/`files` and refuse goal-less rows, so every client
  that writes Board rows must run the same version; no compatibility layer.
- Instructions (≤16,000 code points) and the directory join each member's start
  prompt, coordinator included. Threads keep what they read; the coordinator
  rereads the current row after Lody compacts or replaces its agent conversation.
- Coordinator maintenance (`board-continuity-workflow.ts`): quiet system turns in
  the same Session, outside the Inbox (one divider, hidden replies, no push; neither
  they nor their late output move `lastMessageAt`). It yields to user turns and
  results, never fakes compaction (skips agents it cannot confirm) or changes
  `coordinatorSessionId`.
- A Board's entries act on the whole Board, as a chat's do on the chat: the page's
  header menu (`SessionHeaderMenu` on a coordinator) and the sidebar row
  (`BoardSidebar`) rename, archive and restore through `useBoardActions`, which reads
  members when it runs; share opens the coordinator conversation's share editor. A
  coordinator offers no permanent delete or owner change.
- Archiving a Board archives member roots, then the coordinator, then writes
  `archivedAtMs`; restoring restores every root (Session restore covers only direct
  Tabs), then the coordinator, then clears it. The coordinator (whose state the page
  menu follows) and the row change last, so a failure leaves the Board where it was,
  with its entries to retry; no rollback. Rename patches the current row's name.
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
  and cursors commit together. The coordinator only assigns work: reports and its
  own receipts freeze `deliverWithNextInput` and ride with its next human or
  scheduled input; nothing wakes it ([dispatcher model](../../../../../specs/project-coordinator/board-dispatcher-model.zh.md)).
- Reviewer/other grandchild completions return through their parent; blockers still
  report. A thread coordinates its own task: it opens sessions, decides changes and
  quotes reviewer conclusions verbatim. Cancellation never creates a report.
- The Schedules tab reuses `SchedulesWorkspace` scoped by `boardId`; ordinary
  schedules stay in the global list. `?boardSchedule` opens this tab once, like
  `boardThread`. Destination choices exclude the coordinator and other Boards.
  Scheduled completions use per-turn provenance, bypass human/grandchild completion
  filters and freeze passive delivery. Digest scheduling into the coordinator is deferred.
