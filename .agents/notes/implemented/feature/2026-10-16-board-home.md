# Board home: a Board opens as its coordinator conversation

Status: implemented
Translation: current

[中文](2026-10-16-board-home.zh.md)

## Abstract

The first Board UI was a separate management page, which users did not treat as a
place to work. A Board now opens the way a chat does: the sidebar lists Boards
beside chats, and opening one shows the coordinator conversation with a Board side
panel for threads and files; rarely used settings live in a dialog. The panel
reuses the session side-panel machinery and opens a thread inside it without making
it a Side Chat. Thread rows use metadata and presence only, so a failed thread is
visible once opened and in the coordinator's report, not in the list.

## Decision and evidence

The [design](../../../../specs/project-coordinator/design.md) section "Board home"
records the user's decisions of 2026-10-16. This note covers steps 1 and 2.

- **Coordinator as the Board.** The coordinator's Session page gains a `board`
  side-panel kind. A separate Board page would have needed its own conversation,
  composer, panel layout and mobile drawer; the Session page already has all four.
  `/boards/<id>` remains as an alias that redirects with `?board=1`. The render-phase
  restore follows `?pr`: one state guard per Session, and the parameter leaves the
  URL afterwards, so opening the Board again from the sidebar reapplies it.
- **No Side Chat ids for threads.** Side Chat's close path terminates and deletes
  the Session, and its render path accepts only side-panel children of the page.
  The Board panel therefore renders `SessionChatInterface` directly, passes the
  thread as its own workspace session (otherwise the coordinator's repository, PR
  and diff state would show) and omits the page's file and diff handlers, which are
  scoped to the coordinator. The open thread is page state, because the compact
  layout remounts the panel subtree.
- **Filtering at each list's source.** `sessionListAtom` and
  `useVisibleSessionMetas` also feed the command palette, completion notifier, PR
  watcher, mentions and dock counts, which must keep seeing the coordinator. The
  sidebar, the mobile home list and the Archive page filter it themselves. Sessions
  opened by a hidden coordinator fall back to top-level rows through the existing
  opened-by tree.
- **Sidebar mark without a subscription.** `LoroAppSidebar` already builds an
  identity-stable live-status map; `boardActivity` reads it with the same waiting
  rule as `deriveBoardSessionStatus`.
- **Rows without documents.** PR1 opened a member document for expanded rows. The
  panel has no expansion, and opening every member's document to find failures
  would break the lazy document boundary. Status comes from one derived atom over
  `sessionLiveStatusAtomFamily` plus metadata.
- **Archive and restore.** Session archive already includes Sessions the
  coordinator opened; restore covers only direct Tabs. Archive walks the coordinator
  and every member root, then marks the row; restore re-checks the 50-Board limit in
  the catalog writer, as creation does, restores each root, and clears the mark last.
  The first version cleared the mark first, so a failing member left a Board outside
  the Archive page with nothing to restore it from. With the row changed last in both
  directions, a failure stops with the Board where it was and its entry (Archive
  page or settings) offers the retry; the toast names the reason. No transaction or
  rollback: a retry skips what already succeeded. Two concurrent restores may both
  read 49 active Boards; the limit was never a distributed transaction, as accepted
  in the design.
- **One surface per Session.** Contained Tabs inherit the Board, so the coordinator's
  own Tabs and Side Chats are threads too, and the page already mounts them. Opening
  one in the panel made a second `SessionChatInterface` with its own composer draft.
  A direct child of the coordinator now opens where the page has it: a Tab is
  selected in the main area, a Side Chat in its side-panel tab. Chat commands (focus
  input, find) follow the region the user is in, so a thread open in the visible
  Board panel takes them while the panel has focus.
- **Panel identity.** The Session page is not remounted between Sessions, so a panel
  opened on one Board kept its tab and settings draft on the next, and saving wrote
  Board A's draft into Board B and renamed B's coordinator. `BoardSidePanel` keys its
  content by workspace and Board id; the settings dialog is keyed by Board id too.
- **Entries.** Every Board entry (sidebar, `/boards/<id>`, command palette) writes
  the coordinator's own Tab explicitly with `boardEntrySearch`; an absent `?tab` let
  the route restore the last child Tab, such as a reviewer. The palette keeps
  coordinators in its shared source and shows them by Board name and glyph.
- **Names.** On a Board page the session panel's Files becomes Workspace files and
  the Board panel's tab Board files; the side-panel framework is unchanged.
- **Settings scope.** The dialog edits only fields that act today: name, goal and
  rules. Project scope, Board memory and the digest stay hidden until their steps.
  The coordinator's model stays in its composer. A rename also renames the
  coordinator Session, so its tab and window title follow.

## Verification and limits

- Tests: `packages/components/tests/board-overview.test.tsx` mounts the real side
  panel over metadata and presence atoms, checks grouping, coordinator exclusion,
  stopped-ancestor inheritance, presence over stale status, opening a thread and the
  notes editor; it also covers the sidebar mark and the create dialog's default name
  and rules. Settings, archive and restore run the real Session actions over Session
  metadata in a `LoroRepo`: the settings write and coordinator rename, a Board switch
  under an open settings draft, and archive/restore with a refusing member (the
  Board stays where it was; the retry completes). A coordinator page stand-in counts
  conversation surfaces per Session while the real panel opens a coordinator Tab, a
  Side Chat and an independent thread. `SessionChatInterface` itself cannot be
  mounted in jsdom without the full runtime, so both sides render one marker per
  surface. Each of the three new cases fails with its fix reverted.
  `workspace-catalog-write.test.ts` covers the restore limit and a member failure;
  `session-draft-tabs.test.ts` the persisted `board` panel.
- Storybook `Workspace/Boards` renders the real sidebar, Session layout, tab bars,
  panel, settings and create dialogs with synthetic data; checked at 1440 and 390 px.
- Not verified: the full desktop app (no display on the build machine), phone drawer
  gestures and LAN behavior. The shared directory is a placeholder until step 4.

## Second round (2026-10-16)

After using `dev-v0.105.0-lan.3`, the user moved the Board further toward Claude
Projects. The [design](../../../../specs/project-coordinator/design.md) records the
decisions (9–14) and the implementation ("Board home, second round implemented").

- **Board conversations only in the Board.** This overturns "threads stay in their
  project group". `isBoardSession` filters at each outside list's source; with the
  experiment off threads return as ordinary sessions, so turning it off loses nothing.
- **No first message.** A coordinator is created with `createSession`. Its first user
  message takes the `session/create` dispatch path (no ACP session yet), so
  `buildPrompt` still appends the Board section. The chosen run config is seeded as an
  in-memory run-config draft; a Role comes from the session's Role provenance, which
  the composer already reads for a conversation without turns.
- **Directory through the local agent.** The desktop cannot hold the LAN credential,
  and agents may run on any member, so every reader goes through its own daemon: the
  same `files` connection that carries a message's files gains `board-list` and
  `board-put`, and reads reuse `range` with a `boardId`, which also gives the desktop
  previews through the existing member resource. The host authorizes against its own
  replica; a stale or forged membership on the asking machine is refused there.
- **Memory as files, not Loro.** Agents already read and write files well; a memory
  file per topic plus an index matches how they keep memory elsewhere, and the user
  sees exactly what they wrote. The LoroText memory and `lody_board_memory_update`
  were dropped. Shared notes stay a Loro document (concurrent appends merge) and are a
  row of the Files tab, so nothing migrates.
- **Coordinator positioning.** Its instructions say it only coordinates and keeps the
  whole picture; `lody_board_overview` plus `lody_session_history` already give thread
  progress and conclusions, so no new tool was added.
- **Families in the thread list.** Grouping row by row split a reviewer from its
  thread when their states differed; a family now moves as one, under its strongest
  state.

Evidence: `apps/cli/src/lib/lan/lan-files.test.ts` puts, lists and reads Board files
between two real TLS endpoints and refuses a non-member (by the host's replica) and
paths outside the directory, also through a link. CLI tests cover the instructions,
directory and coordinator text in first prompts and the tool advertisement.
`board-overview.test.tsx` covers the Files tab and preview over the desktop IPC, the
Memory page (instructions saved, `MEMORY.md` first), name-only creation without a
first turn, settings rebuilt on a Board switch, families and the outside-list rule.
Not verified: the real desktop app, a real multi-machine LAN, and the coordinator's
first turn end to end.

## Second-round review corrections (2026-10-16)

After the Codex review, six fixes were made against one bar: agents must not use the
Board tools to step past their own sandbox or workspace limits, and mistakes must not
escape. Every machine of a LAN belongs to one user, so the same user reaching files
across machines is not new. The implementation is recorded in the
[design](../../../../specs/project-coordinator/design.md), "Board home, second-round
review corrections".

- **Local paths reuse the attachment workspace rule.** The daemon checks `source` /
  `saveTo` against the session working directory it holds
  (`resolveSessionWorkspaceRoot`; for a chat session, its actual directory) after
  resolving links, and hands the source on by its real path, so a link pointing out
  reads nothing. Without a known working directory the call fails; it never falls back
  to the daemon's cwd.
- **The root comes from the data directory, level by level with lstat.** The old code
  trusted the realpath of `files/`, which escapes once the whole area is replaced by a
  link. Leaves open with `O_NOFOLLOW`: local reads in `BoardDirectory.read`, LAN reads
  only for `range` requests with a `boardId`, leaving session files and preview paths
  as they open today. A parent replaced after the check stays a known limit in the
  Spec; no directory handles.
- **A coordinator never takes the empty-session delete.** The decision moved to
  `closeSessionTab` (`session-tab-close-target.ts`), which the page's close callback
  and the test both call.
- **`boardThread` goes to the panel.** The panel's `openMember` serves both thread rows
  and the URL request; the panel holds full session metadata, which is surer than the
  page guessing from its child lists. The page clears the URL before handing over: the
  other order lets the panel navigate to a thread's page on narrow windows and the
  page's clearing navigation pull it back to the coordinator. The palette's search
  became `boardMemberEntrySearch`, which the test follows into the panel.
- **Binary downloads reuse `saveMemberFile`.** The Electron member-file schema already
  accepts `boardId`; nothing changed there.
- **Settings navigation focus is a ring, in the Board dialog only.** The global
  settings window's shared `settingsSurface.listRow` also washes hover 6%, focus 6% and
  selected 10%, so keyboard navigation there can look like two selected rows as well;
  it is left for the global settings to decide.

**Mixed-version clients: no compatibility, a uniform upgrade.** An older client's
`normalizeBoardMeta` parses with a zod object, strips `instructions` and `files`, and
refuses a Board without a goal; one write of the row from it (saving settings, a rename
included; archiving; restoring) drops both fields. A compatibility layer would have to
live in the old version, which cannot happen; Boards are still behind the experiment,
so every client that can write Boards is required to upgrade together, with the
consequences written in the Spec.

Evidence: `apps/cli/src/mcp/board-tools.test.ts` uses a real `BoardDirectory` and
`LanFileHandoff` on the real file system, covering reads and writes inside the working
directory, sources outside it (directly, through a leaf link, through a directory link)
and destinations outside it (directly, through a directory link). `lan-files.test.ts`
adds refusals when an area root or the Board directory itself is a link, and when a
leaf is a link, both on the keeper and from another member. `board-overview.test.tsx`:
a coordinator created by the real dialog survives `closeSessionTab` with its Board row
unchanged while an ordinary empty Tab is still deleted (the test fails without the
check); palette parameters handed to the panel open a coordinator Tab, a Side Chat and
an independent thread with one surface each; a binary file in the Files tab downloads
through `saveMemberFile`. Screenshots: Storybook + Playwright at 1440px and 390px, the
download entry and the settings navigation open, keyboard-focused and hovered. Not
verified: the save dialog in the real desktop, and the `boardThread` handover on a
compact desktop (same code path as phones; the panel must be mounted).

## lan.4 field corrections (2026-10-17)

Used on `dev-v0.105.0-lan.4` (every daemon of the five machines on that build), only the
settings dialog worked. The implementation is recorded in the
[design](../../../../specs/project-coordinator/design.md), "Board lan.4 field corrections".

- **`BOARD_NOT_FOUND` is a member's unsynced catalog replica.** Field evidence: the
  desktop's `board/files-list` (Board `bd_ce75…`, coordinator on devNuc) sent straight to
  each machine's own daemon control socket. devNuc (the host) and homeN100 answered an
  empty list; mba answered `BOARD_NOT_FOUND:this machine knows no such Board`, which comes
  from the asking machine's own `LanFileHandoff.boardOf` reading the row, before anything
  reaches the host. After `lody-lan mcp list` on mba, which makes its daemon sync the
  workspace catalog, the same request answered the list at once. In code, every other
  catalog reader (Board tools, member start prompts, Role/MCP reads) calls
  `syncFlockDocOrThrow` first; only `readBoard` in `lody-fleet.ts` read the local replica.
  The fix extracts `readSyncedBoard` (`board-directory.ts`): sync first, warn and use the
  local rows on failure.
- **The split missed 50/50 because an old width carried in.** mba's desktop localStorage
  held `board-detail-panels` as `[61.8, 38.2]` and `[100, 0]`. `DesktopSessionDetailLayout`
  kept the chat's panel width in `lastSidebarSizeRef` across the layout key change,
  resized to it when the panel opened, and `autoSaveId` stored it under the Board key.
  A Board page now remembers no split (`layoutStorageId={null}`) and the reopen width is
  per layout, so the values already stored on users' machines are no longer read.
- **The Board files tab is the session file tree.** `BoardDirectoryFileProvider` builds
  on `LazyDirectoryFileProvider`; the root holds every file and the tree builds folders
  from paths. `openFile` answers unavailable on purpose: the Board preview opens files
  (and owns downloads). Session viewer tabs were not used: they resolve files by session
  path, and another source would mean changing the viewer. The shared notes stay above
  the tree rather than becoming `notes.md`, which needs no migration and keeps merging.
  The settings Memory page keeps its flat list (`MEMORY.md` first).

Evidence: in the new `lan-files.test.ts` case the member's catalog is a real `LoroRepo`
that gets the Board row only through a sync; with the sync failing it answers
`BOARD_NOT_FOUND`, and after it, list, put and read all succeed between two real TLS
endpoints. `desktop-session-detail-layout.test.tsx` covers a chat dragged to 38% followed
by a Board page whose panel opens at 50 and stores no split (`resize(38.2)` before the
fix). The `board-overview.test.tsx` Files case now goes through the tree: expand a
folder, preview, the folder still open on return, binary download. Screenshots:
`/tmp/board-lan4fix-files-*.png`. Not verified: the fix is not deployed, so fixed
reads and writes on the real LAN wait for the next dev build; mba's replica is current
since the investigation's sync, so the failure reproduces only on members that have not
synced; the Windows reproduction was not completed because of shell quoting.

### Review follow-up to the lan.4 corrections (2026-10-17)

The Codex reviewer (gpt-6.1-sol high) raised one P1 and two P2s, all fixed:

- **P1: Boards share one unremembered layout.** Without a page remount, Board A dragged
  to 60/40 left Board B at 60/40. `DesktopSessionDetailLayout` gains `layoutResetKey`,
  separate from the storage id: a new key forgets this layout's reopen width and, with
  the panel open, resizes it back to the default without remounting the page. A Board
  page passes the Board id plus its entry count, bumped whenever `?board=1` applies.
  Leaving a Board turns the key back to undefined, which resets nothing.
- **P2: one ref held the reopen width.** A chat's 38% was overwritten by the Board's.
  Reopen widths are now a Map keyed by layout.
- **P2: the truncation flag was lost.** `useBoardDirectoryFileProvider` carries the
  listing's `truncated`, and `BoardDirectoryTreeView` (the Files tab view, which the
  story renders too) says only the first 500 files are listed, above the tree.

Evidence: the two switch cases in `desktop-session-detail-layout.test.tsx` (A→B and
re-entry; chat→Board→chat) both fail without the fix; the `board-overview.test.tsx`
Files case asserts the truncation line. Screenshots:
`/tmp/board-lan4fix-r3-split-5050.png`, `-split-board-a-dragged.png` (60/40),
`-split-board-b.png` (measured 50.0/50.0 after switching to B), `-truncated.png`.

## Board entry actions (2026-10-17)

The user reported that a Board offered "nothing to act on" and asked for its top right to
match a chat's, at least archive and share. The decision is the
[design](../../../../specs/project-coordinator/design.md)'s decision 15; "Board entry
actions" there lists how each action is handled.

- **What was there.** The desktop Board page's header already was the chat header (the
  `SessionChatInterface` toolbar) with its "…" menu and share control, but rename and
  archive acted on the coordinator session only: archiving left the Board row and its
  members open, and the sidebar kept a Board that no longer opened. At 1440 px with the
  50/50 split, the share control folds into the "…" menu because the container is under
  800 px, as for any chat. The sidebar Board row was a plain button with no menu, and the
  Boards story drew only the settings button in the header, so its screenshots showed
  none of this either.
- **Header: the chat menu, named for the Board.** `SessionHeaderMenu` already hid "Join /
  leave Board" by `boardRole`; it now also names rename, archive and restore as Board
  actions on a coordinator and hides Change owner. The page supplies the actions
  (`session-detail.tsx` swaps in the Board's while `activeBoard` is set) and passes no
  permanent delete. No second Board menu was written, and no prop was threaded through
  `SessionChatInterface`.
- **One entry path: `useBoardActions`.** The failure toasts for archive, restore and
  rename were spread over settings and the Archive page; the header, the sidebar, settings
  and Archive now all use this hook. It reads members from `allActiveSessionsAtom` /
  `archivedSessionListAtom` when an action runs, so the session page and the sidebar do
  not subscribe to every session for it (the rule against page-level subscriptions to
  high-frequency atoms). Settings and Archive used lists filtered by machine/project
  visibility before; the atoms are the visible cache already, so the only difference is
  that filter, which changes nothing on a single user's LAN. `useBoardLifecycle` keeps its
  interface.
- **Rename reuses the chat dialog.** `RenameSessionDialogView` takes an optional title and
  description; `BoardRenameDialog` writes the Board row and the coordinator's title, as
  saving settings does.
- **The sidebar row reuses a chat row's parts.** `SessionRowLeadingSlot` gains `restIcon`,
  so the Board glyph gives way to ⋯ on hover; the end is `SidebarRowEndSlot` with
  `SidebarRowArchiveButton`; right click is a `ContextMenu`. The row's outer element is a
  `div` with `role="button"` instead of a `<button>`, since it now holds buttons. The
  wiring lives in the Board's own `BoardSidebar` container (with the rename and share
  dialogs); `loro-app-sidebar.tsx` passes only copy-link and the navigation after
  archive, so a test renders the real container.

Evidence: two new `board-overview.test.tsx` cases over real metadata (`LoroRepo`) and an
in-memory catalog. The header menu has no Change owner or Rename Chat; Rename Board
writes the row and the coordinator's title; Archive Board archives the coordinator and
member roots and writes `archivedAtMs`. The sidebar row menu's Copy Board URL hands over
the coordinator, Share opens the share editor on the coordinator's conversation, and
rename and archive work as above, with the navigation callback. The Storybook
`Workspace/Boards › Home` header is now the real `SessionHeaderMenu` and share control,
and its sidebar rows carry the menu; 1440 px screenshots are in
`/tmp/board-header-actions/shots/`. Not verified: these menus in the real desktop app
and on phones.

### Review follow-up to the Board entry actions (2026-10-17)

The Codex reviewer (gpt-6.1-sol high) raised two P1s and one P2, all fixed:

- **P1: rename wrote back the row as it was when the dialog opened.** Instructions or
  rules saved, or an archive done, by another window or machine while the dialog was
  open were overwritten, and `archivedAtMs` could be cleared, leaving archived members
  under an active Board. `renameWorkspaceBoard` now reads the current row and changes
  only its name.
- **P1: after a partial failure the page menu offered the opposite action.** The menu
  shows Archive or Restore by the coordinator's `isArchived`, and the coordinator used to
  go first: when a member failed, the coordinator was already archived and the menu
  offered Restore Board, losing the retry; a failed restore did the reverse. Rather than
  pass the Board's state to the menu, the coordinator now comes after the members both
  ways, so a member failure leaves it untouched and the menu keeps the same action. The
  remaining gap is the coordinator succeeding and the row write failing: the menu then
  offers Restore Board, which brings every session and the row back to a consistent
  active state, after which archive can run again.
- **P2: the sidebar row swallowed Enter from the buttons inside it.** The row's
  `onKeyDown` took Enter/Space bubbling up from ⋯ and Archive, prevented their default
  and opened the Board. Like a chat row, it now handles only its own keys.

Evidence: the `board-overview.test.tsx` header case saves instructions while the rename
dialog is open and they survive the rename; the sidebar case presses Enter on ⋯
(nothing opens) and on the row (the Board opens); the lifecycle case asserts that a
member failure leaves the coordinator active and a failed restore leaves it archived.
With the rename and key fixes temporarily reverted, both new assertions fail.

## Settings: instructions on General, one nav focus (2026-10-17)

- **Instructions moved to General.** The instructions every member reads sat on the
  Memory page while the executor instructions sat on General, so the two texts that
  shape a member's first message were a page apart. They now form one Rules group on
  General, instructions first; Memory holds the automatic memory only. The draft, its
  limit and Save are unchanged.
- **The global settings nav takes the Board nav's focus.** Its rows washed keyboard
  focus like hover, which read as a second selection. The Board nav's answer (an inset
  accent ring, never a fill; a focused current row keeps its fill and adds the ring)
  moved into `settingsSurface.navRow`, and both navs, the account entry and Report a
  bug use it.

Evidence: Storybook screenshots of both navs (selected, focused, both, dark) and of the
General and Memory pages, taken on devNuc.

## Thread controls (2026-10-18)

Threads previously hid the conversation header and their list had no lifecycle
controls. The panel now renders the real `SessionHeaderMenu` in the shared page
header, with thread title, Stop, Archive/Restore, rename, search and copy actions.
The ordinary composer was already present: no panel-specific prop suppressed
model, mode or permission, and existing-session agent restrictions remain intact.
Fork and permanent delete remain on the full conversation page because their
page-owned state targets that page's root; the panel does not redirect these
operations onto the coordinator. Header share/IDE controls retain the same narrow
container behavior.

The thread list directly uses the sidebar's memoized `UpdatedItemRow` rather than
copying its menu: rename, unread, copy link/branch, opener navigation, new
window, and archive. It adds Restore for archived rows. Pin is omitted in the Board list because outside lists filter members. Archive uses `useSessionActions.archiveSession`
and its recursive selector (contained Tabs and opened conversations); Restore
keeps the ordinary direct-Tab scope. The list still reads metadata and one derived
presence atom, without acquiring thread documents.

Back is the first control in both the thread panel header and the full page's
`SessionTabBar`. The latter enters the coordinator through `boardEntrySearch`,
which resets the selected panel thread and exits Zen. Split resizing introduces
no other maximize state. `LayoutDashboard` marks only panel conversation headers and full-page tabs while
the experiment is on; coordinators are excluded. Sidebar and thread-list rows
have no Board glyph or per-row membership subscription.

Behavior tests cover menu rename and pin omission, recursive archive/direct-Tab restore,
keyboard event ownership, return entry and membership marks. Stories
`ThreadRowActions`, `ThreadControls` and `ThreadFullPage` use real UI leaves with
synthetic state, including the ordinary run-config and permission menus; full-page
story navigation is a fixture callback, not the router. Real Electron/daemon
end-to-end operation is not established by these tests.

The Board sidebar selection now follows the route or active Tab's `boardId`,
including independently opened descendants and archived threads. Previously only
the coordinator route matched, so opening inside the panel retained selection
but opening the full thread lost it. `BoardSidebar` owns scalar-only membership
subscriptions and a pure resolver; its rows are memoized with stable handlers.
It keeps the existing `selectedFill`: with the experiment on, all outside thread
lists are filtered; with it off, the Board section is absent. Ordinary session
selection is unchanged. `ViewingThread` shows the selected Board beside the
thread's real tab bar. The full-page Back button now follows the experiment gate;
the membership mark also follows the same experiment gate.

## Child-thread hierarchy (2026-10-18)

Child conversations now show `parent › child` in the Board list and panel header.
The parent name is secondary, clickable and bounded; both names stay on one line
and truncate. The full page places the parent link and separator after Back,
before the actual child tab, avoiding a duplicate child title. The palette's
existing `Board › thread` format was extracted into `formatBoardSessionTitle`;
all three surfaces use the same separator/format instead of inventing a new one.

`resolveBoardThreadParent` uses `parentSessionId` before `openedBySessionId` and
accepts only a parent thread in the same Board. The coordinator, missing metadata
and another Board are not parent breadcrumbs. List/panel clicks use the existing
row entry; full pages use `boardMemberEntrySearch`. Clicking a parent inside a row
stops propagation so the child does not open immediately afterward. The page's
connected breadcrumb selects only parent identity/title/membership; rows use their
existing metadata lookup. No member document or second membership list is acquired.

`ChildThreadOpen`, `ChildThreadRows` and `ChildThreadFullPage` render these real
components with synthetic data. Behavioral tests cover both relation types,
coordinator/cross-Board exclusion, row/header parent navigation, event ownership,
and the full-page Board-member entry. Visual and real-app acceptance are delegated
to the user; implementation work does not claim those have passed.

## Thread-controls review corrections (2026-10-18)

Archive/Restore failures now show the same error toast as sidebar session actions,
including a removed local project's restoration refusal. Row Open retains one
callback and reads the latest visible metadata at invocation. The page navigation
rules live in `resolveBoardThreadPageNavigation`: coordinator pages expose no Board
return control; a thread's own contained Tab exposes no duplicate parent breadcrumb.
The two tests that recreated page wiring were removed in favor of production-function
cases for ordinary threads, experiment off, coordinator Tabs, own Tabs and independent
opened children. Real row-action tests assert the error toast and unchanged archive
state. Board glyphs are restricted to conversation headers/page tabs; the redundant
sidebar/list subscription was deleted. Targeted verification precedes the user-owned
visual review; the combined full check is deferred until its feedback is incorporated.

## Shared thread-row archive confirmation (2026-10-18)

The user clarified that direct row archive means operating without entering the
thread, not bypassing confirmation. The one-click exception from `5e4823ee1` is
withdrawn: thread rows reuse the same two-click archive button as ordinary sidebar
rows, with no Board-specific option. Hover archive/more, context menus and header
controls remain available. Behavioral tests verify that the first click leaves
the thread unarchived and unselected, and the confirmation archives it without
opening it; ordinary Board rows retain the same confirmation flow.

## Narrow child-row titles and focus (2026-10-18)

The 900px visual review found that the outer title treated a child breadcrumb as
one inline unit and could replace all of it with an ellipsis. The composed-title
slot now lays out its breadcrumb with flex; each part truncates independently.
The secondary parent is capped at 30%/7em, leaving the child the remaining width.
The shared Button gains an explicit inset focus option that retains its variant's
surface shadow; other callers keep the existing outset behavior. Parent links use
that option and inner text padding so their ring stays inside their own box.

`ChildThreadRowsNarrow` preserves the 900px preview viewport without styling product
components in the story. On the updated code, headless Chrome measured 275.5px
child rows, 62.25px parent links and 132.58px child text in both themes; rows remained
47.14px high and single-line. Light/dark screenshots show readable child titles and
complete 2px inset rings. Keyboard Enter still opens the parent; the narrow panel
header was also checked. These are synthetic Storybook checks, not daemon E2E.
The hover archive and row menus remain available with shared archive confirmation.

The final combined `pnpm check` passed after incorporating the visual corrections.

## Thread controls: second UI pass (2026-10-18)

The Board glyph is a flex sibling of the tab status/agent slot, not inline title text.
The panel header already has a centered flex row. Lists and sidebar rows remain glyph-free.
Only coordinator conversation cards retain a quiet 14px Check. A succeeded create
Operation supplies its exact user-turn id, which must match both `latestUserMsgId` and
`lastHandledUserMsgId`. No processing turn may remain; presence must be synced, the machine
online, and the derived status idle/read. Failed/cancelled results, stopped sessions and
unknown presence show no Check. Metadata alone proves no success. Later turns without a
matching successful creation result deliberately omit the mark; no member documents or
new synchronized outcome fields are introduced. Waiting, activity and unread still use
`SessionRowStatusIndicator`; rows have no done state.

`useBoardSessionNavigation` gives cards, relationship menus, resource links, parent
breadcrumbs, rows (including Go to Opener) and the in-Board command palette one policy.
Side mode opens only same-Board members in the panel; coordinator children select their
existing Tab/Side Chat. Other Boards and ordinary sessions retain page navigation, including
the command palette's Board entry searches. Narrow windows and expanded thread pages retain page routing. The maximize
button explicitly opens the page. No thread is assigned a `side-session:` tab identity.
Resource links inspect `destination(target)` and only use the Board opener for panel or
coordinator destinations. Page destinations retain `openSessionDeepLink`: its explicit
`session:<id>` search must win over a previously selected child tab, and its pending
request retains metadata hydration and timeout handling. Other entry points are unchanged.
The regression test mounts the real deep-link router and session-route `beforeLoad` with
memory history, demonstrates ordinary entry restoring an old child, then clicks a rendered
Board-page link and verifies the exact root tab, with and without target metadata.

The panel thread lacked a file-open callback, so Markdown copied every file path.
It now receives a scoped Board file opener. Recognized Board links create ordinary
closeable viewer tabs, but render the existing Board preview and read/download member
resources with `boardId`. They bypass the session file provider and tree listing limit;
Files-tree opens keep the inline Board preview. Matching requires the current workspace
segment after `boards`, so ordinary repository paths are not intercepted. A matching path
with a missing Board row remains an unavailable Board preview, never a session-provider
read. No filesystem access is added to the renderer.

With the experiment enabled, session mentions use Board identity ahead of project identity, including members on other
projects. The current scope displays the Board name. Other Boards also get distinct keys;
all-project scope stays flat and hydration/expansion retain the complete candidate list.
Turning Boards off restores project keys and scope labels, and invalidates the item cache.

Behavioral coverage extends the Board, relation-card, tab-bar and mention suites for
navigation destinations, existing child surfaces, member file reads/errors and status
transitions. `CompletedThreadCard` and `AssignedThreadsSidePanel` render real components
with synthetic metadata; the latter uses the product navigation hook. Real desktop visual
review and daemon end-to-end validation remain outside this implementation pass.

The interactive assigned-thread story uses the existing `SettingsStoryProviders`, as the
coordinator-page story does. Without that shell, opening the real chat composer threw
because the global preview provides no platform context. Its play checks mouse opening,
thread header, Back, keyboard Enter and Back again. The application root already provides
the platform; no product component or new mock provider is needed for this correction.
