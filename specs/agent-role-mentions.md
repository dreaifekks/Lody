# Agent Role mention discovery

Status: draft
Translation: pending

## Behavior

In every composer, including plain chat, GitHub projects and Local Projects, a
user can mention a Role on any machine they may reach. A Role is a template with
instances, each an agent on one machine. Instances that share an alias, or that
have none and run the same agent family, are one group: they stand in for each
other across machines, and a machine holds at most one of them. The `@` list is
the same flat list as the composer's Role menu: one entry per group, the
composer's machine first. A group shows its instance on that machine when it has
one, else its first instance elsewhere that can run, and an entry elsewhere names
its machine.

A Role with one group is written `@<Role>`; one with several is written
`@<Role>:<group>` per group (`@uiStyle:Claude`) and shown as `uiStyle · Claude`.
A bare `@<Role>` runs the Role's first group that can run, the composer's machine
first inside it — the rule a bare Role follows over MCP. A token two entries would
both produce stays plain text, even while one of them cannot run. The committed range carries the instance id, so
renaming a Role or a group does not retarget a mention; when that instance cannot
run, another of its group stands in. Agents dispatching Roles reach the machines
the executing machine's owner may use, never more than the human driving the
Turn may use; an instance on another machine than a Local Project or local
worktree runs as an independent Session on its own machine rather than as a
child Session.

A term naming a machine after `@` (`@ui@n1`) lists, for each group with an
instance on a machine whose name starts with it, the entry that runs there: the
group's own entry when it already does, else one pinned to that instance and
titled with its machine (`uiStyle · Claude · n100`). A pinned entry is written
`@<entry token>@<machine>` (`@uiStyle:Claude@n100`, `@visionAgent@n100`), the
machine's display name with whitespace as `-`; `@<Role>@<machine>` pins the
Role's first group on that machine, in group order, that can run. A pinned
mention runs that instance or nothing: when it cannot run it stays plain text,
and no other machine stands in. A machine token two machines share stays text.

The Role menu lists those entries for every Role readable in the current
workspace, including unavailable and loading ones. It preserves ownership and
sharing permissions; it does not expose another user's private Roles. Available
search matches come first, followed by disabled matches. Disabled rows explain
their state below the name: checking availability, machine inaccessible/offline,
or binding missing or mismatched. The detail pane names the highlighted entry's
agent and the machine it runs on, this machine included, by the name its title
uses for a machine elsewhere.

The dedicated Role list shows all those entries. Aggregate search keeps its
existing per-category cap, applied after availability ordering. Search matches
Role names, group names and their derived mention tokens.

Disabled entries cannot be selected with mouse or keyboard. Text hydration and
before-send expansion also require current availability; a stale mention stays
plain text and creates no Role dispatch instruction. The instruction names the
Role and instance ids; instance selection and Operation acceptance remain
governed by the [shared contracts](../packages/shared/AGENTS.md).

## Evidence

- [Context, availability and expansion](../packages/components/src/components/mentions/mention-agent-role-source.ts)
- [Candidate mapping](../packages/components/src/components/mentions/mention-registry.ts)
- [Menu rows](../packages/components/src/components/mentions/mention-two-level-menu.tsx)
- [Behavior tests](../packages/components/tests/agent-role-mention-source.test.ts)
- [Selection tests](../packages/components/tests/mention-two-level-menu.test.tsx)
