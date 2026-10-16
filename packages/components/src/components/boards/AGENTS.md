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
  without presence, only a marker newer than `lastMessageAt` means waiting.
  localProject catalogs are acquired at list level, once per machine.
- A thread opened in the panel is a `SessionChatInterface` whose workspace session
  is the thread itself. Never give it a `side-session:` tab id: closing those
  deletes the Session. Narrow windows open the thread's own page instead.
- One conversation surface per Session: a direct child of the coordinator (Tab or
  Side Chat) is already mounted by the page, so the panel selects it there
  (`opensInCoordinatorPage`, for rows and `boardThread` alike).
- Thread rows keep a thread's opened sessions and Tabs under it, grouped by the
  family's strongest state.
- A Board page remembers no split: it opens half and half on every entry.
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
  prompt, coordinator included; sessions already started keep what they read.
- Archiving a Board archives the coordinator and member roots, then writes
  `archivedAtMs`; restoring restores every root (Session restore covers only direct
  Tabs), then clears it. The row changes last, so a failure leaves the Board where it
  was, with its entry to retry; no rollback.
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
