<p align="center">
  <img src="./site-docs/public/icon-mac.png" width="128"/>
</p>
<h1 align="center">Lody LAN</h1>
<p align="center">
  <b>English</b> | <a href="./README.zh-CN.md">简体中文</a>
</p>
<p align="center">
  <b>Lody for your own machines, without an account.</b>
</p>
<p align="center">
  A personal fork of <a href="https://github.com/LodyAI/Lody">Lody</a> that connects your machines through a hub you host yourself.
</p>
<p align="center">
  <a href="https://github.com/dreaifekks/Lody/releases/tag/lan-latest"><b>Download</b></a>
  |
  <a href="./.agents/docs/lan.md"><b>How LANs work</b></a>
  |
  <a href="https://github.com/LodyAI/Lody"><b>Upstream Lody</b></a>
</p>

## What this is

Lody LAN is the open-source Lody desktop app and CLI, extended so that several
machines of one person work together without a Lody account or a hosted
service. It is not made or supported by the Lody team. It follows upstream
releases: a build is named `<upstream version>-lan.<n>`, and its desktop app
and servers update themselves from this repository's
[rolling release](https://github.com/dreaifekks/Lody/releases/tag/lan-latest),
never from upstream.

Most of Lody works as it does upstream: Agents over ACP, worktrees, diffs,
terminals, the browser preview, Roles and the CLI. What depends on Lody's
servers is replaced or missing; [the differences](#how-it-differs-from-lody)
list it.

## Get started

A LAN is a hub you host yourself plus the invite that opens it: every machine
that holds the invite sees the others' projects and runs Agents on them. A
machine can belong to several LANs and is the same machine, under the same
name, in each of them. The terminal of a session opens on the machine that
runs it, whichever machine the desktop is on, and the images and files of a
message are taken there; members reach each other on port 8789 of the address
they use for the hub. The folder of such a session opens in an editor on the
desktop over SSH, if the machine that has it runs an SSH server and the
desktop is let in.

Host a LAN on a server, which also becomes its first member:

```bash
curl -fsSL https://github.com/dreaifekks/Lody/releases/download/lan-latest/install.sh | bash -s -- up
```

The command prints an invite. Join from another server with it, or paste it into
**Settings > LAN** of the desktop app:

```bash
curl -fsSL https://github.com/dreaifekks/Lody/releases/download/lan-latest/install.sh | bash -s -- join lody-lan://…
```

Desktop builds for macOS, Windows and Linux are attached to the
[rolling release](https://github.com/dreaifekks/Lody/releases/tag/lan-latest).
`lody-lan lan --help` lists the commands that list, rename, move and leave LANs;
[how LANs work](.agents/docs/lan.md) explains the rest.

**Settings > LAN** also lists the machines the LANs reach, with the build and
the agent runtimes each of them runs. A newer build is installed from there: a
server updates itself when asked, from the desktop or with
`lody-lan lan update <machine>`, and the desktop app offers its own update in
the sidebar. Builds follow the releases of the repository that built them, so a
fork of this fork follows its own.

Coming from the hosted Lody? The menu of a machine in **Settings > LAN**, or
`lody-lan hosted import` on a server, reads the agents, MCP servers, Roles and
projects the hosted Lody configured on that machine and adds them to the
installation there. Nothing is sent anywhere and the hosted Lody keeps what it
has; [importing](.agents/docs/hosted-import.md) explains what is left behind.
Both desktop apps can run side by side.

## How it differs from Lody

### Added

| Feature                     | In Lody LAN                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LANs                        | A self-hosted hub and its invite replace the account; a machine can belong to several LANs                                                                                                       |
| Terminals of other machines | Open directly between members, encrypted with the LAN's credential, never through the hub                                                                                                        |
| Files of a message          | Sent straight to the machine that runs the session                                                                                                                                               |
| Folders of other machines   | A session's folder on another member opens in a local editor over SSH                                                                                                                            |
| Machines and updates        | Settings > LAN lists every machine with its build; any member can update a server, the desktop updates itself                                                                                    |
| Phone alerts                | The hub pushes alerts and Live Activities through your own APNs key (`lody-lan lan push setup`) to an iOS client that registers with it; a permission can be answered from the Live Activity     |
| Pull requests               | The PR panel, merge, comments, PR-driven auto-archive and auto review and merge work locally, with one GitHub token the hub keeps (`lody-lan lan github setup`) or the `gh` login of the machine |
| Native sessions             | A Lody session catches up with turns written to its Claude or Codex session outside Lody                                                                                                         |
| Hosted import               | Reads a machine's configuration from the hosted Lody                                                                                                                                             |
| Moving and standby hub      | `lody-lan lan take-over` moves the hub to another server; a standby server keeps a copy and takes over when the hub stays away; Settings > LAN marks both                                        |
| Agents on other machines    | Lody's tools inside a session start and drive sessions on the other machines of its LAN                                                                                                          |

### Works differently

| Area                      | Lody                                        | Lody LAN                                                                                                     |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Identity                  | Lody accounts, teams and workspaces         | Whoever holds a LAN's invite is a member; all members act as one user; an invite cannot be rotated in place  |
| Sync                      | Lody's servers                              | Your hub: one node on SQLite; a standby server copies it every ten minutes and takes over when it stays away |
| Requests between machines | Lody's servers                              | Go directly between the machines; through the hub, for up to two minutes, when they cannot connect           |
| Attachments               | Uploaded to a store every device reads      | Stay on the machine that runs the session; other members see the card but cannot open it                     |
| GitHub tokens             | The Lody GitHub App and your linked account | One token the hub keeps for the LAN; an Agent uses it only on a machine without a `gh` login                 |
| PR panel freshness        | GitHub webhooks                             | Polling while the panel is open; new reviews and comments appear on refresh                                  |
| Phone and web             | Lody's iOS, Android and web apps            | Those apps need a Lody account and do not reach a LAN; phones get alerts from the hub                        |
| Updates                   | Lody's update service                       | This repository's rolling release; upstream's updater stays off                                              |

### Not available

- Sharing with a team, and public links to a session.
- The GitHub App: repository registry, Settings > GitHub, repositories cloned
  in the cloud, and acting under your linked GitHub identity.
- Remote preview: a dev server an Agent starts on another machine does not
  open in this machine's browser panel.
- Usage reports across machines.
- Settings > Machines and the machine picker of Prompt Shortcuts; Settings >
  LAN lists the machines instead.
- Hosting a LAN from the desktop app, which does not ship the hub.
- Billing, bug report upload and telemetry, which are off by design.

## Roadmap

- **Toward peer to peer:** requests between machines go over their direct
  connections, the hub moves with `lody-lan lan take-over`, and a standby
  server takes it over when it stays away. Left: keep credentials and keys on
  every member rather than on the hub, and let a phone follow the hub when it
  moves. The hub stays as a relay that stores what an offline member has not
  seen yet.
- **Missing pieces:** remote preview over the members' direct connections,
  usage across machines, and periodic refresh of reviews and comments in the
  PR panel.

## Shared with Lody

The sections below describe features Lody LAN keeps from upstream. Where they
mention teams, workspaces of an account, or the mobile and web apps, read
[the differences](#how-it-differs-from-lody) first.

### Use Lody from the CLI

The CLI is more than the process that connects a machine. From a terminal or script, you can register local projects; inspect workspaces, machines, linked repositories, and Agent configs; create and message sessions; read their history and status; or archive and restore them. Commands that support `--json` can also feed Lody workspace data into your own tools.

```bash
npx lody session create --workspace my-team --agent-config codex \
  --repo owner/repo "Fix the failing test"

npx lody session list --workspace my-team
```

See the [CLI documentation](https://lody.ai/docs/cli) for the full command reference.

### Let Agents coordinate work across conversations

Lody gives Agents tools to create or reuse other conversations, read their status and history, send follow-up instructions, cancel running work, and bring results back. This lets one conversation act as the coordinator: you can analyze a bug with a main Agent, then have it delegate investigation, implementation, and testing to separate conversations running in parallel.

Lody keeps each child conversation independent while preserving its relationship to the conversation that created it. Conversations can also be referenced with an `@` mention when you or an Agent needs to connect work across sessions.

### Keep code and execution in the same workspace

#### Keep parallel work isolated

Give sessions their own Git worktrees so Agents can work in parallel without mixing changes. Open multiple chats, files, diffs, terminals, and previews in tabs, or fork a session into another conversation or worktree to explore a different approach.

#### Inspect changes where the work happened

Browse project files and inspect per-turn or full-session diffs beside the conversation. Add line-level comments, follow pull request status and CI, and keep GitHub review threads close to the Agent that produced the change.

<p align="center">
  <img src="./site-docs/public/_docs-assets/PR-panel.png" alt="A pull request and its CI status beside an Agent conversation" width="100%" />
</p>

#### Give Agents visual feedback

Open a running web app inside the session, switch between responsive viewports, and send element-level visual annotations back to the Agent.

<p align="center">
  <img src="./site-docs/public/_docs-assets/20260507-preview.png" alt="Annotating a running web app and sending the feedback to an Agent" width="100%" />
</p>

### More built in

- **Agent Roles** — share reusable Agent, model, permission, and instruction presets with the team.
- **Attachments** — send files and images from desktop, mobile, web, or CLI, and receive files produced by Agents.
- **Session tools** — search, pin, archive, fork, and organize conversations without losing their history.
- **Desktop tools** — use a built-in terminal, command palette, customizable shortcuts, and open files in your editor.
- **Mobile controls** — receive notifications, approve permission requests, inspect diffs, and follow active work with iOS Live Activities.
- **Usage visibility** — see context, token and quota usage, plus machine and Agent resource consumption.

<p align="center">
  <img src="./site-docs/public/_docs-assets/20260611-island.png" alt="Approving an Agent permission request from an iPhone Live Activity" width="60%" />
</p>

## Releases

A tag `v<upstream>-lan.<n>` builds the desktop apps and the CLI bundle and
replaces the [rolling release](https://github.com/dreaifekks/Lody/releases/tag/lan-latest).
`node scripts/lan-release.mjs version` prints the next version. A tag
`dev-v<upstream>-lan.<n>` builds the same way from any branch and replaces the
`lan-dev` prerelease instead, which only installations made from it follow
(`lan-release.mjs version --channel dev`). Upstream's own
`Release` workflow is disabled on this repository; it accepts only stable
`vX.Y.Z` tags.

## Repository

- `apps/cli` — Connect machines and run coding agents; `src/lib/lan` holds the hub and the LAN features
- `apps/electron` — Desktop app
- `packages/components` — Shared workspace UI
- `packages/ui` — Base UI primitives and StyleX design tokens
- `packages/platform` — Platform capabilities and integrations
- `packages/shared` — Shared schemas, protocols, and utilities
- `packages/cloud-api` — Optional-cloud protocol names and DTOs
- `packages/loro-streams-rpc` — RPC over Loro Streams
- `packages/acp-extension-{core,kimi}` — ACP extension submodule workspaces
- `scripts/lan` — Install scripts published with each release
- `site-docs` — Upstream's website, documentation, and blog

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup.
