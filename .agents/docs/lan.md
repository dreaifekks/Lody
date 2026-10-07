# LANs: machines that reach each other without an account

The local platform has no account service, so nothing tells two installations
that they belong together. A LAN does: it is a self-hosted Streams hub plus the
credential that opens it. Every installation that holds the credential is a
member, sees the other members' machines and projects, and can run agents on
them. This page explains how the pieces fit; the invariants stay in the scoped
`AGENTS.md` files it links to.

## The pieces

| Piece          | Where                                                                                       | What it does                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Hub            | `apps/cli/src/lib/lan/hub-server.ts`                                                        | The single-node Streams server of `@loro-dev/loro-cli` on loopback, behind a bearer-token gate that is the only network entry |
| Handover       | `apps/cli/src/lib/lan/hub-handover.ts`, `lan-host.ts`                                       | Moves a hub onto another machine and points the members there                                                                 |
| Settings       | `packages/shared/src/node/lan-hub.ts`                                                       | `lan-hub.json` in the data directory: the LANs of this installation and the name of this machine                              |
| Contract       | `packages/shared/src/lan-hub.ts`                                                            | What a renderer may know: ids, slugs, invites, users. Never a credential                                                      |
| Membership     | `apps/cli/src/lib/lan/lan-membership.ts`                                                    | One workspace and one gateway per LAN for the running agent service                                                           |
| Store          | `packages/shared/src/node/lan-hub-store.ts`                                                 | The settings as the desktop shell holds and edits them                                                                        |
| Bridge         | `apps/electron/src/main/services/lan-hub-forward.ts`                                        | Forwards the document routes (`/ds/`) of `lody-hub://<lan id>` to the hub of that LAN and adds its credential                 |
| Follower       | `packages/components/src/providers/local-platform-follower.ts`                              | Keeps the renderer's workspaces equal to the CLI catalog                                                                      |
| Services       | `apps/cli/src/lib/lan/service.ts`                                                           | systemd user units that keep a hub and an agent service running on a server                                                   |
| Terminals      | `apps/cli/src/lib/lan/lan-terminal*.ts`, `apps/cli/src/lib/terminal-services.ts`            | Members open terminals on each other's machines, directly and not through the hub                                             |
| Files          | `apps/cli/src/lib/lan/lan-files.ts`, `lan-file-handoff.ts`                                  | The files and images of a message reach the machine that runs its session, over the connection terminals use                  |
| Folders        | `apps/cli/src/lib/lan/lan-ssh.ts`, `packages/shared/src/lan-ssh.ts`                         | Where the SSH server of a machine answers, so an editor on another member opens a folder of it                                |
| Machines       | `apps/cli/src/lib/lan/lan-members.ts`, `lan-fleet-control.ts`                               | What a machine says about itself, the list of machines, and requests between members                                          |
| Standby        | `apps/cli/src/lib/lan/lan-hub-standby.ts`, `hub-snapshot.ts`, `hub-failover.ts`             | Keeps a copy of the hub on another server and starts a hub from it when the hub stays away                                    |
| Requests       | `apps/cli/src/lib/lan/lan-control-channel.ts`                                               | A request of one member to another and its answer, over the connection terminals use                                          |
| Releases       | `packages/shared/src/lan-release.ts`, `packages/shared/src/node/lan-release.ts`             | What a build follows, how builds are ordered, and the checked download of a release file                                      |
| Service update | `apps/cli/src/lib/lan/lan-self-update.ts`, `lan-machine-control.ts`                         | An agent service that replaces itself with the newest build                                                                   |
| Desktop update | `apps/electron/src/main/services/lan-updater-*.ts`                                          | A desktop application that replaces itself with the newest build                                                              |
| GitHub         | `apps/cli/src/lib/lan/hub-github.ts`, `lan-github-tokens.ts`, `lan-agent-github.ts`         | One GitHub token on the host for members that have no `gh` login                                                              |
| Credentials    | `apps/cli/src/lib/lan/hub-credentials.ts`, `lan-credential-sync.ts`, `lan-push-fallback.ts` | Every member keeps a copy of the GitHub token, the APNs key and the phones, and uses it while the hub is away                 |
| Ports          | `apps/cli/src/lib/lan/lan-tunnel.ts`, `apps/cli/src/lib/local-tunnel-server.ts`             | A program of one member reaches a port another member reaches                                                                 |
| Usage          | `apps/cli/src/lib/usage/local-usage-ledger.ts`, `packages/components/src/lib/lan-usage.ts`  | Each machine counts what its agents used; the usage page gathers it from every member                                         |

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

A shell can also belong to a machine rather than to a session. Its terminals
are opened, listed and attached under the scope `lody-shell:<machine id>` in
place of a session id (`machineShellScope` in
`packages/shared/src/terminal-protocol.ts`); an `open` in that scope may name
the directory to start in, the home directory by default, and a command to run
instead of a login shell. The agent service routes the scope by its machine as
it routes a session by its owner, and a member opens only the shells of its own
machine (`ScopedTerminalService`). That grants nothing new: a member that holds
the LAN's key could open a shell in any session of the machine already. A
machine says it opens them with the `lanShell` protocol capability; a build
without it would answer the scope as an unknown session, so it is not asked.

`lody-lan lan shell <machine>` is the client. The command connects to the local
terminal socket, as a desktop does, so the LAN's credential stays in the agent
service. Enter, `~` and `.` leaves the shell running, `--attach` brings it
back, `--list` and `--kill` manage what runs there, and words after `--` run
as a command whose exit code the command returns. The command opens with
`attach`, so the connection receives the terminal's events from the moment it
exists: a command that ends before a second request could cross the network
still reports its output and exit. A machine whose answer does not say
`attached` is attached afterwards, as before. The command runs in a
terminal there, like `ssh -t`, so piped input is echoed.

## Ports of other members

A dev server an agent starts on another member often listens on that
machine's loopback interface only. A connection that asks for `tunnel` names
one port, and optionally a host, in its first line
(`apps/cli/src/lib/lan/lan-tunnel.ts`); the member connects to that port of
its own loopback interface, or of the host as it reaches it, answers
`connected` or the reason it could not, and from then on the connection carries
the port's bytes both ways. The host is not restricted, as `ssh -L` restricts
none: a member that holds the LAN's key can run anything on the machine, and
so reach whatever the machine reaches, already. A machine says it serves them
with the `lanTunnel` protocol capability.

```text
 program ─▶ local tunnel socket ─▶ agent service ─ TLS-PSK ─▶ agent service ─▶ <host>:<port>
 of this    names machine, host,   of this machine            of the member      localhost unless
 machine    port                                                                 a host is named
```

Programs of this machine reach it through the agent service's local tunnel
socket (`getLocalTunnelSocketPath`, beside the terminal socket), which takes the
same first line plus the machine; this machine's own ports are connected
directly. `lody-lan lan forward <machine> [<local>:][<host>:]<port>...`
listens on `127.0.0.1` (`--bind` for another address) and carries every
connection there until it ends.

The Browser panel of a desktop previews the dev server of a session another
member runs the same way. There is no hosted preview on the local platform, so
the desktop asks the agent service of its own machine for the endpoint, as for
a session of its own: that service listens on the same port of its loopback
interface, or, when this machine already uses it, on a free one picked at
random between 10000 and 19999 (`apps/cli/src/preview/lan-member-ports.ts`).
It carries each connection to the member through its tunnel socket and proxies
that port as one of this machine. Keeping the number keeps working the
addresses a page spells out itself; a random port does not. The endpoint names
the member's port either way, which the Browser panel matches against what it
asked for. Sessions previewing the same port of the
same member share one carrying port, which closes once none previews through
it.

Nothing else in the panel asks for the hosted preview service there, which
authorizes every preview control on another machine and creates the shared
tunnels. The panel reads no preview status, and Share, Restore preview and
Stop sharing are hidden (`remotePreview` capability). The iOS Simulator of
another member is not offered either, for the same reason.

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

A picture is still shown as one. The desktop asks the agent service of its own
machine for the file (`session/file-read-local`, with the block's size and
digest and a path the desktop created); it copies the file from its store, or,
when another member keeps it, asks that member over the same `files`
connection with a `read` line. The member answers with the size and the bytes
of a file of a session it has not deleted, and the asker writes them only once
they match the block. Up to 10 MB a picture is read on sight, a larger one on a
click, and the window keeps what it read for the life of the page. A member of
a build from before `read` refuses it, and the card stays.

An image over the 5 MB image limit travels as a file from the new-chat page
too, as it does in a conversation. That limit stays: it is what the agent
receives as an image.

What an agent sends the other way (`lody_upload_images`, `lody_upload_files`,
a Codex generated image, an image or file in its ACP output) is kept the same
way. Without a relay store the agent service stores it as it stores a handed
over file and writes a file block that names its own machine; an image becomes
a file of an image type, which is shown as one. Any file card a desktop can
read that way downloads on a click, through the same `session/file-read-local`.

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

Every server is tried from the same moment on, and the entry at which one
answers first is taken: it is the one with the shortest way to the machine
from where the desktop is, the network of the house at home and the overlay
network elsewhere. No entry that stays silent is waited for. Where two answer
at once, the entry for the address the machine named comes first, then the
order of the file. An entry that goes through another host is not tried and
comes after them. Nothing is asked about an entry the configuration says is
for another user or port. Where no entry answers, the editor is handed
`user@host` as the machine named them, and connects with the keys `ssh` offers
any host.

The user may name the entry instead. Settings > LAN keeps an entry for each
machine (`packages/components/src/lib/machine-ssh-entry.ts`), on the desktop
it is named on: the configuration it is an entry of is that desktop's own. A
named entry is handed over as it is written, without being looked for or
tried, to every editor that can be handed it.

No password is kept for a machine. An editor starts `ssh` itself and asks for
what the server wants; the VS Code family takes no password from whoever
starts it, and one handed to Zed would travel among the arguments of a
process, where every program of the desktop reads it.

The session header offers the editors that work over SSH, which are the VS
Code family and Zed, while the machine of the session names a server. VS Code
and what is built on it take the folder as a `vscode-remote` address and Zed
as an `ssh` one. User, host and the name of an entry are limited to what cannot
be read as an option or as part of an address, by the machine that publishes
them and again by the desktop that reads them, and the path travels encoded.

The name of an entry is whatever its owner chose, and an address is not made
for every name:

| Editor         | A name with capital letters, a colon or a port                         |
| -------------- | ---------------------------------------------------------------------- |
| VS Code family | Handed over as the hexadecimal of its parts, as these editors write it |
| Zed            | With capital letters as it is; an entry with a colon is not taken      |

The VS Code family writes the authority of an address in small letters and
reads a colon in it as the start of a port, so it has its own way to write
such a destination, and the desktop uses it for those only: what the editor
reads as it is written stays as its owner knows it. Zed is handed the machine
as the host of an `ssh` address, where a colon starts the port. For Zed the
desktop therefore asks for an entry an address can name, and an entry such as
`Host ts:server` is reached by giving it a second name: `Host ts:server
ts-server`.

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

Two fields are not the machine's own: `lanAlias`, the short name a member gave
it in Settings > LAN, and `lanColor`, the color of that name, one of
`LAN_MACHINE_COLORS`. The agent service of that member writes both into every
LAN it shares with the machine, which need not be online, and the last one
written wins. The renderer's machine metadata shows the short name as the
machine's `name` everywhere (the registered name stays in `ownName`), the
sidebar and the list draw it in its color, and a member puts the short name in
the alerts it reports to the hub in place of that name.

How a LAN answers is shown where a member looks for it. The sidebar's nameplate
adds the hub's round trip in quiet ink while the workspace is connected, and
the LAN settings add it after the address of each LAN. What answers is the
resting state and gets no mark of its own: a LAN or a machine is marked only
when it does not answer. The shell measures the hub's round trip every ten
seconds on one kept connection, from the request to the first byte
(`measureLanHubLatency`). A machine's round trip is a `machine/ping` through
the hub, measured while its sidebar card is open or the LAN settings show it,
every fifteen seconds; one that does not answer within six seconds says so.

Listing asks nothing of a machine. What a member asks of one is a
project-control request, and these cross machines: `lan/update-machine`,
`lan/restart-machine`, `lan/install-agent`, `lan/usage`,
`hosted-config/preview` and `hosted-config/import`. A restart is refused by a
service nothing would start again (update channel `manual`), and answered
before the service exits.

```text
 window ─ lan/forward ─▶ agent service ─ TLS-PSK ─────────────────▶ agent service
                         of this machine                            of the member
                                   └─ stream in the hub, if no connection ─┘
```

The window hands the request to the agent service of its own machine, which
connects to the member where it accepts members, as for a terminal, with a
hello that asks for `control`. The connection carries the request and the
answer, one line each, and ends; the member answers only for the workspace of
the LAN whose key opened it. The hub carries the request only when that
connection never got as far as the request: the member publishes no endpoint,
cannot be reached from here, or runs a build that serves no `control`. It then
goes on the stream the member reads in the hub of a LAN both are in, the way a
desktop browses the projects of another machine. A connection that breaks
after the request left is not tried again through the hub, so no member is
asked twice.

A machine advertises `lanControl` in its protocol capabilities. One that does
not is not asked by either way: it would drop a request it cannot read without
answering, and the asking member would wait in vain. Such a machine is updated
by hand once.

The runtime of an agent is pinned by the build of the agent service. A machine
reports the version it has and the one its build runs agents with, and
`lan/install-agent` installs the pinned one; a later runtime arrives with a
later build.

Settings > LAN offers a machine's agent processes, which the machine monitor
of the LAN's workspace shows and a member may end, and removes a machine that
is gone for good from the LAN the window shows. Neither is a request between
members: the monitor and the machine's record are in the workspace.

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

A download has no limit on how long it takes, only on how long it receives
nothing (a minute): a desktop bundle is around 180 MB, which a slow connection
abroad takes half an hour for. A connection that breaks off or stalls is asked
again, with a range, for what is missing, as long as each try still receives
something; a few in a row that receive nothing end it. What arrived stays as
`<file>.partial` beside the digest of the file it belongs to, so the desktop
application continues it with its next download of the same file, also after it
was started again, and discards the part of another build. An agent service
discards it with its staging directory, its file being small. A host that ignores
the range sends the whole file, which replaces the part. The file is checked as
a whole once it is complete.

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
names carry no version. It runs only for a tag `v<upstream>-lan.<n>`, pushed
when the branch is ready, whose build replaces the release; run by hand on a
branch, it builds without publishing. `<upstream>` is the newest release in the synced changelog
(`site-docs/content/changelog/en`, since upstream never bumps its manifests),
and `<n>` restarts at 1 with each upstream release, so the updater's order of
upstream part first, build second always puts a later tag after an earlier one.
`lan-release.mjs version` prints the next tag's version.

A tag `dev-v<upstream>-lan.<n>` builds the same way and replaces `lan-dev`
instead, a prerelease that only installations made from it follow: its builds
are stamped with that tag, and its install scripts install from it. A branch
is tried on a few machines that way before it is merged and released to
everyone. Dev builds number themselves on their own
(`lan-release.mjs version --channel dev`), since a build only compares itself
with the builds of the release it follows; a machine changes channel by
installing from the other release. `scripts/lan-release.mjs` names the build and assembles
the release; `scripts/lan/install.sh` and `install-mac.sh` are published with
it. A fork build may carry no publisher's signature, which neither the updater
of the platform nor the one of the framework accepts, so every fork build
[updates itself](#updates).
The update service of the publisher stays off on the local platform: a fork
build is never replaced by an upstream release.

A fork publishes no `lody-code-review-viewer` package, so the CLI build copies
the viewer it pinned beside its bundle (`code-review-viewer.html`), and
`lody review` reads it from there before it asks a CDN; the hash it was built
with still decides.

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

## Moving the host

A LAN is its credential, so its hub can move to another machine and stay the
same LAN: the data directory goes along, and the members only need the new
address. `lody lan take-over`, run on a member that is to host the LAN, does
both with the current host.

```text
 new host                               current host
 POST /lan/handover ──────────────────▶ stops its Streams server, serves nothing
                    ◀── data directory ─ token, database, GitHub and push files
 starts a hub with it
 POST /lan/handover/complete ─────────▶ writes moved.json, answers 410 with the
                                        new address to every request after
```

While it hands over, the current host answers every request with 503: a
database that stands still is one a plain copy reads whole, write-ahead log
included. Each file travels with its size and SHA-256 and the new host checks
that the credential it received is the LAN's own. Until `complete` nothing is
decided. A new host that fails before it, including one whose hub never
answers, removes its hub service and tells the current host to serve again;
a current host that hears nothing for ten minutes does so by itself. Two hubs
therefore never serve one LAN.

After `complete` the former host is a pointer. `/lan/where` and every request
behind its gate answer with the new address, signed with a key derived from
the credential, and it stays a pointer across restarts. The agent service of
every member asks each hub where it is once a minute (`LanMembership`), writes
an address that carries a valid signature into `lan-hub.json`, and then
[follows the change](#following-a-change) as it follows `lody lan move`. A
hub that is away has not moved, and an address without the signature is not
followed: a member hands the credential to whatever address it follows.

Once every member follows, `lody lan down --keep-agent` on the former host
stops the pointer. A member that was away longer has to be moved by hand.

## A desktop's requests to other machines

A desktop asks another machine for what it shows of that machine's sessions
and projects with machine RPC requests, which the hub carries on request and
response streams. In a LAN the window hands the ones answered once (dispatch,
steer, cancel, goal and live status of a session, its preparation, Code
Collab and file previews, project control and git state) to the agent service
of its own machine instead (`lan/rpc-forward` on the local socket). That
service carries the request, as the hub would have carried it, to the member
over the connection terminals use (a hello that asks for `rpc`,
`lan-rpc-channel.ts`), and the member handles it as one read from its request
stream, with the same checks and the same encryption
(`handleDirectRequest` of the machine RPC server), its answers coming back
over the connection instead of going to the hub.

A request that never reached the member, because it publishes no endpoint,
runs a build without `rpc` or cannot be reached from here, goes through the
hub as before. One that reached it and failed is not sent again. Requests
that wait for a second one, such as a cancellation, or that report progress
(restarts, updates, sign-ins, runtime installs) stay on the hub.

## Sessions agents start on other machines

An agent asks for a session on another machine of its LAN through Lody's
tools (`lody_session_create`, `lody_session_chat`, `lody_session_status_many`,
`lody_session_cancel`) as the desktop does. A session in a local project of
that machine reads the project's git state from it over the LAN. The agent service of its own
machine writes the session's document and dispatch pointer into the LAN's
workspace, which the other machine reads through the hub, and asks that
machine over the hub's request streams to take the turn now rather than
when it next looks (`SessionCommandRemote` in
`apps/cli/src/lib/session-command-environment.ts`). The operation stays with
the machine that was asked, which completes it from the synced document.

A machine of the LAN is reached when it is the workspace user's, like every
member; a machine the hub says is offline is refused, and one the hub cannot
say anything about is left to the document, which waits for it.

That is all the asking machine decides. What the other machine holds, such
as whether a project is still there or which turn is running, is for that
machine to answer: the copy of its documents here may be behind. A project
missing from that copy does not refuse a chat; the machine reports it when it
runs the turn. A cancel from an agent or from a terminal (`lody session
cancel`) names no turn when the target advertises `sessionCancelActiveTurn`,
and the target stops the turn it is running; an older build, which needs a
turn named, is told the one its session was last asked for, as before. What
another machine wrote (a session, its agent configs and projects, a
schedule's target) is read after a sync, and a sync that fails is reported as
one to retry (`SYNC_UNAVAILABLE`), not as something that does not exist.

## Standby and failover

A machine that could host a hub, a server whose agent service the install
script set up, says so in its machine metadata (`lanHubRole`), with its round
trip to the hub in steps of 5 ms. Every member chooses the same standby from
what all of them say (`chooseLanHubStandby` in `packages/shared/src/lan-hub-role.ts`):
the capable member closest to the hub that does not host it. One that keeps a
fresh copy stays the standby until another is clearly closer.
`LODY_LAN_STANDBY=off` keeps a server out of it.

The standby copies the hub every ten minutes. The hub backs its database up
while it serves (SQLite's online backup) and sends only the 64 KB blocks whose
digests differ from the standby's copy, with its other files; the standby
patches its copy beside the current one and keeps it only when every block
matches.

```text
 every member, every minute      hub away 2 min: ask the members where it is
 the standby                     hub away 3 min, no member reaches it:
                                 start a hub from the copy in the next term,
                                 tell the members, follow it, then tell the
                                 old address until a hub there hears it
```

Members tell each other over the connection terminals use (`lan-hub-peers.ts`,
a hello that asks for `hub`): where each follows the hub, in which term, and
whether it reaches it; and that a standby took over. Every move of the hub
starts the next term, kept in `term.json` with the hub's data; a member keeps
the term it follows in `lan-hub-terms.json` and follows a later one only. Two
hubs of the same term settle on the address that sorts first.

A hub that came back after a failover hears from the new hub's machine at
`/lan/superseded`, stops serving and points its members to the new address,
as after a handover. What members wrote to it meanwhile they still hold, and
send to the new hub themselves.

The copy may be minutes behind the hub it replaces. A member that read past
the copy's end would resume where the new hub has other bytes: it reads
entries out of place and cannot join the room again. Before the new hub
serves, every binary stream of the copy therefore continues at a base offset
no earlier hub reached (`epoch.json`), and the gate answers a read from an
offset before the base with 410. A client that hears 410 bootstraps again and
sends what the hub lacks, which is how a write that only it and the lost hub
had survives (`hub-failover.test.ts` runs this against the Streams server).
JSON streams, the short-lived request streams, keep their offsets.

## GitHub

Hosted Lody brokers GitHub tokens from its own GitHub App, whose key and
webhooks live on a private server. A LAN has one user, so its host keeps one
token instead: a fine-grained personal access token, or the token of the
host's own `gh` login. `lody lan github setup`, run on any member, asks GitHub
whose it is and sends it to the hub, which saves it in `github.json` of its data
directory; members ask for it at `/github/token` behind the credential gate,
and the host never logs it. `lody lan github status` and `remove` read and drop
it. Members keep a copy of it (see [credentials on every member](#credentials-on-every-member)).

Three places ask the host:

- The pull request panel of a desktop asks the hosts of its LANs from the main
  process, and uses the machine's `gh` login when none keeps a token.
- The agent service hands the host's token to the hosted token port of each
  LAN workspace. PR status checks prefer it over the machine's `gh` login,
  and auto review and merge, which upstream starts only when that port exists,
  now runs on a LAN.
- An agent gets the token only on a machine whose `gh` is not logged in:
  `GH_TOKEN` for `gh`, and a Git credential helper for github.com placed after
  every helper the machine has. Credentials the machine has win, and an SSH
  remote still needs a key of the machine. A session keeps the token it
  started with.

There is no repository registry either: the repositories an agent's
discovery tools and the desktop's pickers offer are the ones the credential
reads (GitHub's `/user/repos`), with the machine's `gh` login before the
host's token. There is no personal identity, no per-repository scoping and no
webhook: the panel refreshes when opened and by polling.

## Credentials on every member

The hub holds three credentials: the GitHub token, the APNs key, and the
phones registered for push. A standby copies them with the rest of the hub, so
a hub started from its copy pushes and hands out the token as before. Every
agent service also keeps a copy of them, so they outlast the hub being away
and a hub that has none of them yet:

- Each agent service asks every hub of its LANs for `/lan/credentials` when it
  starts, every ten minutes and when it follows a hub elsewhere, and writes what
  changed to `<data directory>/lan-credentials/<lan id>/` in the hub's own file
  layout, private to the user (`lan-credential-sync.ts`). Leaving a LAN removes
  its copy. A hub of an earlier build answers 404 and the copy stays as it was.
- The GitHub token port and the desktop's pull request panel use the copy
  while the hub cannot be reached. A hub that answers it keeps no token is
  believed; its copy follows within ten minutes.
- A member whose report the hub does not take sends the alert itself, from
  its copy of the key and the phones (`lan-push-fallback.ts`): finished,
  failed, waiting for approval, scheduled. That includes a hub that cannot be
  reached, one that hands over (503) or moved (410), and a turn that ends
  while the member's own connection to the hub is down; only a hub without
  push (404) is left at that. Live Activities stay with the hub, which alone
  merges what every member reports. The hub gives every alert a collapse id, so
  an alert sent by both shows once.
- A hub started from a standby copy takes what that copy lacks from the
  machine's own copy of the credentials.

`lody lan github setup` and `lody lan push setup` send the credential to the hub
of the LAN from any member; `--data-dir` writes into a hub's data directory on
the machine instead. The renderer never reaches these routes: the bridge
forwards `/ds/` alone, as the standby copy and the credentials route carry
what only a member may hold.

## Usage

The hosted service counts what every agent used from what each machine reports
to it. A LAN has no such service, so each machine counts for itself: on the
local platform the agent service's usage port is a ledger on its own disk
(`apps/cli/src/lib/usage/local-usage-ledger.ts`, `<data dir>/usage-ledger.json`).
It receives the cumulative per-model counters an agent reports, adds what a
reading grew by since the highest one of its accounting scope, which is how the
hosted service counts too, and files the growth under the hour it arrived and
the workspace of the session. Hours older than a week are kept as days.

```text
 Settings > AI Usage ─ lan/machines ─▶ agent service ─ lan/usage ─▶ every member of the LAN
                      lan/usage (self)  of this machine   (direct, else the hub)  answers from its ledger
```

The page asks every machine of the workspace's LAN with `lan/usage`, a request
members put to each other like `lan/update-machine`, and builds the hosted
page's timeline, calendar and day views from the answers
(`packages/components/src/lib/lan-usage.ts`). Every member of a LAN is one user,
so the second chart splits by machine where the hosted page splits by member.
A machine that is offline or runs a build without `lan/usage` is named under
the header and left out; its usage is on its own disk until it answers again.
The `localUsage` platform capability shows the page where `usageAnalytics`
does not.

## Limits

- The hub is a development server on SQLite: one node, no replication. Back up
  its data directory.
- A credential cannot be rotated in place. Host a new LAN and move.
- Only a server with a systemd user session takes a LAN over, as only one hosts
  it. A failover loses what the lost hub alone had: what was written after the
  standby's last copy and is held by no member that comes back.
- While its hub is away, a member does not know who is online, so the standby
  is chosen from what the members said before. A standby that is down as well
  leaves the LAN without a hub until someone takes it over by hand. Phones registered for push keep the address they were given; the iOS
  client has to be pointed to the new host by hand. Alerts still reach them,
  as the new hub and every member send from the copied registrations.
- Settings > Machines depends on the `remoteMachines` capability, which a LAN
  does not grant. Settings > LAN lists the machines instead, with their
  processes, restart and removal; Prompt Shortcuts pick a machine wherever
  more than one is listed.
- A desktop application is updated from its own window, and an agent service
  that nothing starts again by whoever started it; no member can ask either to
  update, nor the latter to restart.
- A request between members that cannot connect to each other waits in the hub
  for up to two minutes. Anyone who holds the credential can read it there, as
  they can read everything else.
- The desktop application cannot host a LAN; it does not ship the Streams
  server.
- Terminals and files of other members need a direct path between the
  machines, which an overlay network gives; a hub reached through a proxy does
  not.
- A file stays on the machine that runs its session. Other members download it
  from there but cannot preview it, and it is gone with that machine's data
  directory.
- A folder of another member opens in an editor only. It takes an SSH server
  on that machine and a POSIX path. A machine that reaches its hub over IPv6
  names its server with `LODY_LAN_SSH`, by a host name or an IPv4 address:
  editors do not agree on how an IPv6 address is written. The files of such a
  session do not open in an editor.
