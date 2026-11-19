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

The disk-full guard (`storage-guard.ts`) requires a failed Lody write AND low space
on a Lody data volume. Space alone never blocks. Only relaunch/quit clears it;
background agents keep running
([decision](../../../../../.agents/notes/implemented/feature/2026-10-22-desktop-disk-full-guard.md)).

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

Product-window `beforeunload` vetoes always show native Stay/Leave confirmation
(`../renderer-unload.ts`). Leave ignores only that document's veto. Quit closes
windows before relays or CLI; Stay cancels quit with the app running. The asynchronous
sheet has a visible parent. If unanswered after fifteen seconds, cancel quit and
retain the window. Leave starts a fresh fifteen-second closing budget. Navigation,
cancellation and destruction invalidate late answers. Non-quit close/reload behavior
stays unchanged. A hung or dead renderer is destroyed so quit remains bounded.
Never bypass unsaved-editor guards or destroy a normally closing window.
A renderer-requested relaunch (`../relaunch-intent.ts`) calls `app.relaunch()` only at
`will-quit`; a quit the barrier cancels settles `cancelled`, and the IPC caller
withdraws any reset request it armed, so a later ordinary quit neither relaunches nor
resets. Relaunching quits the embedded CLI: never make it a default recovery step.

Quit bounds each renderer closing attempt and main-owned resource drain to fifteen seconds.
Unload diagnostics use fixed unsaved-editor, pending-send or unknown categories.
Unconfirmed work keeps its original owner until main exits. Log it, give a
presence-only warning marker at most one second to persist, then exit nonzero
without terminal reporting UI. Next launch delivers a nonmodal native notification; failed
delivery retains the marker. Never replace custody or clear pending writes
on a waiter deadline. CLI and shell process owners must still confirm release
before main can terminate. Quit diagnostics name phases, never credentials or causes.

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
Retain failed process owners; never null them or bind successors before release.
Retry failed quit owners once before shell/relay rebuild and window reopening.
Unresolved owners use the localized quit/retry dialog. Read the
[decision](../../../../../.agents/notes/implemented/architecture/2026-10-10-effect-login-shell-probe.md).

## E2EE runtime

Read [M1](../../../../../.agents/notes/implemented/architecture/2026-10-21-e2ee-m1-runtime-boundaries.md),
[M2](../../../../../.agents/notes/proposed/architecture/2026-10-22-e2ee-m2-product-integration.md),
[join](../../../../../.agents/notes/proposed/architecture/2026-10-26-e2ee-personal-desktop-join.md),
[machine](../../../../../.agents/notes/proposed/architecture/2026-10-26-e2ee-machine-pairing-journal.md)
and [bootstrap](../../../../../.agents/docs/e2ee-workspace-bootstrap.md).
Fence opens/late D03 registration by identity/generation; pin D03 before signing.
Workspace custody; reset binds account/generation; recheck after lock/drain before archive.
No network or proxy lookup under locks; drain before release. Bad keys allow ledger open; core repairs.
Account turns share the account barrier and lock only their identity directory; account switch, close, identity cleanup and account reset hold it exclusively, draining and fencing turns. Work must never re-enter it.
Recovery keeps completed anchors; unfinished rebinding needs verified same-device admission and archived originals.
Isolate verification/storage errors; bad input keeps readers.
Originals precede feed/pin; compare overlaps, retain checkpoints, await history.
Compaction failures warn only; retry after 64 records, keeping originals/pins.
Conflicts refuse fallback. Failed close retains its fence; report restart-required.
Opens join a closing workspace's drain once, outside the lock; never `closed`.
Fixed cloud refs; auth/bound/abort; fence late disposed calls. Keep uncertain bytes; raw/SDK causes stay in main.
Verified reads beat lost ACKs; cleanup keeps admission. `e2ee_staging_invalid` and `e2ee_staging_corrupt` are terminal.

Consent pins exact verified proofs/session/record/requestId/keys/credentials/pins.
Missing credentials block approval; never export them. Failed begin stays discoverable.
Archive terminal/foreign attempts, including pin-only+relay; fence same-request
unknown/admitting. Retain installed origins, other sessions and primary/cleanup causes.
Retirement needs exact superseded socket receipt and atomic all-null local match;
fresh sessions need consent. Unsigned staged material stays pending across windows/retries
until verified admission/history settlement (including revocation); see [rationale](../../../../../.agents/notes/implemented/bug-fix/2026-10-27-e2ee-local-pairing-recovery.md). Verify pinned endorsement/self-admission before snapshot binding/pin/cursor; allow sparse positions. Keys use verified mailbox/history; committed epochs may use staging. Staging read
denial/I/O cannot gate mailbox receipt. Show file protection; socket timeout stays pending. Await CLI current-key install.

Only rotate resumes candidates. Keep errors transport-free.

A content frame the verified ledger has not caught up with (an epoch at most four
ahead, or an unknown author at the current epoch) opens as retryable `key-pending`; the
portable session applies the same bound, and frames further ahead keep their original
failure. The shared content adapter's refresh catches up, at most once per interval.

The iroh client (`e2ee-iroh.mts`) lives with its workspace entry and follows [these rules](../../../../../packages/iroh-native/AGENTS.md).

Machine sharing uses `packages/e2ee-machine-sharing`.
Passive inspection uses existing entries only; never call openWorkspace or
readMachineSharing there. Counts are diagnostic, not authority.
Policy errors affect dependent execution only. Invalidate sharing before exposing changed
verified heads/counts; unchanged ingest keeps cache freshness. Narrow read/update methods keep keys
and credentials in main; see [policy](../../../../../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.md).
