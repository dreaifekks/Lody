# LAN members: terminals, ports, files and requests

Members of a [LAN](lan.md) connect to each other directly for what the hub
should not carry or keep: terminals, ports, the files of a message, and the
requests a desktop or an agent sends to another machine. Folders that open in
an editor are in [folders over SSH](lan-folders.md).

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
read that way downloads on a click, through the same `session/file-read-local`,
and a file with a text preview opens the preview instead, as an uploaded one
does: the desktop reads the whole file and shows its first bytes. The card
still names the machine. When that machine cannot be reached the preview says
why, with the machine's name, and offers the download.

## A desktop's requests to other machines

A desktop asks another machine for what it shows of that machine's sessions
and projects with machine RPC requests, which the hub carries on request and
response streams. In a LAN the window hands the ones answered once (dispatch,
steer, cancel, goal and live status of a session, its preparation, Code
Collab and file previews, project control and git state, memory providers)
to the agent service of its own machine instead (`lan/rpc-forward` on the
local socket). That service carries the request, as the hub would have
carried it, to the member over the connection terminals use (a hello that asks for `rpc`,
`lan-rpc-channel.ts`), and the member handles it as one read from its request
stream, with the same checks and the same encryption
(`handleDirectRequest` of the machine RPC server), its answers coming back
over the connection instead of going to the hub.

A request that never reached the member, because it publishes no endpoint,
runs a build without `rpc` or cannot be reached from here, goes through the
hub as before. One that reached it and failed is not sent again. Requests
that wait for a second one, such as a cancellation, or that report progress
(restarts, updates, sign-ins, runtime installs) stay on the hub.

Settings > Memory lists the machines of the LAN like the Agents settings of a
hosted workspace, so a memory can be imported on a member, such as a headless
one, that a Role runs on. The provider is asked on that member; the import is a
row of the member's machine document, which the window writes and the hub
carries to it.

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

## Limits

- Terminals and files of other members need a direct path between the
  machines, which an overlay network gives; a hub reached through a proxy does
  not.
- A file stays on the machine that runs its session. Other members read it
  from there, so they cannot while that machine is offline, and it is gone with
  that machine's data directory.
