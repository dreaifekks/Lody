# Main services

History watch deadlines include owner wait/read allowance; ordinary controls keep
shorter deadlines.

File previews need no daemon: local reads `machine-id`, cloud reads only machine
metadata from `credentials.json`. Never require cloud login for local files or expose
other credentials.

Packaged macOS icons use `app-icon-service.ts` preferences/serialized native apply;
renderers pass catalog IDs only. Never edit signed resources/shared dev bundles.
Finder metadata affects strict validation; read the
[icon decision](../../../../../.agents/notes/implemented/feature/2026-09-23-macos-app-icons.md).

`NotificationService` retains delivered notifications until click/close/failure;
`notification-delivery.ts` releases them, never IPC success. See the
[lifetime fix](../../../../../.agents/notes/implemented/bug-fix/2026-09-20-notification-click-lifetime.md).

Badge reports replace absolute contributions, including repeated zero. Discard on
crash/navigation/close; do not bounce again while permission waiting remains nonzero.

Devbar defaults off. Enable only through primary-window hidden Developer Mode or `LODY_DEVBAR=true`
automation. Preserve loopback/CSP. Enabling exposes aggregate MCP/Terminals and local
shell access; disabling removes both.
Filesystem management, code-server, non-loopback binding or remote access requires a
new security/capability decision in the owning
[Spec](../../../../../specs/desktop-devbar.md) and
[Agent Note](../../../../../.agents/notes/implemented/feature/2026-09-16-devbar-hub-ui.md).

`storage-guard.ts` requires both failed Lody write and low Lody-volume space. Only
relaunch/quit clears it; background agents continue.
Read the [decision](../../../../../.agents/notes/proposed/feature/2026-10-22-desktop-disk-full-guard.md).

## Public browser

- `services/public-browser-service.ts` performs engine routing only, with no resolver
  or per-request hostname network guard. Route textual loopback addresses to Managed
  Preview. Public names resolving to loopback still render this machine's loopback;
  do not claim resolution-accurate routing.
- Keep its WebContentsView sandboxed, without preload, script injection, capture or
  agent tools; only the person reads rendered content. Non-human readers (DOM, screenshots or preload bridge) require a network guard.
- Agent-authored Managed Preview pages can request navigation. Keep the existing
  private-LAN destination refusal in `session-browser-panel.tsx`; main cannot
  distinguish page-originated requests from human navigation.
- Run engine routing on both `will-navigate` and `will-redirect`, as in
  `installNavigationGuard` in `window.ts`, so 3xx redirects cannot commit loopback here.

Product-window `beforeunload` vetoes use one native Stay/Leave confirmation in
`../renderer-unload.ts`. Leave overrides only that document. Quit obtains approval
before destroying relays or stopping CLI; Stay leaves the app running. Quit sheets
are asynchronous with visible parents and a runnable fifteen-second deadline. Leave
retries only that document's close; navigation, timeout or destruction cancels the
sheet and fences late replies. Preserve non-quit close/reload behavior. Destroy a
quit-closing window only if its renderer hangs/dies, never during normal close or
to bypass unrelated guards such as unsaved editors.

`../relaunch-intent.ts` calls `app.relaunch()` only at `will-quit`. Canceled quit
settles `cancelled`; IPC withdraws its armed reset so later ordinary quit neither
relaunches nor resets. Relaunch stops embedded CLI and is not default recovery.

Bound each quit renderer close and main resource drain to fifteen seconds. Keep
unconfirmed work with its original owner until exit; log phases without credentials
or causes. Allow a presence-only warning marker at most one second to persist, then
exit nonzero without terminal reporting UI. Next launch shows a nonmodal native
notification; failed delivery retains its marker. A waiter deadline never replaces
custody or clears pending writes. CLI/shell owners must confirm release before main exits.

## Auto-update

- Sparkle load failure falls back to electron-updater. Keep Sparkle UI silent and
  expose progress/install readiness through `ElectronUpdaterState`. Follow the
  [Electron packaging rules](../../../AGENTS.md).
- Install Linux `.deb` asynchronously through `app-updater-linux-install.ts`, never
  blocking `DebUpdater.spawnSync`. Quit only on zero exit; signals mean failure.
  AppImage stays on electron-updater without privileged helpers.
- Keep `phase: 'downloaded'` when `downloadedFile` survives failed checks/installs;
  `recordError` must retain the renderer's retry/install controls.

LoginShellCache Layer owns shell environment; `getUserShellEnvCachedLegacy` is
launcher-only. After unload approval, quit awaits application disposal and CLI exit.
Retain failed process owners for recovery; never replace them with null or bind
successors before release. After failed quit, retry owners once before rebuilding
shell/relays and reopening a window; unresolved owners use the localized quit/retry
dialog. Read the
[decision](../../../../../.agents/notes/implemented/architecture/2026-10-10-effect-login-shell-probe.md).

## E2EE runtime

Read [M1](../../../../../.agents/notes/implemented/architecture/2026-10-21-e2ee-m1-runtime-boundaries.md),
[M2](../../../../../.agents/notes/proposed/architecture/2026-10-22-e2ee-m2-product-integration.md),
[join](../../../../../.agents/notes/proposed/architecture/2026-10-26-e2ee-personal-desktop-join.md)
and [machine](../../../../../.agents/notes/proposed/architecture/2026-10-26-e2ee-machine-pairing-journal.md).
Fence opens and late D03 registration by identity/generation; pin D03 before signing.
Custody belongs to the workspace. Bind reset to account/generation and recheck after
lock/drain before archive. Never use network under locks; drain before release.
Bad keys must still allow ledger open for core repair. Isolate verification/storage
errors; malformed input retains readers. Retain originals before feed/pin, compare
overlaps, preserve checkpoints and await history. Conflicts forbid fallback. Failed
close keeps its fence and reports restart-required. Use fixed cloud refs with auth,
bound identity and abort; fence late disposed calls. Preserve uncertain bytes and
keep raw/SDK causes in main. Verified reads override lost ACKs; cleanup retains
admission. Treat `e2ee_staging_invalid` and `e2ee_staging_corrupt` as terminal.

Consent pins exact verified proofs, session, record, requestId, keys, credentials and
pins. Missing credentials block approval; never export them. Failed begin remains
discoverable. Archive terminal/foreign attempts including pin-only and relay state;
fence same-request unknown/admitting attempts. Retain installed origins, other sessions
and both primary/cleanup causes. Retirement requires the exact superseded socket
receipt and atomic all-null local match; fresh sessions require consent.
Unsigned staging stays pending across windows/retries until verified admission/history
settles, including later revocation; read the
[rationale](../../../../../.agents/notes/implemented/bug-fix/2026-10-27-e2ee-local-pairing-recovery.md).
Verify pinned endorsement/self-admission before snapshot binding/pin/cursor; allow
sparse positions. Obtain keys from verified mailbox/history; committed epochs may use
staging. Staging denial/I/O cannot block mailbox receipt. Show file protection, keep
socket timeouts pending, and await CLI current-key installation. Only rotate resumes
candidates. Keep errors transport-free.

Machine sharing uses the lazy host in `packages/e2ee-machine-sharing`. Passive cache
inspection reads existing entries only, never `openWorkspace`/`readMachineSharing`.
Counts are diagnostics, not execution authority. Policy errors affect dependent
execution only. Invalidate sharing before exposing changed verified ledger heads/counts;
unchanged ingest preserves freshness. Narrow read/update methods retain keys/device
credentials in main. Read the
[policy decision](../../../../../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.md).
