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
when a turn switches YOLO on or off. Both Antigravity identities run the same agy
release; from 1.5.10 agy streams what a background wakeup produces after `end_turn`,
and Lody writes it into the finished turn. agy also declares client-provided MCP tools only
up to a prompt budget and drops the rest, so Lody lists its own commands to agy
without input schemas and `lody_help` supplies their parameters.

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

Measured on 2026-11-19 on Linux x86_64 (devNuc) with a minimal ACP client that logs
every JSON-RPC line, `gemini-3.8-flash` at `thought_level` low, and a temporary daemon
(`LODY_DATA_DIR`) running this change:

- agy 1.5.9 holds back what the model does after `end_turn`. Asked to set a 20 s
  `schedule` timer and answer when woken, it returned `end_turn` with the tool
  `in_progress`; its conversation store shows the reply written 17 s later, but stdout
  stayed silent for 90 s until the next `session/prompt`, which first carried the
  `tool_call_update` and the reply, then the new user message. Lody would put that
  late reply into the new turn.
- A replacement process loses it. After the wakeup, a new 1.5.9 process answered
  `session/load` with a replay that ends in the reply, which Lody drops as replay,
  and the next prompt did not send it again. A Lody session on mini lost a `swarm`
  result this way when switching to YOLO restarted agy.
- agy 1.5.10's changelog says it now sends such replies, tool calls and permission
  requests at once. Through the temporary daemon, the timer reply and a `swarm`
  worker's post appeared in the finished turn's assistant entry with no new message,
  and the session left `busy` about 30 s after the wakeup went quiet.
- A parked coordinator wakes only for a board post that concerns it: a worker post
  without `@coordinator` left it asleep.

Measured on 2026-11-19 with agy CLI 1.5.9 and 1.5.10 (the latter launched with
`--process-per-session --disable-telemetry`) on Linux x86_64 and from a macOS
session, reading each conversation's last model request from
`~/.gemini/antigravity-cli/conversations/<id>.db`:

- agy declares the tools of every MCP server passed over ACP as native functions
  (`mcp_<server>_<tool>`), smallest declaration first, until a budget shared by all
  servers runs out. Plugin MCP servers stay lazy and list only names. A tool past the
  budget is in neither list, and `call_mcp_tool` rejects it with
  `tool <name> is not enabled for server <server>`. agy's built-in flag defaults
  include `customization-token-budget: 20000`, one pool that skills, subagents and
  MCP tools fill smallest first. Skills and subagents left out are named in the
  prompt; MCP tools left out are not. Plugin skills decide what remains for MCP: on
  the Mac mini session the skills took about 10.2k (the `science` plugin 6.7k) and
  MCP tools about 9k. In a probe with 120 equal tools, 86 fit; adding the `science`
  plugin's 48 skills left 57, and `agy plugin disable science` restored 86.
- A Mac mini chat session with `lody` and four workspace servers listed 32 of 48
  `lody` tools. The missing 16 included `lody_session_create_options`,
  `lody_session_create`, `lody_session_chat`, `lody_session_list` and
  `lody_session_history`, and the agent's `lody_session_create_options` call failed
  with that error.
- `_meta["antigravity/alwaysLoad"]` on a tool of an ACP-passed server did not keep it
  within the budget: of three equal-size tools past the cut, agy kept the same one
  whichever of them carried the mark.
- A tool whose input schema is `{"type": "object"}` received nested arguments unchanged.
- On a temporary daemon with those four servers replayed from the Mac mini's cached
  declarations, `lody` went from 33 of 45 listed tools to all 45 with compact listings,
  and the workspace servers kept more of theirs (hebi8-market 15 → 17 of 19,
  mail-personal 12 → 15 of 17). agy read `lody_help`, called
  `lody_session_create_options` and then `lody_session_create` with complete
  arguments; the child Tab answered and its completion reached the parent through
  the Inbox.
- The 48 `lody` declarations measured 65.7 KB as full JSON and 12.8 KB compact. Only 5
  of the 47 workspace tools were smaller than the largest compact declaration.
- agy wraps each declaration in fields of its own. In the temporary daemon's request
  the 45 compact `lody` tools took 25.5 KB (509 to 712 bytes each). In the Mac mini
  session the 32 listed full `lody` tools took 27.1 KB of the 46.4 KB declared for all
  MCP tools, about the room the 48 compact commands would need there. The Nowledge Mem
  plugin's MCP server stayed lazy in both and took none of it.

## Decision

The runtime, quota and session permission boundaries are recorded in the
[draft contract](../../../../specs/antigravity-runtime.md).

New Providers use the upstream managed builtin Antigravity, pinned by
`antigravity-runtime-manifest.json` to agy 1.5.10. It launches
`acp --process-per-session --disable-telemetry` with automatic updates disabled;
`antigravityPath` selects a user-managed executable. Persisted registry Providers
keep the fork's agy GitHub distribution in `setting.ts`, hidden from new-Provider
discovery, at the manifest's agy version, so one pin brings an agy fix to both
identities. Their identities and stored conversations are not rewritten.

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

For agy (`isAntigravityServer()`, builtin and registry), AgentClient asks the `lody`
server for compact listings (`x-lody-mcp-compact-tools` over HTTP,
`LODY_MCP_COMPACT_TOOLS` for stdio). Each command keeps its name, summary and help
pointer and advertises `{"type": "object"}` as its input schema; `lody_help` returns
the full schema, and the server validates every call against it. The tool set and
names, and therefore agy's `mcp(lody/<tool>)` allow rules, are unchanged. Other agents
still receive full schemas.

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
- A separate pin for the registry entry, bumped by hand, had already fallen behind
  the managed runtime (1.5.9 against 1.5.10) and kept existing Providers on an agy
  that held wakeup output back.
- Recovering held-back output inside Lody: a later prompt does deliver it, but into
  the new turn, and a replaced process never sends it. Taking it from a
  `session/load` replay needs the loads that restart agy's MCP servers
  ([background work](../bug-fix/2026-11-16-antigravity-background-wakeup.md)), and
  agy's replay carries no turn ids to align it with Lody's history.
- Asking agy not to use its native `swarm` in Lody: unnecessary once agy streams the
  wakeup; timers, subagents and swarms stay usable.
- Marking Lody's session tools with `_meta["antigravity/alwaysLoad"]` was measured to
  have no effect for ACP-passed servers.
- Listing only the session tools to agy would remove the rest of Lody's commands and
  still compete with workspace tools by size.
- A single dispatcher command such as `lody_call` would be the smallest listing, but
  every command would share one tool name, so agy's per-tool allow rules and the
  per-command rendering of tool calls could no longer tell them apart.
- Raising agy's budget: the value comes from agy's experiment flags (20000 in 1.5.9
  and 1.5.10). Six candidate keys in `settings.json` and
  `--include-default-customizations=false` left it at 20000, `acp` rejects
  `--settings`, and the only local override RPC, `SetMendelFlagOverrides`, requires
  developer mode enabled server-side. Patching the binary was not tried.
- Keeping property names without nested schemas saves less: the create, chat and
  schedule commands would still list kilobytes of properties each.

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
- A wakeup's reply lands in the turn that started the background work; Lody announces
  that turn as finished only after the wakeup goes quiet. The managed runtime's next
  agy version also changes the registry entry's download, and the first launch after
  an update downloads it.
- A permission request from a wakeup targets a finished turn, which refuses
  permission writes, so Lody cancels it in any mode. Only what agy decides itself
  never asks: YOLO, agy's allow rules, and commands that agy's `auto` runs in its
  sandbox.
- agy's function declarations no longer show Lody's parameters. An agy session
  depends on `lody_help`, which Lody's instructions already require before every
  command, and an argument error returns the help reminder. Workspace MCP servers keep
  about the room they had under a budget like the Mac mini's, and more of their tools
  under a larger one.

## Verification

- `scripts/generate-acp-registry.test.mjs` verifies discovery exclusion;
  `apps/cli/src/agent/acp-runner.test.ts` covers both identities’ print-mode quota.
- `apps/cli/tests/agent-setting.test.ts` pins the registry entry's capability source
  to the managed runtime's agy version.
- The 2026-11-19 runs in Findings cover agy 1.5.9's held-back output and a replaced
  process losing it (raw ACP), and agy 1.5.10's wakeup reaching the finished turn
  through a temporary daemon, on Linux only.
- `packages/shared/tests/title-generation-defaults.test.ts` pins title ownership.
- `apps/cli/tests/antigravity-acp-stream.test.ts` pins the YOLO mode and launch flag
  and the refused switch.
- `apps/cli/tests/session-execution-service-startup-part-2.test.ts` pins the restart when a turn
  switches YOLO.
- `packages/shared/tests/permission-tier.test.ts` and `permission-mode-face.test.ts`
  pin the mode tiers and faces.
- `apps/cli/src/mcp/tool-help.test.ts` pins compact listings with full help and
  validation, `apps/cli/src/mcp/lody-mcp-http-host.test.ts` carries the header through
  the HTTP host, and `apps/cli/tests/agent-client-plan-mode.test.ts` pins that only
  agy sessions request them, over stdio and HTTP.

Not verified: answering a permission prompt in the desktop app, a `lody` tool call
after approval, `accept-edits` and `plan` in a real run, launching the Windows
archive, a YOLO session through a Lody build (only the agy process was probed),
agy 1.5.10's wakeup on macOS, a permission request from a wakeup, and compact
listings in a Lody build on macOS or Windows.
