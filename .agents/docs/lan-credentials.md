# LAN credentials: GitHub, push and environment variables

The credentials a [LAN](lan.md) holds in place of hosted Lody's services: one
GitHub token on the host, the environment variables its MCP servers read, and
copies of every credential on each member.

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
  through the same workspace token port. Automated review and merge are no longer available.
- An agent gets the token only on a machine whose `gh` is not logged in:
  `GH_TOKEN` for `gh`, and a Git credential helper for github.com placed after
  every helper the machine has. Credentials the machine has win, and an SSH
  remote still needs a key of the machine. A session keeps the token it
  started with. Its runtime credential lease follows speculative preparation into
  the adopted session, and is released after that runtime stops. Host Git receives
  the same lease; tokens are not placed in the serializable session configuration.

There is no repository registry either: the repositories an agent's
discovery tools and the desktop's pickers offer are the ones the credential
reads (GitHub's `/user/repos`), with the machine's `gh` login before the
host's token. There is no personal identity, no per-repository scoping and no
webhook: the panel refreshes when opened and by polling.

Settings > GitHub of the desktop shows the same, behind the capability
`localGitHubCredential` where hosted Lody has `githubIntegration`:

```text
 Settings > GitHub ─ lan/github-token ─▶ agent service ─ GitHub /user, then PUT/DELETE
   (token in, login out)                 of this machine   /lan/credentials/github ─▶ hub
                    ─ lan/github ───────▶ every member: its own gh login (and whose),
                                          the hub's token as it gets it (and whose)
```

- The token row sets, replaces or removes the hub's token. The token goes from
  the renderer to this machine's agent service once, which asks GitHub whose it
  is and hands it to the hub as `lody lan github setup` does; what comes back
  is the login alone. A token GitHub refuses leaves the hub as it was.
- Each machine of the LAN says which credential its agents use: its own `gh`
  login, else the hub's token (its copy while the hub is away), else none.
  Offline machines are not asked; a machine of an earlier build does not answer.
- The repositories are the ones the desktop's pickers offer, read with the
  credential of the desktop (the hub's token first, then its `gh` login).

The entries that open it are "Connect more GitHub projects" in the project
picker and the empty repository picker of a schedule. "Add a GitHub
repository" (Settings > Projects, the mobile home) and the GitHub step of
onboarding stay hidden: a LAN has no registry to add to, and onboarding runs
before a LAN is joined.

## Environment variables for MCP servers

A workspace MCP server names its secrets as `${VAR}` or `envPassthrough`, which
the daemon that starts the session fills from its own environment
(`packages/shared/src/workspace-mcp.ts`); the plaintext `env` of the catalog is
a workspace document every renderer reads, so a token does not belong there. On
a LAN the daemons of every member would each need the variable. The host keeps
one table instead, `env.json` of its data directory, one object of name to
value:

```text
 lody lan env set NAME < value ─ PUT /lan/credentials/env ─▶ hub: env.json
 lody lan env list              ─ GET /lan/credentials/env ◀─ the names alone
 lody lan env unset NAME        ─ DELETE /lan/credentials/env
```

- `set` reads the value from standard input and refuses a terminal, so a value
  never stands in a shell history or an argument list; `--data-dir` writes the
  host's file on this machine instead of asking the hub. `list` and the route
  behind it carry names only. The hub logs the name of a variable, never its
  value.
- Members get the table with the rest of the credentials (below) and a session
  start reads this machine's copy (`readLanCredentialsEnv`) into the MCP
  resolution of `loadSessionMcpCatalog`, behind the daemon's own environment: a
  variable the machine sets itself keeps its value, the LAN fills what it
  lacks. Nothing of the table enters an agent process; only an MCP server that
  names a variable gets it. A copy nobody can read is an empty table.
- A hub of an earlier build answers the document without `env`, which a newer
  member takes as an empty table; a member of an earlier build keeps the rest
  of the copy and ignores the new file.

## Credentials on every member

The hub holds four credentials: the GitHub token, the APNs key, the phones
registered for push, and the environment table. A standby copies them with the rest of the hub, so
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
- Hub and member group alerts on the phone the same way, by `thread-id`: the
  session's project (`project:local:<machine>:<local project>`, a worktree
  session under its project, or `project:github:<repo>`), `chat` for every
  session without one, and the session id for a member too old to report the
  project. A withdrawn approval alert keeps its group.
- A hub started from a standby copy takes what that copy lacks from the
  machine's own copy of the credentials.

`lody lan github setup`, `lody lan push setup` and `lody lan env set` send the
credential to the hub of the LAN from any member; `--data-dir` writes into a hub's data directory on
the machine instead. The renderer never reaches these routes: the bridge
forwards `/ds/` alone, as the standby copy and the credentials route carry
what only a member may hold.
