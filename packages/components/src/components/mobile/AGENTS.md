# components/mobile

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

The Capacitor app is outside this repository; keep native-only behavior behind
explicit platform capabilities. File ownership: [README.md](README.md).
Background: [ui-mobile.md](../../../../../.agents/docs/ui-mobile.md) — read
before touching gestures.

## Swipe-back and drawer layering

- Full-screen Vaul right drawers gate drag to a left-edge zone through
  `VaulDrawerBody` (content no-drag; the only drag-start zone). Drill pages
  mount `MobileEdgeBackSwipeZone` in a body-only `position: relative` region.
- Zones must not overlap a header back button: pass `topInset` = chrome above
  the body (`SESSION_DRAWER_BODY_TOP_INSET` for the session). Native-only; web
  mounts none, content still no-drag.
- Browser is a NESTED Vaul drawer, never a sibling body portal; preview
  iframes survive remount via `managed-preview-frame-cache.ts`. Closing the
  session sticky-mounts SessionDetail for the exit animation but clears nested
  `urlPr`/`urlBrowser` and replaces to the remembered `/chat` base — never
  `history.back()`.
- `MobileProjectFileBrowser`'s in-folder zone (z-60) pops one directory level;
  only the root swipe reaches Vaul's z-30 strip. Keep those apart if either
  moves. Interactive overlays inside a drawer use the nearest
  `data-vaul-no-drag` portal target.
- Composer shell and `SessionInfoBar` stay above the 48px strip (`z-40` over
  `z-30`, via `protectFromEdgeBackZone`); never shrink the zone instead. That
  escape is unavailable inside the message list, so a left-edge control there
  must be inset past `EDGE_ZONE_PX`: the turn action bar reserves
  `MOBILE_TURN_ACTION_LEADING_INSET_PX` (>= `EDGE_ZONE_PX`, pinned by
  `tests/assistant-turn-action-inset.test.ts`) with a duration label nothing may
  precede, whose width survives an unknown duration.
- Full-screen right drawers need `border-l-0!`; plain `border-0` loses to Vaul.

## Home and chat lists

- iOS side rail: host-confirmed, suspended for dialogs, web fallback retained.
- Fold panels retain list state.
- Keep dock icons and their size.
- Inbox requires `showInboxTab`. Keep chat/projects mounted for pull-to-refresh
  and scroll position across tabs. `../chat/chat-landing.tsx` owns the default;
  the workspace stack keeps `/chat` base context mounted under drawers.
- Keep one sticky home row (workspace/search/archive/settings). Search fades for
  `HEADER_SEARCH_EXIT_MS` before connection/pull pills mount; never overlap them.
  Place the filter at the first heading's trailing edge (`firstGroupTrailing`).

- `capGroupPreviews` caps each bucket at `MOBILE_CHAT_PREVIEW_MAX_ROOTS` with a
  showAll/showLess toggle; workspace home passes it, the in-project list does
  not. It counts TOP-LEVEL rows (`countOpenedByTreeRoots`) AFTER `rootRank` and
  never splits an opener from its opened Sessions. Expanded state is per bucket
  id, NEVER `sidebarCollapsedOpenedBySessionsAtom`; SUSPEND the cap during
  archived multi-select. Preview state joins the `AnimatePresence` key,
  collapsing scrolls the toggle in from a LAYOUT effect, and its leading 16px
  slot stays EMPTY.
- The home screen owns list scrolling; never virtualize it with `VList`.
- `MobileChatListCard` renders the sidebar's opened-by tree
  (`lib/session-opened-by-tree.ts`, the same two unmerged fields and the shared
  `sidebarCollapsedOpenedBySessionsAtom`; `../AGENTS.md`) over EACH bucket.
  `groupChats` first moves an opened Session into its topmost unpinned
  ancestor's bucket: the ancestor's project, or the date of the tree's freshest
  member. A bucket's project heading comes only from its own rows. Its
  leading slot owns ONE node — chevron, ├/└, or status indicator, status
  winning; never draw both. A status mark fills a 16px node box at the slot's
  start, so widening the slot never moves the 8px unread dot off the node centre.
  A top-level row keeps flat geometry (`px-4`, `w-4`);
  only an opened Session widens the slot (`w-8 justify-start`, CONTENT indented
  16px, background unchanged), and its chevron is a SIBLING of the row
  `<button>` needing `MobileSwipeableRow liftAboveEdgeSwipeZone` — pass that
  flag ONLY when the chevron renders, since it costs the edge-back swipe.
- `mobile-swipeable-row.tsx` owns Pin/Archive/Restore/Delete visible and aria
  labels (`chat.mobileHome.swipeActions.*`); never hardcode localized overrides.

## Session sheets and viewers

- Keep header sheets pure. `../sessions/session-detail.tsx` derives live status
  through one `sessionLiveStatusAtomFamily` atom, never a `useAtomValue` loop;
  unread means `lastMessageAt > lastReadAt`.

- Conversation rows follow the shared tab order (main first, NOT time) with no
  check affordance; close buttons use the shared tab-close action. `requestPermission` is the warning-tone hand
  outranking the spinner; the header tab badge stays two-state; `Files` leads
  the Viewers card unconditionally. The menu sheet stays flat, and its Owner row
  (multi-member only, writes `SessionMeta.userId`) is a DISCLOSURE, not a list.
- The file viewer header shows only the file-type icon and basename; `…`
  exposes the full path + tap-to-copy and path/content copy (content copy
  Markdown-only). Keep contents mounted across closes. Both Markdown modes keep
  native long-press selection; source mode must not expose Monaco's menu.
- The frosted header is an absolute overlay: session-detail sets
  `--conversation-top-inset`, the ai-gui `VList` adds it to paddingTop, and
  viewer tabs pad by it. Header buttons are `GlassIconButton` (canvas, no CSS
  filters/SVG; CSS-only press).

## Run config, pickers, and sheets

- `mobile-session-run-config.tsx` serves both composers using `agentSelection`
  (no SessionMeta) and model/mode/config props. Explicit permissions outrank
  legacy ACP modes; closing the sheet must not focus the composer.
- Provider IDs use `run-config-option:`; built-in rows use `run-config-`.
- Both composers pass `agentRoles` (`../sessions/AGENTS.md`); render its row even
  when empty, showing `None`. Above Agent, order inline choices as `None`, emoji/name
  Roles, then `New role`. Unavailable Roles remain disabled with reasons. `None`
  uses the EMPTY glyph and reports `null`, clearing only the name. Mobile has no
  Role detail pane or editing.

- New-chat scopes agents via `allowedMachineIds` from the selected machine and
  leaves agent unlocked; in-session locks it after turns. No fast/plan toggles
  on new-chat.
- New chat: session shell/Sheet; machine/project/worktree+branch.
  Home restores last-sent target; project entry/drafts win.
  Group/folder icons, GitHub avatars; recency/name/id order.
  Explain Role clearing on machine change. Hide after session presents;
  suppress entrance across renders. Back/edge drag slide out; the native
  drag binds the page (no strip), skipping the composer.
  [Details](README.md#sheets-and-session-surfaces).
- `mobile-inline-picker.tsx` supports ↑/↓/Enter/Esc and desktop search autofocus
  on `pointer: fine`; virtualize above 40 options. Share `lib/fuzzy-option-filter.ts`
  with desktop run-config menus and use only `shouldOfferOptionSearch` to decide
  whether to show search. Inputs use `type="text"`, never `type="search"`.

- Every mobile sheet with a field, including run config, uses
  `useKeyboardAwareSheet()` rather than assembling its three parts.

## Settings

- In-card row dividers on `bg-card` surfaces must use full-strength
  `border-border` (card outline stays `border-border/60`).
  `MobileSettingsSection` puts `title` + `actions` on one header line and
  `description` full-width below. `workspaceJoinRequestsSlot` owns its own card
  frame: wrap it in `MobileSettingsSection noCard` plus the standard `mx-3`
  inset.
- Mobile Settings carries the complete in-app `from` path. Nested Back opens the
  settings list; top-level Back restores validated `from`, including Projects queries.
  Only direct entries fall back to context-free Chat.

- Keyboard shortcuts is desktop-only: the mobile catalog hides `desktopOnly`
  tabs, and its route redirects back to the settings list.
