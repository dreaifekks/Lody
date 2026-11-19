# Antigravity runtime and quota ownership

Status: draft
Translation: current

[中文](antigravity-runtime.zh.md)

New Antigravity Providers use Lody's pinned managed agy CLI, with telemetry and
automatic updates disabled. A configured `antigravityPath` selects the user's own
executable. Persisted `registry/antigravity-acp` Providers remain runnable through
the fork's agy CLI distribution while staying hidden from new-Provider discovery.
This transition must not rewrite Provider identities, conversation IDs or user data,
or return existing fork Providers to the former plugin-less ACP server.

Both identities obtain quota from their selected executable and account environment
through `agy --print /usage --output-format json`, without a model turn or ACP quota
conversation. Preserve all named model groups and windows. The daemon no longer
reads the old ACP token or directly queries Cloud Code. Unsupported launch arguments
must not be dropped to obtain quota from a different account.

Apart from `yolo`, Lody adds no permission mode to agy's own: approval in `auto`
is agy's sandbox and reviewer, shaped by the machine's agy permission rules. Lody's
former Auto Review is removed; sessions, Roles and schedules saved with it run in
agy's native `auto`. Both identities receive the HTTP MCP capability correction.
Session titles belong to agy; Lody must not create another conversation to title it.
Only a session selecting `yolo` adds `--dangerously-skip-permissions`. Switching
into or out of it replaces only that session's agy process. Provider-level skip
settings are hidden and their stored override is ignored for launch, so parallel
`auto` sessions do not inherit bypass. The upstream schema and protocol field may
remain for compatibility.

## Evidence

- [Runtime and compatibility](../apps/cli/src/agent/README.md#managed-antigravity)
- [Owning decision](../.agents/notes/implemented/feature/2026-11-15-antigravity-agy-cli-acp.md)
- [Auto Review removal](../.agents/notes/implemented/simplification/2026-11-19-antigravity-auto-review-removal.md)
- [Quota boundary tests](../apps/cli/src/agent/acp-runner.test.ts)

This draft describes intent. Runtime launches, live account quota and cross-machine
behavior require integration validation; fixture coverage alone does not establish them.
