# components/sessions

Edit `AGENTS.md`, not its `CLAUDE.md` symlink; parent rules apply.
Read [README](README.md) and these rules.

## [Tabs](../../../../../.agents/docs/sessions-tabs-routing.md)

- One `SessionTabBar` gates traffic-light insets on `!useElectronFullscreen()`.
  Hide IDE/share pills below `SESSION_PAGE_HEADER_PILLS_MIN_WIDTH_PX`, retaining `⋯`.
- Tabs share `TAB_PILL_*_CLASS`, never `--tab-active`/`--tab-inactive`.
- One tab slot orders waiting > working > unread > agent icon. Test
  `isWaiting` first; `sessionHasUnreadMessages` excludes closed/archived output.
- `?tab` owns selection, never mirrored state. Shared closure may select a neighbour
  or draft. Close writes only `isTabClosed`; reopen clears it without unarchiving.
- Read [Cmd/Ctrl+W rules](../../lib/commands/AGENTS.md).
- Change owner writes `SessionMeta.userId`, independently of sharing/visibility.

## [Shell](../../../../../.agents/docs/sessions-side-panel.md)

- File/diff/browser/PR viewers are closeable right-panel tabs, never conversation
  splits. `sidePanelTabs` owns order/close fallback.
- Side Chats are durable children using `childSessionPlacement: 'side-panel'`.
  They roll into the parent row, have no top/sidebar row and mount lazily.
  Only tab close deletes them.
- `openedBySessionId` is provenance, never `parentSessionId`, opener rollup or row
  filtering. Navigate with root/exact-tab IDs.
- Collapsed panels stay mounted; pause connections/polling while off screen.
  Mounting is not preview ownership; cleanup never releases endpoints/tunnels.

## [Browser](../../../../../.agents/docs/sessions-browser.md)

- Managed Preview accepts only agent-machine loopback. Other addresses need
  public-browser capability; no iframe/system-browser/CLI/gateway fallback exists.
- Approval never authorizes LAN preview. Agent-authored `fromPageContent` navigation
  cannot open private LAN; only the address bar may.
- Preload one bounded frame after live confirmation. Require atomic moves, no
  polling and cleanup that remains safe after Browser takeover.
- Static HTML uses policy-owned `srcdoc`. Scripts require credentialless and
  `allow-scripts`; otherwise strip navigation and use an empty sandbox. Never preview
  truncated text. Static frames die with their tab.
- Encrypted remote controls require protected host features/verified write role,
  never ordinary proofs. Disclose plaintext tunnel bytes.
- Comments use `runtime.writer.mutatePreviewVisualComments`, never `setState`.

## [Surface](../../../../../.agents/docs/sessions-surface.md)

- Mobile composers/questions lift for keyboards; other panels use `nativeKeyboardInset`.
  Wide sessions inherit root padding once.
- Message-list crashes preserve the composer and copy the shared report with original
  error/React stacks. Read receipts require `isVisible`, not mounting.
- `useSessionActions` checks current Repo metadata for all affected
  target, including contained/opened sessions, before effects.
- Encrypted history uses bound document access, never wider execution indexes.
  Unavailable targets mount only document readers, without probes/RPC. Read the
  [boundary](../../../../../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.md#member-visibility-a4).
- Window-top headers use shared drag regions, exempting controls.
- Retain question drafts through navigation/IME Enter and show failures.
- Copy uses `buildConversationMarkdown`, never `buildReplayPromptFromHistory`.
  Preserve prose, cap thinking, report omissions and include selected messages
  without requiring ACP fork support.
- Use `useResolvedMachineMeta()` capabilities and `useSessionAcpSelectorContext()`
  selectors; never recompute in composers.
- Rendering belongs mainly in `../ai-gui/view.tsx`. Conversation `VList` scrolls
  vertically only; wide content owns its scroller.

## [Run config](../../../../../.agents/docs/sessions-run-config.md)

- `buildComposerAgentRoleItems` lists every Role group flat by instance, this machine
  first. Unrunnable entries remain disabled with reasons. Drafts authorize instances;
  existing sessions apply only their run config.
- Roles own config. Other knobs are inert; permission pins hide
  `DesktopPermissionModeButton`. Knob changes unname Roles, retaining values.
- Derive selection through `useAcpSessionConfigSelectionState`, never stored resolved
  state or effect reconciliation.
- Freeze Role ID/revision/instance in Turn `inputConfig` (`agentRoleSnapshot`).
  Never rewrite `SessionMeta.agentRoleId`/`agentRoleInstanceId`.
- Apply accepted/queued Turn `inputConfig` and `userTurnId`-fenced
  `SessionDoc.acpRuntimeConfig` only to unedited fields. Permission clicks never infer
  runtime config; explicit execution freezes a non-Plan mode.
- Only `AgentRoleDetailPane` shows pins; `AgentRoleEditorDialog` edits.
  Narrow `ComposerAgentRolePanel` rows put agent/model on the second line.

## [Dispatch](../../../../../.agents/docs/sessions-live-status.md)

- Presence owns Working/Waiting, never `SessionMeta.status`, `lastRunningSeen` or
  CLI pointers. Derive only dispatched-but-not-started activity from durable turn
  time, capped at 30s. Without presence, queue behind unfinished turns, never relight
  Working. Busy composers without authoritative steer use Queue.
- Interrupt-and-send uses `{ interrupt: true }`, never Stop identity.
- Follow the [upload contract](../../../../../specs/composer-send-during-upload.md).
- Coordinators retain Board maintenance; ordinary sessions use negotiated automations.

## [Info bar](../../../../../.agents/docs/sessions-info-bar.md)

- Keep cluster order and a nonempty stage while items/ambient content exist.
  Machine identity stays unstaged (desktop name/mobile icon); ownership is details-only.
  Scheduled drafts stay in the composer, never the bar.
- Stage icons are inert. Colour indicates status; never pulse.
- Reported preview requests enable actions targeting the main Session. One
  platform opens directly; iOS+Android use a chooser on desktop/mobile.
- Open preview requires a real reported target. Prioritize repository actions
  (dirty means Commit & Push), collapse into one and never duplicate below replies.

## [Status slot](../../../../../.agents/docs/sessions-auto-review.md)

- One slot orders browser-offline > machine-removed > machine-offline. Never stack
  statuses, block sends for offline machines or restore doc-stream degradation.

## [Render cost](../../../../../.agents/docs/sessions-render-cost.md)

- Reuse controllers; mount child bodies lazily.
- Page-level `activeSession` and message rows never subscribe to file-index Flock or
  full `sessionMetaAtomFamily`; select only used fields.
- Session switches reset during `session-detail.tsx` render, without a second effect.
- Restored panels never animate. Bump `sidebarRestoreSeq` with non-user `isSidebarOpen`.
- Current branch reads only `SessionMeta.branchName`.
- PR summaries use shared lifecycle reads, never UI writes/API grants; local PRs open externally.

## [File surfaces](../../../../../.agents/docs/sessions-file-surfaces.md)

- Share `hooks/use-session-file-actions.ts` and `lib/session-file-actions.ts`
  capability checks. Hide unavailable local-host actions.
- Failed conversation indexes release optional leases and pause until shown;
  Files/Changes recover independently.
- Mobile Changes starts at the shared list; exact file/comment links open diffs.
  Preserve diffs/drafts/expansion/focus on Back. Viewport-gate bodies, pause hidden
  reads and use shared parse Workers for multi-file cache misses.
- Local paths use the owning machine's root plus relative path;
  `lib/session-local-file-path.ts` rejects absolute/`..`. LAN preview/download retains
  `rootId` through transport/cache identity.
- Keep static shells; load Office on activation/idle and pause hidden video. PDFs
  use 64 KiB ranges/8 MP canvases; retain bundled Worker entry/export.

## [Stories](../../../../../.agents/docs/sessions-stories.md)

- Stories stay minimal and use real components/mocked data. Keep appearance in
  production and verify UI in the app.
- Follow [automation identity rules](automation/AGENTS.md).
