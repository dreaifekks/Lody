# LAN members: folders in an editor

How an editor on a desktop opens the folder of a session another member of a
[LAN](lan.md) runs: over the SSH server of that machine, with the entry of the
desktop's SSH configuration that reaches it.

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

## Limits

- A folder of another member opens in an editor only. It takes an SSH server
  on that machine and a POSIX path. A machine that reaches its hub over IPv6
  names its server with `LODY_LAN_SSH`, by a host name or an IPv4 address:
  editors do not agree on how an IPv6 address is written. The files of such a
  session do not open in an editor.
