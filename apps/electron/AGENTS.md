# Electron contributor guidelines

Edit `AGENTS.md`; `CLAUDE.md` symlinks here.
Root rules apply. For `src/**`, read module, IPC and window contracts in
[`src/AGENTS.md`](src/AGENTS.md).

## Local OSS composition

- Public desktop is local-only: never discover deployment env files, initialize
  authenticated product-cloud behavior or enable telemetry.
- The build-time `mainPlatformKind` is the source of truth for data directories,
  sockets, run/lock files, host leases, and workspace catalogs. Pass it explicitly;
  never infer it from an inherited `LODY_PLATFORM` value.
- `electron.vite.config.ts` maps Vite `oss` to `VITE_LODY_PLATFORM=local`; clear
  caller-provided `VITE_*` before injecting audited local constants.
- Run desktop development from the repository root with `pnpm start:local`. It must
  rebuild the embedded CLI and local renderer before launching the bundled CLI; do
  not reuse production/cloud artifacts.
- Cloud desktop development must likewise build and sync the CLI before
  `electron-vite dev`; the direct `apps/cli/dist` lookup is only a missing-staging
  fallback and must not let an older `resources/cli` shadow a fresh build.
- Turning off **Run local agent** is an explicit cloud control-only mode: do not
  probe an embedded or externally started CLI, and keep the local Loro data-plane
  relay disconnected until the setting is enabled again.
- `localPlatform.getSnapshot` atomically supplies the `local:*` user and every
  active `lw_*` workspace of the CLI catalog: one, or one per
  [LAN](../../.agents/docs/lan.md#one-lan-one-workspace). Never split it into
  fallbacks. No active workspace means provisioning; a malformed identity is an
  error.
- OSS local mode must not create a PostHog client, write an analytics install id, or
  upload source maps, even when unrelated analytics variables exist in the shell.
- Use `pnpm --dir apps/electron preview:local` only with harness-prepared and
  validated OSS artifacts; retain `--skipBuild --mode oss`.

## Build toolchain and window identity

- Electron 44 desktop builds require macOS 13 or newer.

- `desktop-bootstrap` must be the first main import: Nightly chooses its data
  directory before auth stores open. `desktop-channel` changes desktop identity,
  never the shared CLI namespace, data root, or Host endpoint.

- Upgrade Electron and electron-vite targets together; verify the pinned Electron
  major in electron-vite's `dist` target table to avoid obsolete Node/Chrome fallbacks.
- Electron 42+ does not download its binary during install. `scripts/postinstall.mjs`
  runs the package's idempotent `install.js`; dev, preview and E2E need its `path.txt`.
- Keep native top-level await in renderer/module workers; do not add
  `vite-plugin-top-level-await` or another full-bundle AST compatibility rewrite.
- Linux window identity is one contract: the composition's packaged `desktopName`,
  electron-builder's `syncDesktopName`, the pre-ready `app.setDesktopName` value,
  and the AppImage runtime desktop entry must all resolve to the same desktop-file
  basename. KDE uses that identity to associate Wayland/X11 windows with the
  installed icon.

## Embedded CLI and native dependencies

- Main-process E2EE also uses `better-sqlite3`. Declare it in this app's runtime
  dependencies, externalize it in every main composition, and unpack the installed
  package including its target prebuild. Never rely on the embedded CLI's separate
  dependency tree.
- Both compositions build `src/main/native-storage-smoke.mts` with `application.ts`.
  afterPack runs that ASAR entry in packaged Electron on matching hosts to test
  E2EE SQLite close/reopen and encrypted Node custody using synthetic temporary
  state. Keep it separate from CLI binding probes; it does not prove OS-keychain acceptance.

- The embedded CLI runs built JavaScript, never source-loader/Jiti. Development
  and packaged builds share the output layout.
- `@loro-dev/roost-node`, `better-sqlite3`, `@lydell/node-pty`, and Node-only `loro-crdt` remain external and must be
  staged under `resources/cli/node_modules` by `scripts/sync-cli-dist.mjs` and
  `scripts/cli-native-deps.mjs`.
  Roost's client, Worker, and binding retain relative paths; stage only the target prebuild,
  from the main package or its exact-version optional platform package.
- `@lydell/node-pty` and `better-sqlite3 >= 13.0.2` use N-API prebuilds. Stage the
  target platform/arch; never run `install-app-deps` or rebuild these by Electron ABI.
- Every embedded-CLI descendant launched through `process.execPath` must inherit
  `ELECTRON_RUN_AS_NODE` when it exists. On packaged macOS, omitting it launches a
  second GUI app instead of Node.
- macOS nested binaries keep `disable-library-validation` in
  `build/entitlements.mac.inherit.plist` for runtime-installed addons without Team
  IDs. Top-level entitlements stay strict.
- Electron Builder ignores nested staged `node_modules`. `eb-after-pack.mjs` must copy
  them into `app.asar.unpacked`, assert the DeepSeek adapter plus all four pinned
  presets, then probe CLI `--help`, node-pty loading, and a real in-memory SQLite
  database before signing.
- Keep `better-sqlite3 >= 13.0.2`, Node-API 10, and the CLI first-import guard aligned.
  [Node security floors and Electron backport limits](../../.agents/notes/implemented/bug-fix/2026-10-22-node-security-runtime-floor.md)
  are separate. Linux armv7 is unsupported.
- When upgrading `@lydell/node-pty`, audit package layout and Windows ConPTY binding
  names. Apply the staged asar-path repair after downloading target artifacts; a pnpm
  patch cannot cover cross-architecture packages fetched during packaging.
- `electronLanguages` must include underscore names used by macOS resources and
  hyphenated names used by Chromium `.pak` files. The after-pack assertion for
  `locales/en-US.pak` is a release gate.

## Release packaging and auto-update

- Package through `scripts/package-electron.mjs` (`pnpm run package -- <args>`),
  never directly through electron-builder. Inject the release version through
  `extraMetadata`, using package.json only as fallback; force `--publish never`
  unless the caller opts in.
- Windows/Linux electron-updater still uses the `publish` block: Vite strips every
  `VITE_*` value, so `AppUpdaterService` falls back to packaged `app-update.yml` and
  `latest*.yml`. Tag contract is `v${version}`.
- macOS uses Sparkle (`electron-sparkle-updater`): `SUFeedURL` + `SUPublicEDKey` in
  Info.plist, `package-electron.mjs` rebuilds the native addon, afterPack injects
  `SPARKLE_ED_PUBLIC_KEY` before signing. Tag releases contain changelogs only;
  they do not build installers or generate Sparkle feeds/deltas.
- Before changing updater runtime code, read the auto-update rules in
  [`src/main/services/AGENTS.md`](src/main/services/AGENTS.md#auto-update).
- Keep artifact names space-free and never use `${productName}` in `artifactName`;
  GitHub rewriting otherwise breaks updater references.
- macOS releases must be signed and notarized. `generate_appcast` refuses archives
  that fail `codesign --verify --deep --strict`, and Gatekeeper needs a notarized
  first-install DMG. Windows and Linux do not have this constraint.
- `snap` stays in the target list for local builds and needs snapcraft on the machine.

## Verification

- Claimed warm windows stay hidden until matching content readiness. Main owns the
  recovery deadline; do not cover a visible window with a blank surface. Restore
  background throttling after preparation and replenish the spare after show.

- Cloud browser login is owned by main: PKCE attempts, callback exchange and replay
  handling must not depend on a renderer. Organization failures never roll back
  authentication. Windows subscribe then read revisioned snapshots. Contract:
  [desktop browser login](../../specs/desktop-browser-login.md).

- Run the repository checks after source changes. Packaging/native-dependency changes
  also require the Electron packaging probes for every affected target architecture.
- Do not replace deterministic probes with launch sleeps or retry-only tests.
