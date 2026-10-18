# Development conventions

## Local macOS test application

On an Apple Silicon Mac with Xcode command-line tools, the supported Node version
and Corepack, use a dedicated clone whose `origin` is your fork:

```sh
bash scripts/mac-local-test-build.sh
```

Quit **Lody Test** before rerunning. The script fetches and merges `origin/lan-hub`
into the current branch, updates submodules, installs the frozen dependencies,
prepares ACP adapters, builds and packages arm64 only, then opens
`apps/electron/dist/local-test/mac-arm64/Lody Test.app`. Resolve merge conflicts
in that clone normally. Dependencies and build caches are retained; the renderer
still rebuilds. Nothing is installed into `/Applications`, tagged or published.
No signing identity, notarization or DMG is used. The existing packaging hook
retains ad-hoc signing for local execution; it uses no certificate or Apple account.

The build-time test profile isolates the app ID (`dev.loro.lody.test`), protocol
(`lody-test`), userData/single-instance lock (`~/Library/Application Support/Lody Test`),
adjacent desktop stores (`lody-test-desktop`), CLI data (`~/.lody-test`) and CLI host
port (`27789`). These defaults are baked in, so opening the app from Finder needs
no environment variables. The CLI port uses `LODY_LOCAL_CLI_HOST_PORT`, which
isolates the endpoint without E2E behavior. The packaged desktop follows its normal
startup and single-instance path, and Codex keeps its normal home directory.
The build has no LAN release stamp and therefore follows no release updater.

The test installation starts empty and does not copy credentials or join a LAN.
An independent data root gives it a new machine identity. Joining a real LAN in
Settings shares its live writable catalog; it is not a read-only preview and may
run catalog reconciliation. Prefer an isolated LAN/snapshot for migration tests.
Join the real LAN only when that shared-data effect is intended, using a distinct
machine name. Never point this app at the installed application's data directory.

## Platform boundary

The OSS desktop composition is local by construction. Platform selection is
performed once at the process/app entry and is immutable for that lifetime.

- Shared UI calls optional online features through `PlatformProvider` and
  capability-owned operation descriptors.
- The CLI receives one `CloudPort`; local mode uses `createLocalCloudPort` and
  does not construct cloud clients or background services.
- An absent platform selector means `local`. Public commands do not load
  deployment-specific dotenv files, and hosted adapters must inject every
  gateway or artifact URL explicitly.
- Local mode never initializes telemetry, regardless of generic PostHog
  variables inherited from the developer shell.
- A missing capability is represented explicitly and an attempted call fails
  at the public boundary. Do not add silent fallbacks.
- `@lody/cloud-api` contains only public client protocol names and DTOs. Never
  import generated server declarations or implementation modules into it.

The public boundary is executable: `pnpm check:public-boundary` rejects private
workspace dependencies and internal-only repository paths. Platform adapters
must remain explicit at composition roots; shared packages consume only public
capabilities, ports, operation descriptors, and DTOs.

## State and side effects

Jotai atom read paths must remain synchronous and side-effect free. Network,
storage, subscriptions, timers, and runtime lifecycle belong in React effects
or an explicitly disposable runtime/provider.

Write-only atom naming communicates behavior:

- `cmdXxxAtom` may invoke an external side effect and may fail.
- `setXxxAtom` performs only synchronous in-memory state writes.
- ordinary `xxxAtom` values are state or pure derivations.

Long-lived resources such as Loro repositories, transports, room watches, and
control connections must have structured cleanup owned by their provider.

## Error handling

- Treat `null`, unavailable capabilities, and bootstrap states as first-class
  types; do not hide them with `@ts-ignore`.
- Fail early on corrupt local identity/catalog state. Only a genuinely missing
  first-run catalog may enter the creation/wait path.
- Do not replace protocol or configuration errors with guessed defaults.
- Missing managed-runtime or Streams endpoints are configuration errors and
  must fail before any network request.

## Quality

- Tests must be deterministic: no real sleeps, network access, or
  scheduler-dependent assertions.
- Never commit real user/agent transcripts as fixtures. Use synthetic data that
  contains no private paths, tokens, repository content, or personal data.
- Run `pnpm format` before committing. The normal full validation command is
  `pnpm check`; use narrower type/build/static checks while iterating.

## Effect lint

`pnpm lint:effect` shows Effect correctness and function-style warnings and runs
inside `pnpm check:quick` and `pnpm check`. It keeps `lint:fast` syntax-only.
See the [Effect guide](.agents/docs/cli-effect-ts.md#effect-lint) for installation,
file selection, and the initial advisory policy.

## Documentation

Public contributor constraints belong in the nearest scoped `AGENTS.md` or a
self-contained source comment. Internal context, plans, specifications, task
records, and closed-service implementation details stay in the private
repository.
