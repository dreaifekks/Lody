# Settings surfaces

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Parent `AGENTS.md` files also apply.

Settings owns Providers/MCP/Role catalogs. A local Flock write is durable;
Settings never waits for, reports or rolls back upload. Follow root
[AGENTS.md](../../../../../AGENTS.md).

## Layout and components

- Desktop overlay close is `absolute` on the RIGHT pane only (equal `top`/`right`
  inset); the pane's in-scroll `padding-right` keeps chrome off that column.
- Settings style in StyleX from `surface.ts`/`compact-layout.tsx`. The desktop pane
  header names every page; a page hands it actions and a one-line lead through
  `settings-page-header.tsx`, never its own title. Groups are flat in `settingsFlat`
  (pane, project window), else cards. Group by meaning, no one-row groups; a helper
  says what the label cannot. Split master/detail by fill; type: `type.stylex.ts`.
- Preferences grammar: `CompactRow`, one answer; records: name, state, menu/detail.
  Its four switches bind translated labels and rendered helpers.
- `SettingsLineTabs` keeps a held tab's full ID on its overflow menu item as
  `data-settings-tab-overflow-id`; visible tabs retain `data-tab`. Labels may repeat.
- `share-management-setting.tsx` lists published static copies via the scoped cloud
  query. Ordinary members see their publications; admins see the workspace inventory.
  Draft uploads are not published shares. Reuse `useSessionShareLinkActions` for
  copy/reset/revoke; settings must never reconstruct a credential from cloud data.
  Key state by user/workspace and gate the whole surface with `teamSharing`.
  A share outlives its source, so both "View conversation" and "Update deployment"
  require the session in the local metadata cache; opening it closes the desktop
  settings overlay. Rationale:
  [share inventory jump](../../../../../.agents/notes/implemented/feature/2026-09-15-share-inventory-session-jump.md).
  LAN (`lanSharing` only): `lan-share-management-setting.tsx`; every member manages
  hub shares. Links contain no credential.

- Desktop Projects stacks machine/GitHub sources as ruled `CompactSection`s.
  A project opens a nested window with header/tabs, never an inline editor. Mobile
  keeps its stacked list. Reuse `useRemoveLocalProject` without confirmation,
  following parent removal rules. Never probe offline remotes' worktree/skills or
  show `machine_rpc_unavailable` as editor error. Paint GitHub from
  `lody:githubReposCache` immediately; never await `listWorkspaceReposWithStatus`
  to decide whether that source exists.

- Project create/edit: `project-create-wizard.tsx`, scope first; read-only: `ProjectGroupView`.
- Settings rows (`compact-layout.tsx`) give labels remaining width and controls their
  content width. Never size columns from viewport breakpoints: the panel
  clips controls. Desktop Settings nav follows panel width; keep categories/drafts,
  reveal the selection and wrap actions.
- `agent-config-dialog.tsx` and `env-vars-textarea.tsx` own Agent config.
  DeepSeek official/custom choice stays form-only: persist `DEEPSEEK_API_KEY` /
  `DEEPSEEK_BASE_URL`, with official `https://api.deepseek.com/anthropic`, never a
  new AgentConfigMeta field. Live OpenAI-compatible discovery supplies model IDs;
  official Messages/legacy Chat roots share `/models`. Never add a manual catalog.
  Extra env cannot override either connection key; endpoint/credential changes
  invalidate prior live verification.

- Keep three.js/R3F behind the lazy usage-calendar module so lightweight and SSR
  consumers never evaluate its renderer graph.
- Charts follow [timeline rules](../../../../../specs/usage-timeline.md).
  Cache bounded day snapshots per auth session/workspace/date for one hour;
  refresh expiry without blanking data. Keep auth/capability gates
  ([cache](../../../../../specs/usage-detail-cache.md)).
- Interface/terminal fonts exclude symbol families in `lib/local-fonts.ts`; option
  names stay on the default interface font. Five tiers write `--ui-font-size`;
  sizes use `@lody/ui` text tokens. Font ligatures in the Text group writes
  `--lody-font-ligatures` for conversation, code, and tool output.
- Quota UI requires Core `rateLimits`; refresh also requires `query: true`.
  Keep cached values while the shared Provider RPC refreshes.
- Provider rows show identity, read-only remaining quota, a direct flat forecast
  action, and a persistent Provider `…` menu. The forecast action opens its dialog
  in one step; no quota-details interstitial or forecast probability belongs in
  the overview. Listing rows does not fetch forecasts:
  [../codex-reset/AGENTS.md](../codex-reset/AGENTS.md).
- The usage share card is a fixed-format report, not a second `ChatShareCard`:
  fixed aspects, period = page range, headline = range total.
  Derive numbers through `usage-share-stats.ts` (stamp the metric on stats,
  never pass it beside them). Money: `formatUsdCompact` headline,
  `formatUsdTight` cells — never `truncate`. Tokens/member anonymity are
  defaults; cost substitutes for tokens; member slices never include email.
  Both cards reuse `lib/share-image-export.ts` and `components/share-theme-scope.ts`;
  never fork them. Pinned cards bind product and avatar StyleX themes locally;
  inherited aliases keep the app's resolved colours.
  `StatsSettingsView` gates its lazy dialog with opt-in `shareCard` for public-landing
  reuse. Type and spacing use `TEXT`, `PAD_X`, and `RHYTHM`, never fresh `text-[…]`
  or off-grid padding. `PAD_X` aligns every band, including the footer.
  `ASPECT_SIZE` includes the backdrop; size against the
  48px-shorter framed case. Keep every band but the headline `shrink-0`.
  The graphic follows the range
  (hour skyline, day-by-hour grid, or 53-week calendar, as on the Usage screen);
  every kind fits the one `GRAPHIC_H` box so card height never depends on range. Leave the space beside the headline empty.

- Bind `agent-provider-add` to its resolved machine and `agent-config-dialog` to
  its captured `data-machine-id`, including fallback/open-dialog changes. Both
  Add and dialogs honor workspace RPC restrictions before probes/draft writes.
  Signed file RPC grants no Provider management; same-machine IPC remains available.

## Agent Roles

Roles are read and written from Settings, mentioned from the composer, and
resolved by CLI MCP creation, so these are cross-surface rules rather than
component details.

- Before changing Role settings or dispatch, read the authoritative
  [shared Role contracts](../../../../shared/AGENTS.md#workspace-mcp--roles).
  Each target uses its machine's Provider RPC and memory identity. Only ready
  inventory marks missing memories; unlinking never deletes provider data.
  The editor shows shared fields and separately editable targets, including several
  on one machine. Alias or unaliased Agent family is unique per Role/machine.
  Lists use the upstream Role row; editors receive the complete catalog Role.
  Catalog opening never reconciles or writes. Explicit Save can reconcile options.

## Workspace ownership

- Ownership transfer is an owner-only danger-zone slot shared by desktop and mobile.
  `workspace-ownership-transfer.tsx` collects an existing member and exact workspace
  name, then calls the cloud mutation through `account-setting.tsx`. Refresh session
  and active organization after success; cache refresh failure must not claim transfer
  failed. Card changes use the billing Portal separately; transfer keeps the current card.

- Nightly downloads live below Download apps in desktop/Web About.

## Seat billing

- Reuse `SeatCostNotice` in invitation and approval entry points. Approval must show
  the current cost and deferred collection policy before committing membership.
- Removal/leave do not cancel accrued service fees. Deleted workspace invoices stay
  reachable for the retained billing owner through `deleted-workspace-billing.tsx`
  in personal Account settings; invoice details reuse `BillingInvoiceDetails`.

- Billing telemetry: never infer payment from returns; exclude URLs, codes and raw errors.
