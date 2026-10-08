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

## Limits

- The hub is a development server on SQLite: one node, no replication. Back up
  its data directory.
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
