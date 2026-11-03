# Platform composition contracts

Edit `AGENTS.md`; `CLAUDE.md` symlinks here.

## Composition and capabilities

- Gate UI entries and background work on capabilities. Local enables `localUsage`,
  hides `usageAnalytics`, and hides machine selection without `remoteMachines`.
  `githubPullRequests` uses local `gh`; `githubIntegration` gates the hosted registry.
  `localGitHubCredential` gates GitHub settings and links; credentials are input-only.
  Hosted sharing uses `teamSharing`; local LAN hub sharing uses `lanSharing` only in
  LAN workspaces. Keep `teamSharing` and its team visibility disabled locally.
- Remove the legacy PR auto-archive setting. Granted local Automations may archive
  through local Host authority without cloud access; follow the [contract](../../apps/cli/src/automations/README.md).
- Shared packages stay platform-neutral. The public Electron composition
  selects `local` explicitly; private Web/mobile entries and cloud composition
  roots may inject `cloud` without forking those shared packages.
- The OSS desktop entry is local-only and must not make authenticated product-cloud requests;
  Public runtime downloads are the exception.
- An absent platform selector resolves to `local`; public build scripts must
  not accept or discover staging/production deployment presets.
- Local CLI, renderer, and Electron-main telemetry is hard-disabled even when
  unrelated PostHog variables exist in the caller's shell.

- `E2eeRuntimeFactory` synchronously borrows an application-owned runtime port.
  Keep factory calls pure: acquire no custody, perform no I/O, and create no Effect
  runtime during React render. The application retains its Layers/executor through
  confirmed retirement. Its read-only live session is account routing, never device
  approval. Local and Electron compositions retain their existing owners.

## Telemetry privacy

- E2EE and unconfirmed workspace scopes must not record or upload replay. Only a
  matching account, route, workspace and verified plaintext descriptor may enable
  it; an ordinary provisional runtime or listing is not plaintext proof. Pause
  before switching targets and discard buffered work across that boundary.
- Automatic exceptions in those scopes use a fixed diagnostic vocabulary. Shared
  main/daemon processes cannot infer one workspace mode and always use that
  vocabulary. Preserve detailed local, user-submitted support reports.
  [SDK buffering rationale](../../.agents/notes/implemented/bug-fix/2026-10-29-workspace-telemetry-privacy.md).

## Streams token capability

- Only official cloud composition constructs product-cloud Streams token ports;
  LAN ports use their self-hosted hub. Native
  `createTokenProvider` requires the consumer's Scope; dispose those providers
  before disposing the cloud port. Promise consumers retain visible
  `createTokenProviderLegacy` / `LoroStreamsTokenProviderLegacy` names and await
  close. A failed token release retains its owner/Cause and blocks handoff until
  explicit recovery. Contract: [token ownership](../shared/src/loro-streams-token/AGENTS.md).

## Managed runtime channel

- Local and cloud runtime downloads use the public R2 constant in
  `src/runtime-artifacts.ts`. Only `LODY_RUNTIME_BASE_URL` overrides it for mirrors.

## Host identity keys

- `./host-keys` is host-only and remains unconnected until the crypto and host
  adapters are reviewed. CLI assembly receives machine identity only; never grant
  it personal management operations. No generic private export or arbitrary signing.
- Credential-confirmed member removal, and credential-confirmed revocation of this device, are the explicit retention exceptions: match the originating identity, drain only that workspace and erase that identity's local content/keys. Device revocation keeps membership and allows re-pairing. Ordinary failures never authorize deletion.
- Failure, scope close, logout and ordinary cache cleanup must not delete identity
  keys. Preserve uncertain failure reasons and writes. Personal devices never use file protection; machine-only custody may select file protection at first creation under the owner-approved M1 policy, never on reopen.
- Native fixtures use random UUIDs and isolated test keychains only. Verify exact
  cleanup; never change user keychains or global settings. See [validation](README.md).

## LANs

- LAN members share one user per self-hosted hub. Keep its credential out of
  renderers and logs. Read [LANs](../../.agents/docs/lan.md) before changing LAN
  identity, settings, transports, updates or builds. Fork updates follow only the
  build repository, accept only newer builds and verify every file against its manifest.

## Agent-authored configuration

- Session tools `lody_agent_role_create/update` and `lody_schedule_create/update/resume`
  cannot exceed the invoking permission tier for any Role target, resolved Schedule
  Role, stored config or destination chat. Use the lowest of live Agent options,
  persisted report (both ranked as reported), and driving Turn dispatch config;
  apply builtin dispatch defaults first (`permission-tier.ts`). Unknown capability,
  permission option or default requires Settings or `lody_schedule_propose`.
  Builtin Pi is exempt and counts as full when calling. Do not write credential
  options, memory bindings or deletions. Each successful write, including retries,
  sends one `agentConfigNoticeId` to Session/devices outside notification gates.
  Follow the [MCP contract](../../apps/cli/src/mcp/README.md#agent-config-writes).

- LAN platforms keep Roost history authoring disabled, including the experiment UI.

## E2EE workspace control

- `e2eeWorkspaces` is an optional cloud control port; `prepareCreation` exists only
  with persistent host custody. It is separate from the unconnected `./host-keys`
  experiment. The developer preference gates new creation, not existing reads.
- Keep request identity and original genesis across unknown results. Never expose
  private keys, silently replace interrupted preparation, or infer plaintext from
  missing mode fields. A retained encrypted identity rejects mode downgrade.
- A workspace without encrypted evidence may open its local Repo while `describe`
  runs in the background. Unknown mode never authorizes ordinary body egress:
  transports, RPC, attachments, accepted sends and copies wait for authenticated
  classification. Retained immutable account/workspace admission preserves ordinary
  offline access. An encrypted or contradicting answer retires the provisional
  runtime; encrypted evidence still requires admission before opening content.
- Control-only encrypted workspaces must not acquire ordinary content/execution
  transports. Before changing creation, mode admission, cache cleanup or ledger UI,
  read the [bootstrap guide](../../.agents/docs/e2ee-workspace-bootstrap.md).

- Optional `memberProfiles` is a display directory scoped to the live account and
  workspace. Resolve its crypto user IDs through verified ledger members; it cannot
  grant permissions, pin keys, identify the creator, or block ledger availability.
- Account-only machine-policy display reads return opaque ciphertext and untrusted
  metadata. They never replace device-authenticated execution freshness, and a
  server removal tombstone never substitutes for a verified policy-history pin.

- `e2eeMachineScope` is an explicit single-workspace machine-service composition.
  It has no ordinary Streams/account capabilities or account catalog bootstrap.
  Fleet admits only that encrypted workspace and pinned genesis; device-auth discovery
  and the encrypted runtime own access and protected Streams tokens respectively.
- Optional `runtime.readIdentity` returns only workspace ID/genesis from the expected
  account's retained verified ledger, releasing its temporary read before replying.
  Missing capability fails closed; never fall back to unleased `status`.
