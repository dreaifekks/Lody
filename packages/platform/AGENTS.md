# Platform composition contracts

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

These rules also bind callers changing platform assembly, capability-gated settings,
telemetry, or managed-runtime downloads, as routed by the root instructions.

## Composition and capabilities

- Settings must represent real platform support: local hides cloud usage
  (`usageAnalytics`), shows what its machines count themselves (`localUsage`), and
  omits machine selection when `remoteMachines` is absent. PR details, actions
  and PR-driven auto-archive follow `githubPullRequests`, which the local
  desktop backs with its machine's own `gh` login; the hosted repository
  registry stays behind `githubIntegration`. `localGitHubCredential` gates the
  local Settings > GitHub (each machine's credential, the LAN hub's token) and
  the entries that lead there; the page sends the token in and shows none back. Static
  conversation sharing follows `teamSharing` through the hosted service, else
  `lanSharing` (local), which publishes to a LAN's own hub and appears only in a
  LAN workspace; `teamSharing` stays off locally, as it also gates team
  visibility. Gate entries and their background work through capabilities rather
  than build-kind or environment checks.
- Shared packages stay platform-neutral. The public Electron composition
  selects `local` explicitly; private Web/mobile entries and cloud composition
  roots may inject `cloud` without forking those shared packages.
- The OSS desktop entry is local-only and must not make authenticated product-cloud requests;
  public managed-runtime artifact downloads are the explicit exception.
- An absent platform selector resolves to `local`; public build scripts must
  not accept or discover staging/production deployment presets.
- Local CLI, renderer, and Electron-main telemetry is hard-disabled even when
  unrelated PostHog variables exist in the caller's shell.

## Streams token capability

- Only official cloud composition constructs Streams token ports. Native
  `createTokenProvider` requires the consumer's Scope; dispose those providers
  before disposing the cloud port. Promise consumers retain visible
  `createTokenProviderLegacy` / `LoroStreamsTokenProviderLegacy` names and await
  close. A failed token release retains its owner/Cause and blocks handoff until
  explicit recovery. Contract: [token ownership](../shared/src/loro-streams-token/AGENTS.md).

## Managed runtime channel

- Managed runtime downloads default to the public R2-backed channel owned by
  `packages/platform/src/runtime-artifacts.ts`; local and cloud assembly must use that
  same constant. `LODY_RUNTIME_BASE_URL` is only an explicit mirror override.

## Host identity keys

- `./host-keys` is host-only and remains unconnected until the crypto and host
  adapters are reviewed. CLI assembly receives machine identity only; never grant
  it personal management operations. No generic private export or arbitrary signing.
- Failure, scope close, logout and ordinary cache cleanup must not delete identity
  keys. Preserve uncertain failure reasons and writes; no plaintext-file fallback.
- Native fixtures use random UUIDs and isolated test keychains only. Verify exact
  cleanup; never change user keychains or global settings. See [validation](README.md).

## LANs

- A LAN is a self-hosted hub whose members share one user; its credential never
  reaches a renderer or a log. Before changing LAN settings, identity, the hub
  bridge, member terminals, files and folders, requests between members, updates
  or the fork build, read [LANs](../../.agents/docs/lan.md). A fork build follows only
  the releases of the repository that built it, installs only a later build, and
  checks every file against the release's manifest before anything is replaced.

## Agent-authored configuration

- Agent Role and Schedule writes (`lody_agent_role_create/update`,
  `lody_schedule_create/update/resume`) are Session tools capped at the invoking
  Session's permission tier (each Role instance): the lowest of the live Agent's options,
  its persisted report (both ranked as reported) and the driving Turn's dispatch config; dispatched
  configs get dispatch's builtin default first (`permission-tier.ts`). Written and
  stored configs (a Schedule's Role as resolved now) and a chat a Schedule sends into
  stay within it.
  Unknown (no capability, unset permission option beside the mode, unoffered
  default) is left to Settings or `lody_schedule_propose`. Builtin Pi is exempt
  (user's choice): any caller may write it; as a caller it counts as full. No credential option,
  memory binding or deletion. Each successful write, retries too, sends one notice id
  (`agentConfigNoticeId`) to Session and devices, outside `lody_notify_user`'s gates.
  MCP only: [CLI and known limits](../../apps/cli/src/mcp/README.md#agent-config-writes).

- LAN platforms keep Roost history authoring disabled, including the experiment UI.
