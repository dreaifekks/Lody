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
| Files          | `apps/cli/src/lib/lan/lan-files.ts`, `lan-file-handoff.ts`                       | The files and images of a message reach the machine that runs its session, over the connection terminals use                  |
| Folders        | `apps/cli/src/lib/lan/lan-ssh.ts`, `packages/shared/src/lan-ssh.ts`              | Where the SSH server of a machine answers, so an editor on another member opens a folder of it                                |
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

## Files of a message

An image or a file a message carries has to be on the machine that runs the
session, where the agent reads it. The hosted product uploads it to a store
every machine downloads from; a LAN has none, and the hub is no place for it:
a request in the hub is a line in a stream, which the hub keeps.

```text
 window ─ bytes ─▶ shell ─ temp file ─▶ agent service ─ TLS-PSK ─▶ agent service
                                        of this machine            of the member
                                        names the target           stores it for
                                                                   the session
```

The window hands the bytes to the agent service of its own machine, as it
does for a session of that machine. For a session another member runs, the
request names that machine (`targetMachineId`), and the agent service takes the
files there over the connection terminals use: same listener, same key, and a
hello that asks for `files` instead of a terminal. A member says that it takes
files with the `lanFiles` protocol capability; one that does not is not sent
any, because it would read them as terminal input.

Each file is announced with its session, name, size and SHA-256, and the member
answers `ready` or refuses, so a file it will not take is refused before its
bytes travel. It refuses a session that was archived or deleted, or that
another machine runs. A session it has not heard of it takes: the files of a
message are prepared before the message is written, and the first message of a
conversation is what creates it. What arrived is checked against the announced
size and digest, stored under the name alone whatever path the name carried,
and answered with the block the message then carries, which names the member.

The agent service stores the file as it stores one its own desktop hands over,
and dispatch reads it from there. Nothing uploads it afterwards, so the file
card says where the file is kept instead of promising an upload. A picture
reaches the agent as an image and as a path, as an uploaded one does.

## Folders of other members

An editor opens the folder of a session: its worktree, or the folder of its
project. For a session of another member the folder is on that machine, and an
editor on the desktop reaches it the way it reaches any other machine: over
SSH. The agent service opens nothing for that. It names the SSH server the
machine already runs, as `lanSsh` in its machine metadata of each LAN's
workspace: the user it runs as, the address the machine has toward the hub,
and port 22, with what else the machine is called, which is its host name and
its other addresses.

```text
 desktop ─ starts ─▶ editor ─ SSH ─▶ SSH server ─▶ folder
                     of this machine  of the member
                     given the path and the entry
                     of ~/.ssh/config for the member
```

A machine names an SSH server only where one answers: it connects to that
address and reads the version an SSH server starts with. `LODY_LAN_SSH` says
something else: `[user@]host[:port]` for a server the machine cannot find
itself, such as one that an overlay network runs for it or one behind another
name, and `off` to name none.

The key that lets a desktop in is named in its SSH configuration, under the
entry its owner made for the machine. An editor that is handed the bare
address finds no such entry and asks for a password every time. The desktop
therefore reads `~/.ssh/config`, with what it includes, and hands the editor
the entry that reaches the machine
(`apps/electron/src/main/services/ssh-config-core.ts`), by the name the
configuration writes it with: `Host` tells the letters of one case from the
other.

An entry is for the machine when what it connects to is the address the
machine named, anything else the machine is called, or a name that stands for
one of its addresses, which is how an overlay network names a machine. A name
with the domain of a network and the same name without it count as one. It has
to connect to the port the SSH server answers on, as the user the agent
service runs as; an entry that names no user is handed over as `user@entry`.

A configuration often holds one entry for the network at home and one for an
overlay network, and which of them leads anywhere depends on where the desktop
is. So the desktop asks rather than reads:

| What                         | Whom it asks                                            |
| ---------------------------- | ------------------------------------------------------- |
| What an entry connects to    | `ssh -G`, which also answers what a `Match` makes of it |
| What a name stands for       | The resolver of the desktop                             |
| Whether an entry leads there | The address, for the version an SSH server starts with  |

The entry for the address the machine named comes first, then the others in
the order of the file, and the first at which a server answers is taken; an
entry that goes through another host is not tried and comes after them.
Nothing is asked about an entry the configuration says is for another user or
port. Where no entry answers, the editor is handed `user@host` as the machine
named them, and connects with the keys `ssh` offers any host.

The session header offers the editors that work over SSH, which are the VS
Code family and Zed, while the machine of the session names a server. VS Code
and what is built on it take the folder as a `vscode-remote` address and Zed
as an `ssh` one. User, host and the name of an entry are limited to what cannot
be read as an option or as part of an address, by the machine that publishes
them and again by the desktop that reads them, and the path travels encoded.

An editor trusts the server it works on, so the desktop follows a machine to
the server it names only when the machine is the current user's. Every member
of a LAN is; a machine that someone else owns could name any server.

Whether the desktop is let in stays between it and the SSH server. A custom
launcher hands its path to a program of the desktop and is offered for folders
of the desktop only.

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
it. A fork build may carry no publisher's signature, which neither the updater
of the platform nor the one of the framework accepts, so every fork build
[updates itself](#updates).
The update service of the publisher stays off on the local platform: a fork
build is never replaced by an upstream release.

A fork that stores a code-signing certificate as the secrets
`LAN_MAC_SIGNING_P12` and `LAN_MAC_SIGNING_PASSWORD` signs its macOS builds
with it: macOS keys the permissions a user grants to the identity an
application is signed with, which an unsigned build changes with every build.
`lan-release.mjs signing` reads the certificate, and the workflow signs by what
it finds:

| Certificate       | Team ID | What the workflow does                                                        |
| ----------------- | ------- | ----------------------------------------------------------------------------- |
| Developer ID      | Yes     | Signs with the entitlements as they are and keeps its owner's name out of log |
| Of the fork's own | No      | Trusts it on the runner and signs the application with `LODY_MAC_SELF_SIGNED` |

Under the hardened runtime a process loads only what Apple signed or what
carries its own Team ID. For a certificate without one, `LODY_MAC_SELF_SIGNED`
has `package-electron.mjs` sign the application with the exception from library
validation its nested binaries have; without it the application ends in dyld
before it runs. The packaging probes run before signing, so the workflow starts
the signed application and its helper once and publishes nothing that does not
start.

The certificate always comes from the secrets. Signing that asks Apple for one
uses up one of the few an account may have with every build, because a runner
keeps no key. No build is notarized: Gatekeeper stops a copy downloaded with a
browser, while the install script and an update leave no quarantine mark.
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
- Terminals and files of other members need a direct path between the
  machines, which an overlay network gives; a hub reached through a proxy does
  not.
- A file stays on the machine that runs its session. Other members see its
  card and cannot open it, and it is gone with that machine's data directory.
- A folder of another member opens in an editor only. It takes an SSH server
  on that machine and a POSIX path. A machine that reaches its hub over IPv6
  names its server with `LODY_LAN_SSH`, by a host name or an IPv4 address:
  editors do not agree on how an IPv6 address is written. The files of such a
  session do not open in an editor.
