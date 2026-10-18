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
- A Board's conversations live in the Board: the sidebar, mobile home and Archive
  lists drop them with `isBoardSession` at their own sources, never in shared atoms
  (coordinators always; threads while the experiment is on). The palette shows a
  coordinator as its Board and a thread as "Board › thread". Every entry uses
  `boardEntrySearch` (the coordinator's own Tab, `?board=1`); a thread adds
  `boardThread` (`boardMemberEntrySearch`). Both apply once and leave the URL; the page
  clears it first, then hands `boardThread` to the panel, which opens it like its row.
- A new Board has a name and a coordinator created without a first turn
  (`createSession`); the goal is optional and the user speaks first. Its row records
  `files.machineId`, the coordinator's machine. Closing the coordinator's Tab never
  deletes it as an empty session (`closeSessionTab`).
- The panel's thread rows use visible metadata and one derived presence atom; they
  never acquire member documents. Live activity takes priority over waiting markers;
  without presence, only a marker newer than `lastMessageAt` means waiting. Thread
  and Board rows draw the sidebar's `SessionRowStatusIndicator` (✋, working, unread);
  a Board row aggregates every member, coordinator included. No extra "done" state.
  localProject catalogs are acquired at list level, once per machine.
- Sidebar selection follows the route/selected Tab's `boardId` (or coordinator id);
  membership subscriptions stay in `BoardSidebar`; memo rows receive stable handlers.
- Thread rows reuse `UpdatedItemRow` and `useSessionActions`; archive keeps the
  shared recursive selector. Row actions never change Board membership.
- Thread panel headers use `SessionHeaderMenu` and the ordinary composer. Back is
  first in that header and the full page's `SessionTabBar`; the latter uses
  `boardEntrySearch` to reopen the coordinator's thread list, clearing old selection.
- A thread opened in the panel is a `SessionChatInterface` whose workspace session
  is the thread itself. Never give it a `side-session:` tab id: closing those
  deletes the Session. Narrow windows open the thread's own page instead.
- One conversation surface per Session: a direct child of the coordinator (Tab or
  Side Chat) is already mounted by the page, so the panel selects it there
  (`opensInCoordinatorPage`, for rows and `boardThread` alike).
- Thread rows keep a thread's opened sessions and Tabs under it, grouped by the
  family's strongest state.
- A Board page remembers no split: it opens half and half on every entry, and
  `layoutResetKey` (Board id + entry) resets it without remounting the page.
- The Files tab is the session file tree (`FileTreeProviderView`) over
  `BoardDirectoryFileProvider`, with the shared notes one row above it; files open in
  the Board preview, never a session viewer tab.
- Panel and settings state belong to one Board: `BoardSidePanel` and `BoardSettings`
  key themselves by workspace and Board id. Settings open from the conversation
  header's gear, never from the panel.
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
- Startup prompts describe implemented reports. Round enforcement, handoff and digest
  scheduling remain later steps.
