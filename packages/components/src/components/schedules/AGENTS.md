# Schedule UI

Read the [surface guide](README.md).

`CLAUDE.md` links here. Read:
[scheduled tasks note](../../../../../.agents/notes/implemented/feature/2026-09-24-machine-owned-scheduled-tasks.md).

- One shell Registry subscription supplies list/provenance; details acquire/release
  one WorkspaceRuntime Schedule store. Writes await mode admission through `withScheduleStore`; full messages
  have their own editor. Listing opens only scheduled-message bodies: local
  first, one-shot sync when missing. No developer/beta gate on navigation,
  commands, Registry, proposals or Agent tools.
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
- Mount `SchedulesWorkspace` once in the schedules layout route. Desktop uses
  the 720px `ScheduleDetailModal`; Escape/backdrop/close return to the list.
  Mobile uses `ScheduleDetailPage` with Back. Both share `ScheduleDetailFrame`,
  its kind/name/status header, enable Switch or manual Run, delete menu and
  Settings/Run history tabs. New schedules and messages have no tabs. Keep the
  form footer sticky. Electron headers use `useWindowDragRegionClass` with
  `WINDOW_DRAG_EXEMPT_CLASS` controls; hidden macOS nav expands at 96px.
- Run history: a new chat per run lists Sessions with `SessionMeta.scheduleId`;
  a schedule that posts into one chat leads with that chat and reads its runs
  from it (`useScheduleChatRuns`: user turns whose `scheduleRun.scheduleId`
  matches, via `readAll` only while the tab is open). Nothing new is stored.
- `boardId` scopes list and editor; absent means global rows only. Board drafts
  default to a dedicated thread; picked destinations exclude archived/foreign
  sessions and the coordinator. Provenance and proposal links enter its Board's
  Schedules tab through `useOpenSchedule`, never the global detail page.
- Board panels stack list/editor with compact rows, no duplicate title and destination-neutral empty copy.
- Reuse composer parts: one box holds name, a hairline, the
  prompt and, along its bottom, the composer's Agent controls
  (`ScheduleAgentControls` = `DesktopRunConfigMenu` + `DesktopPermissionModeButton`).
  Roles: [rules](../../../../../apps/cli/src/lib/schedules/AGENTS.md).
  Preserve ACP value types through save; never stringify option values.
  Under the box are the chat landing's context pills — `DesktopMachineMenu`, the
  project chip, the worktree checkbox. Destination and trigger share one card;
  timed/manual is a row (`Tabs`) in it. The name is larger and semibold and
  autofocuses on a new schedule. Do not fork look-alikes of
  these controls; pass props to the shared ones.
- Offer owned machines with agents. Seed via `pickScheduleAgent`,
  `readChatLandingDefaults` and `seedScheduleAgentRunRef`; restore model/options/
  advertised permissions from `agentDefaultsCache`. Reseed on target changes,
  without credentials.
- `collectScheduleSaveIssues` assigns blockers to form/machine/agent/destination
  and missing/invalid. Put `FieldIssueMark` beside the control; show missing after
  Save, invalid immediately. Only form errors disable Save; other errors mark and
  focus the first empty field. Never mark optional projects as required.
- Date/time are typed, with native picker buttons hidden. Prompts grow from
  four lines to `max(6lh, 50dvh)`, then scroll, without resize handles. Position
  field marks absolutely.
- No time zone control. Input, preview and kind changes use `MachineMeta.timeZone`
  (device zone for older CLIs). Once retains its instant across machine changes;
  calendar rules retain wall time. [Time contract](../../../../../specs/schedule-time.md).
- Frequency offers daily/weekday/weekly/monthly/hourly/minute/once/manual choices,
  never raw cron. Unsupported rules remain readonly with Replace; preserve
  untouched rules verbatim. Expand weekday ranges before folding 7 onto 0.
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
  back to a different Agent.
- List (`schedule-list.tsx`): two sections, Scheduled tasks and Scheduled
  messages. Only messages get an ⓘ popover saying they send once; tasks need
  none. Rows are name + summary (frequency · Agent · machine), destination (a
  chat destination is a button that opens the chat) and status in words from
  `describeScheduleState`; colour and glyph mark only states needing a look.
  A scheduled message shows its own text (the stored title is fallback only)
  on the viewer's clock. No status pills or dots, no resizable columns. Project
  and status filters and sort sit above the sections. Every row has a ⋯ menu and the same
  context menu (open, run, pause/resume, open chat, last run, delete); delete
  always confirms. The hover action is Run for a manual task, Pause/Resume
  (`RotateCcw`, never `Play`) for a timed one, Delete for a finished message;
  it is visible by default and hidden only behind `@media (hover: hover)`.
  "Clear finished" deletes every finished scheduled message after one confirm.
  Run from the list starts at once with a toast.
- Chrome: every control is an `@lody/ui` primitive (Button, Input, Select,
  Combobox, Menu, Popover, Switch, Tabs, Tooltip, ContextMenu, Skeleton,
  `@/ui/dialog`); `className` carries
  layout only. Cards are `scheduleCardProps()` (the settings `settingsCard`
  StyleX) inside `data-settings-surface`. Copy is `em` of `--ui-font-size`, two
  inks (`foreground`, `muted-foreground`), `font-normal` except the name.
- Keep 44px rows with aligned labels/right edges and solid Select triggers
  and only native time inputs bleeding `-mr-2`. Multiline rows align labels to
  the first line. `PropertyRow` uses content-sized tracks, never viewport breakpoints.
  Check `EditorInNarrowPanel`.
- `AnimatePresence` children must carry their own `key` (`<Reveal key=… >`);
  a key set only inside the child reads as `""` and breaks exit animations.
- The terminal Claude quota-failure banner enables Session capacity recovery; it does
  not create a Schedule. Existing reservations remain under the Schedule owner.
  [Prior shortcut](../../../../../.agents/notes/implemented/feature/2026-10-27-quota-continue.md).
