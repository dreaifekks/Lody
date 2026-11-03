# `@lody/components` contributor guidelines

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` also applies.

Shared React UI serves browser-shaped, Electron and responsive mobile hosts. Read:
[.agents/docs/components-package.md](../../.agents/docs/components-package.md).

## General rules

- Native shells never emit `$pageview`/`$pageleave`; browser tracking stays enabled.
  Mention-fetch failures reach consumers, never analytics. Use `app/active` for
  authenticated readiness, never duplicate `onboarding/account_ready`.

- Regenerate TanStack routes after changing route files.
- Use `pnpm --filter @lody/components dev` to generate and format the route tree
  with Oxfmt before CI compares it with the committed file.
- Add Storybook coverage for new presentational components and meaningful states.
- All user-visible copy must go through i18n.
- Compact number units (K/M/B vs 万/亿) follow the product language via
  `toIntlLocaleOrEn` / `formatCompactNumber`, never the host OS locale.
- Use `@lody/ui` controls without visual `className` overrides.
  Follow the [legacy primitive rules](src/ui/AGENTS.md).

- New/reworked product styling uses StyleX, never Tailwind. Use
  `@lody/ui/tokens/colors.stylex` / `scales.stylex` for colour/shadow/radius/space,
  component `stylex.create` for styles and the area's `surface.ts` for shared styles
  (e.g. `components/settings/surface.ts`). Copy following `--ui-font-size` uses `em`.
  Use `@lody/ui` materials: raised cards/controls, one recessed value well and one
  ruled card for a record list.

- `PlatformContext` intentionally has no default. Cloud-shaped component tests use
  `tests/test-platform.tsx`'s `TestCloudPlatformProvider`; plain-module tests install
  and remove the exact platform port they need.
- Shared UI accesses optional hosted operations only through descriptors in
  `src/lib/cloud-api-operations.ts` and `@lody/platform/react`. Never import generated
  backend declarations or call a hosted database directly.
- Protected RPC requires actual host capabilities and live operation admission;
  its presence never permits ordinary RPC, unsupported controls or execution.
  Control-page readers close their captured account/reader, including cold opens,
  and retain incomplete owners until actual close before reusing that binding.
  Electron counts unlabeled readers per window and workspace, so the control page
  and RuntimeProvider each release one settled acquisition exactly once.
- Encrypted visible indexes add other members' machines only from the host's verified
  sharing view (`useEncryptedSharedMachines`), never server machine tables. Keep them out
  of Convex-authorized probes; automatic writers and machine-RPC surfaces use
  `withoutEncryptedSharedMachines`. [Decision](../../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.md#member-visibility-a4).
- `public` descriptors may run before authentication and expose only deliberately
  public or narrowly token-scoped DTOs.

- Renderer and worker builds that cannot use native top-level await must use
  `vite-top-level-await-fixed.ts`. Do not bypass its audited-version assertion.
- Keep test imports light. Never re-export heavy leaves from `src/ui/index.ts`;
  deep-import `date-fns/locale/<tag>`. Isolate the icon `new URL` glob in
  `src/components/icons/file-icons/asset-url.ts` for the test alias.
  See the [module graph note](../../.agents/notes/implemented/testing/2026-09-10-components-test-module-graph.md).

- `vitest.config.ts` deliberately omits `vite-plugin-top-level-await` and
  `vite-tsconfig-paths`; `vite.config.ts` keeps both because the product bundle
  needs them. The plugin reads `tsconfig.vite.json`; keep the type-only React
  mappings from `tsconfig.json` out of the runtime resolver. Run the suite with
  `NODE_ENV=test` — a `production` value resolves React to a build without `act`.
- `next-themes` owns system theme state, persistence and browser tracking.
  Lody owns preview state, fixed VS Code themes and committed-theme host bridges:
  Electron uses `app.setStartupThemeSource`; native mobile implements
  `window.__LODY_STARTUP_THEME__.persist` from its storage (typed here like
  `LodyLiveActivityBridge`). Never send previews to startup painters.
  `lib/boot-shell-script.ts` applies the renderer's initial class before parse.

- Never `@source`-scan third-party libraries in `src/tailwind/index.css`.
  Keep `#root` off `<body>`'s tail with `lib/body-tail-sentinel.ts`, mounted by
  `routes/__root.tsx`. See the [portal restyle note](../../.agents/notes/implemented/bug-fix/2026-09-23-portal-full-restyle.md).

- Sidebar session-row lists use `SIDEBAR_ROW_LIST_CLASS` (`content-visibility: auto`,
  which also applies paint containment): a row must draw inside its own box (inset
  focus rings; connectors inside the leading slot). Recursive GitHub trees go through
  `lib/repo-file-paths-cache.ts`, never a direct `githubFetchFilePaths` per search.
- Layout components never subscribe to high-frequency atoms (presence/clock/all
  sessions). Put these hooks in a non-rendering leaf such as `LodyLiveActivityHost`;
  read sidebar navigation state at key time. Memoized rows retain unchanged item/
  live-status identity and receive selection-independent handlers.

- Conversation/sidebar contexts keep stable callbacks and content-keyed sets.
  Surrounding `AnimatePresence` uses `presenceAffectsLayout={false}` unless it drives
  `layout` animations.

- Dark-theme brightness ceiling (`vscode-theme-css.ts`): every text foreground token is
  held at the interface ceiling (13:1 on the canvas); only prose (`text-reading`,
  14.6:1), `text-foreground-strong` (headings, bold), the selected sidebar row and the
  active tab go above it. Unselected sidebar text uses `text-sidebar-row-foreground`. Never hard-code
  white text on theme surfaces. Hover changes a row's fill, never its text color.
- Sidebar top-level groups (machines, GitHub Worktrees, Chats) all use
  `SIDEBAR_GROUP_LABEL_CLASS`, with no leading icon or sticky positioning; labels scroll
  with their rows. Project, repo and conversation rows
  are 1em. A machine is identified by its Offline pill and hover card
  (`sidebar-machine-card.tsx`); never show "offline" while its status is unknown.
- `@lody/ui` colours come from the VS Code theme: `theme-provider.tsx` puts
  `lib/vscode-theme/lody-ui-palette.stylex.ts` on the root in the resolved mode. Override
  its tokens there with `createTheme`, never with Tailwind classes on package parts.
- Conversation rows import `Tooltip`, `Popover` and `ContextMenu` from
  `ui/armed-overlays.tsx`, not `@lody/ui`. Unarmed `useInteractionArm` renders only
  triggers until hover/focus; owner-opened overlays still mount. Return arming
  focus to the same trigger and never commit arming inside a press.

- Markdown code blocks tokenize in `lib/markdown-highlight.worker.ts`; the main thread
  keeps only cache hits and the no-worker fallback. Builds without an `es` worker format
  alias `@/lib/markdown-highlight-worker` to a null shim (see site-docs).

## Rules shared by callers

Before changing crash recovery, diagnostics, localStorage cache keys, file preview,
Code Collab, file/diff caches, or Electron IPC typing, read the corresponding section
of [src/lib/AGENTS.md](src/lib/AGENTS.md). These contracts bind all UI, hooks, and
provider callers, not only files under `lib/`. Recovery must preserve auth/preferences
at cache-clear level; local file routes must never silently fall back to cloud.

## Scoped rules

- Product surfaces, sidebar session rows, local projects:
  [src/components/AGENTS.md](src/components/AGENTS.md).
- Shared primitives, emoji picker, field colors, diff viewer:
  [src/ui/AGENTS.md](src/ui/AGENTS.md).
- Hooks: [src/hooks/AGENTS.md](src/hooks/AGENTS.md). Workspace runtime, transports, and
  presence: [src/providers/AGENTS.md](src/providers/AGENTS.md).
- Sessions, mobile, chat, mentions, onboarding, settings, and Codex reset
  forecast each own an `AGENTS.md` under `src/components/`. Commands and shortcuts:
  [src/lib/commands/AGENTS.md](src/lib/commands/AGENTS.md).
