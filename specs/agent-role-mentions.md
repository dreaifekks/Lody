# Agent Role mention discovery

Status: draft
Translation: pending

## Behavior

In every composer, including plain chat, GitHub projects and Local Projects, a
user can mention a Role instance on the composer's machine. A Role is a template
with instances, each an agent on one machine, and the `@` list is the same flat
list as the composer's Role menu: one entry per instance on this machine. A Role
with one instance here is written `@<Role>`; one with several is written
`@<Role>:<label>` per instance (`@uiStyle:Claude`) and shown as `uiStyle · Claude`.
A bare `@<Role>` names that Role's default instance here, its first one. A token
two entries would both produce stays plain text. The committed range carries the
instance id, so renaming a Role or an instance does not retarget a mention.
Agents dispatching Roles still reach the machines the executing machine's owner
may use, never more than the human driving the Turn may use; an instance on
another machine than a Local Project or local worktree runs as an independent
Session on its own machine rather than as a child Session.

The Role menu lists every instance on this machine of the Roles readable in the
current workspace, including unavailable and loading ones. It preserves ownership
and sharing permissions; it does not expose another user's private Roles.
Available search matches come first, followed by disabled matches. Disabled rows
explain their state below the name: checking availability, machine
inaccessible/offline, or binding missing or mismatched.

The dedicated Role list shows all those instances. Aggregate search keeps its
existing per-category cap, applied after availability ordering. Search matches
Role names, instance labels and their derived mention tokens.

Disabled instances cannot be selected with mouse or keyboard. Text hydration and
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
