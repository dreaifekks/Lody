# Product surfaces (`src/components`)

Ancestor rules apply. Edit `AGENTS.md`.

## Sidebar and session rows

- Sidebar rows represent Sessions, never Tasks.
- Desktop project grouping applies `selectVisibleLocalProjectSections`; its
  "Hide Empty Projects" switch is documented in the [README](README.md).
  Keep remote LAN projects visible before their first Session and retain sections
  holding populated project groups; pinned projects retain their independent order.
- Desktop Workspace, Local Project, Updated and Pinned rows support mention drag
  and Mark as unread (hide on unread). Use `lib/session-mention-drag.ts` for
  conversation/landing drops; parent tabs use HTML5 drag, child tabs dnd-kit.
  `startSessionMentionDrag` / `armSessionMentionDrag` must light
  `ConversationDropOverlay` before `dragenter`. Navigation overlays use
  `draggable={false}`; rows own `draggable`.
- Workspace selection navigates in place and preserves the current workspace's route
  on reselection. Browser `/chat` links retain native modified-click, middle-click and
  context-menu actions without switching the source page. Electron Cmd-click
  (Ctrl-click on Windows/Linux) and context menus open native workspace windows.
- Full-width sidebar stays mounted/inert with scroll; Cmd+B animates content width
  (zero for reduced motion); pause hidden eager-sync/keyboard-nav. Compact/settings
  remounts restore scroll. Compact nav is modal: inert content, restore focus,
  nested Escape first. [Spec](../../../../specs/desktop-windows.md). It opens only once
  the synced compact state agrees, and a close that never finishes is unmounted.
- Every list uses `lib/session-opened-by-tree.ts`; keyboard navigation uses
  `sidebar-navigation-model.ts`.
- `openedBySessionId` identifies the precise opener; `openedByRowSessionId` its row.
  `sessions/session-list-rows.ts`'s `buildSidebarOpenerRowResolver` walks `parentSessionId`
  using `allActiveSessions`, never visible rows. Preserve exact openers/independent
  child workspaces; exclude contained children from `sessionListAtom` rows.

- Top-level opener/unrelated rows keep flat alignment. `session-row-leading-slot.tsx`
  owns disclosure for openers and ├/└ for children; hover replaces a child's connector
  or a resting glyph with ⋯ at same 7px centre, regardless of activity, while an
  opener keeps its disclosure (its menu opens by right-click). Only child slots widen
  14px→26px, indenting titles 12px without moving backgrounds.

- Conversation titles stay `font-normal`; pin with the glyph, never weight.
- Sidebar row radius, inset, ink, hover/selected fill and title clipping use
  `sidebar-surface.ts` / `sidebar.tokens.stylex.ts` on conversation, repo and nav rows.
  Tailwind wins same-property conflicts; keep it only for groups, menu-open and focus states.
- Desktop work/wait/unread/send status belongs only in `SessionRowStatusIndicator`
  inside `SidebarRowEndSlot`, never the leading slot; it replaces resting `Mergeable`,
  worktree, PR icon or mobile time with one 14px mark. +/- totals: hover card only.
  Mobile: [mobile/AGENTS.md](mobile/AGENTS.md). Folded groups: only
  `SidebarGroupActivityMark`, no counts.
- Missing, cross-section, cyclic or deeper-than-one-level openers render top-level.
  Workspace `placeWorkspaceSessionsWithOpeners` moves Sessions into their opener's
  group. Pinned openers bring visible descendants into Pinned without changing
  descendant pin flags. `MAX_VISIBLE_SESSIONS` and
  `SHOW_FULL_BUCKET_THRESHOLD` count roots. Pass `rootRank` everywhere; an opener
  ranks by its freshest opened Session.

- `sidebarCollapsedOpenedBySessionsAtom` defaults expanded (folded in low-stimulus mode:
  `lib/low-stimulus.ts`). A folded opener draws its whole family's mark
  (`sidebar-folded-family.ts`). Preserve both navigation directions through the tree, row
  "Go to Opener Session", `SessionHeaderMenu.openedByRelations` and
  successful-create/precise-opener cards. Mobile: same two fields, per-bucket tree; see
  [mobile/AGENTS.md](mobile/AGENTS.md).

- Follow the [Session relation Spec](../../../../specs/session-relations.md): archive
  contains Tabs and optionally opened Sessions via `useArchiveSessionWithConfirmation`.
  Restore/delete includes direct child Tabs only; nested children are unsupported.
  `deleteArchivedSession` requires complete metadata; `deleteSessions(ids)` deletes
  exactly those IDs without discovery. Preserve opener provenance and expose reverse
  navigation only after opener/root hydration. Read the
  [tree rules](../../../../.agents/docs/components-sidebar-session-tree.md).

## Entry points, drafts, and layout

- iOS divisions separate workspace panes; never save the temporary sidebar width. [Decision](../../../../.agents/notes/implemented/bug-fix/2026-10-28-ios-vertical-division.md).
- Keep the touch resize grip and narrower navigation sidebar minimum scoped to wide mobile Web layouts.
- The window is `bg-sidebar`; pages use one inset `WorkspaceCard`. Keep the sidebar on the
  window, never as a floating surface. See [layout docs](../../../../.agents/docs/components-package.md).
- `handleSendDraft` in `sessions/session-detail.tsx` uses ordinary `startSession`
  acceptance to persist Session meta and the first user turn before promoting a
  child draft. `requestSessionDispatch` only accelerates the durable pointer.
  Never create then hand off through pending-turn refs or post-mount flushes.
  Preserve composer text through the draft cache, not refs. Close persists
  `isTabClosed`; legacy archives share the closed list and restore through the
  lifecycle. Surface failed writes.

- Login handoff: confirm account; retain PKCE/channel on switch; allowlisted schemes only.
- Desktop changelogs open in-app as sanitized Markdown with raw HTML off. Only
  missing notes fall back to the website, via `getChangelogUrl` and
  `openExternalUrl`, never a hardcoded link.
- The live agent status shimmer, `ZoomableImageViewer`, and Electron image preview
  copy/save keep their own rules in [shared/AGENTS.md](shared/AGENTS.md);
  `ZoomableImageViewer` is the ONE image viewer, so never add a second one.
- `web-workspace-layout.tsx` owns top/side safe-area insets for desktop surfaces,
  including the iPad native shell. The bottom inset belongs to the adjacent surface
  (the composer uses `env(safe-area-inset-bottom)`); mobile insets per surface.

## Conversation access

- `session-sharing.tsx` owns the shared header control. Its button states Private,
  Team read-only or Team can edit. The panel offers Private and Team read-only;
  shared-machine editing links to machine settings. Only the machine owner can
  change session access; other members see disabled choices with a reason.
  Public links remain a separate section and a busy publisher keeps the panel open.
  Authoritative access comes through the platform `sessionAccess` port, never
  SessionMeta. [Contract](../../../../specs/session-access.md).

## Local projects

- Visible shared project rows navigate and offer New chat regardless of machine
  ownership; only removal is owner-only.

- Folder addition is workspace-wide: every entry says "Add folder" and lets the
  picker select a machine. Settings > Projects lists every addable machine, even
  empty ones, and passes `initialMachineId`. Derive that set only through
  `useAddLocalProjectMachines` and its `canAddProjects` ownership rule.
  Onboarding's native picker is the explicit same-machine exception.

- Directory registration and standalone display are independent. Missing
  `standaloneVisible` means visible. Hide registrations only in standalone lists,
  retaining member resolution, repository-copy selection and session access.
- Delete local projects through existing action without confirmation/dependency
  UI. Retain referenced registrations/sessions; delete unreferenced ones normally.
  Explicit Add restores standalone display/identity.
- Direct folder selection is draft-only until save. Gate read-only inspection on
  `projectFolderSelection`; register missing directories before saving the complete
  Project. Retried saves reuse registrations; source paths stay out of definitions.

E2EE/terminals: read [rules](e2ee/AGENTS.md).

## Crash diagnostics

ErrorBoundary uploads one fixed-vocabulary exception per failure episode, including retries, until healthy content commits.

## Automation markers

- Workspace/machine/invitation/membership/composer controls expose stable,
  translation-independent `data-testid` values. Repeated rows preserve
  `data-settings-machine-id`, `data-machine-id`, `data-membership-id`,
  `data-request-id`, `data-device-key` and `data-agent-config-id` identities.
  These contain public IDs, never invitation tokens, credentials or keys.

- `workspace-ready` denotes scoped sidebar readiness, never execution permission.
  Tests bind the workspace and observe required content/controls. Preserve semantic/
  identity attributes for existing harnesses.
