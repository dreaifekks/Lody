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
title its own sessions and offers its Auto Review mode beside agy's own `auto`,
whose terminal sandbox has no network. The trade-off is that agy asks before every tool call of a
client-provided MCP server, including Lody's own `lody` server, unless an agy allow
rule covers it, and stored `auto_edit` and `thinking_level` selections no longer
validate. agy skips permission requests only for a whole process, so Lody's `yolo`
mode starts the session's agy with `--dangerously-skip-permissions` and restarts it
when a turn switches YOLO on or off.

Lody's Auto Review described below was removed on 2026-11-19; stored selections run
in agy's `auto`. See the [removal decision](../simplification/2026-11-19-antigravity-auto-review-removal.md).

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
- On devNuc with an AppArmor profile allowing agy user namespaces, agy reported `auto`.
  With `read_file(<path>)` grants for `~/.lody-oss/session-bin`, `~/.lody-oss/run`,
  `~/.lody-oss/workspace-catalog.json`, the node directory and
  `~/.local/share/lody-lan`, four `lody-lan` commands ran in its sandbox without asking.
  The sandbox has only a loopback interface, even with
  `userSettings.sandboxAllowNetwork`: `nmem`, `curl` by name or by IP all failed, so
  networked commands need agy's out-of-sandbox review and then the user.
- With `--dangerously-skip-permissions` and `default`, `lody-lan` ran at once on macOS.
  The changelog says the flag only skips tool permission prompts, still blocks the
  system command denylist and keeps explicit deny rules.

## Decision

The runtime, quota and session permission boundaries are recorded in the
[draft contract](../../../../specs/antigravity-runtime.md).

New Providers use the upstream managed builtin Antigravity, pinned by
`antigravity-runtime-manifest.json` to agy 1.5.10. It launches
`acp --process-per-session --disable-telemetry` with automatic updates disabled;
`antigravityPath` selects a user-managed executable. Persisted registry Providers
keep the fork's known agy 1.5.9 GitHub distribution in `setting.ts`, hidden from
new-Provider discovery. Their identities and stored conversations are not rewritten.

The registry's Antigravity joins the Claude/Grok identity fallback for titles and
accepts untagged `session_info_update` titles. agy titles each conversation in the
prompt's language, and an isolated title session would be one more agy conversation
running the user's hooks: an extra nmem thread and context bundle per Lody session.

`withAntigravityAutoReview` adds `auto_review` to the modes a session reports and
runs agy in `default` under it; agy's own `auto` passes through untouched. agy's
sandbox suits `lody-lan` and workspace work, while Lody Auto Review lets networked
commands through, so a session or Role picks one. Its reviewer is a hidden session of
the same binary, which runs the user's hooks for every reviewed session.

Its rules count the session's own agy conversation directory as workspace, so
scratch files there are reviewed like workspace edits. Other conversations'
directories and the rest of `~/.gemini/antigravity-cli/` still ask.

YOLO is a mode Lody adds to agy's list, keeping the former server's id so stored
Roles and sessions validate again. A session whose driving turn selects `yolo`
starts agy with `--dangerously-skip-permissions` (`antigravityLaunchArgs`) and runs
it in `default`; the wrapper reports `yolo` as current. Lody already starts one agy
process per session, so the flag is per session for both builtin and registry
Antigravity. Other sessions of the same Provider are not restarted. A turn that switches YOLO on or off
retires the session's agent and starts a replacement that loads the conversation
(`antigravityYoloChanged` in the session execution service). A mode switch inside a
running turn that would need the other process is refused with an error, and agy
never sees it.

Permission tiers rank agy's `accept-edits` as `edit`, and the composer shows it with
the accept-edits face. `auto`, `default` and `plan` were already classified; `yolo`
is `full` with its warning face.

Provider capability publication removes only the wrapper's virtual `yolo` and
`auto_review` current values, restoring their underlying `default` before writing
the shared capability snapshot and each model's option row. The live Session keeps
its selected display value and all choices. Otherwise an unrelated new Session,
Role or schedule can inherit another Session's bypass policy from the shared cache.
Native modes are left as the agent reports them.

## Alternatives

- Pinning registry 1.5.0 was rejected: it is the same server without plugins.
- Sending a stored `auto_review` as agy's `auto` where agy has one avoided the hidden
  reviewer conversation. It was dropped because agy's sandbox has no network, which
  made the choice per machine rather than per Role.
- Listing `auto_review` as an alias for the native `auto` would keep stored selections
  valid. It was rejected because the ids would differ from agy's own, the mode updates
  would need translating, and only a few stored selections need editing.
- The Provider-level skip flag from upstream LodyAI/Lody#2796 would make every
  session bypass approval, including sessions selecting `auto` or `auto_review`.
  The fork hides that setting and ignores its stored runtime override. The schema
  and protocol field remain compatible, but only the session's `yolo` selection
  adds the launch flag, for both builtin and persisted registry Providers.
- `antigravity acp --process-per-session` runs one agy worker per ACP session inside
  one parent; Lody already runs one process per session, and the flag would still
  belong to the parent.
- agy's `always-proceed` tool execution policy (its Turbo preset) is a setting for
  every agy session on the machine, not an ACP mode.
- Allow rules alone cover only the listed commands and tools. They remain the
  per-machine configuration for sessions outside YOLO.

## Consequences

- Roles, schedules and sessions that store `auto_edit` or `thinking_level` for this
  entry fail at create, and continuing turns drop them and run in `default`. Use
  `accept-edits` and `thought_level`.
- Every Auto Review session adds a hidden agy conversation that runs the user's hooks.
- Switching a session into or out of YOLO costs an agy restart at the next message.
  A switch during a turn takes effect only from the next message.
- Session ids from `agy_acp_server` load as empty conversations, so earlier Antigravity
  sessions lose their agent-side context.
- Builtin and legacy registry quota runs the selected agy executable with
  `--print /usage --output-format json`, preserving its account environment and all
  reported groups. No model turn, ACP quota session, old token read or direct Cloud
  Code request is used. See the [quota decision](../bug-fix/2026-10-20-antigravity-argon-quota.md).
- `LODY_ANTIGRAVITY_THIRD_PARTY_MODELS` no longer changes the model list for this
  entry. Sending the Zed client identity is harmless.

## Verification

- `scripts/generate-acp-registry.test.mjs` verifies discovery exclusion;
  `apps/cli/src/agent/acp-runner.test.ts` covers both identities’ print-mode quota.
- `packages/shared/tests/title-generation-defaults.test.ts` pins title ownership.
- `apps/cli/tests/antigravity-acp-stream.test.ts` pins the YOLO mode and launch flag
  and the refused switch.
- `apps/cli/tests/session-execution-service-startup-part-2.test.ts` pins the restart when a turn
  switches YOLO.
- `packages/shared/tests/permission-tier.test.ts` and `permission-mode-face.test.ts`
  pin the mode tiers and faces.

Not verified: answering a permission prompt in the desktop app, a `lody` tool call
after approval, `accept-edits` and `plan` in a real run, launching the Windows
archive, and a YOLO session through a Lody build (only the agy process was probed).
