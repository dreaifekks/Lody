# Google Antigravity runs the agy CLI's ACP server

Status: implemented
Translation: current

[中文](2026-11-15-antigravity-agy-cli-acp.zh.md)

## Abstract

The registry's Google Antigravity entry ran `agy_acp_server`, which loads none of
the user's agy plugins, plugin hooks or plugin MCP servers and offers only
`default`, `auto_edit` and `yolo`. Its 1.5.0 release is the same server, and no flag,
environment variable or configuration file enables plugins. The LAN fork now
launches `antigravity acp` from the agy CLI's GitHub release, so a Lody session
behaves like local `agy acp`: plugin hooks run, plugin MCP servers load, and the
native `default`/`accept-edits`/`auto`/`plan` modes, a `thought_level` option,
Claude/GPT models and agent-written titles are available. Lody lets that runtime
title its own sessions and treats its Auto Review mode as the native `auto` where
agy has one. The trade-off is that agy asks before every tool call of a
client-provided MCP server, including Lody's own `lody` server, unless an agy allow
rule covers it, and stored `auto_edit` and `thinking_level` selections no longer
validate. agy skips permission requests only for a whole process, so Lody's `yolo`
mode starts the session's agy with `--dangerously-skip-permissions` and restarts it
when a turn switches YOLO on or off.

## Findings

Measured on 2026-11-15 on macOS arm64 with agy CLI 1.5.9, a minimal ACP client and
an nmem plugin that injects its context once per session:

- `agy_acp_server` 1.4.5 and 1.5.0 read hooks only from `$GEMINI_HOME/config/hooks.json`
  and a trusted `<cwd>/.agents/hooks.json`, with no plugin discovery and no session-start
  event. They read MCP servers only from `~/.gemini/config/mcp_config.json`, and they
  write `skills/system/run-workflow/SKILL.md` into the workspace root.
- `antigravity acp` runs the plugin's hooks. The context bundle is present on the first
  turn and still present after tool calls, every conversation becomes an nmem thread,
  the plugin's MCP server is callable, and nothing is written into the workspace.
- The CLI's release ships one executable per archive for macOS, Linux and Windows on
  arm64 and x64. Lody's registry download pins no checksum for any entry.
- A real run on a temporary daemon (`LODY_DATA_DIR`) with this change behaved as
  follows. A capability refresh downloaded the release and reported the four modes,
  nine models and `thought_level`. Each turn applied `auto` and `thought_level`. The
  agy title replaced the draft and no isolated title process started. After a daemon
  restart, `session/load` restored the conversation without duplicating history. The
  quota poller wrote Gemini quota. Create rejected `yolo` and `thinking_level`.
- With `auto`, agy approved an explicitly requested `rm` of a workspace file and a
  `curl` POST of a workspace file to an external host. It asked before reading another
  conversation's files outside the workspace, and before every tool of the `lody` and
  a probe MCP server, offering only allow-once and reject-once. The plugin's MCP tool
  ran without asking in `default` and `auto`. An agy `permissions.allow` rule
  `mcp(<server>/*)` in a separate `--cli_dir_name` settings directory did not stop the
  prompt. Correction: ACP sessions do read agy's shared allow rules, as measured on
  2026-11-18 below.

Measured on 2026-11-18 with agy CLI 1.5.9 on Linux x86_64 (Ubuntu 24.04 and 26.04)
and macOS arm64, through Lody sessions and a minimal ACP client:

- On both Linux machines `kernel.apparmor_restrict_unprivileged_userns` is 1, and agy
  reports `default`, `accept-edits` and `plan` without `auto`; its changelog says it
  hides options that need the terminal sandbox on Linux systems that block
  unprivileged user namespaces. Lody's synthetic Auto Review runs there.
- Allow rules in `~/.gemini/config/config.json` under
  `userSettings.globalPermissionGrants.allow`, such as `command(lody-lan session list)`
  (a word prefix) and `mcp(lody/lody_session_status_many)`, apply to ACP sessions. On
  Linux a session ran `lody-lan` commands and `lody` and nmem MCP tools without one
  permission request reaching Lody. On macOS in `auto`, MCP tools stopped asking.
- On macOS in `auto`, `lody-lan` failed inside agy's terminal sandbox ("operation not
  permitted"); agy's review of running it outside the sandbox took about 40 s without
  a verdict before the allow rule let it run without asking the user.
- Under Lody Auto Review, every `lody-lan … > <scratch>/out.json` asked the user as a
  change to agent configuration: agy tells the agent to keep scratch files in its
  conversation directory `~/.gemini/antigravity-cli/brain/<conversation id>/`, and the
  rules counted all of `~/.gemini/antigravity-cli/` as agent configuration. The
  conversation id is the ACP session id.
- With `--dangerously-skip-permissions` and `default`, `lody-lan` ran at once on macOS.
  The changelog says the flag only skips tool permission prompts, still blocks the
  system command denylist and keeps explicit deny rules.

## Decision

`scripts/generate-acp-registry.mjs` replaces only the `antigravity-acp` entry: the
version is `ANTIGRAVITY_CLI_VERSION`, each platform downloads `agy_cli_<os>_<arch>`
from that GitHub release, and the command is `./antigravity` (`.exe` on Windows) with
`acp`. A version bump is manual because agy releases almost daily.

The registry's Antigravity joins the Claude/Grok identity fallback for titles and
accepts untagged `session_info_update` titles. agy titles each conversation in the
prompt's language, and an isolated title session would be one more agy conversation
running the user's hooks: an extra nmem thread and context bundle per Lody session.

`withAntigravityAutoReview` checks the modes a session reports. When they include
`auto`, it adds no mode, reviews nothing and sends a stored `auto_review` as `auto`.
Its reviewer is a hidden session of the same binary, which on the agy CLI would run
the user's hooks for every reviewed session. Servers without `auto` keep the
synthetic mode, so machines still on `agy_acp_server` are unchanged until they update.

Its rules count the session's own agy conversation directory as workspace, so
scratch files there are reviewed like workspace edits. Other conversations'
directories and the rest of `~/.gemini/antigravity-cli/` still ask.

YOLO is a mode Lody adds to agy's list, keeping the former server's id so stored
Roles and sessions validate again. A session whose driving turn selects `yolo`
starts agy with `--dangerously-skip-permissions` (`antigravityLaunchArgs`) and runs
it in `default`; the wrapper reports `yolo` as current. Lody already starts one agy
process per session, so the flag is per session. A turn that switches YOLO on or off
retires the session's agent and starts a replacement that loads the conversation
(`antigravityYoloChanged` in the session execution service). A mode switch inside a
running turn that would need the other process is refused with an error, and agy
never sees it.

Permission tiers rank agy's `accept-edits` as `edit`, and the composer shows it with
the accept-edits face. `auto`, `default` and `plan` were already classified; `yolo`
is `full` with its warning face.

## Alternatives

- Pinning registry 1.5.0 was rejected: it is the same server without plugins.
- Keeping Lody Auto Review on the agy CLI's `default` mode was rejected for now
  because every reviewed session would add a hidden agy conversation with the user's
  hooks. It remains the option if allow-once prompts for MCP tools prove too costly.
- Listing `auto_review` as an alias for the native `auto` would keep stored selections
  valid. It was rejected because the ids would differ from agy's own, the mode updates
  would need translating, and only a few stored selections need editing.
- A Provider-level skip flag, as upstream LodyAI/Lody#2796 adds for its builtin
  `antigravity` entry, applies to every session of the Provider. The fork keeps a
  per-session mode because Roles and sessions select `yolo` per session. Both end in
  the same launch flag, so adopting the builtin entry later needs no new mechanism.
- `antigravity acp --process-per-session` runs one agy worker per ACP session inside
  one parent; Lody already runs one process per session, and the flag would still
  belong to the parent.
- agy's `always-proceed` tool execution policy (its Turbo preset) is a setting for
  every agy session on the machine, not an ACP mode.
- Allow rules alone cover only the listed commands and tools. They remain the
  per-machine configuration for sessions outside YOLO.

## Consequences

- Roles, schedules and sessions that store `auto_edit` or `thinking_level` for this
  entry fail at create, and continuing turns drop them and run in `default`; so does
  `auto_review` on a machine where agy has `auto`. Use `auto` or `accept-edits` and
  `thought_level`. A machine that gains `auto`, for example after an AppArmor profile
  allows agy user namespaces, loses `auto_review` the same way.
- Switching a session into or out of YOLO costs an agy restart at the next message.
  A switch during a turn takes effect only from the next message.
- Session ids from `agy_acp_server` load as empty conversations, so earlier Antigravity
  sessions lose their agent-side context.
- Quota still reads `~/.gemini/antigravity-acp/acp_token.json`, as described in the
  [Argon quota decision](../bug-fix/2026-10-20-antigravity-argon-quota.md). A machine
  signed in only through the agy CLI reports no quota.
- `LODY_ANTIGRAVITY_THIRD_PARTY_MODELS` no longer changes the model list for this
  entry. Sending the Zed client identity is harmless.

## Verification

- `scripts/generate-acp-registry.test.mjs` pins the generated entry.
- `packages/shared/tests/title-generation-defaults.test.ts` pins title ownership.
- `apps/cli/tests/antigravity-auto-review.test.ts` pins the deferral to `auto`, the
  YOLO mode and launch flag, the refused switch and the conversation directory rule.
- `apps/cli/tests/session-execution-service.test.ts` pins the restart when a turn
  switches YOLO.
- `packages/shared/tests/permission-tier.test.ts` and `permission-mode-face.test.ts`
  pin the mode tiers and faces.

Not verified: answering a permission prompt in the desktop app, a `lody` tool call
after approval, `accept-edits` and `plan` in a real run, launching the Windows
archive, a YOLO session through a Lody build (only the agy process was probed), and
agy's `auto` on Linux with user namespaces allowed.
