# LANs: machines that reach each other without an account

The local platform has no account service, so nothing tells two installations
that they belong together. A LAN does: it is a self-hosted Streams hub plus the
credential that opens it. Every installation that holds the credential is a
member, sees the other members' machines and projects, and can run agents on
them. This page explains how the pieces fit; the invariants stay in the scoped
`AGENTS.md` files it links to.

## The pieces

| Piece | Where | What it does |
| --- | --- | --- |
| Hub | `apps/cli/src/lib/lan/hub-server.ts` | The single-node Streams server of `@loro-dev/loro-cli` on loopback, behind a bearer-token gate that is the only network entry |
| Settings | `packages/shared/src/node/lan-hub.ts` | `lan-hub.json` in the data directory: the LANs of this installation and the name of this machine |
| Contract | `packages/shared/src/lan-hub.ts` | What a renderer may know: ids, slugs, invites, the shared owner. Never a credential |
| Membership | `apps/cli/src/lib/lan/lan-membership.ts` | One workspace and one gateway per LAN for the running agent service |
| Store | `packages/shared/src/node/lan-hub-store.ts` | The settings as the desktop shell holds and edits them |
| Bridge | `apps/electron/src/main/services/lan-hub-forward.ts` | Forwards `lody-hub://<lan id>` to the hub of that LAN and adds its credential |
| Follower | `packages/components/src/providers/local-platform-follower.ts` | Keeps the renderer's workspaces equal to the CLI catalog |
| Services | `apps/cli/src/lib/lan/service.ts` | systemd user units that keep a hub and an agent service running on a server |

```text
 server                                   desktop
 ┌────────────────────────────┐           ┌───────────────────────────────────┐
 │ lody-lan-hub.service       │           │ renderer ── lody-hub://<lan id> ─┐ │
 │   gate :8788 ── streams    │◀── HTTP ──│ main: bridge adds the credential ◀┘ │
 │ lody-lan-agent.service     │           │ embedded agent service             │
 │   one workspace per LAN    │──────────▶│   one workspace per LAN            │
 └────────────────────────────┘           └───────────────────────────────────┘
        both read lan-hub.json of their own data directory
```

## One LAN, one workspace

The id of a LAN is derived from its credential alone, and its workspace id is
that id behind the `lw_` prefix. Two installations that were given the same
credential therefore meet in the same workspace without asking anyone, and a
LAN that moves to another address keeps everything it stores. A changed
credential is another LAN.

An installation may belong to several LANs. The agent service then runs one
workspace per LAN, each attached to its own hub, and the desktop lists them in
the workspace switcher of the sidebar. The name of a LAN and the route slug
derived from it belong to the installation: two machines may call the same LAN
differently.

The machine is the same in every LAN. Its id is the one in the data directory.
Its name is the host name without the domain of the network it happens to be
on, unless one was chosen with `lody lan name` or in Settings; a chosen name
replaces what a workspace stored, a derived one only replaces a stored host
name that carries a network domain.

## One owner

A process has a single user id, and visibility and authorization compare it:
the desktop shows a machine whose owner is the current user, and an agent
service accepts a request of its own user. Members of a LAN therefore act as
one user, `LAN_SHARED_USER_ID`, exactly like one account signed in on several
devices. The id is the same for every LAN because one process may belong to
several. It grants nothing: whoever reaches a hub already holds its credential.

An installation without a LAN keeps the identity and the implicit workspace it
always had. `local-identity.json` remembers which workspace that is, because the
catalog names its owner by whoever reconciled last; leaving the last LAN brings
that workspace back instead of creating an empty one.

## Following a change

Settings change while processes run: `lody lan join` on a server, or Settings >
LAN on a desktop. Both write `lan-hub.json`, and every process that reads it
watches it.

| Change | Agent service | Desktop |
| --- | --- | --- |
| LAN joined, left or renamed | Starts or stops that workspace | The switcher follows the next snapshot |
| First LAN joined, last LAN left | Exits with the restart code | Reloads, because the user id changed |
| LAN moved to another address | Exits with the restart code | The bridge resolves the new address per request |
| Machine renamed | Exits with the restart code | Nothing |

The restart code is `CLI_EXIT_CODE_REMOTE_RESTART`. The daemon runner, the
desktop supervisor and the systemd unit all start the service again after it; a
service started by hand in a terminal has to be started again by hand. Agents
running on the machine are interrupted by a restart, so the editors warn before
the two edits that cause one.

## Hosting and releases

`lody lan up` turns a server into a host and a member in one step: it installs
and starts the two services, joins the LAN it hosts and prints the invite. The
default address is a private one, an overlay network before the local segment;
a machine with public addresses only has to choose with `--host`, because the
hub speaks plain HTTP unless `lody lan hub` is given a certificate.

`.github/workflows/lan-build.yml` builds a fork: the bundles once on Linux, the
installers per platform from those bundles, and a rolling release whose file
names carry no version. `scripts/lan-release.mjs` names the build and assembles
the release; `scripts/lan/install.sh` and `install-mac.sh` are published with
it. The desktop builds are unsigned, and the update service stays off on the
local platform, so a fork build is never replaced by an upstream release.

## Limits

- The hub is a development server on SQLite: one node, no replication. Back up
  its data directory.
- A credential cannot be rotated in place. Host a new LAN and move.
- Settings > Machines and the machine picker of Prompt Shortcuts depend on the
  `remoteMachines` capability, which a LAN does not grant.
- The desktop application cannot host a LAN; it does not ship the Streams
  server.
