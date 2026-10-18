# Schedule UI

`CLAUDE.md` is a symlink to this file. Decisions and rationale:
[scheduled tasks note](../../../../../.agents/notes/implemented/feature/2026-09-24-machine-owned-scheduled-tasks.md).

- One workspace-shell Registry subscription supplies list and provenance links;
  details acquire/release one Schedule store through WorkspaceRuntime. All writes use
  `withScheduleStore`. Never load every definition for listing. Schedules are
  generally available: no developer/beta gate on navigation, commands, the
  Registry subscription, proposal cards or the Agent's Schedule tools.
- `schedule-view.tsx` is presentational with Storybook fixtures;
  `schedules-workspace.tsx` owns domain writes, selectors and composition.
  `schedule-save-blockers.ts` is the one save rule, `schedule-format.ts` the one
  vocabulary and the only place that constructs `Intl` formatters (normalize
  `locale` with `toIntlLocaleOrEn`; `zh_CN` is a RangeError). `AgentRunRef` and the project
  selector live in `components/shared`; the Agent and machine controls are the
  composer's (`sessions/desktop-run-config-menu.tsx`).
- Save/run require an Agent on an owned, capable machine. The composer supplies
  displayed defaults; do not require an explicit permission pin or capability
  cache just to save. Ordinary Session config validation owns runtime support.
  No project is required (none = plain chat). No consent checkbox, directory-scope
  checkbox, full-access warning or resume dialog.
- The global route mounts `SchedulesWorkspace` once; opening details never remounts
  its list. Desktop uses `ScheduleSplitView` under the header; mobile and Board
  panels stack list/editor. Board lists force compact rows independent of viewport,
  omit the duplicate title and use destination-neutral empty copy.
  Blank space closes details, excluding controls/portals.
  Save/close returns to the owning list. Preserve the Electron drag-region exemption
  on header controls. Layout explanation: [README](README.md).
- `boardId` scopes list and editor; absent means global rows only. Board drafts
  default to a dedicated thread; picked destinations exclude archived/foreign
  sessions and the coordinator. Provenance and proposal links enter its Board's
  Schedules tab through `useOpenSchedule`, never the global detail page.
- The editor reuses the composer's parts: one box holds name, a hairline, the
  prompt and, along its bottom, the composer's Agent controls
  (`ScheduleAgentControls` = `DesktopRunConfigMenu` + `DesktopPermissionModeButton`).
  Roles: [rules](../../../../../apps/cli/src/lib/schedules/AGENTS.md).
  Preserve ACP value types through save; never stringify option values.
  Under the box are the chat landing's context pills — `DesktopMachineMenu`, the
  project chip, the worktree checkbox. Destination and trigger share one card;
  timed/manual is a row (`Tabs`) in it. The name is larger and semibold and
  autofocuses on a new schedule. Do not fork look-alikes of
  these controls; pass props to the shared ones.
- Machine choices are owned machines with agents. New schedules use
  `pickScheduleAgent` over `readChatLandingDefaults`, then `seedScheduleAgentRunRef`
  to restore the landing's Agent, model, options and advertised permissions from
  `agentDefaultsCache`. Reseed on machine or Agent changes; never carry credentials.
- `collectScheduleSaveIssues` tags every blocker with the control that fixes it
  (`form | machine | agent | destination`) and `missing | invalid`. Each is an
  exclamation mark (`FieldIssueMark`) next to that control, never a list at the
  bottom; `missing` shows only after a save attempt, `invalid` at once. Only
  `form` reasons sit beside Save and disable it; everything else lets Save
  run the guard, mark and focus the first empty field. No project mark:
  it would read as "a project is required".
- Time and date are typed only: the native picker button is hidden
  (`[&::-webkit-calendar-picker-indicator]:hidden`), which in Chromium also
  removes the popup. The prompt has no resize handle: it grows with its text
  from 4 to 6 lines (`[field-sizing:content]` + `lh` bounds), then scrolls.
  Field marks float (`absolute`) so they never narrow the text.
- No time zone control. Input, preview and kind changes use `MachineMeta.timeZone`
  (device zone for older CLIs). Once retains its instant across machine changes;
  calendar rules retain wall time. [Time contract](../../../../../specs/schedule-time.md).
- Frequency is a short menu, never cron: every day / weekday / week (days) / month
  (dates) / few hours / few minutes / once, plus Manual. A stored rule the menu
  cannot name is `unsupported`: read-only summary plus Replace, re-emitted
  verbatim. An untouched rule is re-emitted unchanged (fingerprint stability).
  Cron day-of-week ranges expand from raw bounds before folding 7 onto 0.
- Manual (`trigger.kind === 'manual'`) is never planned; the editor keeps the last
  timed rule while toggled to Manual.
- Destination: new chat per run, owned chat (schedule + epoch + archive sequence),
  or picked chat. List and save checks select the current epoch’s first usable
  deterministic id, skipping archived/deleted/detached identities; a missing id
  means not created. Never match arbitrary Sessions by `scheduleId`. A picked chat follows
  its Agent and must remain available. Shared-chat destinations carry no project.
- Agents propose (`schedule_proposal` → `ScheduleProposalNotice`) or use tier-capped MCP writes.
  Create on the card persists, with
  `proposalId` as schedule id. Edit reshapes name, prompt and rule in the card
  only (never written back to the notice, so a retried proposal still matches);
  Created cards are immutable. `resolveScheduleProposalTarget` defaults to the
  proposing conversation; a named Role/Agent/machine/project overrides only that
  part; a named Agent without a Role gets the builtin default mode. Same save
  rule, same gate, trigger on the target machine's clock.
- Owner-only pause/delete stays possible when the machine is gone or outdated;
  create/edit/resume/run require the machine's protocol capability. Never fall
  back to a different Agent. Run history is ordinary Sessions with sparse
  `SessionMeta.scheduleId`.
- List (`schedule-list.tsx`): one column template for header and rows; Name,
  Frequency and Next run are resizable from the header (pointer, arrow keys,
  double-click resets), persisted per device in `scheduleListColumnWidthsAtom`,
  as `minmax(72px, width)` so a narrow panel still fits. The header cell must
  not clip — the handle hangs into the gap. A manual row's button is Run
  (`Play`); a timed row's is Pause/Resume (Resume is `RotateCcw`, never `Play`). Every row
  has a context menu (open, run, pause/resume, last run, delete). Run from the
  list starts at once with a toast; delete always confirms. Cells align to their
  first line; the target column names the machine; row actions are visible by
  default and hidden only behind `[@media(hover:hover)]`.
- Chrome: every control is an `@lody/ui` primitive (Button, Input, Select,
  Combobox, Tooltip, ContextMenu, Skeleton, `@/ui/dialog`); `className` carries
  layout only. Cards are `scheduleCardProps()` (the settings `settingsCard`
  StyleX) inside `data-settings-surface`. Copy is `em` of `--ui-font-size`, two
  inks (`foreground`, `muted-foreground`), `font-normal` except the name.
- Alignment is measured: property rows are 44px, labels share
  one left line, every row's last visible mark ends on one right inset (selects
  are solid `Select.Trigger`s; only the native time input bleeds `-mr-2`); a row with a hint
  or multi-line control pins its label to the first line. `PropertyRow` tracks
  are content-sized (`minmax(0,auto)` / `minmax(0,1fr)`), never from `sm:`;
  `EditorInNarrowPanel` catches regressions.
- `AnimatePresence` children must carry their own `key` (`<Reveal key=… >`);
  a key set only inside the child breaks exit animations.
