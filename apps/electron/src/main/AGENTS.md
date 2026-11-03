# Electron main process

Edit `AGENTS.md`; `CLAUDE.md` symlinks here.
Parent [module rules](../AGENTS.md) apply.

Main authentication uses `auth-fetch.ts` with Electron Chromium networking after
app readiness. Preserve Better Auth cookie hooks and cancellation; never bypass
certificate verification. Behavior: [login Spec](../../../../specs/desktop-browser-login.md).

`AuthService.getSession` preserves the durable-cookie retry result after a rejected
renderer bearer; never replace network/5xx failure with the earlier 401. Cache identity
by auth generation, clearing only on explicit sign-out or definitive rejection. Its
five-second timeout bounds callers, not requests: late results seed cache only if no
answer/rejection committed since request start in that generation. `getSessionToken`
treats unreachable verification as no verdict, uses durable cookie then supplied bearer,
and never starts a second check.
For E2EE directory selection, `auth-storage.ts` retains token-hash/user-ID binding
without expiry. `getCachedSessionIdentity` requires a matching device cookie or bearer;
it grants neither cloud access nor ledger authority. Matching bearers may seed the
in-memory token for later E2EE calls. Notify identity observers only on confirmed changes;
transport uncertainty neither clears binding nor signs out. Renderer bootstrap snapshots
keep their seven-day lifetime.

## Diagnostics

Resource links use `lody://` across channels. Never replace existing handlers; packaged
Windows fills absent handlers on first launch. Forward legacy cloud routes only to
Stable's private alias; OSS never exchanges cloud credentials. Keep callbacks
channel-specific. Validate session resources before dispatch and preserve explicit
workspace identity. Provider import URLs stay installation-local and stage confirmation
only, never cloud auth or Provider writes. Contract: [Magpie import](../../../../specs/magpie-provider-import.md). See [deep links](../../../../specs/deep-links.md).

On cross-channel lease conflicts, hand channel-neutral `session`, `chat/new` or
`provider/import` destinations to the running owner over the bounded lease before
quit. ACK only after binding its launch handler; refused startup rejects handoff.
Never hand off auth/cloud callbacks or load credentials/business modules.

`desktop-log.ts` synchronously writes main console/lifecycle and CLI supervision to
the CLI daily log. Never persist credentials or spawn arguments; redaction is only a backstop. See the [tracing decision](../../../../.agents/notes/implemented/feature/2026-09-25-daily-log-crash-and-stall-tracing.md).

## Prepared windows

macOS local preparation shares the opt-in spare slot. Bind readiness to sender/target/
generation and cancellation to its source request. Expire unclaimed views; destroy on
source close. Claim adopts identity/reload target without remounting. Activate renderer
effects only after native show.
The [window Spec](../../../../specs/desktop-windows.md) owns the behavior contract.

## Startup theme

- Open product windows on the committed theme. `theme-settings.ts` feeds
  `getInitialMainWindowThemeSource` before BrowserWindow creation for native frames
  and win32 overlays; CSP-hashed boot owns `.dark`. Previews never write the store.
  All import/startup `conf` stores use `createSettingsStoreWithFallback`, or
  `createMainSettingsStore` for new userData stores, so malformed files do not stop launch.

## E2EE key custody

`e2ee-custody.mts` uses Electron OS protection for core custody: explicit Scope,
wrapped KEK and XChaCha20-Poly1305 blobs. It neither joins renderer IPC registration
nor starts at bootstrap. Explicit E2EE IPC creates/reopens account-bound pending
requests and workspace runtimes, exposing public state and room-bound seal/open only.
Keep device credentials in main; forbid arbitrary signing/content-key export. Reject
local composition before auth/native access and check the main account session.
Encrypted adapters support Meta, Loro documents and owning workspace/machine/Code Collab
index/signal Flocks only; close unsupported rooms/plaintext side channels.
`e2ee-custody-electron.ts` gates native factory readiness. Reject unavailable encryption
and Linux `basic_text`/unknown backends; never use cookie plaintext overrides or files.

New content seals prefer installed current keys inside core, never renderer hints.
Only genuine absence permits retained published keys within the durable fifteen-minute
observation budget; exhaustion fails for retry. Keep sealed old frames and history. See the [sealing decision](../../../../.agents/notes/implemented/architecture/2026-10-27-e2ee-epoch-receive-barrier.md).

Authenticate all installed/candidate bindings as AAD and encrypt them in core payloads.
For new workspaces, `prepareDevice` signs local genesis only; call
`retainDevice(actualGenesis, prepared)` before network/CAS. Failed preparation calls
`discardDevice`, never deleting retained originals. Encrypt private keys on disk and
import nonextractable native handles; never persist Recovery secrets.
Hand custody to `@lody/e2ee-core` only through `desktopE2eePorts` (KeyProtector,
CandidateProtector, DeviceIdentity); keep the two protection purposes distinct.
Caller-owned recipient handles must remain within the custody owner's Scope:
WebCrypto provides no deterministic handle destruction or JS-string erasure.
Before shutdown, stop admission, drain native work and clear owned KEK bytes. Failed
opens preserve originals without deletion/migration. Recover interrupted rewrap only
from validated same-key wrappers under the native OS mutex; PID/age never proves
lock ownership and failure never generates replacement KEKs.

`services/e2ee-bootstrap.mts` commits immutable intent/signed genesis before retaining
device/epoch keys; return only after native reopen and core commitment verification.
Retries preserve original bytes/metadata. Incomplete writes, unknown outcomes or corruption
never replace/delete keys. SQLite owns the cross-process mutex; drain admitted native
work before release. This workflow has no network or plaintext data-plane activation.

Synthetic safeStorage tests use real crypto/filesystem and another process; they
do not prove OS-keychain or all-platform packaging. Native assurance requires an
isolated platform run.

`e2ee.readIdentity` reads retained verified identity bound to the expected account,
granting no renderer reader/status/content capability. Preserve existing readers and
release cold temporary hosts before replying. `status` requires a window reader.

`services/e2ee-member-join.mts` retains exact KeyPackages/signed admissions before
I/O. Unknown outcomes never replace them; verify competing ledger bytes or terminal
server reservation before retirement. New accounts replay genuine history from their
retained genesis; server labels cannot establish native identity. [Decision](../../../../.agents/notes/proposed/feature/2026-10-28-e2ee-team-joining-native.md).
Approval never awaits a key round: `E2eeIpc` owns later delivery and retries it from
due polls ([delivery](../../../../.agents/notes/proposed/feature/2026-10-28-e2ee-team-joining-native.md#key-delivery-after-admission)).

Removal erases `member_joins`/`personal_join_histories`. All three join installs
clear removal only after verifying a different retained signing key. Only parsed
HTTP 560 `e2ee_member_removed`/`e2ee_device_revoked` from credential-bound endpoints
produce `E2eeMemberRemovedError`/`E2eeDeviceRevokedError`. JWT/transport/parsing or
unrelated endpoint failures never authorize cleanup, regardless of matching codes.
Project typed results and causes to exact codes with `accessLoss`. Revocation uses
device-bound removal receipts/cleanup, records its reason and stays terminal until
re-pairing replaces the key. Failed local operations, including dispatch, confirm loss
with this device credential. Dispatch requires its calling reader. Unless another
reader owns them, drain temporary status hosts outside the account lock on every
exit, including failed identity rechecks.
[Decision](../../../../.agents/notes/implemented/architecture/2026-10-30-e2ee-desktop-device-revocation.md).
