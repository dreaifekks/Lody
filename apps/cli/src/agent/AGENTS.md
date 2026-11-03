# apps/cli/src/agent

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Read [README](README.md), context/acp-protocol.md and context/acp-agent-edit-evidence.md;
[CLI rules](../../AGENTS.md) cover adapter repositories.

## `agent-client.ts`

- Consume Core extensions via `agentCapabilities._meta.lody`, session `_meta.lody`, and
  `_lody/...`. Provider/pre-Core readers stay in `lody-acp-extension.ts`; consumers stay neutral.
- Grok Always Approve uses allow_once, never lasting grants. Accepted config changes
  drain pending calls through durable permissions; questions stay interactive. Default
  builtin Grok terminal capability to false. Map ACP ENOENT to RequestError.resourceNotFound;
  preserve other errors/Session validation, never empty-content fallback.

- Send the driving model/config as `_meta.lody.sessionConfig` on establishment;
  adapters own provider translation. Successful session/set_config_option changes become
  replacement startup state. Cache `_meta.lody.modelReasoningEfforts` for Codex model[effort].
  Setup, set_config_option responses and config_option_update project configOptions:
  present values (including []) replace snapshots; omission alone uses the requested
  value. Update replacement state and currentValue. Convert Core goal epoch seconds
  to durable milliseconds and limited to blocked.

- Keep both builtin lody MCP transports; never execute MCP tools inside the daemon.

- MCP HTTP binds loopback with a bearer token. On Linux verify peer uid through
  /proc/net/tcp{,6}; refuse unprovable peers or unreadable socket tables.
  LODY_MCP_HTTP_DISABLED=1 forces stdio. Its explicit env allowlist preserves
  LODY_AUTH_URL, LODY_AUTH_SITE_URL and LODY_SERVER_URL for cloud orchestration;
  local assembly clears them before startup. Never add CLI credentials or secrets.

- Pass the same MCP config on initial and replacement DeepSeek Harness sessions.
- Resolve MCPs before initialize. Before remote baseline, complete selected rows may start
  with a warning. Missing rows retain the typed cold error, reload once before Provider
  Session establishment, then fail if still missing. Check completeness before auth
  preparation so rechecks cannot repeat it.

- Acknowledged steer ends `applied`, `not-applied`, or `unknown`. Only adapter proof maps
  `not-applied`; transport/process ambiguity stays `unknown`. Await the request answer even
  after the turn response; Session execution never classifies provider errors.

## Launch and runtimes

- `acp-runner.ts`: spawn + initialize + `newSession`/`loadSession` go through
  `acp-session-start-gate.ts` (default 2, `LODY_MAX_CONCURRENT_ACP_SESSION_STARTS`). Never bypass
  that gate.
- Builtins use `setting.ts`'s `resolveACPProcessLaunchAsync()`. [Codex profiles](../../../../specs/codex-account-profiles.md)
  forbid upstream keys in shared/child env. Process records delay deletion, never
  restrict same-profile concurrency.
  Catalog scans skip unreadable profiles with one warning per file; selected-account validation stays strict.
- DeepSeek Harness is unmanaged: no download/prefetch/override/auth; retain npx argv
  for recovery. On Windows use npm JS, not cmd.exe; keep npm/forwarder/DSH/Job children
  windowless with stdio/env/containment intact. Verify pinned Node in child cwd, without
  Electron fallback. Isolate homes by Provider id and preserve YAML/settings/history under
  the [contract](../../../../specs/deepseek-harness-settings.md). Credentials stay in env;
  models/reasoning follow Agent requests, permissions follow Harness presets.
  Mount/recompose agent_preset via AgentPresets only before the first prompt. Per-Agent
  ACP stdio/HTTP MCP belongs in the adapter. Never modify JSONL; mixed-root errors name
  both paths.

- Pin native runtimes only in <name>-runtime-manifest.json. Reject mismatched versions,
  unknown legacy fields and duplicate pins without weakening schemas. Read Claude metadata
  from the adapter SDK, not dev SDK. Definition drift is a cache miss; cleanup/update scans
  are best effort. Grok/Devin never build official binaries; desktop cannot depend on Kimi's
  workspace. Gate custom methods by capability. Inject CloudPort.runtimeArtifacts.baseUrl;
  never derive channels/read deployment env. LODY_RUNTIME_BASE_URL is only a mirror override.

- Invalid caches cannot launch; status warns and reports absence. Repairs publish
  verified generations without moving paths. Status/install/launch use the same
  pin/host filtering and ranking of base/completed generations. Preserve unreadable
  originals and generations with unknown readers. Downloads stop at 60s idle, but have
  no total progressing deadline; later calls resume retained bytes.

- Installations share one download with independent leases; only last cancellation aborts
  fetch/checksum/extraction. Retry waits for aborted-generation scratch cleanup before reuse.
  Tar/ZIP use the shared abort signal. ZIP cancellation destroys yauzl, joins relay/output
  and awaits the reader's real close/error before cleanup, never the destroyed endpoint.

- Builtin Dimcode is user-installed.
- `npx-cache.ts`: ACP `npx` spawns force `npm_config_cache`/`NPM_CONFIG_CACHE` to the active
  profile's `npm-cache`. Automatic `_npx`/`_cacache` cleanup is allowed ONLY for that Lody-owned
  cache. Cold initialize timeout never authorizes clearing `_cacache`; whole-cache
  recovery requires a corruption signature. [Recovery decision](../../../../.agents/notes/implemented/bug-fix/2026-09-20-acp-authenticate-queue-lane.md).

## `acp-authentication.ts`

- The per-agent slot covers preparation and the child; cancel/timeout wins through cleanup,
  terminates the process, and releases Retry. Stop the process before success.
- Authorization data must never enter logs, chat, Flock, or config; raw provider output and
  secret defaults must never reach retained progress.
- Claude capability refresh runs its native status command first so missing credentials surface
  as structured auth-required state before adapter startup; explicit environment-authenticated
  paths bypass it.
- Registry/custom/Devin authentication has no terminal capability; run only agent methods.
  Reject env_var; terminal auth requires an interactive Machine RPC bridge. Keep methods
  and elicitations on the original request, with one pending interaction and reply ids.
  Remote authentication-input is encrypted. Bound form schemes, sizes, ids, labels,
  options and defaults within one serialized-byte budget before progress publication.

- Use initialize auth methods for sign-in, record them on the Provider capability row
  and let readers select. Machine RPC accepts only persisted Provider configId. Freeze
  machine/CLI/agent/launch/env/runtime before spawn or refresh; replies cannot replace it.

## Capabilities and titles

- Static builtin capabilities exclude overrides. Cache by agentConfigId/launched version
  and carry the id in requests/responses. Only probes replace Provider previews; actual
  commands stay in Session control. Aborted probes never write; updates never hot-swap
  ACP; Flock ignores fetchedAt. Probes own unique temporary workdirs, never inherited cwd
  or projects. Remove them after shutdown, including failure/cancellation, without replacing
  probe errors. Keep Provider homes unchanged.

- Core sessionTitle v1 owns post-init titles except Codex, whose titles/settings Lody
  owns. Accept generated/explicit, never fallback/unset. Only legacy managed Claude/Grok
  without overrides accept untagged titles. Strip internal instructions and keep user titles.
  Isolated generation accepts absent phases, prefers final answers, discards commentary/
  pre-prompt text and sanitizes output. Follow [title rules](README.md#session-titles).

- NEVER derive a git ref from prompt text: refs reach the remote and no filter proves a
  prompt secret-free. Worktree sessions keep their allocated ref unless the agent renames it.

## Shell

LoginShellCache lives in the app root. Legacy binds it; no Promise cache/timer.
Reader cancellation preserves siblings. Await disposal; replace only after release.
[Decision](README.md#login-shell-cache).
