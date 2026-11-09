# apps/electron/src

Edit `AGENTS.md`; apply; the latter owns build, packaging, native dependencies and OSS composition.

## Module boundaries

- `src/main/index.ts` owns pre-application startup and the cloud desktop lease;
  `application.ts` owns lifecycle wiring, IPC registration and dependency injection.
  Keep credential stores and business imports behind the entry's dynamic import.
  Pre-ready APIs stay in `desktop-bootstrap`; buffer launch URLs before any await.
  Quit must retain ownership if the embedded CLI has not confirmed exit.
  Nightly reserves the CLI Host before application import and passes that identity
  to `CliService`; Worker stop/restart and control-only mode never release it.
  Stable/local keep their existing external-runtime policy.
- Put domain services in `src/main/services/*`, IPC handlers and input validation in
  `src/main/ipc/*`, and local-project worker/storage code in
  `src/main/local-project/*`.
- Main starts, awaits and signals processes only through `@lody/shared/node/process`
  (never `child_process` or `kill`); `check:cli-process-boundary` enforces it.
  Rules: [process layer](../../../packages/shared/src/node/AGENTS.md).
- Keep main-only helpers in `src/main/utils.ts`, cross-runtime pure logic/types in
  `@lody/shared`, and IPC contracts in `@lody/shared/electron-ipc`.
- Electron main and preload code never import runtime values from the
  `@lody/shared` root barrel. Use a narrow subpath so Node bundles do not pull in
  renderer modules or `loro-crdt` WASM.
- Derive invoke signatures from `IpcService` and the sole constructor list in
  `register-services.ts`. Every public instance method is renderer-facing and needs
  `@IpcMethod()`. Do not duplicate invoke contracts or per-method preload lists.
  Components may import inferred service types only with erased `import type`, never
  a runtime dependency. Keep push/send maps in `@lody/shared/electron-ipc`. Preload
  exposes only `{ invoke, on, send }`, gates invoke by service groups in
  `preload/ipc-invoke-policy.ts`, and retains push/send allowlists. The `e2ee` group uses an explicit method list covering every
  `E2eeIpc` method, checked by `e2ee-account-runtime.test.mjs`. Do not add
  `window.api`; validate foreign input at the IPC class boundary.
- The E2E client-loss probe (`e2ee.inspectClientLoss` and `e2ee.clientLossEffects`) is the
  only channel pair outside the service classes. Main registers it, and preload admits it,
  only for unpackaged `LODY_E2E=1` windows through the main-supplied argument. It stays
  read-only and returns counts, booleans and sequences without content, tokens or error text.
  [Decision](../../../.agents/notes/implemented/testing/2026-10-30-e2ee-client-loss-probe.md).
- Preload runs under the renderer CSP. Zod schemas used there must pass
  `{ jitless: true }`; do not add `unsafe-eval` to accommodate Zod's JIT path.

## Renderer and window integration

- Only factory-registered product windows may invoke product-window IPC. Dialogs,
  embedded browsers, navigation and close actions belong to their source window;
  auxiliary windows never overwrite the primary window's persisted view state.

- Devbar is off by default; hidden Developer Mode enables it, while
  `LODY_DEVBAR=true` is automation only. Keep data in memory; MCP/Terminals
  share that switch. GPU means process CPU/RSS, never hardware usage/VRAM.
  Runtime heap is approximate; only the startup override enables precise readings.

- Updates may carry Markdown in `vendor.lodyChangelog.locales.{en,zh_CN}` with
  English `releaseNotes` fallback. Main validates/bounds strings before exposing
  `ElectronUpdaterState`; render through shared safe Markdown, never raw HTML.
- React root callbacks persist fatal IPC diagnostics; ErrorBoundary owns caught-error
  UI and PostHog. Deduplicate errors; report mounted only from a committed layout effect.
  Keep hang capture local and bounded, Wait tied to active stalls, and stack opt-in
  limited to trusted product main frames.
  Contract: [renderer recovery](../../../specs/renderer-fatal-recovery.md).
- A CLI-armed reset (`lody app reset-cache`) is consumed once, before any window
  loads. `hard` is applied natively here because the renderer may not boot; `cache`
  is handed to the renderer exactly once, because only it can spare the Shortcut
  outbox and individual localStorage keys. Spec: `specs/desktop-local-reset.md`.
- Theme changes must also update the native window color in `window-theme.ts`.
  OS appearance changes while `themeSource` is `system` must retint chrome and
  notify the renderer (`app.nativeTheme`). On macOS also subscribe
  to `AppleInterfaceThemeChangedNotification`; Chromium `matchMedia` and
  `nativeTheme.updated` often miss Control Center switches.
- Frameless window drag is per-panel, not a root overlay: each column's top
  header (or a same-height `WindowDragStrip` when there is no header) is
  `-webkit-app-region: drag`. Interactive descendants use `app-region-no-drag`.
  Dialog and alert-dialog overlays mount the strip themselves. Hide those
  regions in native fullscreen. Windows caption buttons stay an OS overlay
  (`MAIN_WINDOW_TITLE_BAR_OVERLAY_HEIGHT`), measured by `--window-caption-*`:
  right-edge headers pad by its width, full-window overlays start below it.
- The onboarding window is native Light before its first renderer paint; normal product windows start from the committed theme ([main/AGENTS.md](main/AGENTS.md#startup-theme)).
  An automatic login launch may suppress the initial product window, but onboarding and deep-link launches must remain visible during normal product use. Unpackaged E2E windows are the exception: they stay hidden unless `LODY_E2E_SHOW_WINDOW=1` and always disable background throttling.
- `sessionControl.send` streams intermediate responses on `sessionControl.response`
  keyed by request id. The renderer subscribes before `invoke`, removes the
  listener after settlement, and treats only the final response as completion.
- Before changing public-browser routing, isolation or its callers, read
  [the service boundary](main/services/AGENTS.md#public-browser).
- `services/image-export-service.ts` owns native image menus, clipboard and save
  dialogs; transfer renderer-owned blob bytes once after selection. Keep naming/filters
  in `image-export-core.ts`, testable without Electron. `context-menu.ts` handles
  other right-clicks and yields on images.

## Local file resources

- Markdown link discovery uses the shared resolver after disk-machine validation.
  It returns identities without resources; the selected path is reauthorized on read.

- Electron previews local files directly after matching the target to its on-disk
  machine identity; never require daemon liveness or protocol metadata. Relative
  paths need original workspace root; never guess a substitute. Remote paths
  stay remote. Never expose filesystem paths in resource URLs. `local-file-resource.ts` issues opaque renderer-lifetime
  capabilities, bounded per renderer, revoked on navigation/destruction.
- Each resource read opens a regular file without following a substituted symlink
  and checks device/inode/size/mtime/ctime before and during reads. Replacement or
  modification invalidates the preview; no mixing revisions or writes through resources.
- Text above the editor budget uses fixed bounded Range requests. Binary uses raw
  streams with backpressure/cancellation; PDFs stay binary `application/pdf`, and
  cross-origin readers can inspect `Accept-Ranges` and `Content-Range`.
  Raster header dimensions bound decode cost.
  The scheme never bypasses CSP, executes file content, or authorizes a remote RPC.
- `lody-resource://member/<token>` uses local file IPC for session blobs and
  [LAN member files](../../../.agents/docs/lan-member-connections.md#parts-of-a-file).
  Main holds no member credential/connection; tokens are opaque, bounded and renderer-owned.
  Register its protocol after app load; keep business imports out of the early local protocol.
  Each Range carries the initial revision; changes return 409. Save through an adjacent
  `.part` stream, never a whole-file buffer.
