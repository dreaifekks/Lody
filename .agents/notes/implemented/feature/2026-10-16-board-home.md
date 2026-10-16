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
