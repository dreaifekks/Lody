# Agent Role mention discovery

Status: draft
Translation: pending

## Behavior

Every composer can mention a readable Role target on any reachable machine. Both
mention and composer Role menus list every target separately, including multiple
targets of one Role on one machine. Entries name the Role, target alias or Agent
family, and machine. The current machine may sort first; ordering and availability
never select a target or substitute one for another.

In every composer, including plain chat, GitHub projects and Local Projects, a
user can mention a Role on any authorized machine. A Role on another machine
than a Local Project or local worktree cannot reach that filesystem, so it runs
as an independent Session on its own machine rather than as a child Session.
When that Local Project's GitHub repository is enabled in the workspace, the
Session works in that repository, cloned on the Role's machine from its default
branch, as if the user had dispatched the Role from that GitHub project;
otherwise it is a plain chat.
Agents dispatching Roles reach the machines the executing machine's owner may
use, never more than the human driving the Turn may use.

A single-target Role keeps `@<Role>`. Multiple targets use
`@<Role>:<alias-or-agent>@<machine>`, with whitespace normalized for the token.
A machine query such as `@review@server` lists every matching target there. Each
menu choice pins the stable target id. Existing instance-id and `pinned:<id>`
ranges still name exactly that target, including its run configuration and memory.
Renaming labels does not retarget a committed range.
The Role menu lists every Role readable in the current workspace, including
unavailable and loading Roles. It preserves ownership and sharing permissions;
it does not expose another user's private Roles. Available search matches come
first, followed by disabled matches. Disabled rows explain their state below
the name: checking availability, machine inaccessible/offline, binding missing
or mismatched, or a pinned model or permission mode the bound agent no longer
offers. Only a runtime probe of that exact agent that lists models or modes can
report a retired pin; static defaults or an empty probe leave the Role available.
The user fixes the pin by editing the Role; saved pins are never rewritten here.

Text hydration resolves only a unique available match. Bare Role names, aliases
or `@Role@machine` text that identifies several targets stays plain text, even
when only one match is online. Deleted or unavailable pins remain plain text and
produce no expanded reference. Mentions are references, not dispatch instructions.
A reference to a selected target carries the Role and stable target id; only a
reference without a target names the Role alone. The user's words determine the
action. If a Session is created,
acceptance freezes the current target, shared prompt and revision.

Unavailable/loading targets remain visible with their reason and cannot be
selected. Readability preserves ownership and sharing rules. Dedicated Role menus
show all entries; aggregate search keeps its category cap after availability
ordering. Detail panes describe the highlighted target's Agent and machine.

Machine access still requires both the executing machine owner and invoking human
to reach the target. An explicit machine or work context must agree with a pinned
target. Dispatch and acceptance follow the [shared contracts](../packages/shared/AGENTS.md)
and [target model](agent-role-machine-targets.md).

## Evidence

- [Discovery, hydration and expansion](../packages/components/src/components/mentions/mention-agent-role-source.ts)
- [Candidate mapping](../packages/components/src/components/mentions/mention-registry.ts)
- [Composer target menu](../packages/components/src/lib/composer-agent-roles.ts)
- [Menu rows](../packages/components/src/components/mentions/mention-two-level-menu.tsx)
- [Retired pin rule](../packages/shared/src/agent-role.ts)
- [Behavior tests](../packages/components/tests/agent-role-mention-source.test.ts)
- [Selection tests](../packages/components/tests/mention-two-level-menu.test.tsx)
