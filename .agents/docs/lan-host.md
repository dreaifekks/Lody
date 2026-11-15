# LAN host: moving the hub, standby and failover

A [LAN](lan.md) is its credential, so its hub can change machines. This page
covers a move by hand and the standby that takes over when the hub stays away.

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
[follows the change](lan-machines.md#following-a-change) as it follows `lody lan move`. It
also asks at once when a request to the hub is answered by such a pointer (a
410 that says `moved`) or three requests in a row fail to reach it
(`lan-hub-watch.ts`), but one hub at most once in ten seconds. A
hub that is away has not moved, and an address without the signature is not
followed: a member hands the credential to whatever address it follows.

Once every member follows, `lody lan down --keep-agent` on the former host
stops the pointer. A member that was away longer has to be moved by hand.

## Standby and failover

A machine that could host a hub, a server whose agent service the install
script set up, says so in its machine metadata (`lanHubRole`), with its round
trip to the hub in steps of 5 ms. Every member chooses the same standby from
what all of them say (`chooseLanHubStandby` in `packages/shared/src/lan-hub-role.ts`):
the capable member closest to the hub that does not host it. One that keeps a
fresh copy stays the standby until another is clearly closer.
`LODY_LAN_STANDBY=off` keeps a server out of it.

The standby copies the hub every ten minutes. The hub copies its database page
by page with SQLite's online backup into `.standby-copy/` in its data directory,
hashes that file, streams only the 64 KB blocks whose digests differ with its
other files, and deletes the copy. It holds a read transaction on the source for
the whole backup, so every step reads the same moment: without it, any write of
the Streams server between two steps restarts the backup, which then never ends
on a busy hub. A pull costs the hub a database's worth of disk writes and next to
no memory. It used to serialize the image in memory instead, which SQLite refuses
above its 2 GiB allocation limit (`Out of memory`).
Before asking for a delta, the standby hashes its current database against the
kept digests; a mismatch invalidates that copy and requests a full one. It stages
and verifies changed blocks in a compact patch file, and finishes copying side
files and shares before patching its current database in place and truncating it
to the new size. It removes `snapshot.json` and syncs its directory before the
first overwrite, checks only the changed blocks after writing, and datasyncs the
database before closing it. It syncs the new marker before renaming it and then
syncs the directory, so a power loss cannot leave a valid marker over mixed pages.
A failed transfer preserves the last good copy; interruption during patching makes
it unusable for takeover and the next pull fetches a full copy. Failures are logged
at warn level and retry after ten minutes, doubling up to two hours; a success
restores the ten-minute cadence. A moved hub URL does not inherit the old URL's
retry delay.

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

## What the hub keeps

The Streams server records a snapshot of a stream by moving the stream's
earliest offset; it never deletes the entries before it. No reader reaches them
any more: a read from below the earliest offset is answered with 410, and a
bootstrap sends the snapshot with the entries after it. The hub deletes them
(`hub-storage.ts`) only while no Streams server has the database open: before
it starts one, and before a standby starts a hub from its copy, so that the
deletion does not use up the 30 seconds the takeover waits for that hub. It
keeps the entry that ends at the snapshot, because the server records a
snapshot, or reads a JSON stream, only at an offset where a stored entry starts
or ends.

It does not delete while serving. A bootstrap takes the snapshot, sends it, and
reads the entries after it only once the snapshot is out. When another client
records a newer snapshot meanwhile, as a member does while a slow reader
receives a large one, entries deleted with it would be missing from that
bootstrap, which would still answer 200 and claim the stream's end
(`hub-storage.test.ts` holds a bootstrap open while that happens). The server
could delete them itself once a bootstrap reads its snapshot and the entries
after it in one view.

A member records a snapshot of a stream only once enough was written to it
since the last one, so a Session archived before that would keep every entry
it wrote. The agent service that ran an archived Session therefore records one
of its Session doc and of its file index as soon as the archive reaches it
(`compactArchivedSessionStreams` in `apps/cli/src/lib/loro/doc.ts`, through
`uploadDocSnapshot` of the fork's `loro-repo` patch), and the hub deletes what
it replaced when it next starts. A file index that never had a row, or whose
stream expired, is skipped, as joining its room would create the stream again.
For the Sessions archived before this, each agent service does the same once
per workspace replica, four at a time, and writes `archived-streams-compacted`
beside the replica when none failed (`archived-session-streams.ts`).

Once a quarter of the file or more is free, the hub VACUUMs it; less stays on
SQLite's free list for the server to reuse. A 2 GB database that had kept seven
weeks of replaced entries took 13 seconds on a small NVMe server to delete them
and VACUUM, and came out at half the size; the hub does not answer meanwhile.
A start that finds nothing to delete costs a few milliseconds.

## Telling what is outside Lody

A tunnel, a reverse proxy or a monitor that names the hub's machine has to
follow a move, and may live on any member. So every member runs its own hook
once its agent service follows a hub to another address, whatever told it: the
pointer, a member, its own takeover, `lody lan move` or Settings
(`lan-hub-moved.ts`, from the one place all of them pass,
`LanMembership.apply`). The hook is the executable file
`hooks/lan-hub-moved` of the data directory; without one nothing happens, and
nothing in the application shows or edits it.

| Variable                     | Value                                                      |
| ---------------------------- | ---------------------------------------------------------- |
| `LODY_HOOK_EVENT`            | `lan-hub-moved`                                            |
| `LODY_HOOK_LAN_ID`           | The id of the LAN                                          |
| `LODY_HOOK_LAN_NAME`         | The LAN as this machine calls it                           |
| `LODY_HOOK_HUB_URL`          | Where the hub is now                                       |
| `LODY_HOOK_HUB_PREVIOUS_URL` | Where this machine reached it before                       |
| `LODY_HOOK_HUB_TERM`         | The term this machine follows; a move by hand starts none  |
| `LODY_HOOK_HUB_HOSTED_HERE`  | `true` on the machine that hosts the hub now, else `false` |

The hook inherits the service's environment without `LODY_LAN_HUB_URL` and
`LODY_LAN_HUB_TOKEN`, and is never given the credential: what needs it, such as
the address shares open at, it asks `lody lan` for. It runs in `hooks/`, one
move after the other, and is stopped after a minute; how it ended and the last
of what it wrote go to the service's log. It is not run again, so it should set
things to where the hub is now rather than undo the previous address.

The machine that hosts the hub now also has it alert the phones of the LAN
(`hub-moved` of the push events), once per term, with the new address: a phone
keeps the address it was given.

A desktop application that is running says so too, in a notification of its
machine: it watches the settings its agent service rewrote
(`LanHubStore.onMoved`). An address the user changes in Settings is their own
edit and is not told.

## Limits

- The hub is a development server on SQLite: one node, no replication. Back up
  its data directory.
- Between starts, the entries that snapshots replace accumulate again: a hub
  that runs for weeks grows by them until it starts next. `lody lan up` and
  `lody lan take-over` delete them inside the 30 seconds they wait for the hub.
  A take-over that runs out leaves the LAN with the former host, which deletes
  them before it serves again, so the next take-over is quick.
- Nothing removes the streams of archived or deleted sessions from the hub.
  An archived Session keeps one snapshot per stream and what was written after
  it; a deleted one keeps everything, as does one archived while its agent
  service had no hub. File index streams expire 180 days after they were
  created when the agent service created them, and never when a desktop did.
- A credential cannot be rotated in place. Host a new LAN and move.
- Only a server with a systemd user session takes a LAN over, as only one hosts
  it. A failover loses what the lost hub alone had: what was written after the
  standby's last copy and is held by no member that comes back.
- While its hub is away, a member does not know who is online, so the standby
  is chosen from what the members said before. A standby that is down as well
  leaves the LAN without a hub until someone takes it over by hand. Phones
  registered for push keep the address they were given; the iOS client has to
  be pointed to the new host by hand. Alerts still reach them,
  as the new hub and every member send from the copied registrations.
- The hook runs in an agent service that is running when the address changes.
  A machine moved while its service was stopped runs none, and Windows runs
  none at all.
