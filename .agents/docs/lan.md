# LANs: machines that reach each other without an account

The local platform has no account service, so nothing tells two installations
that they belong together. A LAN does: it is a self-hosted Streams hub plus the
credential that opens it. Every installation that holds the credential is a
member, sees the other members' machines and projects, and can run agents on
them. This page explains how the pieces fit and [lists the pages](#pages) for
each topic; the invariants stay in the scoped `AGENTS.md` files they link to.

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
| Shares         | `apps/cli/src/lib/lan/hub-shares.ts`, `lan-shares.ts`, `packages/lan-share-reader`          | The hub keeps published conversations and serves them to readers on a port of their own                                       |

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

## Pages

| Page                                                              | What it covers                                                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Terminals, ports, files and requests](lan-member-connections.md) | Direct connections between members; desktop and agent requests to another machine  |
| [Folders in an editor](lan-folders.md)                            | Opening another member's folder in an editor over SSH                              |
| [Machines](lan-machines.md)                                       | Machine metadata, the machine list, requests between members, following a change   |
| [Updates, hosting and releases](lan-releases.md)                  | Self-update of services and desktops, `lody lan up`, fork builds, tags and signing |
| [Moving the hub, standby and failover](lan-host.md)               | Take-over, the pointer a former host leaves, the standby copy and its epochs       |
| [GitHub and credentials](lan-credentials.md)                      | The host's GitHub token, Settings > GitHub, credential copies and push fallback    |
| [Shared conversations](lan-sharing.md)                            | Publishing, storage, the reader listener, and shares following the hub             |
| [Usage and Prompt Shortcuts](lan-usage-and-shortcuts.md)          | The per-machine usage ledger and the usage page; shortcuts synced through the hub  |

The limits of a topic close its page.
