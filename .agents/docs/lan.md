# LANs: machines that reach each other without an account

The local platform has no account service, so nothing tells two installations
that they belong together. A LAN does: it is a self-hosted Streams hub plus the
credential that opens it. Every installation that holds the credential is a
member, sees the other members' machines and projects, and can run agents on
them. This page explains how the pieces fit; the invariants stay in the scoped
`AGENTS.md` files it links to.

## The pieces

| Piece          | Where                                                                            | What it does                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Hub            | `apps/cli/src/lib/lan/hub-server.ts`                                             | The single-node Streams server of `@loro-dev/loro-cli` on loopback, behind a bearer-token gate that is the only network entry |
| Settings       | `packages/shared/src/node/lan-hub.ts`                                            | `lan-hub.json` in the data directory: the LANs of this installation and the name of this machine                              |
| Contract       | `packages/shared/src/lan-hub.ts`                                                 | What a renderer may know: ids, slugs, invites, users. Never a credential                                                      |
| Membership     | `apps/cli/src/lib/lan/lan-membership.ts`                                         | One workspace and one gateway per LAN for the running agent service                                                           |
| Store          | `packages/shared/src/node/lan-hub-store.ts`                                      | The settings as the desktop shell holds and edits them                                                                        |
| Bridge         | `apps/electron/src/main/services/lan-hub-forward.ts`                             | Forwards `lody-hub://<lan id>` to the hub of that LAN and adds its credential                                                 |
| Follower       | `packages/components/src/providers/local-platform-follower.ts`                   | Keeps the renderer's workspaces equal to the CLI catalog                                                                      |
| Services       | `apps/cli/src/lib/lan/service.ts`                                                | systemd user units that keep a hub and an agent service running on a server                                                   |
| Terminals      | `apps/cli/src/lib/lan/lan-terminal*.ts`, `apps/cli/src/lib/terminal-services.ts` | Members open terminals on each other's machines, directly and not through the hub                                             |
| Machines       | `apps/cli/src/lib/lan/lan-members.ts`, `lan-fleet-control.ts`                    | What a machine says about itself, the list of machines, and requests between members                                          |
| Releases       | `packages/shared/src/lan-release.ts`, `packages/shared/src/node/lan-release.ts`  | What a build follows, how builds are ordered, and the checked download of a release file                                      |
| Service update | `apps/cli/src/lib/lan/lan-self-update.ts`, `lan-machine-control.ts`              | An agent service that replaces itself with the newest build                                                                   |
| Desktop update | `apps/electron/src/main/services/lan-updater-*.ts`                               | A desktop application that replaces itself with the newest build                                                              |

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

## One user per LAN

Visibility and authorization compare user ids: the desktop shows a machine
whose owner is the current user, and an agent service accepts a request of
its own user. The members of a LAN therefore act as one user, like one account
signed in on several devices. That user is derived from the credential, as the
workspace is, so every build that knows the credential agrees on it and an
installation can be updated without the others. It grants nothing: whoever
reaches a hub already holds its credential.

A member of two LANs is two users. Each workspace runs as the user of its own
LAN: the fleet hands a workspace runtime the port with that identity, the local
access oracle answers per workspace, and a desktop window acts as the user of
the workspace its route names. Only what has no workspace uses the user of the
first LAN, which is why a changed first LAN restarts the agent service.

An installation without a LAN keeps the identity and the implicit workspace it
always had. `local-identity.json` remembers which workspace that is, because the
catalog names its owner by whoever reconciled last; leaving the last LAN brings
that workspace back instead of creating an empty one.

## Terminals of other members

A terminal cannot go through the hub: every keystroke would be a stream write,
and the hub would store what was typed. Members therefore connect to each
other. The agent service of each member listens on the address it has toward
each hub, on port 8789 unless that is taken, and publishes the endpoint as
`lanTerminal` in its machine metadata of that LAN's workspace.

```text
 desktop ─ unix socket ─▶ agent service ─ TLS-PSK ─▶ agent service ─▶ shell
          (as before)     of this machine            of the member
                          routes by the machine
                          that owns the session
```

The desktop keeps talking to its own agent service over the local terminal
socket; that service routes each terminal by the machine that owns its
session. For another member it connects with TLS keyed by the LAN's
credential (TLS-PSK): only a member completes the handshake in either
direction, the traffic is encrypted, and no certificate is involved. After the
handshake the client names the machine it meant to reach, so an address that
passed to another member does not receive its input. A connection reaches only
sessions of that LAN's workspace owned by the machine, and only terminals it
listed, opened or attached.

The session header offers a terminal for another member's session while that
member is online and publishes an endpoint. A dropped connection ends its
terminals on the desktop; the shells keep running over there, and listing the
session again finds them. `LODY_LAN_TERMINAL_PORT` chooses another port, `0`
any port, and `off` closes a machine's terminals to members.

## The machines of a LAN

Settings > LAN and `lody lan machines` list every machine the LANs of this
machine reach. The agent service answers for the list: it runs one workspace
per LAN and so sees all of them, while a window shows one.

A machine says what it runs in its own machine metadata of each LAN's
workspace, where members already read its name:

| Field       | What it says                                                                 |
| ----------- | ---------------------------------------------------------------------------- |
| `lanBuild`  | The version, the releases the build follows, and who updates it              |
| `lanUpdate` | Where an update stands; absent while none is under way                       |
| `lanAgents` | The runtime of each agent it has providers for: installed and pinned version |

Listing asks nothing of a machine. What a member asks of one is a
project-control request, and four of them cross machines: `lan/update-machine`,
`lan/install-agent`, `hosted-config/preview` and `hosted-config/import`.

```text
 window ─ lan/forward ─▶ agent service ─ stream in the hub ─▶ agent service
                         of this machine                      of the member
```

The window hands the request to the agent service of its own machine, which
puts it on the stream the member reads in the hub of a LAN both are in, the way
a desktop browses the projects of another machine. A machine advertises
`lanControl` in its protocol capabilities. One that does not is not asked: it
would drop a request it cannot read without answering, and the asking member
would wait in vain. Such a machine is updated by hand once.

The runtime of an agent is pinned by the build of the agent service. A machine
reports the version it has and the one its build runs agents with, and
`lan/install-agent` installs the pinned one; a later runtime arrives with a
later build.

## Updates

The workflow that builds a release stamps its builds with the repository it
ran in and the tag it publishes (`LODY_LAN_REPOSITORY`, `LODY_LAN_TAG` and
`LODY_LAN_COMMIT`, compiled in as `__LODY_LAN_RELEASE_JSON__`). A stamped build
follows `manifest.json` of that release, so a fork of the fork follows its own
releases; a build made anywhere else follows nothing. Builds are ordered by the
upstream version first and the build number second, and only a later build is
installed. Every file is checked against the size and the SHA-256 the manifest
names. A release replaces its files one by one, so a mismatch is what a
download meets while a newer build is being published.

Who replaces the agent service of a machine is its update channel:

| Channel   | The agent service                                                                     | Who updates it                       |
| --------- | ------------------------------------------------------------------------------------- | ------------------------------------ |
| `service` | Was installed by the install script, and systemd or the daemon runner starts it again | Itself, when a member asks           |
| `desktop` | Is carried by a desktop application                                                   | The application, from its own window |
| `manual`  | Anything else, such as a checkout or a service started by hand                        | Whoever installed it                 |

An agent service installs the newest build beside the running one, starts it
once to see that it reports the version it should, and only then renames it
into place; the replaced build stays as `node_modules.previous` until the next
update. Whatever fails before the rename leaves the installation as it was.
The machine answers a request before it installs, because being done starts it
again, together with the hub if it hosts one. Members follow `lanUpdate`, and
the update is over when the machine registers with the new version.

A desktop application checks when it starts, every quarter of an hour and
when the computer wakes up, and asks before it downloads: a fork publishes a
build for every push. A check in the background leaves an update it already
offers on screen. It is replaced after it quit, by a script that first waits
for it to be gone.

| Platform | How the application is replaced                                           |
| -------- | ------------------------------------------------------------------------- |
| macOS    | The bundle is swapped with one staged beside it, so each move is a rename |
| Windows  | The installer runs without asking and starts the application              |
| Linux    | The downloaded AppImage is renamed over the running one                   |

An application that runs from a disk image, or from the read-only copy the
system makes of a quarantined application, cannot replace itself and says so.
On macOS and Linux a replacement that fails starts the application that was
there and leaves the reason in `lan-updates/last-failure.txt` of the
application data; the application shows it with the update it offers again.
The Windows installer reports nothing.

## Following a change

Settings change while processes run: `lody lan join` on a server, or Settings >
LAN on a desktop. Both write `lan-hub.json`, and every process that reads it
watches it.

| Change                            | Agent service                  | Desktop                                           |
| --------------------------------- | ------------------------------ | ------------------------------------------------- |
| LAN joined, left or renamed       | Starts or stops that workspace | The switcher follows the next snapshot            |
| First LAN changed, joined or left | Exits with the restart code    | Reloads, because the installation is another user |
| LAN moved to another address      | Exits with the restart code    | The bridge resolves the new address per request   |
| Machine renamed                   | Exits with the restart code    | Nothing                                           |

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
it. The desktop builds are unsigned, which neither the updater of the platform
nor the one of the framework accepts, so a fork build [updates itself](#updates).
The update service of the publisher stays off on the local platform: a fork
build is never replaced by an upstream release.
Changes to a submodule the fork cannot push to live in `patches/submodules/`;
`scripts/apply-submodule-patches.mjs` applies them before the adapters build,
and fails the build once an upstream update conflicts with one.

## Limits

- The hub is a development server on SQLite: one node, no replication. Back up
  its data directory.
- A credential cannot be rotated in place. Host a new LAN and move.
- Settings > Machines and the machine picker of Prompt Shortcuts depend on the
  `remoteMachines` capability, which a LAN does not grant. Settings > LAN lists
  the machines instead.
- A desktop application is updated from its own window, and an agent service
  that nothing starts again by whoever started it; no member can ask either.
- A request between members waits in the hub for up to two minutes. Anyone who
  holds the credential can read it there, as they can read everything else.
- The desktop application cannot host a LAN; it does not ship the Streams
  server.
- Terminals of other members need a direct path between the machines, which an
  overlay network gives; a hub reached through a proxy does not.
