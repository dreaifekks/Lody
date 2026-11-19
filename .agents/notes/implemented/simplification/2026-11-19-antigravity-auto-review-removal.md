# Remove Lody's Antigravity Auto Review

Status: implemented
Translation: current

[中文](2026-11-19-antigravity-auto-review-removal.zh.md)

## Abstract

Lody's Auto Review mode for Antigravity ran agy in `default` and judged each
permission request with its own rules and a hidden Gemini Flash reviewer session,
because agy's own `auto` ran commands in a sandbox without network. Measurements on
agy CLI 1.5.9 show that agy's `read_url(<domain>)` rules give sandboxed commands
network to named hosts without any review, and that its allow rules stop the review
of everything else from asking the user. Lody therefore drops Auto Review and keeps
only agy's modes plus its per-session `yolo`; sessions, Roles and schedules saved
with `auto_review` run in agy's `auto`. A networked command outside the granted hosts
still waits about 20–40 s for agy's own review in `auto`, which no Lody-side setting
removes; trusted networked work uses `yolo`.

This partially supersedes the [agy CLI decision](../feature/2026-11-15-antigravity-agy-cli-acp.md),
which still owns the runtime, titles, YOLO and HTTP MCP decisions.

## Findings

Measured on 2026-11-19 with agy CLI 1.5.9 in `auto` through a minimal ACP client, on
Linux x86_64 with an AppArmor profile that lets agy create user namespaces and on
macOS arm64. Rules were added to `~/.gemini/config/config.json` under
`userSettings.globalPermissionGrants`.

- Without grants the sandbox has no network. `read_url(example.com)` and
  `read_url(github.com)` let `curl` reach those hosts and their subdomains at once,
  with no review; `raw.githubusercontent.com` needed `read_url(githubusercontent.com)`.
  With both, `git ls-remote` against GitHub ran inside the sandbox on both systems.
  Only ports 80 and 443 pass, IP addresses are refused, and `read_url(*)` opens every
  host. `userSettings.sandboxAllowNetwork` changed nothing.
- A command that fails in the sandbox is offered to run outside it, and agy's
  reviewer judges that before anything reaches the client: `git push` took 21–23 s,
  `lody-lan` on macOS (whose sandbox blocks the daemon's Unix socket) 38 s. With a
  matching `command(<word prefix>)` allow rule it then ran without asking; without one
  the review escalated to the user. An allow rule did not skip the review (an `rm`
  took 6 s with the rule, 12 s and a prompt without), and neither did a global
  PreToolUse hook answering `auto_approve` (19 s).
- ACP permission prompts offer only allow-once and reject-once; answering one wrote
  nothing to `config.json` or `settings.json`.
- In `accept-edits` and `default`, an allow-listed command ran at once, outside the
  sandbox; other commands asked at once.
- An `nmem` CLI configured with an IP address and port cannot run in the sandbox; the
  nmem MCP tools ran in 0.7 s under `mcp(...)` allow rules. On Linux, `lody-lan` ran in
  the sandbox with the `read_file` grants recorded in the agy CLI decision.

## Decision

Remove the `auto_review` mode, its rules and its reviewer process. `antigravity-acp-stream.ts`
keeps the per-session `yolo` and the Streamable HTTP MCP capability correction and
otherwise passes agy's modes through. Approval in `auto` is agy's: each machine's agy
rules grant the hosts its sandboxed commands need (`read_url`), allow the networked
commands whose review should not ask (`command(git push)`, with force pushes kept on
`ask`), and allow nmem through its MCP tools.

Saved selections are read through one mapping, `migrateLegacyAntigravityModeId`
(`auto_review` → `auto`; no other agent uses the id): Role run configs, the session
config readers (`resolveSessionConversationConfig`, `resolveSessionAcpRuntimeConfig`)
and the Schedule-to-Session boundary (`resolveScheduleAgentRunConfig`) apply it on
read, so menus, inherited turns and scheduled runs use `auto` and pass the ordinary
capability validation. Schedule definitions and their fingerprints keep what was
saved. Turns frozen with `auto_review` (queued or signed input) are not rewritten;
the stream wrapper sends them to agy as `auto`. The permission tier table keeps
`auto_review` at `auto` for those frozen turns.

## Alternatives

- Keep Auto Review for networked work. Its reviewer was one more hidden agy
  conversation per reviewed session, running the user's hooks (an extra nmem thread
  and context bundle each) and spending Gemini Flash quota beside agy's own reviewer.
  The reason for it, a sandbox without network, is answered by `read_url` grants for
  the known hosts and `yolo` for the rest.
- Approve agy's out-of-sandbox requests in Lody: nothing to save, because agy reviews
  before the request reaches the client.
- `read_url(*)`: every host becomes reachable from sandboxed commands; named hosts
  were chosen instead.
- Serving nmem over HTTPS on port 443 under a host name (for example
  `tailscale serve`) would let its CLI run in the sandbox. Not done: the MCP tools
  cover the use.
- Listing `auto_review` as an alias mode, as the agy CLI decision already rejected:
  the read mapping keeps the id out of menus while stored selections keep working.

## Consequences

- In `auto`, a networked command outside the granted hosts costs one agy review
  (about 20–40 s) per call; with an allow rule it then runs without asking, otherwise
  the user is asked. On macOS every `lody-lan` call leaves the sandbox this way.
- agy rules are per-machine user configuration, not part of the repository.
- A Provider capability cached by an older build still lists Auto Review until it is
  refreshed; choosing it runs `auto`.
- A machine whose agy does not offer `auto` (Linux without the AppArmor profile)
  rejects a mapped selection like any other `auto`.

## Verification

- `apps/cli/tests/antigravity-acp-stream.test.ts`: the offered modes, YOLO and its
  refused switches, HTTP MCP, and a saved `auto_review` running agy in `auto` at
  start, on resume and on a switch.
- `packages/shared/tests/agent-role.test.ts` and `session-input.test.ts`: Role and
  session reads map `auto_review` to `auto`.
- `apps/cli/src/lib/schedules/schedule-session-preparation.test.ts`: a schedule saved
  with `auto_review` (as `modeId` or as the `mode` option) prepares its turn in `auto`.
- `packages/shared/tests/permission-tier.test.ts` keeps its tier.

Not verified: a Lody build with this change on a real machine (only agy itself and
the fixture were run), and the desktop composer of an old Auto Review session.
