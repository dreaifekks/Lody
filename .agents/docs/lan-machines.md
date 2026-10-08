# LAN machines

The machines of a [LAN](lan.md): what each says about itself, the requests
members put to each other about a machine, and how the processes follow a
change of the LAN settings while they run.

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
`lan/restart-machine`, `lan/install-agent`, `lan/usage`, `lan/github`,
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

## Following a change

Settings change while processes run: `lody lan join` on a server, or Settings >
LAN on a desktop. Both write `lan-hub.json`, and every process that reads it
watches it.

| Change                            | Agent service                  | Desktop                                           |
| --------------------------------- | ------------------------------ | ------------------------------------------------- |
| LAN joined, left or renamed       | Starts or stops that workspace | The switcher follows the next snapshot            |
| First LAN changed, joined or left | Exits with the restart code    | Reloads, because the installation is another user |
| LAN moved to another address      | Reconnects that workspace      | The bridge resolves the new address per request   |
| Machine renamed                   | Exits with the restart code    | Nothing                                           |

The restart code is `CLI_EXIT_CODE_REMOTE_RESTART`. The daemon runner, the
desktop supervisor and the systemd unit all start the service again after it; a
service started by hand in a terminal has to be started again by hand. Agents
running on the machine are interrupted by a restart, so the editors warn before
the two edits that cause one.

A move restarts nothing. The fleet detaches that workspace's Streams transport
and attaches a new one toward the new address (`followLanMoves` in
`lody-fleet.ts`, the remote bridge transition the hosted build uses offline);
presence and the machine monitor go with it. Machine RPC reads its request
stream from the start, as at startup, and skips the requests it already read:
after a failover the offset it held may lie past the copy's end of that JSON
stream, which the [epoch](lan-host.md#standby-and-failover) does not cover, and the hub
may answer it with an empty 200 rather than 410. Push, credentials and GitHub
requests read the address per request and hold no offset. Agents and their
turns keep running on the local replica, and what they wrote meanwhile reaches
the new hub when the transport catches up.

## Limits

- Settings > Machines depends on the `remoteMachines` capability, which a LAN
  does not grant. Settings > LAN lists the machines instead, with their
  processes, restart and removal; Prompt Shortcuts pick a machine wherever
  more than one is listed.
- A request between members that cannot connect to each other waits in the hub
  for up to two minutes. Anyone who holds the credential can read it there, as
  they can read everything else.
