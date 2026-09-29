# Importing from a hosted installation

Someone who used the hosted Lody and moves to the local platform has configured
agents, MCP servers, Roles and projects once already. This page explains how the
local platform reads that configuration from the same machine and adds it to one
of its workspaces, and what it leaves behind.

## The pieces

| Piece | Where | What it does |
| --- | --- | --- |
| Contract | `packages/shared/src/hosted-config.ts` | Categories, items and what an import does with each |
| Source | `apps/cli/src/lib/hosted-config/hosted-config-source.ts` | Reads a hosted workspace from the files on disk |
| Plan | `apps/cli/src/lib/hosted-config/hosted-config-plan.ts` | Decides per item: create, update, unchanged or skip |
| Import | `apps/cli/src/lib/hosted-config/hosted-config-import.ts` | Reads the workspace, plans, and writes |
| Command | `apps/cli/src/commands/hosted.ts` | `lody hosted import`, on this machine or with `--machine` on a member of a LAN |
| Dialog | `packages/components/src/components/settings/lan-hosted-import.tsx` | The menu of a machine in Settings > LAN |

```text
 hosted data directory              agent service of the local platform
 ┌───────────────────────┐          ┌──────────────────────────────────┐
 │ workspace-catalog.json│─ read ──▶│ source ─▶ plan ─▶ import          │
 │ loro-repo/<ws>/…sqlite│─ copy ──▶│             ▲          │          │
 │ local-project-setup/  │─ read ──▶│   workspace as it is   ▼ writes   │
 └───────────────────────┘          └──────────────────────────────────┘
        never written                 asked by the command and the dialog
                                      as two project-control requests
```

The machine that holds the hosted installation does the import, into its own
installation. Another member of a LAN asks it the way it asks a machine to
update: through the hub, as [LANs](lan.md#the-machines-of-a-lan) explains.

## Reading without an account

The hosted installation keeps a replica of every workspace it served. The import
reads that replica and nothing else: no request reaches the hosted service, so
the local platform stays free of cloud I/O and the import works signed out.

The replica is copied with SQLite's online backup and only the copy is opened.
The hosted agent service may be running and owns the file, and opening a replica
migrates it. The copy holds the credentials agents were configured with; it
lives in a directory only the user can read and is removed before the import
returns.

The hosted data directory is named by the hosted profile, not by
`getLodyDataDir`: inside a desktop-started agent service `LODY_DATA_DIR` names
the local data directory for every profile.

## What an item becomes

The hosted machine and the local one are the same computer under two ids, and
the hosted user is not the local one. Every item is rewritten to the machine and
the user of the workspace it is imported into.

| Category | Counterpart in the workspace | Left behind |
| --- | --- | --- |
| Agents | Same id, or the only builtin agent of that type | The hosted sign-in |
| MCP servers | Same id, or same name | Who created it |
| Roles | Same id | Roles of other machines, Roles whose agent is absent |
| Projects | Same id, which is derived from the path | History, projects whose directory is gone |
| Worktree scripts | Same project and phase | Scripts whose project is absent |

The local agent service registers builtin agents itself, under ids of its own,
so a hosted builtin agent updates that agent instead of adding a second one. Its
environment is merged over the local one. A hosted sign-in is a reference to a
credential stored for the hosted workspace, machine and agent; it opens nothing
elsewhere, so the agent is imported without it and has to sign in again.

Importing twice changes nothing the second time. An unselected category still
decides what a selected one may refer to: a Role needs its agent and a script
its project, imported now or present already.

## Limits

- Prompt shortcuts and appearance settings live in the browser profile of the
  hosted desktop, not in its data directory, and are not imported.
- Only what the hosted workspace configured for a machine is imported on it.
  Every machine that moves imports for itself, asked from its own window or
  from the window of another member.
- Sessions are not imported.
